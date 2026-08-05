import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { JsonObject, OmpRunResult, OmpWorkerOptions, ThinkingLevel } from "./types.ts";

interface PendingRequest {
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingChunks {
  id: string;
  count: number;
  byteLength: number;
  next: number;
  chunks: Buffer[];
  bytes: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export class OmpRpcWorker {
  readonly options: OmpWorkerOptions;
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number | null;
  lastUsed = Date.now();
  sessionPath: string | null;
  sessionId = "";
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private turnResolve: ((value: OmpRunResult) => void) | undefined;
  private turnReject: ((error: Error) => void) | undefined;
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAssistantText = "";
  private chunks: PendingChunks | undefined;
  private activePromptId: string | undefined;
  private finishingTurn = false;
  private closed = false;
  private dead = false;
  private stopNotified = false;
  private leases = 0;
  private queuedTurns = 0;
  private readonly subagents = new Map<string, JsonObject>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: OmpWorkerOptions) {
    this.options = options;
    this.sessionPath = options.sessionPath ?? null;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const args: string[] = [];
    if (options.profile.trim() && options.profile !== "default") args.push("--profile", options.profile);
    args.push("--mode", "rpc");
    this.child = spawn(options.command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        OTEL_SDK_DISABLED: "true",
        PI_RPC_EMIT_TITLE: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid ?? null;

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error(`[omp:${this.options.key}] ${text}`);
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.dead = true;
      this.fail(new Error(`OMP RPC worker exited (${signal ?? `code ${code ?? "unknown"}`})`));
    });
  }

  async initialize(): Promise<void> {
    await withTimeout(this.ready, REQUEST_TIMEOUT_MS, "OMP RPC startup");
    await this.request("negotiate_protocol", { protocolVersion: 2 });
    if (this.sessionPath) await this.request("switch_session", { sessionPath: this.sessionPath });
    if (this.options.provider && this.options.model) {
      await this.request("set_model", { provider: this.options.provider, modelId: this.options.model });
    }
    if (this.options.thinking) await this.request("set_thinking_level", { level: this.options.thinking });
    await this.request("set_subagent_subscription", { level: "progress" });
    await this.refreshState();
  }

  runPrompt(message: string): Promise<OmpRunResult> {
    this.queuedTurns++;
    const run = this.queue.then(() => this.runPromptNow(message));
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.queuedTurns--;
      this.lastUsed = Date.now();
    });
  }

  reserve(): void {
    if (!this.isAlive) throw new Error("OMP worker is unavailable");
    this.leases++;
    this.lastUsed = Date.now();
  }

  release(): void {
    this.leases = Math.max(0, this.leases - 1);
    this.lastUsed = Date.now();
  }

  async steer(message: string): Promise<void> {
    await this.request("steer", { message });
  }

  async followUp(message: string): Promise<void> {
    await this.request("follow_up", { message });
  }

  async abort(): Promise<void> {
    await this.request("abort");
  }

  async newSession(): Promise<void> {
    await this.request("new_session");
    this.sessionPath = null;
    await this.refreshState();
  }

  async setModel(provider: string, model: string): Promise<void> {
    await this.request("set_model", { provider, modelId: model });
  }

  async setThinking(level: ThinkingLevel): Promise<void> {
    await this.request("set_thinking_level", { level });
  }

  async getState(): Promise<JsonObject> {
    const response = await this.request("get_state");
    return asObject(response.data);
  }

  async refreshSwarmStatus(): Promise<JsonObject> {
    const response = await this.request("get_subagents");
    const snapshots = asObject(response.data).subagents;
    if (Array.isArray(snapshots)) {
      this.subagents.clear();
      for (const value of snapshots) this.rememberSubagent(value);
    }
    return this.swarmStatus;
  }

  get swarmStatus(): JsonObject {
    return swarmView([...this.subagents.values()]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dead = true;
    clearTimeout(this.turnTimer);
    const error = new Error("OMP worker was stopped");
    this.turnReject?.(error);
    this.turnResolve = undefined;
    this.turnReject = undefined;
    this.activePromptId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.notifyStopped();
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  get isAlive(): boolean {
    return !this.closed && !this.dead;
  }

  get isOccupied(): boolean {
    return this.leases > 0 || this.queuedTurns > 0;
  }

  matches(options: OmpWorkerOptions): boolean {
    return (
      this.options.command === options.command &&
      this.options.profile === options.profile &&
      this.options.cwd === options.cwd
    );
  }

  private async runPromptNow(message: string): Promise<OmpRunResult> {
    this.lastUsed = Date.now();
    this.lastAssistantText = "";
    const completion = new Promise<OmpRunResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
      this.turnTimer = setTimeout(() => {
        reject(new Error("OMP turn timed out"));
        void this.request("abort").catch(() => undefined);
      }, TURN_TIMEOUT_MS);
    });
    try {
      const response = await this.request("prompt", { message });
      if (asObject(response.data).agentInvoked === false) {
        const final = await this.request("get_last_assistant_text");
        this.lastAssistantText = firstString(asObject(final.data).text);
        await this.finishTurn();
      }
      return await completion;
    } catch (error) {
      clearTimeout(this.turnTimer);
      this.turnResolve = undefined;
      this.turnReject = undefined;
      this.activePromptId = undefined;
      throw error;
    }
  }

  private request(type: string, fields: JsonObject = {}): Promise<JsonObject> {
    if (this.closed || this.dead) return Promise.reject(new Error("OMP worker is unavailable"));
    const id = `persephone-${++this.requestCounter}`;
    if (type === "prompt") this.activePromptId = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OMP request timed out: ${type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, type, ...fields });
    });
  }

  private write(value: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private onLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as unknown;
      const decoded = this.decodeFrame(parsed);
      if (decoded) void this.onMessage(decoded);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private decodeFrame(value: unknown): JsonObject | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OMP RPC frame must be an object");
    const frame = asObject(value);
    if (frame.type !== "rpc_chunk") {
      if (this.chunks) throw new Error("OMP RPC chunk sequence was interrupted");
      return frame;
    }
    const id = firstString(frame.chunkId);
    const index = Number(frame.index);
    const count = Number(frame.count);
    const byteLength = Number(frame.byteLength);
    const data = firstString(frame.data);
    if (!id || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength)) {
      throw new Error("Invalid OMP RPC chunk metadata");
    }
    if (count < 2 || count > byteLength || index < 0 || index >= count || byteLength < 1 || byteLength > MAX_REASSEMBLED_BYTES) {
      throw new Error("OMP RPC chunk limits were violated");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) throw new Error("OMP RPC chunk was empty");
    if (!this.chunks) {
      if (index !== 0) throw new Error("OMP RPC chunk sequence did not start at zero");
      this.chunks = { id, count, byteLength, next: 0, chunks: [], bytes: 0 };
    }
    const pending = this.chunks;
    if (pending.id !== id || pending.count !== count || pending.byteLength !== byteLength || pending.next !== index) {
      throw new Error("OMP RPC chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.bytes += bytes.length;
    pending.next++;
    if (pending.bytes > pending.byteLength) throw new Error("OMP RPC chunk exceeded declared length");
    if (pending.next < pending.count) return undefined;
    this.chunks = undefined;
    if (pending.bytes !== pending.byteLength) throw new Error("OMP RPC chunk length mismatch");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const decoded = JSON.parse(text) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("OMP RPC reassembled frame must be an object");
    }
    return decoded as JsonObject;
  }

  private async onMessage(message: JsonObject): Promise<void> {
    const type = firstString(message.type);
    if (type === "ready") {
      this.readyResolve();
      return;
    }
    if (type === "response") {
      const id = firstString(message.id);
      const pending = this.pending.get(id);
      if (!pending) {
        if (id === this.activePromptId && message.success === false) {
          this.turnReject?.(new Error(firstString(message.error) || "OMP prompt scheduling failed"));
          clearTimeout(this.turnTimer);
          this.turnResolve = undefined;
          this.turnReject = undefined;
          this.activePromptId = undefined;
        }
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.success === false) pending.reject(new Error(firstString(message.error) || "OMP command failed"));
      else pending.resolve(message);
      return;
    }
    if (type === "message_end") {
      const text = assistantText(message.message);
      if (text) this.lastAssistantText = text;
      return;
    }
    if (type === "agent_end" && message.isTerminal !== false) {
      const messages = Array.isArray(message.messages) ? message.messages : [];
      for (let index = messages.length - 1; index >= 0; index--) {
        const text = assistantText(messages[index]);
        if (text) {
          this.lastAssistantText = text;
          break;
        }
      }
      await this.finishTurn();
      return;
    }
    if (type === "prompt_result" && message.agentInvoked === false) {
      await this.completeLocalTurn();
      return;
    }
    if (type === "subagent_lifecycle" || type === "subagent_progress") {
      this.rememberSubagent(message.payload);
      return;
    }
    if (type === "extension_ui_request") {
      const response = await this.options.onUiRequest(message);
      this.write({ type: "extension_ui_response", id: firstString(message.id), ...response });
      return;
    }
    if (type === "extension_error") {
      console.error(`[omp:${this.options.key}:extension] ${firstString(message.error) || "unknown error"}`);
    }
  }

  private async finishTurn(): Promise<void> {
    if (!this.turnResolve || this.finishingTurn) return;
    this.finishingTurn = true;
    clearTimeout(this.turnTimer);
    const resolve = this.turnResolve;
    const reject = this.turnReject;
    this.turnResolve = undefined;
    this.turnReject = undefined;
    this.activePromptId = undefined;
    try {
      await this.refreshState();
      resolve({ text: this.lastAssistantText, sessionPath: this.sessionPath, sessionId: this.sessionId });
    } catch (error) {
      reject?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.finishingTurn = false;
    }
  }

  private async completeLocalTurn(): Promise<void> {
    if (!this.turnResolve || this.finishingTurn) return;
    try {
      const final = await this.request("get_last_assistant_text");
      this.lastAssistantText = firstString(asObject(final.data).text);
    } catch {
      // A local command may intentionally have no assistant message.
    }
    await this.finishTurn();
  }

  private async refreshState(): Promise<void> {
    const state = await this.getState();
    this.sessionId = firstString(state.sessionId);
    const sessionPath = firstString(state.sessionFile);
    if (sessionPath) {
      this.sessionPath = sessionPath;
      this.options.onSession(sessionPath);
    }
  }

  private rememberSubagent(value: unknown): void {
    const snapshot = normalizeSubagent(value);
    const id = firstString(snapshot.id);
    if (!id) return;
    const merged: JsonObject = { ...(this.subagents.get(id) ?? {}) };
    for (const [key, item] of Object.entries(snapshot)) {
      if (item !== null || !(key in merged)) merged[key] = item;
    }
    this.subagents.set(id, merged);
  }

  private fail(error: Error): void {
    this.dead = true;
    this.readyReject(error);
    this.turnReject?.(error);
    this.turnResolve = undefined;
    this.turnReject = undefined;
    this.activePromptId = undefined;
    clearTimeout(this.turnTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.notifyStopped();
    if (!this.closed && !this.child.killed) this.child.kill("SIGTERM");
  }

  private notifyStopped(): void {
    if (this.stopNotified) return;
    this.stopNotified = true;
    this.options.onExit?.();
  }
}

export class OmpWorkerPool {
  private readonly workers = new Map<string, OmpRpcWorker>();
  private mutation: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly maximum: number, private readonly idleMs: number) {}

  async acquire(options: OmpWorkerOptions): Promise<OmpRpcWorker> {
    while (true) {
      const worker = await this.exclusive(async () => {
        if (this.closed) throw new Error("OMP worker pool is closed");
        const existing = this.workers.get(options.key);
        if (existing?.isAlive && existing.matches(options)) {
          existing.reserve();
          return existing;
        }
        if (existing) {
          if (existing.isOccupied) return null;
          this.workers.delete(options.key);
          await existing.close();
        }
        await this.reapIdleUnlocked();
        if (this.workers.size >= this.maximum) {
          const oldest = [...this.workers.values()]
            .filter((candidate) => !candidate.isOccupied)
            .sort((left, right) => left.lastUsed - right.lastUsed)[0];
          if (!oldest) return null;
          this.workers.delete(oldest.options.key);
          await oldest.close();
        }
        const created = new OmpRpcWorker(options);
        created.reserve();
        this.workers.set(options.key, created);
        try {
          await created.initialize();
          return created;
        } catch (error) {
          this.workers.delete(options.key);
          created.release();
          await created.close();
          throw error;
        }
      });
      if (worker) return worker;
      await delay(50);
    }
  }

  get(key: string): OmpRpcWorker | undefined {
    return this.workers.get(key);
  }

  async drop(key: string): Promise<void> {
    const worker = this.workers.get(key);
    if (!worker) return;
    this.workers.delete(key);
    await worker.close();
  }

  async reapIdle(): Promise<void> {
    await this.exclusive(() => this.reapIdleUnlocked());
  }

  private async reapIdleUnlocked(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    for (const [key, worker] of this.workers) {
      if (worker.isOccupied || worker.lastUsed >= cutoff) continue;
      this.workers.delete(key);
      await worker.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.exclusive(async () => {
      await Promise.all([...this.workers.values()].map((worker) => worker.close()));
      this.workers.clear();
    });
  }

  get size(): number {
    return this.workers.size;
  }

  snapshot(): JsonObject[] {
    return [...this.workers.values()].map((worker) => ({
      key: worker.options.key,
      pid: worker.pid,
      alive: worker.isAlive,
      occupied: worker.isOccupied,
      sessionPath: worker.sessionPath,
      nativeSwarm: worker.swarmStatus,
    }));
  }

  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }
}

function assistantText(value: unknown): string {
  const message = asObject(value);
  if (message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      const block = asObject(part);
      return block.type === "text" ? firstString(block.text) : "";
    })
    .filter(Boolean)
    .join("");
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function normalizeSubagent(value: unknown): JsonObject {
  const snapshot = asObject(value);
  const progress = asObject(snapshot.progress);
  const id = firstString(progress.id, snapshot.id);
  if (!id) return {};
  const rawStatus = firstString(progress.status, snapshot.status) || "unknown";
  return {
    id,
    index: finiteInteger(snapshot.index ?? progress.index),
    agent: firstString(snapshot.agent, progress.agent) || "task",
    description: firstString(progress.description, snapshot.description) || null,
    task: firstString(snapshot.task, progress.task, snapshot.assignment, progress.assignment) || null,
    status: rawStatus === "started" ? "running" : rawStatus,
    sessionFile: firstString(snapshot.sessionFile) || null,
    currentIntent: firstString(progress.lastIntent) || null,
    currentTool: firstString(progress.currentTool) || null,
    updatedAt: new Date().toISOString(),
  };
}

function swarmView(subagents: JsonObject[]): JsonObject {
  const ids = new Set(subagents.map((item) => firstString(item.id)).filter(Boolean));
  const nodes = new Map<string, JsonObject>();
  for (const item of subagents) {
    const id = firstString(item.id);
    if (id) nodes.set(id, { ...item, parentId: parentSubagentId(id, ids), children: [] });
  }
  const roots: JsonObject[] = [];
  const counts: Record<string, number> = {};
  for (const [id, node] of nodes) {
    const status = firstString(node.status) || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    const parentId = parentSubagentId(id, ids);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) (parent.children as JsonObject[]).push(node);
    else roots.push(node);
  }
  return {
    engine: "omp-task-hub",
    childCount: subagents.length,
    activeCount: subagents.filter((item) => ["pending", "running"].includes(firstString(item.status))).length,
    statusCounts: counts,
    children: roots,
  };
}

function parentSubagentId(id: string, ids: Set<string>): string | null {
  const parts = id.split(".");
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join(".");
    if (ids.has(candidate)) return candidate;
  }
  return null;
}

function finiteInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value) return value;
  return "";
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

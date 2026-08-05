import type { Server } from "bun";
import { cronMatches, cronMinute } from "./cron.ts";
import { PersephoneDatabase } from "./database.ts";
import { DiscordClient } from "./discord.ts";
import { OmpWorkerPool, type OmpRpcWorker } from "./rpc.ts";
import { SignalClient } from "./signal.ts";
import { SlackClient } from "./slack.ts";
import { sleep, type ChatTransport } from "./transport.ts";
import type { InboxRecord, JsonObject, PersephoneConfig, RouteRecord, ScheduleRecord, ThinkingLevel } from "./types.ts";

interface PendingApproval {
  workerKey: string;
  channel: string;
  peerId: string;
  resolve: (response: JsonObject) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LoopState {
  running: boolean;
  starts: number;
  failures: number;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  lastError: string | null;
  restartDelayMs: number | null;
}

const PRIORITY_ROUTE_COMMANDS = new Set(["/approve", "/deny", "/follow", "/help", "/status", "/steer", "/stop"]);
const MAX_ROUTE_DEPTH = 32;

export class PersephoneDaemon {
  readonly db: PersephoneDatabase;
  readonly pool: OmpWorkerPool;
  readonly transports = new Map<string, ChatTransport>();
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private readonly approvals = new Map<number, PendingApproval>();
  private readonly loops = new Map<string, LoopState>();
  private readonly routeTails = new Map<string, Promise<void>>();
  private readonly routeDepth = new Map<string, number>();
  private server?: Server<unknown>;
  private startedAt = Date.now();

  constructor(readonly config: PersephoneConfig) {
    this.db = new PersephoneDatabase();
    this.pool = new OmpWorkerPool(config.omp.maxWorkers, config.omp.idleSeconds * 1000);
    if (config.signal.enabled) this.registerTransport(new SignalClient(config.signal));
    if (config.discord.enabled) this.registerTransport(new DiscordClient(config.discord));
    if (config.slack.enabled) this.registerTransport(new SlackClient(config.slack));
  }

  async run(): Promise<void> {
    this.server = Bun.serve({
      hostname: this.config.listen.host,
      port: this.config.listen.port,
      fetch: (request) => this.handleHttp(request),
    });
    console.log(`Persephone listening on http://${this.config.listen.host}:${this.server.port}`);
    for (const transport of this.transports.values()) {
      this.startLoop(transport.channel, () => this.transportLoop(transport));
    }
    this.startLoop("inbox", () => this.inboxLoop());
    this.startLoop("outbox", () => this.outboxLoop());
    this.startLoop("scheduler", () => this.schedulerLoop());
    this.startLoop("reaper", () => this.reaperLoop());

    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    await this.close();
  }

  async close(): Promise<void> {
    this.controller.abort();
    this.server?.stop(true);
    for (const [id, pending] of this.approvals) {
      clearTimeout(pending.timer);
      this.db.resolveApproval(id, { cancelled: true }, "denied");
      pending.resolve({ cancelled: true });
    }
    this.approvals.clear();
    await this.pool.close();
    await Promise.allSettled([...this.active]);
    this.db.close();
  }

  status(): Record<string, unknown> {
    const loops = Object.fromEntries(
      [...this.loops.entries()].map(([name, state]) => [name, {
        running: state.running,
        starts: state.starts,
        restarts: Math.max(0, state.starts - 1),
        failures: state.failures,
        lastStartedAt: isoTime(state.lastStartedAt),
        lastStoppedAt: isoTime(state.lastStoppedAt),
        lastError: state.lastError,
        restartDelayMs: state.restartDelayMs,
      }]),
    );
    const ok = this.loops.size > 0 && [...this.loops.values()].every((state) => state.running);
    return {
      ok,
      version: 1,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      pid: process.pid,
      workers: this.pool.size,
      workerState: this.pool.snapshot(),
      transports: {
        signal: { enabled: this.transports.has("signal"), endpoint: this.config.signal.url },
        discord: { enabled: this.transports.has("discord") },
        slack: { enabled: this.transports.has("slack") },
      },
      queues: this.db.status(),
      routing: {
        activeRoutes: this.routeTails.size,
        inFlightAndQueuedMessages: [...this.routeDepth.values()].reduce((total, depth) => total + depth, 0),
        queuedBehindActive: [...this.routeDepth.values()].reduce((total, depth) => total + Math.max(0, depth - 1), 0),
      },
      loops,
    };
  }

  private startLoop(name: string, body: () => Promise<void>): void {
    if (this.loops.has(name)) throw new Error(`Duplicate Persephone loop: ${name}`);
    const state: LoopState = {
      running: false,
      starts: 0,
      failures: 0,
      lastStartedAt: null,
      lastStoppedAt: null,
      lastError: null,
      restartDelayMs: null,
    };
    this.loops.set(name, state);
    const task = (async () => {
      let failureStreak = 0;
      while (!this.controller.signal.aborted) {
        state.running = true;
        state.starts++;
        state.lastStartedAt = Date.now();
        state.restartDelayMs = null;
        try {
          await body();
          if (!this.controller.signal.aborted) throw new Error("loop exited unexpectedly");
        } catch (error) {
          if (this.controller.signal.aborted) break;
          state.running = false;
          state.lastStoppedAt = Date.now();
          state.failures++;
          state.lastError = formatError(error);
          if (state.lastStartedAt && Date.now() - state.lastStartedAt >= 60_000) failureStreak = 0;
          const delay = Math.min(30_000, 500 * 2 ** Math.min(failureStreak++, 6));
          state.restartDelayMs = delay;
          console.error(`[${name}] ${state.lastError}; restarting in ${delay}ms`);
          await sleep(delay, this.controller.signal).catch(() => undefined);
        } finally {
          state.running = false;
          state.lastStoppedAt = Date.now();
        }
      }
    })();
    this.track(task);
  }

  private track(task: Promise<void>): void {
    this.active.add(task);
    void task.finally(() => this.active.delete(task));
  }

  private registerTransport(transport: ChatTransport): void {
    if (this.transports.has(transport.channel)) throw new Error(`Duplicate transport: ${transport.channel}`);
    this.transports.set(transport.channel, transport);
  }

  private async transportLoop(transport: ChatTransport): Promise<void> {
    for await (const event of transport.events(this.controller.signal)) {
      this.db.enqueueInbox(transport.channel, event.peerId, event.messageId, event.body, event.receivedAt);
    }
  }

  private async inboxLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const records = this.db.claimInbox(Math.max(4, this.config.omp.maxWorkers * 2));
      for (const record of records) this.dispatchInbox(record);
      await sleep(records.length ? 100 : 500, this.controller.signal);
    }
  }

  private dispatchInbox(record: InboxRecord): void {
    if (this.isPriorityRouteCommand(record.body)) {
      this.track(this.processInbox(record));
      return;
    }
    const key = `${record.channel}:${record.peerId}`;
    const depth = this.routeDepth.get(key) ?? 0;
    if (depth >= MAX_ROUTE_DEPTH) {
      const message = `Per-route queue limit reached (${MAX_ROUTE_DEPTH}); retry after the active OMP turn advances.`;
      this.db.finishInbox(record.id, message);
      this.reply(record, message);
      return;
    }
    const predecessor = this.routeTails.get(key) ?? Promise.resolve();
    this.routeDepth.set(key, depth + 1);
    let task: Promise<void>;
    task = predecessor
      .catch(() => undefined)
      .then(() => this.processInbox(record))
      .finally(() => {
        const remaining = Math.max(0, (this.routeDepth.get(key) ?? 1) - 1);
        if (remaining) this.routeDepth.set(key, remaining);
        else this.routeDepth.delete(key);
        if (this.routeTails.get(key) === task) this.routeTails.delete(key);
      });
    this.routeTails.set(key, task);
    this.track(task);
  }

  private isPriorityRouteCommand(body: string): boolean {
    const command = body.trim().split(/\s+/, 1)[0]?.toLowerCase();
    return Boolean(command && PRIORITY_ROUTE_COMMANDS.has(command));
  }

  private async processInbox(record: InboxRecord): Promise<void> {
    try {
      const route = this.ensureRoute(record.channel, record.peerId);
      const commandResult = await this.handleCommand(record, route);
      if (commandResult !== null) {
        this.reply(record, commandResult);
        this.db.finishInbox(record.id);
        return;
      }

      const worker = await this.workerFor(route);
      try {
        const transport = this.transports.get(record.channel);
        await this.setTyping(transport, record.peerId, true);
        const typingTimer = transport
          ? setInterval(() => void this.setTyping(transport, record.peerId, true), 8000)
          : undefined;
        try {
          this.db.updateWorker(worker.options.key, worker.sessionPath, worker.pid, route.profile, route.cwd, "busy");
          const result = await worker.runPrompt(record.body);
          this.db.updateWorker(worker.options.key, result.sessionPath, worker.pid, route.profile, route.cwd, "ready");
          this.reply(record, result.text || "OMP completed the turn without a text response.");
        } finally {
          if (typingTimer) clearInterval(typingTimer);
          await this.setTyping(transport, record.peerId, false);
        }
      } finally {
        worker.release();
      }
      this.db.finishInbox(record.id);
    } catch (error) {
      const message = formatError(error);
      this.db.finishInbox(record.id, message);
      this.reply(record, `Persephone could not complete that turn: ${message}`);
    }
  }

  private ensureRoute(channel: string, peerId: string): RouteRecord {
    return (
      this.db.getRoute(channel, peerId) ??
      this.db.upsertRoute({
        channel,
        peerId,
        sessionPath: null,
        cwd: this.config.omp.cwd,
        profile: this.config.omp.profile,
        provider: this.config.omp.provider ?? null,
        model: this.config.omp.model ?? null,
        thinking: this.config.omp.thinking ?? null,
      })
    );
  }

  private async setTyping(transport: ChatTransport | undefined, peerId: string, active: boolean): Promise<void> {
    if (!transport) return;
    try {
      await transport.typing(peerId, active);
    } catch (error) {
      console.error(`[${transport.channel}:typing] ${formatError(error)}`);
    }
  }

  private async workerFor(route: RouteRecord): Promise<OmpRpcWorker> {
    const key = `${route.channel}:${route.peerId}`;
    const worker = await this.pool.acquire({
      key,
      command: this.config.omp.command,
      profile: route.profile,
      cwd: route.cwd,
      sessionPath: route.sessionPath,
      provider: route.provider,
      model: route.model,
      thinking: route.thinking,
      onSession: (sessionPath) => this.db.updateSession(route.channel, route.peerId, sessionPath),
      onUiRequest: (request) => this.handleUiRequest(key, route.channel, route.peerId, request),
      onExit: () => {
        this.db.markWorkerStopped(key);
        this.cancelWorkerApprovals(key);
      },
    });
    this.db.updateWorker(key, worker.sessionPath, worker.pid, route.profile, route.cwd, "ready");
    return worker;
  }

  private async handleCommand(record: InboxRecord, route: RouteRecord): Promise<string | null> {
    const body = record.body.trim();
    if (!body.startsWith("/")) return null;
    const [rawCommand, ...parts] = body.split(/\s+/);
    const command = rawCommand?.toLowerCase();
    switch (command) {
      case "/help":
        return [
          "Persephone commands:",
          "/status · /stop · /new · /steer TEXT · /follow TEXT",
          "/cwd PATH · /model PROVIDER/MODEL · /thinking LEVEL",
          "/approve ID · /deny ID",
        ].join("\n");
      case "/status": {
        const worker = this.pool.get(`${route.channel}:${route.peerId}`);
        const state = worker ? await worker.getState() : undefined;
        const nativeSwarm = worker ? await worker.refreshSwarmStatus() : {
          engine: "omp-task-hub",
          childCount: 0,
          activeCount: 0,
          statusCounts: {},
          children: [],
        };
        return JSON.stringify({ route, worker: state ?? "stopped", nativeSwarm, queues: this.db.status() }, null, 2);
      }
      case "/new": {
        await this.pool.drop(`${route.channel}:${route.peerId}`);
        this.db.updateSession(route.channel, route.peerId, null);
        return "The next message will begin a new OMP session.";
      }
      case "/steer": {
        const message = parts.join(" ").trim();
        if (!message) return "Usage: /steer TEXT";
        const worker = this.pool.get(`${route.channel}:${route.peerId}`);
        if (!worker) return "No active OMP turn exists to steer.";
        await worker.steer(message);
        return "Steering message queued.";
      }
      case "/stop": {
        const worker = this.pool.get(`${route.channel}:${route.peerId}`);
        if (!worker?.isOccupied) return "No active OMP turn exists to stop.";
        await worker.abort();
        return "Stop requested. The saved OMP session and route are preserved.";
      }
      case "/follow": {
        const message = parts.join(" ").trim();
        if (!message) return "Usage: /follow TEXT";
        const worker = this.pool.get(`${route.channel}:${route.peerId}`);
        if (!worker) return "No active OMP worker exists; send the message normally instead.";
        await worker.followUp(message);
        return "Follow-up queued.";
      }
      case "/cwd": {
        const cwd = parts.join(" ").trim();
        if (!cwd || !cwd.startsWith("/")) return "Usage: /cwd /absolute/path";
        await this.pool.drop(`${route.channel}:${route.peerId}`);
        this.db.upsertRoute({ ...stripTimes(route), cwd, sessionPath: null });
        return `Working directory changed to ${cwd}; the next message starts a new session.`;
      }
      case "/model": {
        const value = parts.join(" ").trim();
        const separator = value.indexOf("/");
        if (separator < 1 || separator === value.length - 1) return "Usage: /model PROVIDER/MODEL";
        const provider = value.slice(0, separator);
        const model = value.slice(separator + 1);
        const worker = this.pool.get(`${route.channel}:${route.peerId}`);
        if (worker) await worker.setModel(provider, model);
        this.db.upsertRoute({ ...stripTimes(route), provider, model });
        return `Model set to ${provider}/${model}.`;
      }
      case "/thinking": {
        const level = parts[0] as ThinkingLevel | undefined;
        const allowed = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
        if (!level || !allowed.has(level)) return "Usage: /thinking off|minimal|low|medium|high|xhigh|max";
        const worker = this.pool.get(`${route.channel}:${route.peerId}`);
        if (worker) await worker.setThinking(level);
        this.db.upsertRoute({ ...stripTimes(route), thinking: level });
        return `Thinking level set to ${level}.`;
      }
      case "/approve":
      case "/deny": {
        const id = Number(parts[0]);
        if (!Number.isInteger(id)) return `Usage: ${command} ID`;
        const pending = this.approvals.get(id);
        const stored = this.db.getApproval(id);
        if (!pending || !stored || stored.channel !== record.channel || stored.peerId !== record.peerId || stored.status !== "pending") {
          return `Approval ${id} is not pending for this conversation.`;
        }
        const approved = command === "/approve";
        const value = parts.slice(1).join(" ").trim();
        if (approved && stored.method !== "confirm" && !value) {
          return `Approval ${id} needs a value: /approve ${id} VALUE`;
        }
        const response = stored.method === "confirm" ? { confirmed: approved } : { cancelled: !approved, value: approved ? value : undefined };
        this.db.resolveApproval(id, response, approved ? "approved" : "denied");
        clearTimeout(pending.timer);
        this.approvals.delete(id);
        pending.resolve(response);
        return `Approval ${id} ${approved ? "accepted" : "denied"}.`;
      }
      default:
        return "Unknown Persephone command. Use /help.";
    }
  }

  private async handleUiRequest(workerKey: string, channel: string, peerId: string, request: JsonObject): Promise<JsonObject> {
    const method = String(request.method || "");
    if (method === "cancel") {
      const targetId = String(request.targetId || "");
      const stored = this.db.getApprovalByRequest(workerKey, targetId);
      if (stored) {
        const pending = this.approvals.get(stored.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.approvals.delete(stored.id);
          pending.resolve({ cancelled: true });
        }
        this.db.resolveApproval(stored.id, { cancelled: true }, "denied");
      }
      return { cancelled: true };
    }
    if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"].includes(method)) {
      if (method === "notify") {
        const message = String(request.message || request.title || "OMP notification");
        if (this.transports.has(channel)) this.db.enqueueOutbox(channel, peerId, message);
      }
      return { cancelled: true };
    }
    if (!this.transports.has(channel)) return method === "confirm" ? { confirmed: false } : { cancelled: true };
    const requestId = String(request.id || "");
    const title = String(request.title || "OMP approval");
    const message = String(request.message || request.prompt || method);
    const expiresAt = Date.now() + this.config.security.approvalTimeoutSeconds * 1000;
    const approval = this.db.createApproval({ workerKey, requestId, channel, peerId, method, title, message, expiresAt });
    this.db.enqueueOutbox(
      channel,
      peerId,
      `[Approval ${approval.id}] ${title}\n${message}\nReply /approve ${approval.id} or /deny ${approval.id}.`,
    );
    return await new Promise<JsonObject>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(approval.id);
        this.db.resolveApproval(approval.id, { cancelled: true, timedOut: true }, "denied");
        resolve(method === "confirm" ? { confirmed: false } : { cancelled: true, timedOut: true });
      }, this.config.security.approvalTimeoutSeconds * 1000);
      this.approvals.set(approval.id, { workerKey, channel, peerId, resolve, timer });
    });
  }

  private cancelWorkerApprovals(workerKey: string): void {
    for (const [id, pending] of this.approvals) {
      if (pending.workerKey !== workerKey) continue;
      clearTimeout(pending.timer);
      this.approvals.delete(id);
      this.db.resolveApproval(id, { cancelled: true }, "denied");
      pending.resolve({ cancelled: true });
    }
  }

  private reply(record: InboxRecord, body: string): void {
    if (this.transports.has(record.channel)) this.db.enqueueOutbox(record.channel, record.peerId, body, record.id);
    else console.log(`[${record.channel}:${record.peerId}] ${body}`);
  }

  private async outboxLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const records = this.db.claimOutbox(16);
      for (const record of records) {
        try {
          const transport = this.transports.get(record.channel);
          if (!transport) throw new Error(`Unsupported delivery channel: ${record.channel}`);
          await transport.send(record.peerId, record.body);
          this.db.finishOutbox(record.id);
        } catch (error) {
          this.db.finishOutbox(record.id, formatError(error), record.attempts < 5);
        }
      }
      await sleep(records.length ? 100 : 500, this.controller.signal);
    }
  }

  private async schedulerLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const now = new Date();
      const minute = cronMinute(now);
      for (const schedule of this.db.listSchedules()) {
        if (!schedule.enabled || schedule.lastMinute === minute || !cronMatches(schedule.cron, now)) continue;
        if (!this.db.claimSchedule(schedule.id, minute)) continue;
        this.track(this.runSchedule(schedule, minute));
      }
      await sleep(this.config.scheduler.pollSeconds * 1000, this.controller.signal);
    }
  }

  private async runSchedule(schedule: ScheduleRecord, minute: number): Promise<void> {
    try {
      const route = this.ensureRoute("schedule", schedule.name);
      const configured = this.db.upsertRoute({
        ...stripTimes(route),
        cwd: schedule.cwd,
        profile: schedule.profile,
      });
      const worker = await this.workerFor(configured);
      try {
        const result = await worker.runPrompt(schedule.prompt);
        if (schedule.channel && schedule.peerId) this.db.enqueueOutbox(schedule.channel, schedule.peerId, result.text);
      } finally {
        worker.release();
      }
      this.db.markSchedule(schedule.id, minute);
    } catch (error) {
      this.db.markSchedule(schedule.id, minute, formatError(error));
    }
  }

  private async reaperLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      await sleep(60_000, this.controller.signal);
      await this.pool.reapIdle();
    }
  }

  private async handleHttp(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.authorized(request)) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/health") {
      const status = this.status();
      return json(status, status.ok ? 200 : 503);
    }
    if (request.method === "GET" && url.pathname === "/v1/status") return json(this.status());
    if (request.method === "GET" && url.pathname === "/v1/schedules") return json(this.db.listSchedules());
    if (request.method === "GET" && url.pathname === "/v1/routes") return json(this.db.listRoutes());
    if (request.method === "POST" && url.pathname === "/v1/prompt") {
      const body = asObject(await request.json());
      const channel = String(body.channel || "api");
      const peerId = String(body.peerId || "owner");
      const message = String(body.message || "").trim();
      if (!message) return json({ error: "message is required" }, 400);
      const messageId = String(body.messageId || `api:${crypto.randomUUID()}`);
      const id = this.db.enqueueInbox(channel, peerId, messageId, message);
      return json({ accepted: id !== null, inboxId: id }, id === null ? 409 : 202);
    }
    return json({ error: "not found" }, 404);
  }

  private authorized(request: Request): boolean {
    const expected = process.env[this.config.listen.tokenEnv]?.trim();
    if (!expected) return true;
    const authorization = request.headers.get("authorization") || "";
    return authorization === `Bearer ${expected}`;
  }
}

function stripTimes(route: RouteRecord): Omit<RouteRecord, "createdAt" | "updatedAt"> {
  const { createdAt: _created, updatedAt: _updated, ...rest } = route;
  return rest;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

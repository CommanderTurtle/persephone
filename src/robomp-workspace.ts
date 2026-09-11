#!/usr/bin/env bun
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_MUTATION_BYTES = 1_000_000;
const MAX_HTTP_BODY_BYTES = 8_000_000;
const DEFAULT_LIMIT = 50;
const OWNER_REPOSITORY = "https://github.com/can1357/oh-my-pi.git";
const ISSUE_REFERENCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;

type SettingKind = "boolean" | "csv" | "host" | "integer" | "string";

interface SettingSpec {
  key: string;
  kind: SettingKind;
  min?: number;
  max?: number;
}

const SETTINGS: readonly SettingSpec[] = [
  { key: "ROBOMP_BOT_LOGIN", kind: "string" },
  { key: "ROBOMP_GIT_AUTHOR_NAME", kind: "string" },
  { key: "ROBOMP_GIT_AUTHOR_EMAIL", kind: "string" },
  { key: "ROBOMP_REPO_ALLOWLIST", kind: "csv" },
  { key: "ROBOMP_MAINTAINER_LOGINS", kind: "csv" },
  { key: "ROBOMP_REVIEWER_BOTS", kind: "csv" },
  { key: "ROBOMP_RATE_LIMIT_DEFAULT", kind: "integer", min: 0, max: 10_000 },
  { key: "ROBOMP_RATE_LIMIT_CONTRIBUTOR", kind: "integer", min: 0, max: 10_000 },
  { key: "ROBOMP_RATE_LIMIT_UNLIMITED", kind: "csv" },
  { key: "ROBOMP_RATE_LIMIT_WINDOW_SECONDS", kind: "integer", min: 1, max: 31_536_000 },
  { key: "ROBOMP_MODEL", kind: "string" },
  { key: "ROBOMP_PROVIDER", kind: "string" },
  { key: "ROBOMP_THINKING", kind: "string" },
  { key: "ROBOMP_MAX_CONCURRENCY", kind: "integer", min: 1, max: 32 },
  { key: "ROBOMP_TASK_TIMEOUT_SECONDS", kind: "integer", min: 60, max: 604_800 },
  { key: "ROBOMP_TASK_TIMEOUT_HARD_GRACE_SECONDS", kind: "integer", min: 0, max: 86_400 },
  { key: "ROBOMP_REQUEST_TIMEOUT_SECONDS", kind: "integer", min: 1, max: 86_400 },
  { key: "ROBOMP_EVENT_MAX_RETRIES", kind: "integer", min: 0, max: 100 },
  { key: "ROBOMP_EVENT_RETRY_DELAYS_SECONDS", kind: "csv" },
  { key: "ROBOMP_TASK_COMPLETION_MAX_REMINDERS", kind: "integer", min: 0, max: 100 },
  { key: "ROBOMP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS", kind: "integer", min: 0, max: 600 },
  { key: "ROBOMP_SHUTDOWN_KILL_TIMEOUT_SECONDS", kind: "integer", min: 0, max: 600 },
  { key: "ROBOMP_RECLAIM_WORKSPACE_CACHES", kind: "boolean" },
  { key: "ROBOMP_NATIVES_CACHE_ENABLED", kind: "boolean" },
  { key: "ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO", kind: "integer", min: 1, max: 1_000 },
  { key: "ROBOMP_NATIVES_CACHE_MAX_BYTES", kind: "integer", min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: "ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS", kind: "integer", min: 1, max: 604_800 },
  { key: "ROBOMP_PR_REVIEW_ENABLED", kind: "boolean" },
  { key: "ROBOMP_QUESTION_AUTOCLOSE_ENABLED", kind: "boolean" },
  { key: "ROBOMP_QUESTION_AUTOCLOSE_HOURS", kind: "integer", min: 1, max: 8_760 },
  { key: "ROBOMP_QUESTION_AUTOCLOSE_SCAN_SECONDS", kind: "integer", min: 1, max: 86_400 },
  { key: "ROBOMP_ISSUE_INDEX_SYNC_SECONDS", kind: "integer", min: 1, max: 604_800 },
  { key: "ROBOMP_RELEASE_SENTINEL_ENABLED", kind: "boolean" },
  { key: "ROBOMP_RELEASE_COMMIT_PREFIX", kind: "string" },
  { key: "ROBOMP_RELEASE_MAX_ROUNDS", kind: "integer", min: 1, max: 100 },
  { key: "ROBOMP_RELEASE_TASK_TIMEOUT_SECONDS", kind: "integer", min: 60, max: 604_800 },
  { key: "ROBOMP_RELEASE_MODEL", kind: "string" },
  { key: "ROBOMP_PUBLIC_HOST", kind: "host" },
  { key: "ROBOMP_PUBLIC_PORT", kind: "integer", min: 1, max: 65_535 },
] as const;

const SECRET_KEYS = new Set([
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "ROBOMP_GH_PROXY_HMAC_KEY",
  "ROBOMP_REPLAY_TOKEN",
]);
const SETTING_BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));

export interface RobompPaths {
  root: string;
  integration: string;
  envFile: string;
  composeFile: string;
  script: string;
}

export interface MutationResult extends Record<string, unknown> {
  schemaVersion: "persephone.robomp.mutation.v1";
  action: string;
  changed: boolean;
  restartRequired: boolean;
}

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RequestResult {
  ok: boolean;
  status: number | null;
  value: unknown;
  error?: string;
}

export function robompPaths(root = process.env.PERSEPHONE_REPO_ROOT || path.resolve(import.meta.dir, "..")): RobompPaths {
  const resolved = path.resolve(root);
  const integration = path.join(resolved, "integrations", "robomp");
  return {
    root: resolved,
    integration,
    envFile: path.join(integration, ".env"),
    composeFile: path.join(integration, "compose.yaml"),
    script: path.join(resolved, "scripts", "robomp.sh"),
  };
}

export function readSimpleEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]!] = decodeEnvValue(match[2]!);
  }
  return values;
}

export function renderEnvUpdates(source: string, updates: Readonly<Record<string, string | null>>): string {
  const pending = new Map(Object.entries(updates));
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[1]!)) {
      output.push(raw);
      continue;
    }
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = pending.get(key);
    pending.delete(key);
    if (value !== undefined && value !== null) output.push(`${key}=${encodeEnvValue(value)}`);
  }
  for (const [key, value] of [...pending.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (value !== null) output.push(`${key}=${encodeEnvValue(value)}`);
  }
  while (output.length > 1 && output.at(-1) === "") output.pop();
  return `${output.join("\n")}\n`;
}

export function normalizeConfigPatch(value: unknown): Record<string, string | null> {
  const patch = asRecord(value, "values");
  const updates: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const spec = SETTING_BY_KEY.get(key);
    if (!spec) throw new Error(`RoboOMP setting is not writable: ${key}`);
    updates[key] = normalizeSetting(raw, spec);
  }
  return updates;
}

export function normalizeSecretPatch(value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  const patch = asRecord(value, "secrets");
  const updates: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!SECRET_KEYS.has(key)) throw new Error(`RoboOMP secret is not writable: ${key}`);
    if (raw === null || raw === "") updates[key] = null;
    else if (typeof raw === "string" && !/[\r\n\0]/.test(raw)) updates[key] = raw;
    else throw new Error(`${key} must be a one-line string, empty string, or null`);
  }
  return updates;
}

export function writeEnvUpdates(file: string, updates: Readonly<Record<string, string | null>>): boolean {
  const source = existsSync(file) ? readFileSync(file, "utf8") : "# RoboOMP configuration\n";
  const rendered = renderEnvUpdates(source, updates);
  if (rendered === source) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, rendered, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  return true;
}

export async function robompWorkspaceSnapshot(
  options: { limit?: number; state?: "open" | "closed" | "all"; paths?: RobompPaths; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const paths = options.paths ?? robompPaths();
  const limit = boundedInteger(options.limit ?? DEFAULT_LIMIT, "limit", 1, 200);
  const state = options.state ?? "open";
  if (!new Set(["open", "closed", "all"]).has(state)) throw new Error("state must be open, closed, or all");
  const timeoutMs = boundedInteger(options.timeoutMs ?? 1_500, "timeout", 100, 30_000);
  const environment = readSimpleEnv(paths.envFile);
  const port = environment.ROBOMP_PUBLIC_PORT && /^\d+$/.test(environment.ROBOMP_PUBLIC_PORT)
    ? boundedInteger(Number(environment.ROBOMP_PUBLIC_PORT), "ROBOMP_PUBLIC_PORT", 1, 65_535)
    : 6543;
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = environment.ROBOMP_REPLAY_TOKEN || "";
  const headers = token ? { "X-Robomp-Replay-Token": token } : {};

  const [health, ready, status, logs, events, issues, releases, browse] = await Promise.all([
    request(`${baseUrl}/healthz`, {}, timeoutMs),
    request(`${baseUrl}/readyz`, {}, timeoutMs),
    request(`${baseUrl}/api/status`, {}, timeoutMs),
    request(`${baseUrl}/api/logs?limit=${limit}`, {}, timeoutMs),
    request(`${baseUrl}/events?limit=${limit}`, {}, timeoutMs),
    request(`${baseUrl}/issues?limit=${limit}`, {}, timeoutMs),
    request(`${baseUrl}/releases?limit=${limit}`, {}, timeoutMs),
    token
      ? request(`${baseUrl}/api/github/issues?state=${state}&limit=${limit}`, { headers }, timeoutMs)
      : Promise.resolve({ ok: false, status: null, value: null, error: "ROBOMP_REPLAY_TOKEN is not configured" }),
  ]);

  return {
    schemaVersion: "persephone.robomp.workspace.v1",
    generatedAt: new Date().toISOString(),
    configured: existsSync(paths.envFile),
    endpoint: baseUrl,
    version: versionSnapshot(environment, paths),
    configuration: publicConfiguration(environment),
    secrets: [...SECRET_KEYS].sort().map((name) => ({ name, configured: Boolean(environment[name]) })),
    services: composeSnapshot(paths),
    runtime: { health, ready, status, logs, events, issues, releases, browse },
    capabilities: {
      reads: ["workspace", "issue", "events", "issues", "releases", "logs", "repository browse"],
      actions: [
        "configuration.patch",
        "trigger.triage",
        "trigger.retry",
        "trigger.cancel",
        "issue.cleanup",
        "audit.dream",
        "timer.enable",
        "timer.disable",
        "version.sync",
      ],
    },
  };
}

export function inspectIssueWorkspace(issue: string, limit = DEFAULT_LIMIT, paths = robompPaths()): unknown {
  validateIssueReference(issue);
  const bounded = boundedInteger(limit, "limit", 1, 200);
  requireRuntimeConfig(paths);
  const result = composeCommand(paths, [
    "exec",
    "-T",
    "robomp",
    "python",
    "/usr/local/libexec/persephone-robomp-workspace-inspect",
    issue,
    "--limit",
    String(bounded),
  ], 30_000);
  if (!result.ok) throw new Error(result.stderr || "RoboOMP workspace inspection failed");
  return JSON.parse(result.stdout) as unknown;
}

export async function applyRobompMutation(value: unknown, paths = robompPaths()): Promise<MutationResult> {
  const payload = asRecord(value, "RoboOMP mutation");
  if (payload.version !== 1) throw new Error("RoboOMP mutation version must be 1");
  const action = requiredString(payload.action, "action", 80);

  if (action === "configuration.patch") {
    const updates = normalizeConfigPatch(payload.values);
    const secretUpdates = normalizeSecretPatch(payload.secrets);
    const changed = writeEnvUpdates(paths.envFile, { ...updates, ...secretUpdates });
    return mutationResult(action, changed, changed, {
      updatedSettings: Object.keys(updates).sort(),
      updatedSecretNames: Object.entries(secretUpdates).filter(([, item]) => item !== null).map(([name]) => name).sort(),
      removedSecretNames: Object.entries(secretUpdates).filter(([, item]) => item === null).map(([name]) => name).sort(),
    });
  }

  if (action === "version.sync") {
    const requested = payload.ompVersion === undefined ? undefined : requiredVersion(payload.ompVersion);
    const pin = syncVersion(paths, requested);
    return mutationResult(action, pin.changed, pin.changed, { version: pin.version, commit: pin.commit });
  }

  if (action === "trigger.triage") {
    const issue = requiredIssue(payload.issue);
    return remoteMutation(action, "/api/trigger", { mode: "triage", issue }, paths);
  }
  if (action === "trigger.retry") {
    const body: Record<string, string> = { mode: "retry" };
    if (payload.issue !== undefined) body.issue = requiredIssue(payload.issue);
    else body.delivery_id = requiredString(payload.deliveryId, "deliveryId", 500);
    return remoteMutation(action, "/api/trigger", body, paths);
  }
  if (action === "trigger.cancel") {
    const deliveryId = requiredString(payload.deliveryId, "deliveryId", 500);
    return remoteMutation(action, "/api/cancel", { delivery_id: deliveryId }, paths);
  }
  if (action === "issue.cleanup") {
    const issue = requiredIssue(payload.issue);
    runOwnerScript(paths, ["cleanup", issue], 120_000);
    return mutationResult(action, true, false, { issue });
  }
  if (action === "audit.dream") {
    const repository = requiredRepository(payload.repository);
    const focus = payload.focus === undefined ? "" : requiredString(payload.focus, "focus", 2_000);
    runOwnerScript(paths, focus ? ["dream", repository, focus] : ["dream", repository], 120_000);
    return mutationResult(action, true, false, { repository });
  }
  if (action === "timer.enable") {
    const repository = requiredRepository(payload.repository);
    const calendar = payload.calendar === undefined ? "Sun *-*-* 05:00:00" : requiredString(payload.calendar, "calendar", 500);
    runOwnerScript(paths, ["dream-timer-enable", repository, calendar], 30_000);
    return mutationResult(action, true, false, { repository, calendar });
  }
  if (action === "timer.disable") {
    const repository = requiredRepository(payload.repository);
    runOwnerScript(paths, ["dream-timer-disable", repository], 30_000);
    return mutationResult(action, true, false, { repository });
  }
  throw new Error(`Unsupported RoboOMP mutation action: ${action}`);
}

export function syncVersion(paths = robompPaths(), requestedVersion?: string): { changed: boolean; version: string; commit: string } {
  const version = requestedVersion ?? installedOmpVersion();
  const commit = resolveTagCommit(version);
  const changed = writeEnvUpdates(paths.envFile, { OMP_VERSION: version, OMP_COMMIT: commit });
  return { changed, version, commit };
}

function versionSnapshot(environment: Record<string, string>, paths: RobompPaths): Record<string, unknown> {
  const host = tryInstalledOmpVersion();
  const tracked = readSimpleEnv(path.join(paths.integration, ".env.example"));
  return {
    runtime: { version: environment.OMP_VERSION || null, commit: environment.OMP_COMMIT || null },
    tracked: { version: tracked.OMP_VERSION || null, commit: tracked.OMP_COMMIT || null },
    host: { version: host },
    drift: Boolean(host && environment.OMP_VERSION && host !== environment.OMP_VERSION),
  };
}

function publicConfiguration(environment: Record<string, string>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const setting of SETTINGS) result[setting.key] = environment[setting.key] || null;
  return result;
}

function composeSnapshot(paths: RobompPaths): Record<string, unknown> {
  if (!existsSync(paths.envFile)) return { ok: false, error: "RoboOMP configuration does not exist" };
  const result = composeCommand(paths, ["ps", "--format", "json"], 5_000);
  if (!result.ok) return { ok: false, error: result.stderr || "docker compose ps failed" };
  const rows = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) as unknown; } catch { return line; }
  });
  return { ok: true, containers: rows };
}

async function remoteMutation(
  action: string,
  route: string,
  body: Record<string, string>,
  paths: RobompPaths,
): Promise<MutationResult> {
  const environment = requireRuntimeConfig(paths);
  const token = environment.ROBOMP_REPLAY_TOKEN;
  if (!token) throw new Error("ROBOMP_REPLAY_TOKEN is not configured");
  const port = boundedInteger(Number(environment.ROBOMP_PUBLIC_PORT || 6543), "ROBOMP_PUBLIC_PORT", 1, 65_535);
  const response = await request(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Robomp-Replay-Token": token },
    body: JSON.stringify(body),
  }, 30_000);
  if (!response.ok) throw new Error(response.error || `RoboOMP returned HTTP ${response.status ?? "unknown"}`);
  return mutationResult(action, true, false, { response: response.value });
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<RequestResult> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = (await response.text()).slice(0, MAX_HTTP_BODY_BYTES);
    let value: unknown = text;
    if (text) {
      try { value = JSON.parse(text) as unknown; } catch { /* retain text */ }
    } else value = null;
    return response.ok
      ? { ok: true, status: response.status, value }
      : { ok: false, status: response.status, value, error: responseError(value, response.status) };
  } catch (error) {
    return { ok: false, status: null, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function responseError(value: unknown, status: number): string {
  if (typeof value === "string" && value.trim()) return `HTTP ${status}: ${value.slice(0, 1_000)}`;
  if (value && typeof value === "object" && "detail" in value) return `HTTP ${status}: ${String((value as { detail: unknown }).detail)}`;
  return `HTTP ${status}`;
}

function composeCommand(paths: RobompPaths, args: string[], timeout: number): CommandResult {
  return command("docker", [
    "compose",
    "--project-directory", paths.integration,
    "--env-file", paths.envFile,
    "-f", paths.composeFile,
    ...args,
  ], paths.root, timeout);
}

function runOwnerScript(paths: RobompPaths, args: string[], timeout: number): void {
  const result = command(paths.script, args, paths.root, timeout);
  if (!result.ok) throw new Error(result.stderr || `${args[0] || "RoboOMP action"} failed`);
}

function command(executable: string, args: string[], cwd: string, timeout: number): CommandResult {
  const result: SpawnSyncReturns<string> = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OTEL_SDK_DISABLED: "true", DO_NOT_TRACK: "1" },
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout?.trim() || "",
    stderr: result.error?.message || result.stderr?.trim() || "",
  };
}

function installedOmpVersion(): string {
  const version = tryInstalledOmpVersion();
  if (!version) throw new Error("Unable to read the host OMP version from `omp --version`");
  return version;
}

function tryInstalledOmpVersion(): string | null {
  const result = command("omp", ["--version"], process.cwd(), 5_000);
  if (!result.ok) return null;
  const match = result.stdout.match(/(?:^|\s)omp\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)/);
  return match?.[1] || null;
}

function resolveTagCommit(version: string): string {
  const result = command("git", ["ls-remote", "--refs", OWNER_REPOSITORY, `refs/tags/v${version}`], process.cwd(), 30_000);
  if (!result.ok) throw new Error(result.stderr || `Unable to resolve OMP v${version}`);
  const match = result.stdout.match(/^([0-9a-f]{40})\s+/m);
  if (!match) throw new Error(`OMP tag v${version} was not found in ${OWNER_REPOSITORY}`);
  return match[1]!;
}

function requireRuntimeConfig(paths: RobompPaths): Record<string, string> {
  if (!existsSync(paths.envFile)) throw new Error("Run `persephone git-agent init` first");
  const mode = statSync(paths.envFile).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${paths.envFile} must have mode 600`);
  return readSimpleEnv(paths.envFile);
}

function mutationResult(
  action: string,
  changed: boolean,
  restartRequired: boolean,
  details: Record<string, unknown> = {},
): MutationResult {
  return { schemaVersion: "persephone.robomp.mutation.v1", action, changed, restartRequired, ...details };
}

function normalizeSetting(value: unknown, spec: SettingSpec): string | null {
  if (value === null || value === "") return null;
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${spec.key} must be a boolean`);
    return value ? "true" : "false";
  }
  if (spec.kind === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${spec.key} must be an integer`);
    return String(boundedInteger(value, spec.key, spec.min ?? Number.MIN_SAFE_INTEGER, spec.max ?? Number.MAX_SAFE_INTEGER));
  }
  if (spec.kind === "csv") {
    if (Array.isArray(value)) {
      if (!value.every((item) => typeof item === "string" && item.trim() && !/[,\r\n\0]/.test(item))) {
        throw new Error(`${spec.key} must be an array of non-empty comma-free strings`);
      }
      return value.map((item) => (item as string).trim()).join(",");
    }
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`${spec.key} must be a one-line CSV string or array`);
    return value.split(",").map((item) => item.trim()).filter(Boolean).join(",");
  }
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`${spec.key} must be a one-line string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (spec.kind === "host" && !new Set(["127.0.0.1", "localhost", "::1"]).has(normalized)) {
    throw new Error("ROBOMP_PUBLIC_HOST must remain loopback-only");
  }
  return normalized;
}

function decodeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function encodeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+,%= -]*$/.test(value) && !/^\s|\s$/.test(value) ? value : JSON.stringify(value);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0]/.test(value)) {
    throw new Error(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function requiredVersion(value: unknown): string {
  const version = requiredString(value, "version", 80);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("version must be a semantic version");
  return version;
}

function requiredIssue(value: unknown): string {
  const issue = requiredString(value, "issue", 500);
  validateIssueReference(issue);
  return issue;
}

function validateIssueReference(value: string): void {
  if (!ISSUE_REFERENCE.test(value)) throw new Error("issue must be owner/repository#123");
}

function requiredRepository(value: unknown): string {
  const repository = requiredString(value, "repository", 400);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  return repository;
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return value;
}

function readMutation(file: string): unknown {
  const size = statSync(file).size;
  if (size < 2 || size > MAX_MUTATION_BYTES) throw new Error(`Mutation must contain 2-${MAX_MUTATION_BYTES} bytes`);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [commandName = "show", ...args] = process.argv.slice(2);
  if (commandName === "show") {
    const limit = Number(option(args, "--limit") || DEFAULT_LIMIT);
    const state = (option(args, "--state") || "open") as "open" | "closed" | "all";
    console.log(JSON.stringify(await robompWorkspaceSnapshot({ limit, state }), null, 2));
    return;
  }
  if (commandName === "inspect") {
    const issue = args.find((item) => !item.startsWith("--"));
    if (!issue) throw new Error("Usage: persephone git-agent workspace inspect owner/repo#123 [--limit N]");
    console.log(JSON.stringify(inspectIssueWorkspace(issue, Number(option(args, "--limit") || DEFAULT_LIMIT)), null, 2));
    return;
  }
  if (commandName === "mutate") {
    const consume = args.includes("--consume");
    const files = args.filter((item) => item !== "--consume");
    if (files.length !== 1 || !files[0]) throw new Error("Usage: persephone git-agent workspace mutate FILE.json [--consume]");
    const file = path.resolve(files[0]);
    try {
      console.log(JSON.stringify(await applyRobompMutation(readMutation(file)), null, 2));
    } finally {
      if (consume) rmSync(file, { force: true });
    }
    return;
  }
  if (commandName === "sync-version") {
    const requested = args[0] ? requiredVersion(args[0]) : undefined;
    console.log(JSON.stringify({ schemaVersion: "persephone.robomp.version.v1", ...syncVersion(robompPaths(), requested) }, null, 2));
    return;
  }
  throw new Error("Usage: workspace show|inspect|mutate|sync-version");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

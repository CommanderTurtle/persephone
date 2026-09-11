import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSeq, parseDocument } from "yaml";

import { ompAgentDir, ompHome } from "./paths.ts";
import type { PersephoneConfig } from "./types.ts";

export type OmpReconcileStatus = "integrated" | "unchanged" | "missing" | "failed";

export interface OmpReconcileResult {
  name: string;
  status: OmpReconcileStatus;
  detail: string;
}

export interface OmpReconcileCheck {
  check: string;
  ok: boolean;
  detail: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type OmpCommandRunner = (args: string[]) => CommandResult;

export interface OwnedProfile {
  profile: string;
  agentDir: string;
  localflame: boolean;
  camofox: boolean;
  imageModels: boolean;
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  enabledServers?: string[];
  disabledServers?: string[];
}

const EFFORT_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max)$/;

/**
 * Repair only the OMP state Persephone positively owns. Every value is read
 * through OMP first; a correct value is never rewritten.
 */
export function reconcileOmp(config: PersephoneConfig): OmpReconcileResult[] {
  const executable = resolveExecutable(config.omp.command);
  if (!executable) {
    return [{ name: "omp-reconcile", status: "missing", detail: `OMP command was not found: ${config.omp.command}` }];
  }
  const run = createRunner(executable);
  const results: OmpReconcileResult[] = [];
  for (const owned of discoverOwnedProfiles(config)) {
    if (owned.localflame) {
      results.push(reconcileSetting(run, owned.profile, "web_search.enabled", () => true));
      results.push(reconcileSetting(run, owned.profile, "providers.webSearchOrder", (current) =>
        prependUniqueString(current, "firecrawl", "providers.webSearchOrder")));
      results.push(reconcileSetting(run, owned.profile, "providers.webSearchExclude", (current) =>
        removeString(current, "firecrawl", "providers.webSearchExclude")));
    }
    if (owned.camofox && config.web.camofox.replaceNativeBrowser) {
      results.push(reconcileSetting(run, owned.profile, "browser.enabled", () => false));
    }
    if (owned.imageModels && config.omp.imageModels.length > 0) {
      results.push(reconcileSetting(run, owned.profile, "images.autoResize", () => true));
      results.push(reconcileSetting(run, owned.profile, "images.blockImages", () => false));
      results.push(reconcileImageModels(run, owned, config.omp.imageModels));
    }
  }
  return results;
}

/** Read-only counterpart used by `persephone doctor`. */
export function inspectOmpReconciliation(config: PersephoneConfig): OmpReconcileCheck[] {
  const executable = resolveExecutable(config.omp.command);
  if (!executable) {
    return [{ check: "omp-reconcile", ok: false, detail: `OMP command was not found: ${config.omp.command}` }];
  }
  const run = createRunner(executable);
  const checks: OmpReconcileCheck[] = [];
  for (const owned of discoverOwnedProfiles(config)) {
    if (owned.localflame) {
      checks.push(inspectSetting(run, owned.profile, "web_search.enabled", () => true));
      checks.push(inspectSetting(run, owned.profile, "providers.webSearchOrder", (current) =>
        prependUniqueString(current, "firecrawl", "providers.webSearchOrder")));
      checks.push(inspectSetting(run, owned.profile, "providers.webSearchExclude", (current) =>
        removeString(current, "firecrawl", "providers.webSearchExclude")));
    }
    if (owned.camofox && config.web.camofox.replaceNativeBrowser) {
      checks.push(inspectSetting(run, owned.profile, "browser.enabled", () => false));
    }
    if (owned.imageModels && config.omp.imageModels.length > 0) {
      checks.push(inspectSetting(run, owned.profile, "images.autoResize", () => true));
      checks.push(inspectSetting(run, owned.profile, "images.blockImages", () => false));
      checks.push(inspectImageModels(run, owned, config.omp.imageModels));
    }
  }
  return checks;
}

export function discoverOwnedProfiles(config: PersephoneConfig): OwnedProfile[] {
  const configuredProfiles = new Set([config.omp.interactiveProfile, config.omp.profile]);
  const profiles = new Map<string, string>();
  for (const profile of configuredProfiles) profiles.set(profile, ompAgentDir(profile));

  const profilesRoot = path.join(ompHome(), "profiles");
  if (existsSync(profilesRoot)) {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) profiles.set(entry.name, ompAgentDir(entry.name));
    }
  }
  profiles.set("default", ompAgentDir("default"));

  return [...profiles]
    .map(([profile, agentDir]) => {
      const mcp = readMcpConfig(path.join(agentDir, "mcp.json"));
      return {
        profile,
        agentDir,
        localflame: config.integrations.localflame && activeMcp(mcp, "localflame"),
        camofox: config.integrations.camofox && activeMcp(mcp, "camofox"),
        imageModels: configuredProfiles.has(profile),
      };
    })
    .filter((entry) => entry.localflame || entry.camofox || entry.imageModels)
    .sort((left, right) => profileSort(left.profile, right.profile));
}

function createRunner(executable: string): OmpCommandRunner {
  return (args) => {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    });
    return {
      status: result.status,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || result.error?.message || ""),
    };
  };
}

function reconcileSetting(
  run: OmpCommandRunner,
  profile: string,
  key: string,
  desired: (current: unknown) => unknown,
): OmpReconcileResult {
  const read = readSetting(run, profile, key);
  const name = `omp-setting:${profile}:${key}`;
  if (!read.ok) return { name, status: "failed", detail: read.error };
  let expected: unknown;
  try {
    expected = desired(read.value);
  } catch (error) {
    return { name, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (sameValue(read.value, expected)) {
    return { name, status: "unchanged", detail: `Already ${formatValue(expected)}` };
  }
  const command = run(profileArgs(profile, "set", key, serializeSetting(expected)));
  return command.status === 0
    ? { name, status: "integrated", detail: `${formatValue(read.value)} -> ${formatValue(expected)}` }
    : { name, status: "failed", detail: cleanCommandError(command) };
}

function inspectSetting(
  run: OmpCommandRunner,
  profile: string,
  key: string,
  desired: (current: unknown) => unknown,
): OmpReconcileCheck {
  const read = readSetting(run, profile, key);
  const check = `omp-setting:${profile}:${key}`;
  if (!read.ok) return { check, ok: false, detail: read.error };
  try {
    const expected = desired(read.value);
    return {
      check,
      ok: sameValue(read.value, expected),
      detail: sameValue(read.value, expected)
        ? formatValue(expected)
        : `current ${formatValue(read.value)}; expected ${formatValue(expected)}`,
    };
  } catch (error) {
    return { check, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function readSetting(
  run: OmpCommandRunner,
  profile: string,
  key: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const command = run(profileArgs(profile, "get", key));
  if (command.status !== 0) return { ok: false, error: cleanCommandError(command) };
  const value = command.stdout.trim();
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: true, value };
  }
}

function profileArgs(profile: string, action: "get" | "set", key: string, value?: string): string[] {
  const command = ["config", action, key, ...(value === undefined ? [] : [value])];
  return profile === "default" ? command : ["--profile", profile, ...command];
}

function prependUniqueString(current: unknown, value: string, key: string): string[] {
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} is not a string array; refusing to replace it`);
  }
  return [value, ...current.filter((entry) => entry !== value)];
}

function removeString(current: unknown, value: string, key: string): string[] {
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} is not a string array; refusing to replace it`);
  }
  return current.filter((entry) => entry !== value);
}

function reconcileImageModels(
  run: OmpCommandRunner,
  owned: OwnedProfile,
  declared: string[],
): OmpReconcileResult {
  const name = `omp-models:${owned.profile}:image-input`;
  const resolved = resolveImageModels(run, owned.profile, declared);
  if (!resolved.ok) return { name, status: "failed", detail: resolved.error };
  if (resolved.models.length === 0) return { name, status: "unchanged", detail: "No matching image model selectors" };
  try {
    const patch = patchImageModels(owned.agentDir, resolved.models, true);
    return {
      name,
      status: patch.changed ? "integrated" : "unchanged",
      detail: `${patch.file}: ${resolved.models.join(", ")}${patch.changed ? " marked text+image" : " already text+image"}`,
    };
  } catch (error) {
    return { name, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

function inspectImageModels(
  run: OmpCommandRunner,
  owned: OwnedProfile,
  declared: string[],
): OmpReconcileCheck {
  const check = `omp-models:${owned.profile}:image-input`;
  const resolved = resolveImageModels(run, owned.profile, declared);
  if (!resolved.ok) return { check, ok: false, detail: resolved.error };
  if (resolved.models.length === 0) return { check, ok: true, detail: "No matching image model selectors" };
  try {
    const patch = patchImageModels(owned.agentDir, resolved.models, false);
    return {
      check,
      ok: !patch.changed,
      detail: !patch.changed
        ? `${patch.file}: ${resolved.models.join(", ")} accept text+image`
        : `${patch.file}: missing text+image capability for ${resolved.models.join(", ")}`,
    };
  } catch (error) {
    return { check, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function resolveImageModels(
  run: OmpCommandRunner,
  profile: string,
  declared: string[],
): { ok: true; models: string[] } | { ok: false; error: string } {
  let roles: Record<string, string> | null = null;
  const selectors: string[] = [];
  for (const item of declared) {
    if (!item.startsWith("@")) {
      selectors.push(item);
      continue;
    }
    if (!roles) {
      const read = readSetting(run, profile, "modelRoles");
      if (!read.ok) return read;
      if (!isRecord(read.value)) return { ok: false, error: `modelRoles for ${profile} is not an object` };
      roles = Object.fromEntries(
        Object.entries(read.value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
    const selector = roles[item.slice(1)];
    if (selector) selectors.push(selector);
  }
  const models = [...new Set(selectors.map(normalizeModelSelector).filter((value): value is string => Boolean(value)))];
  return { ok: true, models };
}

function normalizeModelSelector(selector: string): string | null {
  const normalized = selector.trim().replace(EFFORT_SUFFIX, "");
  const slash = normalized.indexOf("/");
  if (slash < 1 || slash === normalized.length - 1) return null;
  return normalized;
}

function patchImageModels(agentDir: string, selectors: string[], write: boolean): { file: string; changed: boolean } {
  const file = modelConfigPath(agentDir);
  const source = existsSync(file) ? readFileSync(file, "utf8") : "providers:\n";
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw new Error(`Refusing to edit malformed OMP model config ${file}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  let changed = false;
  for (const selector of selectors) {
    const slash = selector.indexOf("/");
    const provider = selector.slice(0, slash);
    const model = selector.slice(slash + 1);
    const keyPath = ["providers", provider, "modelOverrides", model, "input"];
    const current = document.getIn(keyPath, true);
    const values = isSeq(current)
      ? current.items.map((item) => String((item as { value?: unknown }).value ?? item))
      : [];
    if (values.includes("text") && values.includes("image")) continue;
    document.setIn(keyPath, ["text", "image"]);
    changed = true;
  }
  if (write && changed) writeAtomic(file, String(document));
  return { file, changed };
}

function modelConfigPath(agentDir: string): string {
  for (const name of ["models.yml", "models.yaml"]) {
    const file = path.join(agentDir, name);
    if (existsSync(file)) return file;
  }
  return path.join(agentDir, "models.yml");
}

function writeAtomic(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(temporary, value, { mode });
  renameSync(temporary, file);
}

function readMcpConfig(file: string): McpConfig | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed as McpConfig : null;
  } catch {
    return null;
  }
}

function activeMcp(config: McpConfig | null, name: string): boolean {
  if (!config || !isRecord(config.mcpServers) || !Object.hasOwn(config.mcpServers, name)) return false;
  if (Array.isArray(config.disabledServers) && config.disabledServers.includes(name)) return false;
  return !Array.isArray(config.enabledServers) || config.enabledServers.length === 0 || config.enabledServers.includes(name);
}

function resolveExecutable(command: string): string | null {
  if (path.isAbsolute(command) && existsSync(command)) return command;
  return Bun.which(command);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function serializeSetting(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatValue(value: unknown): string {
  return JSON.stringify(value);
}

function cleanCommandError(command: CommandResult): string {
  return `${command.stdout}\n${command.stderr}`.trim() || `OMP exited ${command.status ?? "without a status"}`;
}

function profileSort(left: string, right: string): number {
  if (left === "default") return right === "default" ? 0 : -1;
  if (right === "default") return 1;
  return left.localeCompare(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

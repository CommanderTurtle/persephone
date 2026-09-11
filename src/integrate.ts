import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverOwnedProfiles, reconcileOmp } from "./omp-reconcile.ts";
import { ompAgentDir, repoRoot, stateRoot } from "./paths.ts";
import type { PersephoneConfig } from "./types.ts";

interface McpConfig {
  $schema?: string;
  mcpServers?: Record<string, unknown>;
  disabledServers?: string[];
  enabledServers?: string[];
  [key: string]: unknown;
}

export interface IntegrationResult {
  name: string;
  status: "integrated" | "unchanged" | "missing" | "failed";
  detail: string;
}

const MCP_SCHEMA = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
const MISSING = "__persephone_missing__";
const BUILT_IN_MODEL_ROLES = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
] as const;

interface IntegrationBackup {
  version: 1;
  mcp: Record<string, Record<string, unknown>>;
  managedFiles: string[];
}

export function integrate(config: PersephoneConfig): IntegrationResult[] {
  const results: IntegrationResult[] = [];
  const omp = resolveExecutable(config.omp.command);
  if (!omp) throw new Error(`OMP command was not found: ${config.omp.command}`);

  linkPersephonePlugin(omp, "default", results);

  const interactiveAgent = ompAgentDir(config.omp.interactiveProfile);
  const workerAgent = ompAgentDir(config.omp.profile);
  const modelRoles = resolveLocalModelRoles(omp, config.omp.interactiveProfile, config);
  configureInteractiveProfile(omp, config.omp.interactiveProfile, config, modelRoles, results);
  if (interactiveAgent !== workerAgent) {
    releaseManagedProfileSettings(workerAgent);
    synchronizeProfileConfiguration(interactiveAgent, workerAgent);
  }
  configureWorkerProfile(omp, config.omp.profile, config, modelRoles, results);

  const publicEntries: Record<string, unknown> = {};

  for (const profile of new Set([config.omp.interactiveProfile, config.omp.profile])) {
    const publicFile = path.join(ompAgentDir(profile), "mcp.json");
    rememberMcp(publicFile, Object.keys(publicEntries));
    const changed = mergeMcp(publicFile, publicEntries);
    results.push({ name: `omp-mcp:${profile}`, status: changed ? "integrated" : "unchanged", detail: publicFile });
  }
  releaseDelegatedMcpOwnership([
    "context-mode",
    "retrieval",
    "localflame",
    "librarian",
    "librarian-okf",
    "camofox",
    "codebase-memory",
  ]);
  if (config.integrations.codebaseMemory) {
    integrateCodebaseMemory(config, results);
  }
  if (config.integrations.contextMode) {
    integrateContextMode(config, results);
  }
  if (config.integrations.camofox) {
    integrateCamofox(config, results);
  }
  if (config.integrations.retrieval) {
    integrateRetrieval(config, results);
  }
  if (config.integrations.localflame) {
    integrateLocalflame(config, results);
  }
  if (config.integrations.librarian) {
    integrateLibrarian(config, results);
  }
  for (const owned of discoverOwnedProfiles(config)) {
    if (owned.profile !== "default") linkPersephonePlugin(omp, owned.profile, results);
  }
  results.push(...reconcileOmp(config));
  refreshManagedProfileConfig(workerAgent);
  return results;
}

function linkPersephonePlugin(omp: string, profile: string, results: IntegrationResult[]): void {
  const profileArgs = profile === "default" ? [] : ["--profile", profile];
  const listed = spawnSync(omp, [...profileArgs, "plugin", "list", "--json"], {
    encoding: "utf8",
    env: childEnvironment(),
  });
  if (listed.status === 0 && pluginPointsToRepository(listed.stdout)) {
    results.push({
      name: `persephone-plugin:${profile}`,
      status: "unchanged",
      detail: "Native OMP plugin link already points to this repository",
    });
    return;
  }
  const args = profile === "default"
    ? ["plugin", "link", repoRoot()]
    : ["--profile", profile, "plugin", "link", repoRoot()];
  const linked = spawnSync(omp, args, { encoding: "utf8", env: childEnvironment() });
  results.push({
    name: `persephone-plugin:${profile}`,
    status: linked.status === 0 ? "integrated" : "failed",
    detail: linked.status === 0 ? "Linked through native omp plugin link" : cleanOutput(linked),
  });
}

function pluginPointsToRepository(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { npm?: Array<{ name?: unknown; path?: unknown; enabled?: unknown }> };
    const plugin = parsed.npm?.find((entry) => entry.name === "@commanderturtle/persephone" && entry.enabled !== false);
    return typeof plugin?.path === "string"
      && existsSync(plugin.path)
      && realpathSync(plugin.path) === realpathSync(repoRoot());
  } catch {
    return false;
  }
}

function integrateCodebaseMemory(
  config: PersephoneConfig,
  results: IntegrationResult[],
): void {
  const root = path.join(config.integrations.servicesRoot, "codebase-memory-mcp");
  const installer = path.join(root, "integrate-local.sh");
  if (!existsSync(installer)) {
    results.push({ name: "codebase-memory", status: "missing", detail: installer });
    return;
  }

  const command = spawnSync("bash", [installer, "--target", "omp"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: childEnvironment(),
  });
  results.push({
    name: "codebase-memory",
    status: command.status === 0 ? "integrated" : "failed",
    detail: command.status === 0
      ? `Applied ${installer} --target omp`
      : cleanOutput(command),
  });
}

function integrateContextMode(
  config: PersephoneConfig,
  results: IntegrationResult[],
): void {
  const root = path.join(config.integrations.servicesRoot, "context-mode");
  const installer = path.join(root, "integrate.sh");
  if (!existsSync(installer)) {
    results.push({ name: "context-mode", status: "missing", detail: installer });
    return;
  }

  const command = spawnSync("bash", [installer, "--target", "omp"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: childEnvironment(),
  });
  results.push({
    name: "context-mode",
    status: command.status === 0 ? "integrated" : "failed",
    detail: command.status === 0
      ? `Applied ${installer} --target omp`
      : cleanOutput(command),
  });
}

function integrateCamofox(
  config: PersephoneConfig,
  results: IntegrationResult[],
): void {
  const root = path.join(config.integrations.servicesRoot, "camofox-mcp");
  const installer = path.join(root, "integrate.sh");
  if (!existsSync(installer)) {
    results.push({ name: "camofox", status: "missing", detail: installer });
    return;
  }

  const apiKey = process.env[config.web.camofox.apiKeyEnv]?.trim();
  const command = spawnSync("bash", [installer, "--target", "omp"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...childEnvironment(),
      CAMOFOX_URL: config.web.camofox.url,
      ...(apiKey ? { CAMOFOX_API_KEY: apiKey } : {}),
    },
  });
  results.push({
    name: "camofox",
    status: command.status === 0 ? "integrated" : "failed",
    detail: command.status === 0
      ? `Applied ${installer} --target omp`
      : cleanOutput(command),
  });
}

function integrateRetrieval(
  config: PersephoneConfig,
  results: IntegrationResult[],
): void {
  const root = path.join(config.integrations.servicesRoot, "retrieval");
  const installer = path.join(root, "integrate.sh");
  if (!existsSync(installer)) {
    results.push({ name: "retrieval", status: "missing", detail: installer });
    return;
  }

  const command = spawnSync("bash", [installer], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: childEnvironment(),
  });
  results.push({
    name: "retrieval",
    status: command.status === 0 ? "integrated" : "failed",
    detail: command.status === 0
      ? `Applied ${installer}`
      : cleanOutput(command),
  });
}

function integrateLocalflame(
  config: PersephoneConfig,
  results: IntegrationResult[],
): void {
  const root = config.integrations.localflameRoot;
  const installer = path.join(root, "install.sh");
  if (!existsSync(installer)) {
    results.push({ name: "localflame", status: "missing", detail: installer });
    return;
  }

  const apiKey = process.env[config.web.firecrawl.apiKeyEnv]?.trim();
  const command = spawnSync("bash", [installer, "--target", "omp"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...childEnvironment(),
      LOCALFLAME_BASE_URL: config.web.firecrawl.url,
      ...(apiKey ? { FIRECRAWL_API_KEY: apiKey } : {}),
    },
  });
  results.push({
    name: "localflame",
    status: command.status === 0 ? "integrated" : "failed",
    detail: command.status === 0
      ? `Applied ${installer} --target omp`
      : cleanOutput(command),
  });
}

function integrateLibrarian(
  config: PersephoneConfig,
  results: IntegrationResult[],
): void {
  const root = path.join(config.integrations.servicesRoot, "librarian");
  const installer = path.join(root, "integrate.sh");
  if (!existsSync(installer)) {
    results.push({ name: "librarian", status: "missing", detail: installer });
    return;
  }

  const command = spawnSync("bash", [installer], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: childEnvironment(),
  });
  results.push({
    name: "librarian",
    status: command.status === 0 ? "integrated" : "failed",
    detail: command.status === 0
      ? `Applied ${installer}`
      : cleanOutput(command),
  });
}

function configureInteractiveProfile(
  omp: string,
  profile: string,
  config: PersephoneConfig,
  modelRoles: Record<string, string> | null,
  results: IntegrationResult[],
): void {
  const skills = activeSkillDirectories(config, true);
  const values: Array<readonly [string, string]> = [
    ["advisor.enabled", "true"],
    ["task.agentAdvisor", JSON.stringify({ task: "off" })],
    ["advisor.syncBacklog", "1"],
    ["advisor.immuneTurns", "3"],
    ["task.maxConcurrency", "4"],
    ["task.maxRecursionDepth", "2"],
    ["task.batch", "true"],
    ["memory.backend", "mnemopi"],
    ["mnemopi.scoping", "per-project"],
    ["mnemopi.autoRecall", "true"],
    ["mnemopi.autoRetain", "true"],
    ["mnemopi.llmMode", "smol"],
    ["mnemopi.enhancedRecall", "true"],
    ["mnemopi.polyphonicRecall", "false"],
    ["mnemopi.proactiveLinking", "false"],
    ["mnemopi.injectionTokenLimit", "2000"],
    ["mnemopi.recallLimit", "6"],
    ["compaction.methodOrder", JSON.stringify(["snapcompact", "soft"])],
    ["compaction.remoteStreamingV2Enabled", "false"],
    ["images.describeForTextModels", "true"],
    ["exa.enabled", "false"],
    ["retry.modelFallback", "false"],
    ["startup.checkUpdate", "false"],
    ["marketplace.autoUpdate", "off"],
    ["dev.autoqa", "false"],
    ["providers.fetch", "native"],
    ["tools.xdev", "true"],
    ["features.unexpectedStopDetection", "smart"],
    ["skills.enableSkillCommands", "true"],
    ["skills.customDirectories", JSON.stringify(skills)],
  ];
  if (modelRoles) values.unshift(["modelRoles", JSON.stringify(modelRoles)]);
  configureProfile(omp, profile, values, results, `interactive-profile:${profile}`);
}

function configureWorkerProfile(
  omp: string,
  profile: string,
  config: PersephoneConfig,
  modelRoles: Record<string, string> | null,
  results: IntegrationResult[],
  resultName = `worker-profile:${profile}`,
): void {
  const skills = activeSkillDirectories(config, false);
  const values: Array<readonly [string, string]> = [
    ["advisor.enabled", "false"],
    ["task.agentAdvisor", JSON.stringify({ task: "off" })],
    ["async.enabled", "false"],
    ["task.maxConcurrency", "1"],
    ["task.maxRecursionDepth", "1"],
    ["task.batch", "true"],
    ["memory.backend", "off"],
    ["compaction.methodOrder", JSON.stringify(["snapcompact", "soft"])],
    ["compaction.remoteStreamingV2Enabled", "false"],
    ["images.describeForTextModels", "true"],
    ["exa.enabled", "false"],
    ["retry.modelFallback", "false"],
    ["startup.checkUpdate", "false"],
    ["marketplace.autoUpdate", "off"],
    ["dev.autoqa", "false"],
    ["providers.fetch", "native"],
    ["tools.xdev", "true"],
    ["skills.enableSkillCommands", "true"],
    ["skills.customDirectories", JSON.stringify(skills)],
  ];
  if (modelRoles) values.unshift(["modelRoles", JSON.stringify(modelRoles)]);
  configureProfile(omp, profile, values, results, resultName);
}

function configureProfile(
  omp: string,
  profile: string,
  values: Array<readonly [string, string]>,
  results: IntegrationResult[],
  resultName: string,
): void {
  const failures: string[] = [];
  let changed = 0;
  for (const [key, value] of values) {
    const getArgs = profile === "default"
      ? ["config", "get", key]
      : ["--profile", profile, "config", "get", key];
    const current = spawnSync(omp, getArgs, { encoding: "utf8", env: childEnvironment() });
    if (current.status !== 0) {
      failures.push(`${key}: ${cleanOutput(current)}`);
      continue;
    }
    if (sameSetting(current.stdout.trim(), value)) continue;
    const setArgs = profile === "default"
      ? ["config", "set", key, value]
      : ["--profile", profile, "config", "set", key, value];
    const command = spawnSync(omp, setArgs, { encoding: "utf8", env: childEnvironment() });
    if (command.status !== 0) failures.push(`${key}: ${cleanOutput(command)}`);
    else changed += 1;
  }
  results.push({
    name: resultName,
    status: failures.length ? "failed" : changed ? "integrated" : "unchanged",
    detail: failures.length
      ? failures.join("; ")
      : changed
        ? `Applied ${changed} drifted native OMP profile setting(s)`
        : "Native OMP profile settings already match",
  });
}

function sameSetting(current: string, desired: string): boolean {
  return JSON.stringify(canonicalValue(parseSetting(current))) === JSON.stringify(canonicalValue(parseSetting(desired)));
}

function parseSetting(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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

function resolveLocalModelRoles(
  omp: string,
  profile: string,
  config: PersephoneConfig,
): Record<string, string> | null {
  const args = profile === "default"
    ? ["config", "get", "modelRoles"]
    : ["--profile", profile, "config", "get", "modelRoles"];
  const command = spawnSync(omp, args, { encoding: "utf8", env: childEnvironment() });
  let existing: Record<string, string> = {};
  if (command.status === 0) {
    try {
      const parsed = JSON.parse(command.stdout.trim()) as unknown;
      if (isRecord(parsed)) {
        existing = Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
    } catch {
      // A configured provider/model below can still establish the local role map.
    }
  }
  const configured = config.omp.provider && config.omp.model
    ? `${config.omp.provider}/${config.omp.model}`
    : undefined;
  const fallback = configured || existing.default;
  if (!fallback) return null;
  return Object.fromEntries(
    BUILT_IN_MODEL_ROLES.map((role) => [role, existing[role] || fallback]),
  );
}

function activeSkillDirectories(config: PersephoneConfig, includeOperations: boolean): string[] {
  const directories = includeOperations ? [path.join(repoRoot(), "skills")] : [];
  return directories.filter((directory) => existsSync(directory));
}

function refreshManagedProfileConfig(agent: string): void {
  for (const name of ["models.yml", "models.yaml", "models.json", "models.jsonc"]) {
    const target = path.join(agent, name);
    const marker = `${target}.managed-by-persephone`;
    if (!existsSync(target) || !existsSync(marker)) continue;
    try {
      const value = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
      writeJsonAtomicIfChanged(marker, {
        ...value,
        sha256: sha256(readFileSync(target)),
      });
    } catch {
      // A malformed marker is deliberately left untouched for the next audit.
    }
  }
}

export function restoreIntegrations(): string[] {
  const file = backupPath();
  if (!existsSync(file)) return [];
  const backup = JSON.parse(readFileSync(file, "utf8")) as IntegrationBackup;
  if (backup.version !== 1 || !isRecord(backup.mcp)) throw new Error(`Malformed integration backup: ${file}`);
  const restored: string[] = [];
  for (const [mcpFile, values] of Object.entries(backup.mcp)) {
    let config: McpConfig = {};
    if (existsSync(mcpFile)) config = JSON.parse(readFileSync(mcpFile, "utf8")) as McpConfig;
    config.mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
    for (const [name, value] of Object.entries(values)) {
      if (value === MISSING) delete config.mcpServers[name];
      else config.mcpServers[name] = value;
      restored.push(`${mcpFile}:${name}`);
    }
    writeJsonAtomic(mcpFile, config);
  }
  for (const target of backup.managedFiles || []) {
    const marker = `${target}.managed-by-persephone`;
    if (!existsSync(marker)) continue;
    if (managedFileCurrent(target, marker)) rmSync(target, { force: true });
    rmSync(marker, { force: true });
    restored.push(target);
  }
  rmSync(file, { force: true });
  return restored;
}

export function mergeMcp(file: string, entries: Record<string, unknown>): boolean {
  let config: McpConfig = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
    } catch (error) {
      throw new Error(`Refusing to overwrite malformed OMP MCP config ${file}: ${String(error)}`);
    }
  }
  config.$schema ||= MCP_SCHEMA;
  config.mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  for (const [name, entry] of Object.entries(entries)) config.mcpServers[name] = entry;
  if (existsSync(file)) {
    try {
      const current = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (JSON.stringify(canonicalValue(current)) === JSON.stringify(canonicalValue(config))) return false;
    } catch {
      // The malformed-file case was rejected above; this only guards a race.
    }
  }
  writeJsonAtomic(file, config);
  return true;
}

function synchronizeProfileConfiguration(sourceAgent: string, targetAgent: string): void {
  mkdirSync(targetAgent, { recursive: true, mode: 0o700 });
  for (const name of ["models.yml", "models.yaml", "models.json", "models.jsonc"]) {
    const source = path.join(sourceAgent, name);
    const target = path.join(targetAgent, name);
    const marker = `${target}.managed-by-persephone`;
    if (!existsSync(source)) continue;
    if (existsSync(target) && !existsSync(marker)) continue;
    if (existsSync(target) && existsSync(marker) && !managedFileCurrent(target, marker)) continue;
    const backup = loadBackup();
    if (!backup.managedFiles.includes(target)) {
      backup.managedFiles.push(target);
      writeJsonAtomic(backupPath(), backup);
    }
    const content = readFileSync(source);
    if (!existsSync(target) || !readFileSync(target).equals(content)) writeFileAtomic(target, content);
    writeJsonAtomicIfChanged(marker, { source, sha256: sha256(content) });
  }
}

function releaseManagedProfileSettings(agent: string): void {
  const released = new Set([path.join(agent, "config.yml"), path.join(agent, "config.yaml")]);
  for (const target of released) rmSync(`${target}.managed-by-persephone`, { force: true });
  const file = backupPath();
  if (!existsSync(file)) return;
  const backup = loadBackup();
  const retained = backup.managedFiles.filter((target) => !released.has(target));
  if (retained.length === backup.managedFiles.length) return;
  backup.managedFiles = retained;
  writeJsonAtomic(file, backup);
}

function rememberMcp(file: string, names: string[]): void {
  if (names.length === 0) return;
  const backup = loadBackup();
  backup.mcp[file] ||= {};
  let current: McpConfig = {};
  if (existsSync(file)) current = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
  const servers = isRecord(current.mcpServers) ? current.mcpServers : {};
  for (const name of names) {
    if (Object.hasOwn(backup.mcp[file]!, name)) continue;
    backup.mcp[file]![name] = Object.hasOwn(servers, name) ? servers[name] : MISSING;
  }
  writeJsonAtomic(backupPath(), backup);
}

function releaseDelegatedMcpOwnership(names: string[]): void {
  const file = backupPath();
  if (!existsSync(file)) return;
  const backup = loadBackup();
  let changed = false;
  for (const values of Object.values(backup.mcp)) {
    for (const name of names) {
      if (!Object.hasOwn(values, name)) continue;
      delete values[name];
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(file, backup);
}

function loadBackup(): IntegrationBackup {
  const file = backupPath();
  if (!existsSync(file)) return { version: 1, mcp: {}, managedFiles: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as IntegrationBackup;
  if (parsed.version !== 1 || !isRecord(parsed.mcp)) throw new Error(`Malformed integration backup: ${file}`);
  parsed.managedFiles ||= [];
  return parsed;
}

function backupPath(): string {
  return path.join(stateRoot(), "integration-backup.json");
}

function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function writeJsonAtomicIfChanged(file: string, value: unknown): void {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (existsSync(file) && readFileSync(file).equals(content)) return;
  writeFileAtomic(file, content);
}

function writeFileAtomic(file: string, value: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
}

function managedFileCurrent(target: string, marker: string): boolean {
  if (!existsSync(target) || !existsSync(marker)) return false;
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as { sha256?: unknown };
    return typeof value.sha256 === "string" && value.sha256 === sha256(readFileSync(target));
  } catch {
    return false;
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveExecutable(command: string): string | null {
  if (path.isAbsolute(command) && existsSync(command)) return command;
  return Bun.which(command);
}

function cleanOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim() || `exit ${result.status ?? "unknown"}`;
}

function childEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, OTEL_SDK_DISABLED: "true" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

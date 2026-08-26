import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEnvFile } from "./config.ts";
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
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun is required");

  const linked = spawnSync(omp, ["plugin", "link", repoRoot()], { encoding: "utf8", env: childEnvironment() });
  results.push({
    name: "persephone-plugin",
    status: linked.status === 0 ? "integrated" : "failed",
    detail: linked.status === 0 ? "Linked through omp plugin link" : cleanOutput(linked),
  });

  const interactiveAgent = ompAgentDir(config.omp.interactiveProfile);
  const workerAgent = ompAgentDir(config.omp.profile);
  const modelRoles = resolveLocalModelRoles(omp, config.omp.interactiveProfile, config);
  configureInteractiveProfile(omp, config.omp.interactiveProfile, config, modelRoles, results);
  if (interactiveAgent !== workerAgent) {
    synchronizeProfileConfiguration(interactiveAgent, workerAgent);
  }
  configureWorkerProfile(omp, config.omp.profile, config, modelRoles, results);
  refreshManagedProfileConfig(workerAgent);

  const services = config.integrations.servicesRoot;
  const publicEntries: Record<string, unknown> = {};
  if (config.integrations.contextMode) {
    const root = path.join(services, "context-mode");
    if (!existsSync(path.join(root, "package.json"))) {
      results.push({ name: "context-mode", status: "missing", detail: root });
    } else {
      const command = spawnSync(omp, ["plugin", "link", root], { encoding: "utf8", env: childEnvironment() });
      results.push({
        name: "context-mode",
        status: command.status === 0 ? "integrated" : "failed",
        detail: command.status === 0 ? "Linked through its native omp.extensions entry" : cleanOutput(command),
      });
      const server = path.join(root, "server.bundle.mjs");
      if (existsSync(server)) {
        publicEntries["context-mode"] = { type: "stdio", command: bun, args: [server], cwd: root };
        results.push({ name: "context-mode-mcp", status: "integrated", detail: server });
      } else {
        results.push({ name: "context-mode-mcp", status: "missing", detail: server });
      }
    }
  }

  if (config.integrations.retrieval) {
    const root = path.join(services, "retrieval");
    const start = path.join(root, "start.sh");
    if (existsSync(start)) {
      publicEntries.retrieval = { type: "stdio", command: start, cwd: root };
      results.push({ name: "retrieval", status: "integrated", detail: start });
    } else results.push({ name: "retrieval", status: "missing", detail: start });
  }

  if (config.integrations.codebaseMemory) {
    const root = path.join(services, "codebase-memory-mcp");
    const binary = path.join(root, "build", "c", "codebase-memory-mcp");
    if (existsSync(binary)) {
      publicEntries["codebase-memory"] = {
        type: "stdio",
        command: binary,
        cwd: root,
        env: { CBM_AUTO_INDEX: "true", CBM_LOG_LEVEL: "warn" },
      };
      results.push({ name: "codebase-memory", status: "integrated", detail: binary });
    } else results.push({ name: "codebase-memory", status: "missing", detail: binary });
  }

  if (config.integrations.camofox) {
    const root = path.join(services, "camofox-mcp");
    const entry = path.join(root, "dist", "index.js");
    if (existsSync(entry)) {
      const camofoxEnv: Record<string, string> = { CAMOFOX_URL: config.web.camofox.url };
      const apiKey = process.env[config.web.camofox.apiKeyEnv]?.trim();
      if (apiKey) camofoxEnv.CAMOFOX_API_KEY = apiKey;
      publicEntries.camofox = { type: "stdio", command: bun, args: [entry], cwd: root, env: camofoxEnv };
      results.push({ name: "camofox", status: "integrated", detail: entry });
    } else results.push({ name: "camofox", status: "missing", detail: entry });
  }

  if (config.integrations.librarian) {
    integrateLibrarian(config, bun, publicEntries, modelRoles, results);
  }

  for (const profile of new Set([config.omp.interactiveProfile, config.omp.profile])) {
    const publicFile = path.join(ompAgentDir(profile), "mcp.json");
    rememberMcp(publicFile, Object.keys(publicEntries));
    mergeMcp(publicFile, publicEntries);
    results.push({ name: `omp-mcp:${profile}`, status: "integrated", detail: publicFile });
  }
  return results;
}

function integrateLibrarian(
  config: PersephoneConfig,
  bun: string,
  publicEntries: Record<string, unknown>,
  modelRoles: Record<string, string> | null,
  results: IntegrationResult[],
): void {
  const root = path.join(config.integrations.servicesRoot, "librarian");
  const publicEntry = path.join(root, "packages", "server", "dist", "mcp", "stdio.js");
  const privateEntry = path.join(root, "packages", "server", "dist", "mcp", "okf-stdio.js");
  if (!existsSync(publicEntry) || !existsSync(privateEntry)) {
    results.push({ name: "librarian", status: "missing", detail: "Run bun install && bun run build in the Librarian repository" });
    return;
  }
  const existing = readEnvFile(path.join(root, ".env"));
  const bundleRoot = existing.BUNDLE_ROOT || path.join(root, "data");
  const profile = existing.OMP_PROFILE || "librarian";
  const privateAgent = ompAgentDir(profile);
  const publicEnv: Record<string, string> = {
    BUNDLE_ROOT: bundleRoot,
    LIBRARIAN_AGENT_BACKEND: "omp",
    OMP_COMMAND: resolveExecutable(config.omp.command) || config.omp.command,
    OMP_HOME: path.dirname(ompAgentDir("default")),
    OMP_AGENT_DIR: ompAgentDir(config.omp.profile),
    OMP_PROFILE: profile,
    OMP_PROFILE_AGENT_DIR: privateAgent,
    OMP_TIMEOUT_MS: existing.OMP_TIMEOUT_MS || "600000",
    OMP_PROVIDER: config.omp.provider || existing.OMP_PROVIDER || "",
    OMP_MODEL: config.omp.model || existing.OMP_MODEL || "",
    VLLM_API_KEY: existing.VLLM_API_KEY || process.env.VLLM_API_KEY || "local",
    QUERY_CACHE: existing.QUERY_CACHE || "true",
    QUERY_CACHE_TTL: existing.QUERY_CACHE_TTL || "24h",
    HOT_MEMORY: existing.HOT_MEMORY || "true",
    HOT_MEMORY_TTL: existing.HOT_MEMORY_TTL || "1h",
    GIT_AUTOCOMMIT: existing.GIT_AUTOCOMMIT || "false",
    OTEL_SDK_DISABLED: "true",
  };
  publicEntries.librarian = {
    type: "stdio",
    command: bun,
    args: [publicEntry],
    cwd: root,
    env: publicEnv,
    timeout: 660000,
  };
  const privateFile = path.join(privateAgent, "mcp.json");
  rememberMcp(privateFile, [...readMcpServerNames(privateFile), "librarian-okf"]);
  replaceMcp(privateFile, {
    "librarian-okf": {
      type: "stdio",
      command: bun,
      args: [privateEntry],
      cwd: root,
      env: { BUNDLE_ROOT: bundleRoot, GIT_AUTOCOMMIT: existing.GIT_AUTOCOMMIT || "false" },
    },
  });
  synchronizeProfileConfiguration(ompAgentDir(config.omp.interactiveProfile), privateAgent);
  configureWorkerProfile(
    resolveExecutable(config.omp.command) || config.omp.command,
    profile,
    config,
    modelRoles,
    results,
    "librarian-profile",
  );
  refreshManagedProfileConfig(privateAgent);
  results.push({
    name: "librarian",
    status: "integrated",
    detail: `Public MCP plus isolated '${profile}' OMP RPC profile containing only deterministic OKF tools`,
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
    ["inspect_image.mode", "auto"],
    ["exa.enabled", "false"],
    ["retry.modelFallback", "false"],
    ["startup.checkUpdate", "false"],
    ["marketplace.autoUpdate", "off"],
    ["dev.autoqa", "false"],
    ["providers.fetch", "native"],
    ["tools.xdev", "true"],
    ["features.unexpectedStopDetection", "true"],
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
    ["inspect_image.mode", "auto"],
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
  for (const [key, value] of values) {
    const args = profile === "default"
      ? ["config", "set", key, value]
      : ["--profile", profile, "config", "set", key, value];
    const command = spawnSync(omp, args, { encoding: "utf8", env: childEnvironment() });
    if (command.status !== 0) failures.push(`${key}: ${cleanOutput(command)}`);
  }
  results.push({
    name: resultName,
    status: failures.length ? "failed" : "integrated",
    detail: failures.length ? failures.join("; ") : "Applied native OMP profile settings",
  });
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
  const directories = [
    path.join(config.integrations.servicesRoot, "retrieval", "skills"),
    ...(includeOperations ? [path.join(repoRoot(), "skills")] : []),
  ];
  return directories.filter((directory) => existsSync(directory));
}

function refreshManagedProfileConfig(agent: string): void {
  for (const name of ["config.yml", "config.yaml"]) {
    const target = path.join(agent, name);
    const marker = `${target}.managed-by-persephone`;
    if (!existsSync(target) || !existsSync(marker)) continue;
    try {
      const value = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
      writeJsonAtomic(marker, {
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

export function mergeMcp(file: string, entries: Record<string, unknown>): void {
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
  writeJsonAtomic(file, config);
}

function replaceMcp(file: string, entries: Record<string, unknown>): void {
  let config: McpConfig = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
    } catch (error) {
      throw new Error(`Refusing to overwrite malformed OMP MCP config ${file}: ${String(error)}`);
    }
  }
  config.$schema ||= MCP_SCHEMA;
  config.mcpServers = { ...entries };
  writeJsonAtomic(file, config);
}

function readMcpServerNames(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
    return Object.keys(isRecord(config.mcpServers) ? config.mcpServers : {});
  } catch (error) {
    throw new Error(`Refusing to replace malformed OMP MCP config ${file}: ${String(error)}`);
  }
}

function synchronizeProfileConfiguration(sourceAgent: string, targetAgent: string): void {
  mkdirSync(targetAgent, { recursive: true, mode: 0o700 });
  for (const name of ["config.yml", "config.yaml", "models.yml", "models.yaml", "models.json", "models.jsonc"]) {
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
    writeFileAtomic(target, content);
    writeJsonAtomic(marker, { source, sha256: sha256(content) });
  }
}

function rememberMcp(file: string, names: string[]): void {
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

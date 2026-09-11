import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configRoot, expandHome } from "./paths.ts";
import type { PersephoneConfig, ThinkingLevel } from "./types.ts";

const THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_CONFIG: PersephoneConfig = {
  version: 1,
  listen: { host: "127.0.0.1", port: 4737, tokenEnv: "PERSEPHONE_API_TOKEN" },
  omp: {
    command: "omp",
    interactiveProfile: "default",
    profile: "persephone",
    cwd: "~",
    maxWorkers: 1,
    idleSeconds: 1800,
    imageModels: ["vllm/qwen3.8-27b"],
  },
  signal: {
    enabled: false,
    url: "http://127.0.0.1:8090",
    accountEnv: "SIGNAL_ACCOUNT",
    allowedSenders: [],
    allowedGroups: [],
    allowAll: false,
    typing: true,
  },
  discord: {
    enabled: false,
    tokenEnv: "DISCORD_BOT_TOKEN",
    allowedUsers: [],
    allowedGuilds: [],
    allowedChannels: [],
    allowAll: false,
    requireMention: true,
  },
  slack: {
    enabled: false,
    botTokenEnv: "SLACK_BOT_TOKEN",
    appTokenEnv: "SLACK_APP_TOKEN",
    allowedUsers: [],
    allowedTeams: [],
    allowedChannels: [],
    allowAll: false,
    requireMention: true,
  },
  roboomp: {
    enabled: false,
    url: "http://127.0.0.1:6543",
  },
  integrations: {
    servicesRoot: "~/Hermes",
    localflameRoot: "~/Deepseek/localflame",
    localflame: true,
    contextMode: true,
    librarian: true,
    retrieval: true,
    codebaseMemory: true,
    camofox: true,
  },
  web: {
    firecrawl: {
      url: "http://127.0.0.1:3002",
      apiKeyEnv: "FIRECRAWL_API_KEY",
    },
    camofox: {
      replaceNativeBrowser: true,
      url: "http://127.0.0.1:9377",
      apiKeyEnv: "CAMOFOX_API_KEY",
      userId: "omp-persephone",
    },
  },
  scheduler: { pollSeconds: 15 },
  security: { approvalTimeoutSeconds: 300 },
};

export function configPath(): string {
  return process.env.PERSEPHONE_CONFIG || path.join(configRoot(), "config.json");
}

export function envPath(): string {
  return path.join(configRoot(), ".env");
}

export function loadEnvironment(): void {
  const file = envPath();
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = parseEnvValue(line.slice(separator + 1).trim());
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(): PersephoneConfig {
  loadEnvironment();
  const file = configPath();
  const parsed = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Partial<PersephoneConfig>)
    : {};
  const merged: PersephoneConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    listen: { ...DEFAULT_CONFIG.listen, ...parsed.listen },
    omp: { ...DEFAULT_CONFIG.omp, ...parsed.omp },
    signal: { ...DEFAULT_CONFIG.signal, ...parsed.signal },
    discord: { ...DEFAULT_CONFIG.discord, ...parsed.discord },
    slack: { ...DEFAULT_CONFIG.slack, ...parsed.slack },
    roboomp: { ...DEFAULT_CONFIG.roboomp, ...parsed.roboomp },
    integrations: { ...DEFAULT_CONFIG.integrations, ...parsed.integrations },
    web: {
      ...DEFAULT_CONFIG.web,
      ...parsed.web,
      firecrawl: { ...DEFAULT_CONFIG.web.firecrawl, ...parsed.web?.firecrawl },
      camofox: { ...DEFAULT_CONFIG.web.camofox, ...parsed.web?.camofox },
    },
    scheduler: { ...DEFAULT_CONFIG.scheduler, ...parsed.scheduler },
    security: { ...DEFAULT_CONFIG.security, ...parsed.security },
  };
  validateConfig(merged);
  merged.omp.cwd = expandHome(merged.omp.cwd);
  merged.integrations.servicesRoot = expandHome(merged.integrations.servicesRoot);
  merged.integrations.localflameRoot = expandHome(merged.integrations.localflameRoot);
  return merged;
}

export function saveConfig(config: PersephoneConfig): void {
  validateConfig(config);
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export interface ConfigWriteOptions {
  configFile?: string;
  envFile?: string;
}

/**
 * Validate and atomically replace the public configuration together with a
 * bounded set of secret-environment edits. Secret values are never returned.
 */
export function applyConfigAndSecrets(
  config: PersephoneConfig,
  updates: Record<string, string | null>,
  allowedNames: ReadonlySet<string>,
  options: ConfigWriteOptions = {},
): { updatedSecretNames: string[]; removedSecretNames: string[] } {
  const configFile = options.configFile ?? configPath();
  const envFile = options.envFile ?? envPath();
  const normalizedUpdates: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(updates)) {
    if (!allowedNames.has(name)) throw new Error(`Secret environment name is not owned by Persephone: ${name}`);
    validateEnvName(name, "secret environment name");
    if (value !== null && typeof value !== "string") throw new Error(`Secret value for ${name} must be a string or null`);
    if (typeof value === "string" && /[\r\n\0]/.test(value)) throw new Error(`Secret value for ${name} must be one line`);
    normalizedUpdates[name] = value;
  }

  const currentEnv = readEnvFile(envFile);
  const validationEnv: Record<string, string | undefined> = { ...process.env, ...currentEnv };
  for (const [name, value] of Object.entries(normalizedUpdates)) {
    if (value === null || value === "") delete validationEnv[name];
    else validationEnv[name] = value;
  }
  validateConfig(config, validationEnv);

  const configDirectory = path.dirname(configFile);
  const envDirectory = path.dirname(envFile);
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(envDirectory, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${crypto.randomUUID()}.tmp`;
  const configTemporary = `${configFile}.${suffix}`;
  const envTemporary = `${envFile}.${suffix}`;
  const originalEnv = existsSync(envFile) ? readFileSync(envFile, "utf8") : "# Local secrets for Persephone\n";
  writeFileSync(configTemporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(envTemporary, renderEnvUpdates(originalEnv, normalizedUpdates), { mode: 0o600 });
  renameSync(envTemporary, envFile);
  renameSync(configTemporary, configFile);

  return {
    updatedSecretNames: Object.entries(normalizedUpdates)
      .filter(([, value]) => value !== null && value !== "")
      .map(([name]) => name)
      .sort(),
    removedSecretNames: Object.entries(normalizedUpdates)
      .filter(([, value]) => value === null || value === "")
      .map(([name]) => name)
      .sort(),
  };
}

export function ensureConfig(): { config: PersephoneConfig; created: boolean } {
  const file = configPath();
  if (existsSync(file)) return { config: loadConfig(), created: false };
  const config = structuredClone(DEFAULT_CONFIG);
  saveConfig(config);
  const env = envPath();
  if (!existsSync(env)) {
    writeFileSync(env, "# Local secrets for Persephone\nSIGNAL_ACCOUNT=\nDISCORD_BOT_TOKEN=\nSLACK_BOT_TOKEN=\nSLACK_APP_TOKEN=\nPERSEPHONE_API_TOKEN=\nFIRECRAWL_API_KEY=\nCAMOFOX_API_KEY=\nOTEL_SDK_DISABLED=true\n", {
      mode: 0o600,
    });
  }
  return { config, created: true };
}

export function validateConfig(
  config: PersephoneConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (config.version !== 1) throw new Error(`Unsupported config version: ${String(config.version)}`);
  if (!config.listen || typeof config.listen.host !== "string" || !config.listen.host.trim()) {
    throw new Error("listen.host must be a non-empty string");
  }
  if (!Number.isInteger(config.listen.port) || config.listen.port < 1 || config.listen.port > 65535) {
    throw new Error("listen.port must be an integer from 1 to 65535");
  }
  if (typeof config.listen.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.listen.tokenEnv)) {
    throw new Error("listen.tokenEnv must name an environment variable");
  }
  if (!config.omp || typeof config.omp.command !== "string" || !config.omp.command.trim()) {
    throw new Error("omp.command must be a non-empty string");
  }
  if (typeof config.omp.interactiveProfile !== "string" || !config.omp.interactiveProfile.trim()) {
    throw new Error("omp.interactiveProfile must be a non-empty string");
  }
  if (typeof config.omp.profile !== "string" || !config.omp.profile.trim()) {
    throw new Error("omp.profile must be a non-empty string");
  }
  if (typeof config.omp.cwd !== "string" || !config.omp.cwd.trim()) {
    throw new Error("omp.cwd must be a non-empty path");
  }
  if (!Number.isInteger(config.omp.maxWorkers) || config.omp.maxWorkers < 1 || config.omp.maxWorkers > 32) {
    throw new Error("omp.maxWorkers must be an integer from 1 to 32");
  }
  if (!Number.isInteger(config.omp.idleSeconds) || config.omp.idleSeconds < 30) {
    throw new Error("omp.idleSeconds must be an integer of at least 30");
  }
  validateStringArray(config.omp.imageModels, "omp.imageModels");
  for (const selector of config.omp.imageModels) {
    if (!selector.startsWith("@") && !selector.includes("/")) {
      throw new Error(`omp.imageModels entry must be provider/model or @role: ${selector}`);
    }
  }
  if (config.omp.thinking && !THINKING.has(config.omp.thinking)) {
    throw new Error(`Unsupported OMP thinking level: ${config.omp.thinking}`);
  }
  if (!config.signal || typeof config.signal.url !== "string") throw new Error("signal.url must be a URL");
  try {
    const signalUrl = new URL(config.signal.url);
    if (!new Set(["http:", "https:"]).has(signalUrl.protocol)) throw new Error();
  } catch {
    throw new Error("signal.url must be an HTTP(S) URL");
  }
  if (!Array.isArray(config.signal.allowedSenders) || !config.signal.allowedSenders.every((value) => typeof value === "string")) {
    throw new Error("signal.allowedSenders must be an array of strings");
  }
  if (!Array.isArray(config.signal.allowedGroups) || !config.signal.allowedGroups.every((value) => typeof value === "string")) {
    throw new Error("signal.allowedGroups must be an array of strings");
  }
  validateBoolean(config.signal.enabled, "signal.enabled");
  validateBoolean(config.signal.allowAll, "signal.allowAll");
  validateBoolean(config.signal.typing, "signal.typing");
  if (config.signal.enabled) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.signal.accountEnv)) {
      throw new Error("signal.accountEnv must name an environment variable");
    }
    const account = environment[config.signal.accountEnv]?.trim();
    if (!account) throw new Error(`signal.enabled requires ${config.signal.accountEnv} in ${envPath()}`);
    if (!config.signal.allowAll && config.signal.allowedSenders.length === 0 && config.signal.allowedGroups.length === 0) {
      throw new Error("Signal is fail-closed: configure at least one allowed sender or group");
    }
  }
  validateStringArray(config.discord.allowedUsers, "discord.allowedUsers");
  validateStringArray(config.discord.allowedGuilds, "discord.allowedGuilds");
  validateStringArray(config.discord.allowedChannels, "discord.allowedChannels");
  validateEnvName(config.discord.tokenEnv, "discord.tokenEnv");
  validateBoolean(config.discord.enabled, "discord.enabled");
  validateBoolean(config.discord.allowAll, "discord.allowAll");
  validateBoolean(config.discord.requireMention, "discord.requireMention");
  if (config.discord.enabled) {
    if (!environment[config.discord.tokenEnv]?.trim()) {
      throw new Error(`discord.enabled requires ${config.discord.tokenEnv} in ${envPath()}`);
    }
    if (!config.discord.allowAll && !hasAny(config.discord.allowedUsers, config.discord.allowedGuilds, config.discord.allowedChannels)) {
      throw new Error("Discord is fail-closed: configure an allowlist or set discord.allowAll explicitly");
    }
  }
  validateStringArray(config.slack.allowedUsers, "slack.allowedUsers");
  validateStringArray(config.slack.allowedTeams, "slack.allowedTeams");
  validateStringArray(config.slack.allowedChannels, "slack.allowedChannels");
  validateEnvName(config.slack.botTokenEnv, "slack.botTokenEnv");
  validateEnvName(config.slack.appTokenEnv, "slack.appTokenEnv");
  validateBoolean(config.slack.enabled, "slack.enabled");
  validateBoolean(config.slack.allowAll, "slack.allowAll");
  validateBoolean(config.slack.requireMention, "slack.requireMention");
  if (config.slack.enabled) {
    if (!environment[config.slack.botTokenEnv]?.trim()) {
      throw new Error(`slack.enabled requires ${config.slack.botTokenEnv} in ${envPath()}`);
    }
    if (!environment[config.slack.appTokenEnv]?.trim()) {
      throw new Error(`slack.enabled requires ${config.slack.appTokenEnv} in ${envPath()}`);
    }
    if (!config.slack.allowAll && !hasAny(config.slack.allowedUsers, config.slack.allowedTeams, config.slack.allowedChannels)) {
      throw new Error("Slack is fail-closed: configure an allowlist or set slack.allowAll explicitly");
    }
  }
  validateHttpUrl(config.roboomp.url, "roboomp.url");
  validateBoolean(config.roboomp.enabled, "roboomp.enabled");
  if (!config.integrations || typeof config.integrations.servicesRoot !== "string" || !config.integrations.servicesRoot.trim()) {
    throw new Error("integrations.servicesRoot must be a non-empty path");
  }
  if (typeof config.integrations.localflameRoot !== "string" || !config.integrations.localflameRoot.trim()) {
    throw new Error("integrations.localflameRoot must be a non-empty path");
  }
  validateBoolean(config.integrations.localflame, "integrations.localflame");
  if (!config.web || !config.web.firecrawl || !config.web.camofox) {
    throw new Error("web.firecrawl and web.camofox must be configured");
  }
  validateHttpUrl(config.web.firecrawl.url, "web.firecrawl.url");
  validateEnvName(config.web.firecrawl.apiKeyEnv, "web.firecrawl.apiKeyEnv");
  if ((config.web.firecrawl as { nativeFallback?: unknown }).nativeFallback === true) {
    throw new Error("web.firecrawl.nativeFallback is no longer supported; hosted search fallback is forbidden");
  }
  validateHttpUrl(config.web.camofox.url, "web.camofox.url");
  validateEnvName(config.web.camofox.apiKeyEnv, "web.camofox.apiKeyEnv");
  if (typeof config.web.camofox.userId !== "string" || !config.web.camofox.userId.trim()) {
    throw new Error("web.camofox.userId must be a non-empty string");
  }
  if (typeof config.web.camofox.replaceNativeBrowser !== "boolean") {
    throw new Error("web.camofox.replaceNativeBrowser must be a boolean");
  }
  if (!Number.isInteger(config.scheduler.pollSeconds) || config.scheduler.pollSeconds < 1 || config.scheduler.pollSeconds > 60) {
    throw new Error("scheduler.pollSeconds must be an integer from 1 to 60");
  }
  if (!Number.isInteger(config.security.approvalTimeoutSeconds) || config.security.approvalTimeoutSeconds < 30) {
    throw new Error("security.approvalTimeoutSeconds must be an integer of at least 30");
  }
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopback.has(config.listen.host) && !environment[config.listen.tokenEnv]?.trim()) {
    throw new Error(`Non-loopback listen host requires ${config.listen.tokenEnv}`);
  }
}

function validateHttpUrl(value: string, field: string): void {
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error();
  } catch {
    throw new Error(`${field} must be an HTTP(S) URL`);
  }
}

function validateEnvName(value: string, field: string): void {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${field} must name an environment variable`);
  }
}

function validateStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
}

function validateBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
}

function hasAny(...values: string[][]): boolean {
  return values.some((entries) => entries.length > 0);
}

export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const result: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = parseEnvValue(line.slice(separator + 1).trim());
    result[key] = value;
  }
  return result;
}

function parseEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function renderEnvUpdates(source: string, updates: Record<string, string | null>): string {
  const pending = new Map(Object.entries(updates));
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !(match[1]! in updates)) {
      output.push(raw);
      continue;
    }
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const value = pending.get(name);
    pending.delete(name);
    if (typeof value === "string" && value !== "") output.push(`${name}=${encodeEnvValue(value)}`);
  }
  for (const [name, value] of [...pending.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (value !== null && value !== "") output.push(`${name}=${encodeEnvValue(value)}`);
  }
  while (output.length > 1 && output.at(-1) === "") output.pop();
  return `${output.join("\n")}\n`;
}

function encodeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+,%=-]*$/.test(value) ? value : JSON.stringify(value);
}

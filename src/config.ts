import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configRoot, expandHome, repoRoot } from "./paths.ts";
import type { PersephoneConfig, RoboOmpGitHubConfig, ThinkingLevel } from "./types.ts";

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
    url: "http://127.0.0.1:8080",
    github: {
      enabled: false,
      orchestratorUrl: "http://robomp:8080",
      upstreamProxyUrl: "http://gh-proxy:8081",
      workspaceRoot: "/data/workspaces",
      allowedRepositories: [],
      allowedActors: [],
      persephoneBotLogin: "",
      webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
      approvalTokenEnv: "PERSEPHONE_GITHUB_APPROVAL_TOKEN",
      replayTokenEnv: "ROBOMP_REPLAY_TOKEN",
      proposalMaxDiffBytes: 2_000_000,
      dream: {
        enabled: false,
        intervalMinutes: 1440,
        repositories: [],
        directiveAuthor: "",
        profile: "persephone-dream",
        cwdRoot: "/data/persephone-dreams",
        thinking: "high",
        promptFile: "rules/github-dream.md",
        issueProxyUrl: "http://persephone-issue-author:8092",
        issueProxyKeyEnv: "PERSEPHONE_GITHUB_ISSUE_HMAC_KEY",
      },
      ensemble: {
        enabled: false,
        profile: "persephone-ensemble",
        cwd: "/tmp/persephone-ensemble",
        thinking: "high",
        personas: [
          {
            id: "persona-1",
            name: "Ensemble I",
            botLogin: "",
            promptFile: "rules/ensemble/persona-1.md",
            commentProxyUrl: "http://persephone-ensemble-1:8091",
            commentProxyKeyEnv: "PERSEPHONE_ENSEMBLE_1_HMAC_KEY",
          },
          {
            id: "persona-2",
            name: "Ensemble II",
            botLogin: "",
            promptFile: "rules/ensemble/persona-2.md",
            commentProxyUrl: "http://persephone-ensemble-2:8091",
            commentProxyKeyEnv: "PERSEPHONE_ENSEMBLE_2_HMAC_KEY",
          },
          {
            id: "persona-3",
            name: "Ensemble III",
            botLogin: "",
            promptFile: "rules/ensemble/persona-3.md",
            commentProxyUrl: "http://persephone-ensemble-3:8091",
            commentProxyKeyEnv: "PERSEPHONE_ENSEMBLE_3_HMAC_KEY",
          },
        ],
      },
    },
  },
  integrations: {
    servicesRoot: "~/Hermes",
    contextMode: true,
    librarian: true,
    retrieval: true,
    codebaseMemory: true,
    camofox: true,
  },
  web: {
    firecrawl: {
      enabled: true,
      url: "http://127.0.0.1:3002",
      apiKeyEnv: "FIRECRAWL_API_KEY",
      timeoutSeconds: 60,
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
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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
    roboomp: {
      ...DEFAULT_CONFIG.roboomp,
      ...parsed.roboomp,
      github: {
        ...DEFAULT_CONFIG.roboomp.github,
        ...parsed.roboomp?.github,
        dream: {
          ...DEFAULT_CONFIG.roboomp.github.dream,
          ...parsed.roboomp?.github?.dream,
        },
        ensemble: {
          ...DEFAULT_CONFIG.roboomp.github.ensemble,
          ...parsed.roboomp?.github?.ensemble,
          personas: parsed.roboomp?.github?.ensemble?.personas ?? DEFAULT_CONFIG.roboomp.github.ensemble.personas,
        },
      },
    },
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
  merged.roboomp.github.workspaceRoot = expandHome(merged.roboomp.github.workspaceRoot);
  merged.roboomp.github.dream.cwdRoot = expandHome(merged.roboomp.github.dream.cwdRoot);
  merged.roboomp.github.dream.promptFile = resolveRepoFile(merged.roboomp.github.dream.promptFile);
  merged.roboomp.github.ensemble.cwd = expandHome(merged.roboomp.github.ensemble.cwd);
  for (const persona of merged.roboomp.github.ensemble.personas) {
    persona.promptFile = resolveRepoFile(persona.promptFile);
  }
  return merged;
}

/** Load only the RoboOMP GitHub bridge contract.
 *
 * Sidecars use this narrow loader so Signal/Discord/Slack credentials never
 * need to enter their containers merely because those transports are enabled
 * in the main Persephone daemon configuration.
 */
export function loadRoboOmpGitHubConfig(): RoboOmpGitHubConfig {
  loadEnvironment();
  const file = configPath();
  const parsed = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Partial<PersephoneConfig>)
    : {};
  const github: RoboOmpGitHubConfig = {
    ...DEFAULT_CONFIG.roboomp.github,
    ...parsed.roboomp?.github,
    dream: {
      ...DEFAULT_CONFIG.roboomp.github.dream,
      ...parsed.roboomp?.github?.dream,
    },
    ensemble: {
      ...DEFAULT_CONFIG.roboomp.github.ensemble,
      ...parsed.roboomp?.github?.ensemble,
      personas: parsed.roboomp?.github?.ensemble?.personas ?? DEFAULT_CONFIG.roboomp.github.ensemble.personas,
    },
  };
  const holder = structuredClone(DEFAULT_CONFIG);
  holder.roboomp.github = github;
  validateRoboOmpGitHub(holder);
  github.workspaceRoot = expandHome(github.workspaceRoot);
  github.dream.cwdRoot = expandHome(github.dream.cwdRoot);
  github.dream.promptFile = resolveRepoFile(github.dream.promptFile);
  github.ensemble.cwd = expandHome(github.ensemble.cwd);
  for (const persona of github.ensemble.personas) {
    persona.promptFile = resolveRepoFile(persona.promptFile);
  }
  return github;
}

export function saveConfig(config: PersephoneConfig): void {
  validateConfig(config);
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function ensureConfig(): { config: PersephoneConfig; created: boolean } {
  const file = configPath();
  if (existsSync(file)) return { config: loadConfig(), created: false };
  const config = structuredClone(DEFAULT_CONFIG);
  saveConfig(config);
  const env = envPath();
  if (!existsSync(env)) {
    writeFileSync(env, "# Local secrets for Persephone\nSIGNAL_ACCOUNT=\nDISCORD_BOT_TOKEN=\nSLACK_BOT_TOKEN=\nSLACK_APP_TOKEN=\nPERSEPHONE_API_TOKEN=\nFIRECRAWL_API_KEY=\nCAMOFOX_API_KEY=\nPERSEPHONE_GITHUB_APPROVAL_TOKEN=\nPERSEPHONE_GITHUB_ISSUE_HMAC_KEY=\nPERSEPHONE_ENSEMBLE_1_HMAC_KEY=\nPERSEPHONE_ENSEMBLE_2_HMAC_KEY=\nPERSEPHONE_ENSEMBLE_3_HMAC_KEY=\nOTEL_SDK_DISABLED=true\n", {
      mode: 0o600,
    });
  }
  return { config, created: true };
}

function validateConfig(config: PersephoneConfig): void {
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
    const account = process.env[config.signal.accountEnv]?.trim();
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
    if (!process.env[config.discord.tokenEnv]?.trim()) {
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
    if (!process.env[config.slack.botTokenEnv]?.trim()) {
      throw new Error(`slack.enabled requires ${config.slack.botTokenEnv} in ${envPath()}`);
    }
    if (!process.env[config.slack.appTokenEnv]?.trim()) {
      throw new Error(`slack.enabled requires ${config.slack.appTokenEnv} in ${envPath()}`);
    }
    if (!config.slack.allowAll && !hasAny(config.slack.allowedUsers, config.slack.allowedTeams, config.slack.allowedChannels)) {
      throw new Error("Slack is fail-closed: configure an allowlist or set slack.allowAll explicitly");
    }
  }
  validateHttpUrl(config.roboomp.url, "roboomp.url");
  validateBoolean(config.roboomp.enabled, "roboomp.enabled");
  validateRoboOmpGitHub(config);
  if (!config.integrations || typeof config.integrations.servicesRoot !== "string" || !config.integrations.servicesRoot.trim()) {
    throw new Error("integrations.servicesRoot must be a non-empty path");
  }
  if (!config.web || !config.web.firecrawl || !config.web.camofox) {
    throw new Error("web.firecrawl and web.camofox must be configured");
  }
  validateHttpUrl(config.web.firecrawl.url, "web.firecrawl.url");
  validateEnvName(config.web.firecrawl.apiKeyEnv, "web.firecrawl.apiKeyEnv");
  if (typeof config.web.firecrawl.enabled !== "boolean") throw new Error("web.firecrawl.enabled must be a boolean");
  if ((config.web.firecrawl as { nativeFallback?: unknown }).nativeFallback === true) {
    throw new Error("web.firecrawl.nativeFallback is no longer supported; hosted search fallback is forbidden");
  }
  if (!Number.isInteger(config.web.firecrawl.timeoutSeconds) || config.web.firecrawl.timeoutSeconds < 1 || config.web.firecrawl.timeoutSeconds > 300) {
    throw new Error("web.firecrawl.timeoutSeconds must be an integer from 1 to 300");
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
  if (!loopback.has(config.listen.host) && !process.env[config.listen.tokenEnv]?.trim()) {
    throw new Error(`Non-loopback listen host requires ${config.listen.tokenEnv}`);
  }
}

export function validateRoboOmpGitHub(config: PersephoneConfig): void {
  const github = config.roboomp.github;
  if (!github) throw new Error("roboomp.github must be configured");
  validateBoolean(github.enabled, "roboomp.github.enabled");
  validateHttpUrl(github.orchestratorUrl, "roboomp.github.orchestratorUrl");
  validateHttpUrl(github.upstreamProxyUrl, "roboomp.github.upstreamProxyUrl");
  if (typeof github.workspaceRoot !== "string" || !github.workspaceRoot.trim()) {
    throw new Error("roboomp.github.workspaceRoot must be a non-empty path");
  }
  validateStringArray(github.allowedRepositories, "roboomp.github.allowedRepositories");
  validateStringArray(github.allowedActors, "roboomp.github.allowedActors");
  for (const repo of github.allowedRepositories) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes("..")) throw new Error(`invalid GitHub repository: ${repo}`);
  }
  for (const actor of github.allowedActors) {
    if (!validGitHubLogin(actor)) throw new Error(`invalid GitHub actor login: ${actor}`);
  }
  validateEnvName(github.webhookSecretEnv, "roboomp.github.webhookSecretEnv");
  validateEnvName(github.approvalTokenEnv, "roboomp.github.approvalTokenEnv");
  validateEnvName(github.replayTokenEnv, "roboomp.github.replayTokenEnv");
  if (!Number.isInteger(github.proposalMaxDiffBytes) || github.proposalMaxDiffBytes < 100_000 || github.proposalMaxDiffBytes > 20_000_000) {
    throw new Error("roboomp.github.proposalMaxDiffBytes must be an integer from 100000 to 20000000");
  }
  const login = github.persephoneBotLogin.trim().toLowerCase();
  if (login && !validGitHubLogin(login)) throw new Error("roboomp.github.persephoneBotLogin is invalid");
  if (github.enabled) {
    if (github.allowedRepositories.length === 0) throw new Error("RoboOMP GitHub bridge is fail-closed: configure allowedRepositories");
    if (github.allowedActors.length === 0) throw new Error("RoboOMP GitHub bridge is fail-closed: configure allowedActors");
    if (!login) throw new Error("roboomp.github.persephoneBotLogin is required when enabled");
    if (!process.env[github.webhookSecretEnv]?.trim()) throw new Error(`roboomp.github.enabled requires ${github.webhookSecretEnv}`);
    if (!process.env[github.approvalTokenEnv]?.trim()) throw new Error(`roboomp.github.enabled requires ${github.approvalTokenEnv}`);
  }
  const dream = github.dream;
  validateBoolean(dream.enabled, "roboomp.github.dream.enabled");
  if (!Number.isInteger(dream.intervalMinutes) || dream.intervalMinutes < 15 || dream.intervalMinutes > 525_600) {
    throw new Error("roboomp.github.dream.intervalMinutes must be an integer from 15 to 525600");
  }
  validateStringArray(dream.repositories, "roboomp.github.dream.repositories");
  if (!dream.profile?.trim()) throw new Error("roboomp.github.dream.profile is required");
  if (!dream.cwdRoot?.trim()) throw new Error("roboomp.github.dream.cwdRoot is required");
  if (!dream.promptFile?.trim()) throw new Error("roboomp.github.dream.promptFile is required");
  if (dream.thinking && !THINKING.has(dream.thinking)) throw new Error("Unsupported dream thinking level");
  validateHttpUrl(dream.issueProxyUrl, "roboomp.github.dream.issueProxyUrl");
  validateEnvName(dream.issueProxyKeyEnv, "roboomp.github.dream.issueProxyKeyEnv");
  if (dream.enabled) {
    if (dream.repositories.length === 0) throw new Error("dream loop is fail-closed: configure dream.repositories");
    const allowedRepos = new Set(github.allowedRepositories.map((repo) => repo.trim().toLowerCase()));
    for (const repo of dream.repositories) {
      if (!allowedRepos.has(repo.trim().toLowerCase())) throw new Error(`dream repository is not allowlisted: ${repo}`);
    }
    const directiveAuthor = dream.directiveAuthor.trim().toLowerCase();
    if (!directiveAuthor) throw new Error("roboomp.github.dream.directiveAuthor is required when dream is enabled");
    if (!github.allowedActors.some((actor) => actor.trim().toLowerCase() === directiveAuthor)) {
      throw new Error("dream.directiveAuthor must be present in allowedActors");
    }
    if (!process.env[dream.issueProxyKeyEnv]?.trim()) throw new Error(`dream loop requires ${dream.issueProxyKeyEnv}`);
    if (!process.env[github.replayTokenEnv]?.trim()) throw new Error(`dream loop requires ${github.replayTokenEnv} for native RoboOMP triage`);
  }
  const ensemble = github.ensemble;
  validateBoolean(ensemble.enabled, "roboomp.github.ensemble.enabled");
  if (typeof ensemble.profile !== "string" || !ensemble.profile.trim()) throw new Error("roboomp.github.ensemble.profile is required");
  if (typeof ensemble.cwd !== "string" || !ensemble.cwd.trim()) throw new Error("roboomp.github.ensemble.cwd is required");
  if (ensemble.thinking && !THINKING.has(ensemble.thinking)) throw new Error("Unsupported ensemble thinking level");
  if (!Array.isArray(ensemble.personas) || ensemble.personas.length !== 3) {
    throw new Error("roboomp.github.ensemble.personas must contain exactly three personas");
  }
  const ids = new Set<string>();
  const botLogins = new Set<string>();
  for (const [index, persona] of ensemble.personas.entries()) {
    const prefix = `roboomp.github.ensemble.personas[${index}]`;
    if (!persona.id?.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(persona.id)) throw new Error(`${prefix}.id is invalid`);
    if (ids.has(persona.id)) throw new Error(`${prefix}.id must be unique`);
    ids.add(persona.id);
    if (!persona.name?.trim()) throw new Error(`${prefix}.name is required`);
    if (!persona.promptFile?.trim()) throw new Error(`${prefix}.promptFile is required`);
    validateHttpUrl(persona.commentProxyUrl, `${prefix}.commentProxyUrl`);
    validateEnvName(persona.commentProxyKeyEnv, `${prefix}.commentProxyKeyEnv`);
    const personaLogin = persona.botLogin?.trim().toLowerCase();
    if (personaLogin && !validGitHubLogin(personaLogin)) throw new Error(`${prefix}.botLogin is invalid`);
    if (ensemble.enabled) {
      if (!personaLogin) throw new Error(`${prefix}.botLogin is required when ensemble is enabled`);
      if (personaLogin === login || botLogins.has(personaLogin)) throw new Error(`${prefix}.botLogin must be a distinct GitHub identity`);
      if (!process.env[persona.commentProxyKeyEnv]?.trim()) throw new Error(`ensemble requires ${persona.commentProxyKeyEnv}`);
    }
    if (personaLogin) botLogins.add(personaLogin);
  }
  if ((dream.enabled || ensemble.enabled) && !github.enabled) {
    throw new Error("dream and ensemble require roboomp.github.enabled");
  }
}

function resolveRepoFile(value: string): string {
  if (value.startsWith("~")) return expandHome(value);
  return path.isAbsolute(value) ? value : path.join(repoRoot(), value);
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

function validGitHubLogin(value: string): boolean {
  const login = value.trim().replace(/^@/, "").replace(/\[bot\]$/i, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login);
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
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

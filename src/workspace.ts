import { readFileSync, statSync } from "node:fs";
import { applyConfigAndSecrets, envPath, readEnvFile, validateConfig, type ConfigWriteOptions } from "./config.ts";
import { validateCron } from "./cron.ts";
import { PersephoneDatabase } from "./database.ts";
import type { JsonObject, PersephoneConfig, ScheduleRecord } from "./types.ts";

const MAX_MUTATION_BYTES = 1_000_000;
const MAX_MESSAGE_CHARS = 1_000_000;

export interface WorkspaceMutationResult extends JsonObject {
  schemaVersion: "persephone.workspace-mutation.v1";
  action: string;
  changed: boolean;
  restartRequired: boolean;
}

export function workspaceSnapshot(
  config: PersephoneConfig,
  db: PersephoneDatabase,
  runtime: Record<string, unknown> | null = null,
  limit = 50,
): Record<string, unknown> {
  const environment = { ...process.env, ...readEnvFile(envPath()) };
  const secrets = secretDescriptors(config, environment);
  return {
    schemaVersion: "persephone.workspace.v1",
    generatedAt: new Date().toISOString(),
    runtime,
    configuration: structuredClone(config),
    secrets,
    connectors: connectorStates(config, environment),
    setup: setupGuides(config),
    counts: db.status(),
    routes: db.listRoutes(),
    schedules: db.listSchedules(),
    inbox: db.listQueue("inbox", limit),
    outbox: db.listQueue("outbox", limit),
    approvals: db.listApprovals(limit),
    workers: db.listWorkers(limit),
  };
}

export function readWorkspaceMutation(file: string): unknown {
  const size = statSync(file).size;
  if (size < 2 || size > MAX_MUTATION_BYTES) {
    throw new Error(`Workspace mutation must contain 2-${MAX_MUTATION_BYTES} bytes`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

export function applyWorkspaceMutation(
  value: unknown,
  config: PersephoneConfig,
  db: PersephoneDatabase,
  writeOptions: ConfigWriteOptions = {},
): WorkspaceMutationResult {
  const payload = asRecord(value, "workspace mutation");
  if (payload.version !== 1) throw new Error("Workspace mutation version must be 1");
  const action = requiredString(payload.action, "action", 80);

  if (action === "configuration.replace") {
    const candidate = asRecord(payload.configuration, "configuration") as unknown as PersephoneConfig;
    const updates = optionalSecretUpdates(payload.secrets);
    const allowedNames = secretNames(candidate);
    validateConfig(candidate, environmentWithUpdates(updates, writeOptions.envFile));
    const result = applyConfigAndSecrets(candidate, updates, allowedNames, writeOptions);
    return mutationResult(action, true, true, {
      updatedSecretNames: result.updatedSecretNames,
      removedSecretNames: result.removedSecretNames,
    });
  }

  if (action === "schedule.put") {
    const schedule = parseSchedule(payload.schedule, config);
    return mutationResult(action, true, false, { schedule: db.putSchedule(schedule) });
  }
  if (action === "schedule.remove") {
    const name = requiredString(payload.name, "name", 160);
    return mutationResult(action, db.removeSchedule(name), false, { name });
  }
  if (action === "schedule.enable") {
    const name = requiredString(payload.name, "name", 160);
    const enabled = requiredBoolean(payload.enabled, "enabled");
    return mutationResult(action, db.setScheduleEnabled(name, enabled), false, { name, enabled });
  }
  if (action === "route.remove") {
    const channel = identifier(payload.channel, "channel", 80);
    const peerId = requiredString(payload.peerId, "peerId", 500);
    return mutationResult(action, db.removeRoute(channel, peerId), false, { channel, peerId });
  }
  if (action === "queue.retry") {
    const kind = queueKind(payload.kind);
    const id = positiveInteger(payload.id, "id");
    return mutationResult(action, db.retryQueueRecord(kind, id), false, { kind, id });
  }
  if (action === "prompt.enqueue") {
    const channel = identifier(payload.channel, "channel", 80);
    const peerId = requiredString(payload.peerId, "peerId", 500);
    const message = requiredString(payload.message, "message", MAX_MESSAGE_CHARS);
    const messageId = `workspace:${crypto.randomUUID()}`;
    const inboxId = db.enqueueInbox(channel, peerId, messageId, message);
    return mutationResult(action, inboxId !== null, false, { channel, peerId, inboxId });
  }
  throw new Error(`Unsupported workspace mutation action: ${action}`);
}

export function secretNames(config: PersephoneConfig): Set<string> {
  return new Set([
    config.listen.tokenEnv,
    config.signal.accountEnv,
    config.discord.tokenEnv,
    config.slack.botTokenEnv,
    config.slack.appTokenEnv,
    config.web.firecrawl.apiKeyEnv,
    config.web.camofox.apiKeyEnv,
  ]);
}

function secretDescriptors(
  config: PersephoneConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Array<Record<string, unknown>> {
  const uses = new Map<string, string[]>();
  const add = (name: string, use: string) => uses.set(name, [...(uses.get(name) || []), use]);
  add(config.listen.tokenEnv, "Control API bearer token");
  add(config.signal.accountEnv, "Signal account");
  add(config.discord.tokenEnv, "Discord bot token");
  add(config.slack.botTokenEnv, "Slack bot token");
  add(config.slack.appTokenEnv, "Slack app token");
  add(config.web.firecrawl.apiKeyEnv, "Firecrawl API key");
  add(config.web.camofox.apiKeyEnv, "Camofox API key");
  return [...uses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, ownedBy]) => ({
      name,
      configured: Boolean(environment[name]?.trim()),
      ownedBy,
      writeOnly: true,
    }));
}

function connectorStates(
  config: PersephoneConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const signalAllowlist = config.signal.allowAll || config.signal.allowedSenders.length > 0 || config.signal.allowedGroups.length > 0;
  const discordAllowlist = config.discord.allowAll || config.discord.allowedUsers.length > 0 || config.discord.allowedGuilds.length > 0 || config.discord.allowedChannels.length > 0;
  const slackAllowlist = config.slack.allowAll || config.slack.allowedUsers.length > 0 || config.slack.allowedTeams.length > 0 || config.slack.allowedChannels.length > 0;
  return {
    signal: {
      enabled: config.signal.enabled,
      ready: Boolean(environment[config.signal.accountEnv]?.trim()) && signalAllowlist,
      endpoint: config.signal.url,
      accountConfigured: Boolean(environment[config.signal.accountEnv]?.trim()),
      allowlistConfigured: signalAllowlist,
      allowAll: config.signal.allowAll,
    },
    discord: {
      enabled: config.discord.enabled,
      ready: Boolean(environment[config.discord.tokenEnv]?.trim()) && discordAllowlist,
      tokenConfigured: Boolean(environment[config.discord.tokenEnv]?.trim()),
      allowlistConfigured: discordAllowlist,
      allowAll: config.discord.allowAll,
      requireMention: config.discord.requireMention,
    },
    slack: {
      enabled: config.slack.enabled,
      ready: Boolean(environment[config.slack.botTokenEnv]?.trim()) && Boolean(environment[config.slack.appTokenEnv]?.trim()) && slackAllowlist,
      botTokenConfigured: Boolean(environment[config.slack.botTokenEnv]?.trim()),
      appTokenConfigured: Boolean(environment[config.slack.appTokenEnv]?.trim()),
      allowlistConfigured: slackAllowlist,
      allowAll: config.slack.allowAll,
      requireMention: config.slack.requireMention,
    },
  };
}

function setupGuides(config: PersephoneConfig): Record<string, unknown> {
  return {
    signal: {
      title: "Signal",
      summary: "Connect Persephone to one local signal-cli JSON-RPC/SSE account.",
      steps: [
        "Start signal-cli's local HTTP service and verify its /api/v1/check endpoint.",
        `Write the registered account to ${config.signal.accountEnv}.`,
        "Add at least one sender phone number or group ID, unless allow-all is deliberately enabled.",
        "Enable Signal, save the configuration, and restart Persephone.",
      ],
      copy: [
        { label: "Secret entry", value: `${config.signal.accountEnv}=+15551234567` },
        { label: "Health URL", value: `${config.signal.url.replace(/\/$/, "")}/api/v1/check` },
      ],
    },
    discord: {
      title: "Discord",
      summary: "Connect a Discord bot through Gateway v10 and the REST API.",
      steps: [
        "Create a bot in the Discord Developer Portal and enable the Message Content privileged intent.",
        `Write its token to ${config.discord.tokenEnv}.`,
        "Invite it with View Channels, Send Messages, and Read Message History only where it should operate.",
        "Add user, server, or channel IDs to the allowlists; mention gating remains enabled by default.",
        "Enable Discord, save the configuration, and restart Persephone.",
      ],
      copy: [
        { label: "Secret entry", value: `${config.discord.tokenEnv}=BOT_TOKEN` },
        {
          label: "Bot invite template",
          value: "https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&permissions=68608&scope=bot",
        },
      ],
    },
    slack: {
      title: "Slack",
      summary: "Connect a Slack app through Socket Mode and the Web API.",
      steps: [
        "Create a Slack app, enable Socket Mode, and create an app token with connections:write.",
        "Grant the bot app_mentions:read, chat:write, and the history scopes for the channel types it may use.",
        "Subscribe to app_mention and message.im; add channel message events only when mention gating is disabled.",
        `Write the bot and app tokens to ${config.slack.botTokenEnv} and ${config.slack.appTokenEnv}.`,
        "Add user, workspace, or channel IDs to the allowlists, enable Slack, save, and restart Persephone.",
      ],
      copy: [
        { label: "Bot secret entry", value: `${config.slack.botTokenEnv}=xoxb-...` },
        { label: "App secret entry", value: `${config.slack.appTokenEnv}=xapp-...` },
        {
          label: "Socket Mode manifest fields",
          value: "socket_mode_enabled: true\nsettings:\n  event_subscriptions:\n    bot_events:\n      - app_mention\n      - message.im\noauth_config:\n  scopes:\n    bot:\n      - app_mentions:read\n      - chat:write\n      - im:history",
        },
      ],
    },
  };
}

function parseSchedule(value: unknown, config: PersephoneConfig): Omit<ScheduleRecord, "id" | "lastMinute" | "lastStatus" | "lastError"> {
  const input = asRecord(value, "schedule");
  const cron = requiredString(input.cron, "schedule.cron", 160);
  validateCron(cron);
  const channelValue = optionalString(input.channel, "schedule.channel", 80);
  const peerValue = optionalString(input.peerId, "schedule.peerId", 500);
  if ((channelValue === null) !== (peerValue === null)) throw new Error("Schedule channel and peerId must be supplied together");
  return {
    name: requiredString(input.name, "schedule.name", 160),
    cron,
    prompt: requiredString(input.prompt, "schedule.prompt", MAX_MESSAGE_CHARS),
    cwd: optionalString(input.cwd, "schedule.cwd", 4000) || config.omp.cwd,
    profile: optionalString(input.profile, "schedule.profile", 160) || config.omp.profile,
    channel: channelValue,
    peerId: peerValue,
    enabled: input.enabled === undefined ? true : requiredBoolean(input.enabled, "schedule.enabled"),
  };
}

function optionalSecretUpdates(value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  const input = asRecord(value, "secrets");
  const output: Record<string, string | null> = {};
  for (const [name, secret] of Object.entries(input)) {
    if (secret !== null && typeof secret !== "string") throw new Error(`Secret ${name} must be a string or null`);
    output[name] = secret;
  }
  return output;
}

function environmentWithUpdates(
  updates: Record<string, string | null>,
  envFile = envPath(),
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env, ...readEnvFile(envFile) };
  for (const [name, value] of Object.entries(updates)) {
    if (value === null || value === "") delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

function mutationResult(
  action: string,
  changed: boolean,
  restartRequired: boolean,
  details: JsonObject = {},
): WorkspaceMutationResult {
  return {
    schemaVersion: "persephone.workspace-mutation.v1",
    action,
    changed,
    restartRequired,
    ...details,
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > maxLength || /\0/.test(result)) throw new Error(`${field} must contain 1-${maxLength} characters`);
  return result;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, field, maxLength);
}

function identifier(value: unknown, field: string, maxLength: number): string {
  const result = requiredString(value, field, maxLength);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new Error(`${field} contains unsupported characters`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${field} must be a positive integer`);
  return result;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function queueKind(value: unknown): "inbox" | "outbox" {
  if (value !== "inbox" && value !== "outbox") throw new Error("kind must be inbox or outbox");
  return value;
}

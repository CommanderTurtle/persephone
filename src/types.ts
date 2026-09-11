export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PersephoneConfig {
  version: 1;
  listen: {
    host: string;
    port: number;
    tokenEnv: string;
  };
  omp: {
    command: string;
    interactiveProfile: string;
    profile: string;
    cwd: string;
    maxWorkers: number;
    idleSeconds: number;
    /** Exact provider/model selectors, or @role aliases, that accept direct image input. */
    imageModels: string[];
    provider?: string;
    model?: string;
    thinking?: ThinkingLevel;
  };
  signal: {
    enabled: boolean;
    url: string;
    accountEnv: string;
    allowedSenders: string[];
    allowedGroups: string[];
    allowAll: boolean;
    typing: boolean;
  };
  discord: {
    enabled: boolean;
    tokenEnv: string;
    allowedUsers: string[];
    allowedGuilds: string[];
    allowedChannels: string[];
    allowAll: boolean;
    requireMention: boolean;
  };
  slack: {
    enabled: boolean;
    botTokenEnv: string;
    appTokenEnv: string;
    allowedUsers: string[];
    allowedTeams: string[];
    allowedChannels: string[];
    allowAll: boolean;
    requireMention: boolean;
  };
  roboomp: {
    enabled: boolean;
    url: string;
  };
  integrations: {
    servicesRoot: string;
    localflameRoot: string;
    localflame: boolean;
    contextMode: boolean;
    librarian: boolean;
    retrieval: boolean;
    codebaseMemory: boolean;
    camofox: boolean;
  };
  web: {
    firecrawl: {
      url: string;
      apiKeyEnv: string;
    };
    camofox: {
      replaceNativeBrowser: boolean;
      url: string;
      apiKeyEnv: string;
      userId: string;
    };
  };
  scheduler: {
    pollSeconds: number;
  };
  security: {
    approvalTimeoutSeconds: number;
  };
}

export interface RouteRecord {
  channel: string;
  peerId: string;
  sessionPath: string | null;
  cwd: string;
  profile: string;
  provider: string | null;
  model: string | null;
  thinking: ThinkingLevel | null;
  createdAt: number;
  updatedAt: number;
}

export interface InboxRecord {
  id: number;
  channel: string;
  peerId: string;
  messageId: string;
  body: string;
  receivedAt: number;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  error: string | null;
}

export interface ScheduleRecord {
  id: number;
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  profile: string;
  channel: string | null;
  peerId: string | null;
  enabled: boolean;
  lastMinute: number | null;
  lastStatus: string | null;
  lastError: string | null;
}

export type JsonObject = Record<string, unknown>;

export interface OmpWorkerOptions {
  key: string;
  command: string;
  profile: string;
  cwd: string;
  sessionPath?: string | null;
  provider?: string | null;
  model?: string | null;
  thinking?: ThinkingLevel | null;
  onSession: (path: string) => void;
  onUiRequest: (request: JsonObject) => Promise<JsonObject>;
  onExit?: () => void;
}

export interface OmpRunResult {
  text: string;
  sessionPath: string | null;
  sessionId: string;
}

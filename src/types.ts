export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GitHubEnsemblePersona {
  id: string;
  name: string;
  botLogin: string;
  promptFile: string;
  commentProxyUrl: string;
  commentProxyKeyEnv: string;
}

export interface RoboOmpGitHubConfig {
  enabled: boolean;
  orchestratorUrl: string;
  upstreamProxyUrl: string;
  workspaceRoot: string;
  allowedRepositories: string[];
  allowedActors: string[];
  persephoneBotLogin: string;
  webhookSecretEnv: string;
  approvalTokenEnv: string;
  replayTokenEnv: string;
  proposalMaxDiffBytes: number;
  dream: {
    enabled: boolean;
    automatic: boolean;
    intervalMinutes: number;
    repositories: string[];
    directiveAuthor: string;
    profile: string;
    cwdRoot: string;
    provider?: string;
    model?: string;
    thinking?: ThinkingLevel;
    promptFile: string;
    issueProxyUrl: string;
    issueProxyKeyEnv: string;
  };
  ensemble: {
    enabled: boolean;
    profile: string;
    cwd: string;
    provider?: string;
    model?: string;
    thinking?: ThinkingLevel;
    personas: GitHubEnsemblePersona[];
  };
}

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
    github: RoboOmpGitHubConfig;
  };
  integrations: {
    servicesRoot: string;
    contextMode: boolean;
    librarian: boolean;
    retrieval: boolean;
    codebaseMemory: boolean;
    camofox: boolean;
  };
  web: {
    firecrawl: {
      enabled: boolean;
      url: string;
      apiKeyEnv: string;
      timeoutSeconds: number;
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
  extraArgs?: string[];
  scrubEnv?: string[];
  onSession: (path: string) => void;
  onUiRequest: (request: JsonObject) => Promise<JsonObject>;
  onExit?: () => void;
}

export interface OmpRunResult {
  text: string;
  sessionPath: string | null;
  sessionId: string;
}

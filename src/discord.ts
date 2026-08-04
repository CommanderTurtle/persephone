import type { PersephoneConfig } from "./types.ts";
import type { ChatTransport, TransportInbound } from "./transport.ts";
import { AsyncEventQueue, sleep, splitMessage } from "./transport.ts";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_INTENTS = 1 | 512 | 4096 | 32768;

export class DiscordClient implements ChatTransport {
  readonly channel = "discord";
  private readonly token: string;
  private botUserId = "";

  constructor(private readonly config: PersephoneConfig["discord"]) {
    this.token = process.env[config.tokenEnv]?.trim() || "";
    if (!this.token) throw new Error(`Missing Discord bot token in ${config.tokenEnv}`);
  }

  async health(): Promise<boolean> {
    try {
      const me = await this.api("/users/@me");
      this.botUserId = stringField(me, "id");
      return Boolean(this.botUserId);
    } catch {
      return false;
    }
  }

  async *events(signal: AbortSignal): AsyncGenerator<TransportInbound> {
    const queue = new AsyncEventQueue<TransportInbound>();
    void this.pump(signal, (event) => queue.push(event)).then(
      () => queue.close(),
      (error) => queue.close(error),
    );
    while (!signal.aborted) {
      const event = await queue.shift(signal);
      if (!event) return;
      yield event;
    }
  }

  async send(peerId: string, body: string): Promise<void> {
    const channelId = parseChannelPeer(peerId);
    for (const content of splitMessage(body, 1900)) {
      await this.api(`/channels/${encodeURIComponent(channelId)}/messages`, { content });
    }
  }

  async typing(peerId: string, active: boolean): Promise<void> {
    if (!active) return;
    const channelId = parseChannelPeer(peerId);
    await this.api(`/channels/${encodeURIComponent(channelId)}/typing`, {});
  }

  private async pump(signal: AbortSignal, emit: (event: TransportInbound) => void): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.connect(signal, emit);
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[discord] ${formatError(error)}`);
      }
      await sleep(2000 + Math.floor(Math.random() * 1000), signal);
    }
  }

  private async connect(signal: AbortSignal, emit: (event: TransportInbound) => void): Promise<void> {
    const gateway = await this.api("/gateway/bot");
    const baseUrl = stringField(gateway, "url");
    if (!baseUrl) throw new Error("Discord gateway response did not include a URL");
    const url = new URL(baseUrl);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      let sequence: number | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let settled = false;

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        socket.close(1000, "Persephone stopping");
        finish();
      };
      signal.addEventListener("abort", abort, { once: true });

      socket.addEventListener("message", (message) => {
        try {
          const payload = asObject(JSON.parse(String(message.data)));
          const op = Number(payload.op);
          if (typeof payload.s === "number") sequence = payload.s;
          if (op === 10) {
            const interval = Number(asObject(payload.d).heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1000) throw new Error("Discord sent an invalid heartbeat interval");
            const sendHeartbeat = () => socket.send(JSON.stringify({ op: 1, d: sequence }));
            heartbeat = setInterval(sendHeartbeat, interval);
            socket.send(JSON.stringify({
              op: 2,
              d: {
                token: this.token,
                intents: DISCORD_INTENTS,
                properties: { os: process.platform, browser: "persephone", device: "persephone" },
              },
            }));
            return;
          }
          if (op === 7 || op === 9) {
            socket.close(4000, "Discord requested reconnect");
            return;
          }
          if (op !== 0) return;
          const eventName = String(payload.t || "");
          const data = asObject(payload.d);
          if (eventName === "READY") {
            this.botUserId = stringField(asObject(data.user), "id");
          } else if (eventName === "MESSAGE_CREATE") {
            const event = this.parseMessage(data);
            if (event) emit(event);
          }
        } catch (error) {
          console.error(`[discord:event] ${formatError(error)}`);
        }
      });
      socket.addEventListener("close", () => finish());
      socket.addEventListener("error", () => finish(new Error("Discord gateway WebSocket failed")));
    });
  }

  private parseMessage(message: Record<string, unknown>): TransportInbound | null {
    const author = asObject(message.author);
    const senderId = stringField(author, "id");
    const channelId = stringField(message, "channel_id");
    const messageId = stringField(message, "id");
    const guildId = stringField(message, "guild_id");
    if (!senderId || !channelId || !messageId || author.bot === true || senderId === this.botUserId) return null;

    const isDirect = !guildId;
    if (!this.config.allowAll) {
      if (isDirect) {
        if (!this.config.allowedUsers.includes(senderId)) return null;
      } else {
        if (this.config.allowedUsers.length && !this.config.allowedUsers.includes(senderId)) return null;
        if (this.config.allowedGuilds.length && !this.config.allowedGuilds.includes(guildId)) return null;
        if (this.config.allowedChannels.length && !this.config.allowedChannels.includes(channelId)) return null;
      }
    }

    const mentions = Array.isArray(message.mentions) ? message.mentions.map(asObject) : [];
    const mentioned = Boolean(this.botUserId) && mentions.some((entry) => stringField(entry, "id") === this.botUserId);
    if (!isDirect && this.config.requireMention && !mentioned) return null;
    const rawBody = stringField(message, "content");
    const body = stripDiscordMention(rawBody, this.botUserId).trim();
    if (!body) return null;
    const timestamp = Date.parse(stringField(message, "timestamp"));
    return {
      peerId: `channel:${channelId}`,
      senderId,
      messageId,
      body,
      receivedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
  }

  private async api(pathname: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${DISCORD_API}${pathname}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bot ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Discord API ${pathname} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (response.status === 204) return {};
    return asObject(await response.json());
  }
}

function parseChannelPeer(peerId: string): string {
  if (!peerId.startsWith("channel:") || peerId.length <= 8) {
    throw new Error("Discord destination must be channel:CHANNEL_ID");
  }
  return peerId.slice(8);
}

function stripDiscordMention(body: string, botUserId: string): string {
  if (!botUserId) return body;
  return body.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), " ");
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

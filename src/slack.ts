import type { PersephoneConfig } from "./types.ts";
import type { ChatTransport, TransportInbound } from "./transport.ts";
import { AsyncEventQueue, sleep, splitMessage } from "./transport.ts";

const SLACK_API = "https://slack.com/api";

export class SlackClient implements ChatTransport {
  readonly channel = "slack";
  private readonly botToken: string;
  private readonly appToken: string;
  private botUserId = "";

  constructor(private readonly config: PersephoneConfig["slack"]) {
    this.botToken = process.env[config.botTokenEnv]?.trim() || "";
    this.appToken = process.env[config.appTokenEnv]?.trim() || "";
    if (!this.botToken) throw new Error(`Missing Slack bot token in ${config.botTokenEnv}`);
    if (!this.appToken) throw new Error(`Missing Slack app token in ${config.appTokenEnv}`);
  }

  async health(): Promise<boolean> {
    try {
      const auth = await this.api("auth.test", {}, this.botToken);
      this.botUserId = stringField(auth, "user_id");
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
    const destination = parseSlackPeer(peerId);
    for (const text of splitMessage(body, 3900)) {
      await this.api("chat.postMessage", {
        channel: destination.channelId,
        text,
        ...(destination.threadTs ? { thread_ts: destination.threadTs } : {}),
      }, this.botToken);
    }
  }

  async typing(_peerId: string, _active: boolean): Promise<void> {
    // Slack's Web API does not expose a supported bot typing endpoint.
  }

  private async pump(signal: AbortSignal, emit: (event: TransportInbound) => void): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.connect(signal, emit);
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[slack] ${formatError(error)}`);
      }
      await sleep(2000 + Math.floor(Math.random() * 1000), signal);
    }
  }

  private async connect(signal: AbortSignal, emit: (event: TransportInbound) => void): Promise<void> {
    if (!this.botUserId && !(await this.health())) throw new Error("Slack auth.test failed");
    const connection = await this.api("apps.connections.open", {}, this.appToken);
    const url = stringField(connection, "url");
    if (!url) throw new Error("Slack Socket Mode did not return a WebSocket URL");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
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
          const envelope = asObject(JSON.parse(String(message.data)));
          const envelopeId = stringField(envelope, "envelope_id");
          if (envelopeId) socket.send(JSON.stringify({ envelope_id: envelopeId }));
          if (envelope.type === "disconnect") {
            socket.close(4000, "Slack requested reconnect");
            return;
          }
          if (envelope.type !== "events_api") return;
          const payload = asObject(envelope.payload);
          const event = this.parseEvent(asObject(payload.event), payload);
          if (event) emit(event);
        } catch (error) {
          console.error(`[slack:event] ${formatError(error)}`);
        }
      });
      socket.addEventListener("close", () => finish());
      socket.addEventListener("error", () => finish(new Error("Slack Socket Mode WebSocket failed")));
    });
  }

  private parseEvent(event: Record<string, unknown>, payload: Record<string, unknown>): TransportInbound | null {
    const eventType = stringField(event, "type");
    if (!new Set(["message", "app_mention"]).has(eventType)) return null;
    if (event.subtype || event.bot_id) return null;
    const senderId = stringField(event, "user");
    const channelId = stringField(event, "channel");
    const eventTs = stringField(event, "ts");
    if (!senderId || !channelId || !eventTs || senderId === this.botUserId) return null;

    const teamId = stringField(payload, "team_id");
    const isDirect = event.channel_type === "im";
    if (!this.config.allowAll) {
      if (isDirect) {
        if (!this.config.allowedUsers.includes(senderId)) return null;
      } else {
        if (this.config.allowedUsers.length && !this.config.allowedUsers.includes(senderId)) return null;
        if (this.config.allowedTeams.length && !this.config.allowedTeams.includes(teamId)) return null;
        if (this.config.allowedChannels.length && !this.config.allowedChannels.includes(channelId)) return null;
      }
    }
    const rawBody = stringField(event, "text");
    const mentioned = Boolean(this.botUserId) && rawBody.includes(`<@${this.botUserId}>`);
    if (!isDirect && this.config.requireMention && eventType !== "app_mention" && !mentioned) return null;
    const body = stripSlackMention(rawBody, this.botUserId).trim();
    if (!body) return null;
    const threadTs = stringField(event, "thread_ts");
    // A mentioned channel message may arrive through both the `message` and
    // `app_mention` subscriptions. The channel timestamp identifies the
    // underlying Slack message across both envelopes, so the durable inbox
    // can collapse the duplicate without conflating separate channels.
    const messageId = `${channelId}:${eventTs}`;
    return {
      peerId: `channel:${channelId}${threadTs ? `:thread:${threadTs}` : ""}`,
      senderId,
      messageId,
      body,
      receivedAt: Number.parseFloat(eventTs) * 1000 || Date.now(),
    };
  }

  private async api(method: string, body: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Slack API ${method} returned HTTP ${response.status}`);
    const payload = asObject(await response.json());
    if (payload.ok !== true) throw new Error(`Slack API ${method}: ${stringField(payload, "error") || "unknown error"}`);
    return payload;
  }
}

function parseSlackPeer(peerId: string): { channelId: string; threadTs?: string } {
  const match = /^channel:([^:]+)(?::thread:(.+))?$/.exec(peerId);
  if (!match?.[1]) throw new Error("Slack destination must be channel:CHANNEL_ID or channel:CHANNEL_ID:thread:THREAD_TS");
  return { channelId: match[1], ...(match[2] ? { threadTs: match[2] } : {}) };
}

function stripSlackMention(body: string, botUserId: string): string {
  return botUserId ? body.replaceAll(`<@${botUserId}>`, " ") : body;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

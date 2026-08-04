import type { JsonObject, PersephoneConfig } from "./types.ts";

export interface SignalInbound {
  peerId: string;
  senderId: string;
  messageId: string;
  body: string;
  receivedAt: number;
  isGroup: boolean;
}

export class SignalClient {
  private readonly account: string;

  constructor(private readonly config: PersephoneConfig["signal"]) {
    this.account = process.env[config.accountEnv]?.trim() || "";
    if (!this.account) throw new Error(`Missing Signal account in ${config.accountEnv}`);
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.url}/api/v1/check`, { signal: AbortSignal.timeout(10_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async *events(signal: AbortSignal): AsyncGenerator<SignalInbound> {
    while (!signal.aborted) {
      try {
        const url = `${this.config.url}/api/v1/events?account=${encodeURIComponent(this.account)}`;
        const response = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`Signal SSE returned HTTP ${response.status}`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const parsed = parseInbound(JSON.parse(data), this.account, this.config);
            if (parsed) yield parsed;
          }
        }
        if (!signal.aborted) await sleep(2000 + Math.floor(Math.random() * 1000), signal);
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[signal] ${error instanceof Error ? error.message : String(error)}`);
        await sleep(2000 + Math.floor(Math.random() * 1000), signal);
      }
    }
  }

  async send(peerId: string, body: string): Promise<void> {
    const params: JsonObject = { account: this.account, message: body };
    if (peerId.startsWith("group:")) params.groupId = peerId.slice(6);
    else params.recipient = [peerId];
    await this.rpc("send", params);
  }

  async typing(peerId: string, active: boolean): Promise<void> {
    if (!this.config.typing) return;
    const params: JsonObject = { account: this.account, stop: !active };
    if (peerId.startsWith("group:")) params.groupId = peerId.slice(6);
    else params.recipient = [peerId];
    try {
      await this.rpc("sendTyping", params, "typing");
    } catch (error) {
      console.error(`[signal:typing] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async rpc(method: string, params: JsonObject, requestId = `${method}-${Date.now()}`): Promise<unknown> {
    const response = await fetch(`${this.config.url}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Signal RPC ${method} returned HTTP ${response.status}`);
    const result = (await response.json()) as JsonObject;
    if (result.error) throw new Error(`Signal RPC ${method}: ${JSON.stringify(result.error)}`);
    return result.result;
  }
}

function parseInbound(value: unknown, account: string, config: PersephoneConfig["signal"]): SignalInbound | null {
  const root = asObject(value);
  const envelope = asObject(root.envelope ?? root);
  const data = asObject(envelope.dataMessage ?? asObject(envelope.editMessage).dataMessage);
  const body = firstString(data.message).trim();
  if (!body) return null;
  const sender = firstString(envelope.sourceNumber, envelope.sourceUuid, envelope.source);
  if (!sender || sender === account) return null;
  const groupId = firstString(asObject(data.groupInfo).groupId);
  const isGroup = Boolean(groupId);
  if (isGroup) {
    if (!config.allowedGroups.includes(groupId)) return null;
  } else if (!config.allowedSenders.includes(sender)) {
    return null;
  }
  const timestamp = Number(envelope.timestamp ?? data.timestamp ?? Date.now());
  return {
    peerId: isGroup ? `group:${groupId}` : sender,
    senderId: sender,
    messageId: `${sender}:${timestamp}`,
    body,
    receivedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
    isGroup,
  };
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value) return value;
  return "";
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

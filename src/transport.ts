export interface TransportInbound {
  peerId: string;
  senderId: string;
  messageId: string;
  body: string;
  receivedAt: number;
}

export interface ChatTransport {
  readonly channel: string;
  health(): Promise<boolean>;
  events(signal: AbortSignal): AsyncGenerator<TransportInbound>;
  send(peerId: string, body: string): Promise<void>;
  typing(peerId: string, active: boolean): Promise<void>;
}

export class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private error?: unknown;

  push(value: T): void {
    if (this.closed) return;
    this.values.push(value);
    this.wake();
  }

  close(error?: unknown): void {
    this.closed = true;
    this.error = error;
    this.wake();
  }

  async shift(signal: AbortSignal): Promise<T | undefined> {
    while (!signal.aborted) {
      const value = this.values.shift();
      if (value !== undefined) return value;
      if (this.closed) {
        if (this.error) throw this.error;
        return undefined;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          this.waiters.delete(done);
          resolve();
        };
        this.waiters.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    return undefined;
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }
}

export function splitMessage(body: string, limit: number): string[] {
  const remaining = body.trim() || "OMP completed the turn without a text response.";
  const chunks: string[] = [];
  let cursor = remaining;
  while (cursor.length > limit) {
    const newline = cursor.lastIndexOf("\n", limit);
    const space = cursor.lastIndexOf(" ", limit);
    const boundary = Math.max(newline, space, Math.floor(limit * 0.7));
    chunks.push(cursor.slice(0, boundary).trimEnd());
    cursor = cursor.slice(boundary).trimStart();
  }
  if (cursor) chunks.push(cursor);
  return chunks;
}

export async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

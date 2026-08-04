import type { PersephoneConfig } from "./types.ts";

export async function controlRequest<T>(
  config: PersephoneConfig,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const token = process.env[config.listen.tokenEnv]?.trim();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const host = config.listen.host === "0.0.0.0" || config.listen.host === "::" ? "127.0.0.1" : config.listen.host;
  const response = await fetch(`http://${host}:${config.listen.port}${pathname}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as T;
  if (!response.ok) throw new Error(`Persephone HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-persephone-signature";
export const TIMESTAMP_HEADER = "x-persephone-timestamp";
const MAX_CLOCK_SKEW_SECONDS = 300;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyGitHubSignature(secret: string, body: Uint8Array, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return safeEqual(expected, header.slice("sha256=".length));
}

export function signInternalRequest(
  key: string,
  method: string,
  target: string,
  body: Uint8Array,
  timestamp = Math.floor(Date.now() / 1000),
): Headers {
  const canonical = `${timestamp}\n${method.toUpperCase()}\n${target}\n${sha256(body)}`;
  const signature = createHmac("sha256", key).update(canonical).digest("hex");
  return new Headers({
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: `sha256=${signature}`,
  });
}

export function verifyInternalRequest(
  key: string,
  method: string,
  target: string,
  body: Uint8Array,
  headers: Headers,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const rawTimestamp = headers.get(TIMESTAMP_HEADER);
  const supplied = headers.get(SIGNATURE_HEADER);
  if (!rawTimestamp || !supplied?.startsWith("sha256=")) return false;
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = signInternalRequest(key, method, target, body, timestamp).get(SIGNATURE_HEADER)!;
  return safeEqual(expected, supplied);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

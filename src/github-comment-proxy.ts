#!/usr/bin/env bun
import { verifyInternalRequest } from "./github-security.ts";
import { GitHubAuth, tokenHeaders } from "./github-auth.ts";

const auth = GitHubAuth.fromEnv();
const hmacKey = requiredEnv("PERSEPHONE_COMMENT_PROXY_HMAC_KEY");
const expectedLogin = normalizeLogin(requiredEnv("PERSEPHONE_GITHUB_LOGIN"));
const allowedRepositories = new Set(csv(requiredEnv("PERSEPHONE_REPO_ALLOWLIST")).map((value) => value.toLowerCase()));
const host = process.env.PERSEPHONE_COMMENT_PROXY_HOST || "0.0.0.0";
const port = integerEnv("PERSEPHONE_COMMENT_PROXY_PORT", 8091);
let authenticatedLogin: string | null = null;

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      try {
        const login = await verifyIdentity();
        return Response.json({ ok: true, login, capability: "comment-only" });
      } catch (error) {
        return Response.json({ ok: false, error: message(error) }, { status: 503 });
      }
    }
    if (request.method !== "POST" || url.pathname !== "/v1/comment") return Response.json({ error: "not found" }, { status: 404 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!verifyInternalRequest(hmacKey, request.method, url.pathname, bytes, request.headers)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const repo = String(input.repo || "").trim();
    const number = Number(input.number);
    const body = String(input.body || "").trim();
    const sourceKey = String(input.sourceKey || "").trim();
    if (!allowedRepositories.has(repo.toLowerCase())) return Response.json({ error: "repository not allowed" }, { status: 403 });
    if (!Number.isSafeInteger(number) || number < 1) return Response.json({ error: "number must be a positive integer" }, { status: 400 });
    if (!body || body.length > 20_000) return Response.json({ error: "body must contain 1..20000 characters" }, { status: 400 });
    if (!/^[a-z0-9][a-z0-9:-]{1,180}$/i.test(sourceKey)) return Response.json({ error: "sourceKey is invalid" }, { status: 400 });
    try {
      const login = await verifyIdentity();
      const marker = `<!-- persephone-ensemble:${sourceKey} -->`;
      const existing = await findMarker(repo, number, marker, login);
      if (existing) return Response.json({ ...existing, login, duplicate: true });
      const posted = await github(`/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `${body}\n\n${marker}` }),
      });
      return Response.json({
        id: Number(posted.id),
        url: String(posted.html_url || ""),
        login,
        duplicate: false,
      }, { status: 201 });
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 502 });
    }
  },
});

console.log(`[persephone-comment-proxy] ${expectedLogin} listening on ${server.url} (comment-only)`);

async function verifyIdentity(): Promise<string> {
  if (authenticatedLogin) return authenticatedLogin;
  const actual = normalizeLogin(await auth.login());
  if (actual !== expectedLogin) throw new Error(`token identity ${actual || "unknown"} does not match configured ${expectedLogin}`);
  authenticatedLogin = actual;
  return actual;
}

async function findMarker(repo: string, number: number, marker: string, login: string): Promise<{ id: number; url: string } | null> {
  for (let page = 1; page <= 10; page++) {
    const comments = await github(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) break;
    for (const item of comments) {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const author = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : {};
      if (normalizeLogin(String(author.login || "")) === login && String(record.body || "").includes(marker)) {
        return { id: Number(record.id), url: String(record.html_url || "") };
      }
    }
    if (comments.length < 100) break;
  }
  return null;
}

async function github(endpoint: string, init: RequestInit = {}): Promise<any> {
  let access = await auth.accessToken();
  let response = await requestGitHub(endpoint, access.token, init);
  if (response.status === 401 && auth.source.mode === "app") {
    auth.invalidate();
    access = await auth.accessToken(true);
    response = await requestGitHub(endpoint, access.token, init);
  }
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? {} : response.json();
}

function requestGitHub(endpoint: string, token: string, init: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      ...tokenHeaders(token),
      "Content-Type": "application/json",
      "User-Agent": "Persephone-comment-proxy",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`);
  return value;
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeLogin(value: string): string {
  return value.trim().replace(/^@/, "").replace(/\[bot\]$/i, "").toLowerCase();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

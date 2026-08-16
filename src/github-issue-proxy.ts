#!/usr/bin/env bun
import { verifyInternalRequest } from "./github-security.ts";

const token = requiredEnv("GITHUB_TOKEN");
const hmacKey = requiredEnv("PERSEPHONE_ISSUE_PROXY_HMAC_KEY");
const expectedLogin = normalizeLogin(requiredEnv("PERSEPHONE_GITHUB_LOGIN"));
const allowedRepositories = new Set(csv(requiredEnv("PERSEPHONE_REPO_ALLOWLIST")).map((value) => value.toLowerCase()));
const host = process.env.PERSEPHONE_ISSUE_PROXY_HOST || "0.0.0.0";
const port = integerEnv("PERSEPHONE_ISSUE_PROXY_PORT", 8092);
let authenticatedLogin: string | null = null;

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      try {
        const login = await verifyIdentity();
        return Response.json({ ok: true, login, capability: "issue-only" });
      } catch (error) {
        return Response.json({ ok: false, error: message(error) }, { status: 503 });
      }
    }
    if (request.method !== "POST" || url.pathname !== "/v1/issue") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
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
    const title = String(input.title || "").trim();
    const body = String(input.body || "").trim();
    const sourceKey = String(input.sourceKey || "").trim();
    if (!allowedRepositories.has(repo.toLowerCase())) return Response.json({ error: "repository not allowed" }, { status: 403 });
    if (!title || title.length > 256) return Response.json({ error: "title must contain 1..256 characters" }, { status: 400 });
    if (!body || body.length > 60_000) return Response.json({ error: "body must contain 1..60000 characters" }, { status: 400 });
    if (!/^[a-z0-9][a-z0-9:-]{1,180}$/i.test(sourceKey)) return Response.json({ error: "sourceKey is invalid" }, { status: 400 });
    try {
      const login = await verifyIdentity();
      const marker = `<!-- persephone-dream:${sourceKey} -->`;
      const existing = await findMarker(repo, marker, login);
      if (existing) return Response.json({ ...existing, login, duplicate: true });
      const issue = await github(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, body: `${body}\n\n${marker}` }),
      });
      return Response.json({
        number: Number(issue.number),
        url: String(issue.html_url || ""),
        login,
        duplicate: false,
      }, { status: 201 });
    } catch (error) {
      return Response.json({ error: message(error) }, { status: 502 });
    }
  },
});

console.log(`[persephone-issue-proxy] ${expectedLogin} listening on ${server.url} (issue-only)`);

async function verifyIdentity(): Promise<string> {
  if (authenticatedLogin) return authenticatedLogin;
  const user = await github("/user");
  const actual = normalizeLogin(String(user.login || ""));
  if (actual !== expectedLogin) throw new Error(`token identity ${actual || "unknown"} does not match configured ${expectedLogin}`);
  authenticatedLogin = actual;
  return actual;
}

async function findMarker(repo: string, marker: string, login: string): Promise<{ number: number; url: string } | null> {
  for (let page = 1; page <= 10; page++) {
    const issues = await github(`/repos/${repo}/issues?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) break;
    for (const item of issues) {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      if (record.pull_request) continue;
      const author = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : {};
      if (normalizeLogin(String(author.login || "")) === login && String(record.body || "").includes(marker)) {
        return { number: Number(record.number), url: String(record.html_url || "") };
      }
    }
    if (issues.length < 100) break;
  }
  return null;
}

async function github(endpoint: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Persephone-issue-proxy",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? {} : response.json();
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

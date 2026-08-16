import { createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export type GitHubCredentialSource =
  | { mode: "token"; token: string }
  | { mode: "app"; appId: string; installationId: string; privateKey: string | KeyObject };

export type GitHubAccessToken = { token: string; expiresAt: number | null };

export class GitHubAuth {
  private cached: GitHubAccessToken | null = null;
  private cachedLogin: string | null = null;

  constructor(
    readonly source: GitHubCredentialSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAuth {
    const token = env.GITHUB_TOKEN?.trim() || "";
    const appId = env.GITHUB_APP_ID?.trim() || "";
    const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim() || "";
    const privateKeyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim() || "";
    const appRequested = Boolean(appId || installationId);

    if (appRequested && (!appId || !installationId || !privateKeyFile)) {
      throw new Error("GitHub App auth requires GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY_FILE");
    }
    if (appRequested) {
      if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId)) {
        throw new Error("GitHub App and installation IDs must be decimal integers");
      }
      return new GitHubAuth({ mode: "app", appId, installationId, privateKey: readFileSync(privateKeyFile, "utf8") });
    }
    if (!token) throw new Error("Configure either GITHUB_TOKEN or the complete GitHub App credential set");
    return new GitHubAuth({ mode: "token", token });
  }

  async accessToken(forceRefresh = false): Promise<GitHubAccessToken> {
    if (this.source.mode === "token") return { token: this.source.token, expiresAt: null };
    const now = Date.now();
    if (!forceRefresh && this.cached && this.cached.expiresAt && this.cached.expiresAt - now > 5 * 60_000) {
      return this.cached;
    }

    const response = await this.fetchImpl(
      `https://api.github.com/app/installations/${this.source.installationId}/access_tokens`,
      {
        method: "POST",
        headers: appHeaders(this.appJwt()),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub App token HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as Record<string, unknown>;
    const token = String(body.token || "").trim();
    const expiresAt = Date.parse(String(body.expires_at || ""));
    if (!token || !Number.isFinite(expiresAt)) throw new Error("GitHub returned an invalid installation token response");
    this.cached = { token, expiresAt };
    return this.cached;
  }

  async login(): Promise<string> {
    if (this.cachedLogin) return this.cachedLogin;
    if (this.source.mode === "app") {
      const response = await this.fetchImpl("https://api.github.com/app", {
        headers: appHeaders(this.appJwt()),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub App identity HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body = await response.json() as Record<string, unknown>;
      const slug = String(body.slug || "").trim();
      if (!slug) throw new Error("GitHub App identity response did not contain a slug");
      this.cachedLogin = `${slug}[bot]`;
      return this.cachedLogin;
    }

    const access = await this.accessToken();
    const response = await this.fetchImpl("https://api.github.com/user", {
      headers: tokenHeaders(access.token),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub token identity HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as Record<string, unknown>;
    const login = String(body.login || "").trim();
    if (!login) throw new Error("GitHub token identity response did not contain a login");
    this.cachedLogin = login;
    return login;
  }

  invalidate(): void {
    if (this.source.mode === "app") this.cached = null;
  }

  private appJwt(): string {
    if (this.source.mode !== "app") throw new Error("GitHub App JWT requested for token credentials");
    const now = Math.floor(Date.now() / 1000);
    const header = encodeJson({ alg: "RS256", typ: "JWT" });
    const payload = encodeJson({ iat: now - 60, exp: now + 9 * 60, iss: this.source.appId });
    const input = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    signer.end();
    return `${input}.${signer.sign(this.source.privateKey, "base64url")}`;
  }
}

export function tokenHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function appHeaders(jwt: string): Record<string, string> {
  return { ...tokenHeaders(jwt), "User-Agent": "Persephone-github-app-auth" };
}

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

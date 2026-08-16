import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAuth } from "../src/github-auth.ts";

describe("GitHub credential isolation", () => {
  test("uses a static token without network exchange", async () => {
    const auth = new GitHubAuth({ mode: "token", token: "test-token" });
    expect(await auth.accessToken()).toEqual({ token: "test-token", expiresAt: null });
  });

  test("allows a mounted but inactive App key path with token fallback", async () => {
    const auth = GitHubAuth.fromEnv({ GITHUB_TOKEN: "test-token", GITHUB_APP_PRIVATE_KEY_FILE: "/not/read.pem" });
    expect(await auth.accessToken()).toEqual({ token: "test-token", expiresAt: null });
  });

  test("mints and caches a GitHub App installation token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let exchanges = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app")) return Response.json({ slug: "clio-ensemble" });
      exchanges++;
      return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    }) as typeof fetch;
    const auth = new GitHubAuth({ mode: "app", appId: "123", installationId: "456", privateKey }, fakeFetch);

    expect(await auth.login()).toBe("clio-ensemble[bot]");
    expect((await auth.accessToken()).token).toBe("installation-token");
    expect((await auth.accessToken()).token).toBe("installation-token");
    expect(exchanges).toBe(1);
  });
});

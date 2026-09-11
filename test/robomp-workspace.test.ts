import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRobompMutation,
  normalizeConfigPatch,
  normalizeSecretPatch,
  readSimpleEnv,
  renderEnvUpdates,
  robompPaths,
  robompWorkspaceSnapshot,
  writeEnvUpdates,
} from "../src/robomp-workspace.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): ReturnType<typeof robompPaths> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "persephone-robomp-workspace-"));
  directories.push(directory);
  mkdirSync(path.join(directory, "integrations", "robomp"), { recursive: true });
  mkdirSync(path.join(directory, "scripts"), { recursive: true });
  writeFileSync(path.join(directory, "integrations", "robomp", "compose.yaml"), "services: {}\n");
  writeFileSync(path.join(directory, "scripts", "robomp.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return robompPaths(directory);
}

describe("RoboOMP owner workspace contract", () => {
  test("preserves comments while atomically editing owned environment keys", () => {
    const paths = fixture();
    const source = "# private\nROBOMP_MODEL=old\nGITHUB_TOKEN=secret\nROBOMP_MODEL=duplicate\n";
    writeFileSync(paths.envFile, source, { mode: 0o600 });
    chmodSync(paths.envFile, 0o600);

    expect(writeEnvUpdates(paths.envFile, {
      ROBOMP_MODEL: "local/model",
      ROBOMP_MAX_CONCURRENCY: "4",
      GITHUB_TOKEN: null,
    })).toBe(true);
    const rendered = readFileSync(paths.envFile, "utf8");
    expect(rendered).toContain("# private");
    expect(rendered).toContain("ROBOMP_MODEL=local/model");
    expect(rendered.match(/ROBOMP_MODEL=/g)).toHaveLength(1);
    expect(rendered).toContain("ROBOMP_MAX_CONCURRENCY=4");
    expect(rendered).not.toContain("GITHUB_TOKEN");
    expect(readSimpleEnv(paths.envFile).ROBOMP_MODEL).toBe("local/model");
  });

  test("normalizes typed configuration and rejects non-loopback dashboard hosts", () => {
    expect(normalizeConfigPatch({
      ROBOMP_MAX_CONCURRENCY: 6,
      ROBOMP_PR_REVIEW_ENABLED: false,
      ROBOMP_REPO_ALLOWLIST: ["owner/one", "owner/two"],
      ROBOMP_PUBLIC_HOST: "127.0.0.1",
    })).toEqual({
      ROBOMP_MAX_CONCURRENCY: "6",
      ROBOMP_PR_REVIEW_ENABLED: "false",
      ROBOMP_REPO_ALLOWLIST: "owner/one,owner/two",
      ROBOMP_PUBLIC_HOST: "127.0.0.1",
    });
    expect(() => normalizeConfigPatch({ ROBOMP_PUBLIC_HOST: "0.0.0.0" })).toThrow("loopback-only");
    expect(() => normalizeConfigPatch({ ROBOMP_UNKNOWN: true })).toThrow("not writable");
  });

  test("accepts only the four write-only secret fields", () => {
    expect(normalizeSecretPatch({ GITHUB_TOKEN: "new-token", ROBOMP_REPLAY_TOKEN: null })).toEqual({
      GITHUB_TOKEN: "new-token",
      ROBOMP_REPLAY_TOKEN: null,
    });
    expect(() => normalizeSecretPatch({ PATH: "bad" })).toThrow("not writable");
    expect(() => normalizeSecretPatch({ GITHUB_TOKEN: "line\nbreak" })).toThrow("one-line");
  });

  test("mutation results never echo secret values", async () => {
    const paths = fixture();
    writeFileSync(paths.envFile, "ROBOMP_MODEL=old\n", { mode: 0o600 });
    chmodSync(paths.envFile, 0o600);
    const result = await applyRobompMutation({
      version: 1,
      action: "configuration.patch",
      values: { ROBOMP_MODEL: "new" },
      secrets: { GITHUB_TOKEN: "the-secret-value" },
    }, paths);
    expect(result.changed).toBe(true);
    expect(result.restartRequired).toBe(true);
    expect(JSON.stringify(result)).not.toContain("the-secret-value");
    expect(readFileSync(paths.envFile, "utf8")).toContain("GITHUB_TOKEN=the-secret-value");
  });

  test("snapshot reports readiness without exposing configured secret values", async () => {
    const paths = fixture();
    writeFileSync(path.join(paths.integration, ".env.example"), "OMP_VERSION=18.1.16\nOMP_COMMIT=abc\n");
    writeFileSync(paths.envFile, [
      "OMP_VERSION=18.1.16",
      "OMP_COMMIT=abc",
      "ROBOMP_PUBLIC_PORT=65534",
      "ROBOMP_MODEL=local/model",
      "ROBOMP_REPLAY_TOKEN=hidden-token",
      "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(paths.envFile, 0o600);
    const snapshot = await robompWorkspaceSnapshot({ paths, limit: 2, timeoutMs: 100 });
    expect(snapshot.schemaVersion).toBe("persephone.robomp.workspace.v1");
    expect(JSON.stringify(snapshot)).not.toContain("hidden-token");
    const secrets = snapshot.secrets as Array<{ name: string; configured: boolean }>;
    expect(secrets.find((entry) => entry.name === "ROBOMP_REPLAY_TOKEN")?.configured).toBe(true);
    const capabilities = snapshot.capabilities as { actions: string[] };
    expect(capabilities.actions).toContain("review.open");
  });

  test("hands an existing host worktree to the fixed review command", async () => {
    const paths = fixture();
    const repository = mkdtempSync(path.join(os.tmpdir(), "persephone-review-repository-"));
    directories.push(repository);
    expect(spawnSync("git", ["init", "--quiet", repository]).status).toBe(0);
    const invocation = path.join(paths.root, "review-invocation.txt");
    writeFileSync(
      paths.script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(invocation)}\nprintf 'review ready\\n'\n`,
      { mode: 0o755 },
    );

    const result = await applyRobompMutation({
      version: 1,
      action: "review.open",
      repositoryPath: repository,
      pullRequest: 27,
    }, paths);

    expect(result).toMatchObject({
      action: "review.open",
      changed: true,
      restartRequired: false,
      repositoryPath: repository,
      pullRequest: 27,
      output: "review ready",
    });
    expect(readFileSync(invocation, "utf8").trim().split("\n")).toEqual([
      "review",
      repository,
      "27",
    ]);
  });

  test("rejects review handoff for a non-worktree or invalid pull request", async () => {
    const paths = fixture();
    await expect(applyRobompMutation({
      version: 1,
      action: "review.open",
      repositoryPath: paths.root,
    }, paths)).rejects.toThrow("not a Git worktree");
    const repository = mkdtempSync(path.join(os.tmpdir(), "persephone-review-invalid-"));
    directories.push(repository);
    expect(spawnSync("git", ["init", "--quiet", repository]).status).toBe(0);
    await expect(applyRobompMutation({
      version: 1,
      action: "review.open",
      repositoryPath: repository,
      pullRequest: 0,
    }, paths)).rejects.toThrow("positive integer");
  });

  test("renderer quotes values that cannot safely remain bare", () => {
    const rendered = renderEnvUpdates("A=one\n", { A: " leading", B: "line: with spaces" });
    expect(rendered).toContain('A=" leading"');
    expect(rendered).toContain("B=line: with spaces");
  });
});

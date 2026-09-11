import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PersephoneDatabase } from "../src/database.ts";
import { serviceLogSnapshot } from "../src/service.ts";
import { applyWorkspaceMutation, workspaceSnapshot } from "../src/workspace.ts";

const directories: string[] = [];
const originalConfigHome = process.env.PERSEPHONE_CONFIG_HOME;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalConfigHome === undefined) delete process.env.PERSEPHONE_CONFIG_HOME;
  else process.env.PERSEPHONE_CONFIG_HOME = originalConfigHome;
});

function fixture(): { directory: string; db: PersephoneDatabase } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "persephone-workspace-test-"));
  directories.push(directory);
  process.env.PERSEPHONE_CONFIG_HOME = path.join(directory, "config-home");
  return {
    directory,
    db: new PersephoneDatabase(path.join(directory, "state.sqlite"), { recover: false }),
  };
}

describe("workspace owner contract", () => {
  test("returns a bounded redacted dashboard model", () => {
    const { db } = fixture();
    const config = structuredClone(DEFAULT_CONFIG);
    db.upsertRoute({
      channel: "discord",
      peerId: "channel:123",
      sessionPath: "/tmp/session.jsonl",
      cwd: "/tmp/project",
      profile: "persephone",
      provider: "openai",
      model: "local",
      thinking: "high",
    });
    db.enqueueInbox("discord", "channel:123", "message-1", "hello from Discord");
    db.enqueueOutbox("discord", "channel:123", "hello back");
    db.updateWorker("discord:channel:123", "/tmp/session.jsonl", 42, "persephone", "/tmp/project", "ready");

    const snapshot = workspaceSnapshot(config, db, { ok: true }, 20);
    expect(snapshot.schemaVersion).toBe("persephone.workspace.v1");
    expect((snapshot.routes as unknown[]).length).toBe(1);
    expect((snapshot.inbox as Array<{ body: string }>)[0]?.body).toBe("hello from Discord");
    expect((snapshot.workers as unknown[]).length).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
    expect((snapshot.setup as Record<string, unknown>).discord).toBeDefined();
    const discordGuide = (snapshot.setup as Record<string, Record<string, unknown>>).discord;
    expect(discordGuide?.validation).toEqual([
      { label: "Connector enabled", ok: false },
      { label: "Bot token stored", ok: false },
      { label: "User, server, or channel allowlist configured", ok: false },
    ]);
    db.close();
  });

  test("returns bounded service logs through the owner command contract", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const snapshot = serviceLogSnapshot(25, ((command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: "one\r\ntwo\r\n", stderr: "", pid: 1, output: [] };
    }) as unknown as typeof spawnSync, "/usr/bin/journalctl");
    expect(snapshot).toMatchObject({
      schemaVersion: "persephone.workspace-logs.v1",
      source: "systemd-user-journal",
      available: true,
      lines: 25,
      text: "one\ntwo\n",
      truncated: false,
    });
    expect(calls).toEqual([{
      command: "/usr/bin/journalctl",
      args: ["--user", "--unit=persephone.service", "--no-pager", "--output=short-iso", "--lines=25"],
    }]);
  });

  test("applies one validated configuration and write-only secret mutation", () => {
    const { directory, db } = fixture();
    const config = structuredClone(DEFAULT_CONFIG);
    config.discord.enabled = true;
    config.discord.allowedUsers = ["123456789"];
    const configFile = path.join(directory, "config.json");
    const envFile = path.join(directory, ".env");
    const result = applyWorkspaceMutation(
      {
        version: 1,
        action: "configuration.replace",
        configuration: config,
        secrets: { DISCORD_BOT_TOKEN: "secret-value" },
      },
      structuredClone(DEFAULT_CONFIG),
      db,
      { configFile, envFile },
    );
    expect(result.changed).toBe(true);
    expect(result.restartRequired).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(readFileSync(envFile, "utf8")).toContain("DISCORD_BOT_TOKEN=secret-value");
    expect(JSON.parse(readFileSync(configFile, "utf8")).discord.enabled).toBe(true);
    db.close();
  });

  test("mutates schedules, routes, queues, and prompt dispatch through typed actions", () => {
    const { db } = fixture();
    const config = structuredClone(DEFAULT_CONFIG);
    const schedule = applyWorkspaceMutation({
      version: 1,
      action: "schedule.put",
      schedule: { name: "daily", cron: "0 6 * * *", prompt: "Review the queue", enabled: true },
    }, config, db);
    expect(schedule.changed).toBe(true);
    expect(db.listSchedules()).toHaveLength(1);

    db.upsertRoute({
      channel: "signal",
      peerId: "+15551234567",
      sessionPath: null,
      cwd: "/tmp",
      profile: "persephone",
      provider: null,
      model: null,
      thinking: null,
    });
    expect(applyWorkspaceMutation({
      version: 1,
      action: "route.remove",
      channel: "signal",
      peerId: "+15551234567",
    }, config, db).changed).toBe(true);

    const failedId = db.enqueueInbox("api", "owner", "failed-1", "retry me")!;
    const claimed = db.claimInbox(1)[0]!;
    expect(claimed.id).toBe(failedId);
    db.finishInbox(failedId, "temporary failure");
    expect(applyWorkspaceMutation({ version: 1, action: "queue.retry", kind: "inbox", id: failedId }, config, db).changed).toBe(true);

    const prompt = applyWorkspaceMutation({
      version: 1,
      action: "prompt.enqueue",
      channel: "api",
      peerId: "owner",
      message: "Run a read-only audit",
    }, config, db);
    expect(prompt.changed).toBe(true);
    expect(db.status().pendingInbox).toBe(2);
    db.close();
  });
});

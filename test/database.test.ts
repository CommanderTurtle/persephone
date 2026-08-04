import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersephoneDatabase } from "../src/database.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("database", () => {
  test("deduplicates inbox messages and persists routes", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "persephone-test-"));
    directories.push(directory);
    const db = new PersephoneDatabase(path.join(directory, "state.sqlite"));
    const route = db.upsertRoute({
      channel: "signal",
      peerId: "+10000000000",
      sessionPath: null,
      cwd: "/tmp/project",
      profile: "default",
      provider: null,
      model: null,
      thinking: "high",
    });
    expect(route.cwd).toBe("/tmp/project");
    expect(db.enqueueInbox("signal", route.peerId, "message-1", "hello")).toBeNumber();
    expect(db.enqueueInbox("signal", route.peerId, "message-1", "hello")).toBeNull();
    const claimed = db.claimInbox();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("running");
    db.finishInbox(claimed[0]!.id);
    expect(db.status().pendingInbox).toBe(0);
    db.close();
  });

  test("claims a schedule only once per minute before execution", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "persephone-test-"));
    directories.push(directory);
    const db = new PersephoneDatabase(path.join(directory, "state.sqlite"));
    const schedule = db.putSchedule({
      name: "audit",
      cron: "* * * * *",
      prompt: "Audit the repository",
      cwd: "/tmp/project",
      profile: "default",
      channel: null,
      peerId: null,
      enabled: true,
    });
    expect(db.claimSchedule(schedule.id, 1234)).toBe(true);
    expect(db.claimSchedule(schedule.id, 1234)).toBe(false);
    expect(db.listSchedules()[0]?.lastStatus).toBe("running");
    db.markSchedule(schedule.id, 1234);
    expect(db.listSchedules()[0]?.lastStatus).toBe("done");
    db.close();
  });

  test("binds approvals to their originating transport and conversation", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "persephone-test-"));
    directories.push(directory);
    const db = new PersephoneDatabase(path.join(directory, "state.sqlite"));
    const approval = db.createApproval({
      workerKey: "slack:channel:C123:thread:100.2",
      requestId: "request-1",
      channel: "slack",
      peerId: "channel:C123:thread:100.2",
      method: "confirm",
      title: "Run command",
      message: "Proceed?",
      expiresAt: Date.now() + 60_000,
    });
    expect(db.getApproval(approval.id)?.channel).toBe("slack");
    expect(db.getApproval(approval.id)?.peerId).toBe("channel:C123:thread:100.2");
    db.close();
  });
});

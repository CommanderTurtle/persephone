import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubBridgeDatabase } from "../src/github-database.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(): GitHubBridgeDatabase {
  const directory = mkdtempSync(path.join(os.tmpdir(), "persephone-github-test-"));
  directories.push(directory);
  return new GitHubBridgeDatabase(path.join(directory, "state.sqlite"));
}

describe("GitHub bridge database", () => {
  test("binds publication approval to one workspace and exact head", () => {
    const db = database();
    const proposal = db.putProposal({
      id: "a".repeat(24), repo: "owner/project", issueNumber: 7,
      workspaceKey: "owner__project__7", branch: "robomp/issue-7",
      headSha: "b".repeat(40), baseSha: "c".repeat(40), diffSha256: "d".repeat(64),
      diffText: "diff", diffTruncated: false,
    });
    expect(proposal.status).toBe("pending");
    expect(db.findProposal("owner__project__7", "b".repeat(40))?.id).toBe(proposal.id);
    expect(db.transitionProposal(proposal.id, ["pending"], "approved")?.status).toBe("approved");
    expect(db.transitionProposal(proposal.id, ["pending"], "rejected")?.status).toBe("approved");
    db.close();
  });

  test("deduplicates each ensemble identity per source post", () => {
    const db = database();
    const input = {
      personaId: "persona-1", repo: "owner/project", issueNumber: 9,
      sourceCommentId: 101, sourceBody: "A useful post", issueTitle: "Title",
      issueBody: "Body", sourceUrl: "https://github.com/owner/project/issues/9#issuecomment-101",
    };
    expect(db.enqueueEnsemble(input)).toBe(true);
    expect(db.enqueueEnsemble(input)).toBe(false);
    expect(db.claimEnsemble()?.personaId).toBe("persona-1");
    db.close();
  });

  test("waits for every persona and retries only failed sidecars", () => {
    const db = database();
    for (const personaId of ["opsec-bro", "longtimeuser4", "ancient-guru"]) {
      expect(db.enqueueEnsemble({
        personaId, repo: "owner/project", issueNumber: 10,
        sourceCommentId: 202, sourceBody: "A concrete proposal",
        issueTitle: "But what about bounded retries?", issueBody: "Body",
        sourceUrl: "https://github.com/owner/project/issues/10",
      })).toBe(true);
    }
    const first = db.claimEnsemble()!;
    db.finishEnsemble(first.id, "commented", "One security concern.");
    const second = db.claimEnsemble()!;
    db.finishEnsemble(second.id, "skipped", undefined, "Malformed source");
    const third = db.claimEnsemble()!;
    db.finishEnsemble(third.id, "failed", undefined, "GitHub App unavailable");

    expect(db.ensembleProgress("OWNER/PROJECT", 10, ["opsec-bro", "longtimeuser4", "ancient-guru"])).toEqual({
      complete: true,
      failed: [third.personaId],
    });
    expect(db.retryFailedEnsemble("owner/project", 10)).toBe(1);
    const retried = db.claimEnsemble()!;
    expect(retried.personaId).toBe(third.personaId);
    db.finishEnsemble(retried.id, "commented", "Recovered comment.");
    expect(db.ensembleProgress("owner/project", 10, ["opsec-bro", "longtimeuser4", "ancient-guru"])).toEqual({
      complete: true,
      failed: [],
    });
    db.close();
  });

  test("does not run a new dream schedule immediately and preserves deliberation before dispatch", () => {
    const db = database();
    const now = 1_800_000_000_000;
    db.initializeDreamSchedule(["owner/project"], now);
    expect(db.claimDueDream(60_000, now)).toBeNull();
    expect(db.claimDueDream(60_000, now + 60_000)).toBe("owner/project");
    db.finishDreamRun("owner/project");
    const dream = db.putDream({
      id: "e".repeat(24), repo: "owner/project", baseSha: "f".repeat(40),
      title: "But what about bounded retries?", issueBody: "x".repeat(120),
      rationale: "A concrete reliability gap exists.", implementationBrief: "Add one bounded retry and cover it with a focused test.",
    });
    expect(db.hasPendingDream("OWNER/PROJECT")).toBe(true);
    expect(db.transitionDream(dream.id, ["pending"], "approved")?.status).toBe("approved");
    expect(db.transitionDream(dream.id, ["approved"], "issued", { issueNumber: 12, issueUrl: "https://example/12" })?.issueNumber).toBe(12);
    expect(db.hasPendingDream("owner/project")).toBe(true);
    expect(db.transitionDream(dream.id, ["issued"], "ready")?.status).toBe("ready");
    expect(db.transitionDream(dream.id, ["ready"], "dispatched")?.status).toBe("dispatched");
    db.close();
  });
});

import { describe, expect, test } from "bun:test";
import { parseDreamDecision, parseEnsembleDecision } from "../src/github-contracts.ts";

describe("bounded GitHub model contracts", () => {
  test("accepts a grounded dream proposal and rejects generic titles", () => {
    const decision = parseDreamDecision(JSON.stringify({
      action: "propose",
      title: "But what about bounded event retries?",
      issueBody: "Concrete evidence and acceptance criteria. ".repeat(4),
      rationale: "This closes a demonstrated reliability gap.",
      implementationBrief: "Change the named retry boundary and add a focused regression test.",
    }));
    expect(decision.action).toBe("propose");
    expect(() => parseDreamDecision(JSON.stringify({
      action: "propose", title: "Improve everything", issueBody: "x".repeat(120),
      rationale: "x".repeat(30), implementationBrief: "x".repeat(60),
    }))).toThrow(/But what about/);
  });

  test("keeps ensemble output to one bounded comment or an explicit skip", () => {
    expect(parseEnsembleDecision('{"action":"skip","reason":"It would only repeat the post."}').action).toBe("skip");
    expect(parseEnsembleDecision('{"action":"comment","body":"One concrete tradeoff is worth measuring before this lands."}').action).toBe("comment");
    expect(() => parseEnsembleDecision('{"action":"comment","body":"nice"}')).toThrow(/bounded/);
  });
});

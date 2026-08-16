import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, validateRoboOmpGitHub } from "../src/config.ts";

describe("RoboOMP GitHub configuration", () => {
  test("dream mode is fail-closed around repos, actors, issue capability, and native triage", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.roboomp.github.enabled = true;
    config.roboomp.github.allowedRepositories = ["owner/project"];
    config.roboomp.github.allowedActors = ["human-owner"];
    config.roboomp.github.persephoneBotLogin = "persephone-bot";
    config.roboomp.github.dream.enabled = true;
    config.roboomp.github.dream.repositories = ["owner/project"];
    config.roboomp.github.dream.directiveAuthor = "human-owner";
    const names = [
      config.roboomp.github.webhookSecretEnv,
      config.roboomp.github.approvalTokenEnv,
      config.roboomp.github.replayTokenEnv,
      config.roboomp.github.dream.issueProxyKeyEnv,
    ];
    const prior = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = "test-secret";
      expect(() => validateRoboOmpGitHub(config)).not.toThrow();
      delete process.env[config.roboomp.github.dream.issueProxyKeyEnv];
      expect(() => validateRoboOmpGitHub(config)).toThrow(/dream loop requires/);
      process.env[config.roboomp.github.dream.issueProxyKeyEnv] = "test-secret";
      config.roboomp.github.dream.repositories = ["owner/not-allowed"];
      expect(() => validateRoboOmpGitHub(config)).toThrow(/not allowlisted/);
    } finally {
      for (const [name, value] of prior) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

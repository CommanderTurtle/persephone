import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { signInternalRequest, verifyGitHubSignature, verifyInternalRequest } from "../src/github-security.ts";

describe("GitHub bridge signatures", () => {
  test("verifies GitHub SHA-256 signatures without accepting altered bodies", () => {
    const body = Buffer.from('{"action":"opened"}');
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;
    expect(verifyGitHubSignature("webhook-secret", body, signature)).toBe(true);
    expect(verifyGitHubSignature("webhook-secret", Buffer.from("altered"), signature)).toBe(false);
  });

  test("binds an internal capability signature to time, method, path, and body", () => {
    const body = Buffer.from('{"repo":"owner/project"}');
    const now = 1_800_000_000;
    const headers = signInternalRequest("capability-key", "POST", "/v1/issue", body, now);
    expect(verifyInternalRequest("capability-key", "POST", "/v1/issue", body, headers, now)).toBe(true);
    expect(verifyInternalRequest("capability-key", "POST", "/v1/comment", body, headers, now)).toBe(false);
    expect(verifyInternalRequest("capability-key", "POST", "/v1/issue", Buffer.from("{}"), headers, now)).toBe(false);
    expect(verifyInternalRequest("capability-key", "POST", "/v1/issue", body, headers, now + 301)).toBe(false);
  });
});

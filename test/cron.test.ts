import { describe, expect, test } from "bun:test";
import { cronMatches, validateCron } from "../src/cron.ts";

describe("cron", () => {
  test("matches exact and ranged schedules", () => {
    const monday = new Date(2026, 7, 3, 18, 30, 0);
    expect(cronMatches("30 18 * * 1-5", monday)).toBe(true);
    expect(cronMatches("0 18 * * 1-5", monday)).toBe(false);
  });

  test("supports steps and lists", () => {
    const date = new Date(2026, 7, 3, 12, 20, 0);
    expect(cronMatches("*/10 8,12,16 * * *", date)).toBe(true);
  });

  test("rejects malformed expressions", () => {
    expect(() => validateCron("* * *")).toThrow();
    expect(() => validateCron("99 * * * *")).toThrow();
  });
});

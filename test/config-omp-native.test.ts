import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, validateConfig } from "../src/config.ts";

describe("native OMP ownership config", () => {
  test("accepts native memory ownership and declared semantic guards", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects unknown model guard families", () => {
    const config = structuredClone(DEFAULT_CONFIG) as any;
    config.omp.semanticLoopGuardModels["vllm/qwen3.8-27b"] = "qwen";
    expect(() => validateConfig(config)).toThrow("Unsupported semantic loop guard family");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

import { patchFsharpLspProfileConfig, patchSemanticLoopGuardModelConfig } from "../src/omp-reconcile.ts";

describe("OMP model compatibility reconciliation", () => {
  test("adds a semantic loop guard without replacing existing compat metadata", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "persephone-omp-models-"));
    try {
      const file = path.join(root, "models.yml");
      writeFileSync(file, [
        "providers:",
        "  vllm:",
        "    modelOverrides:",
        "      qwen3.8-27b:",
        "        input:",
        "          - text",
        "          - image",
        "        compat:",
        "          thinkingFormat: qwen-chat-template",
        "          reasoningContentField: reasoning_content",
        "",
      ].join("\n"));

      const first = patchSemanticLoopGuardModelConfig(root, { "vllm/qwen3.8-27b": "deepseek" }, true);
      expect(first.changed).toBe(true);
      const parsed = parse(readFileSync(file, "utf8")) as any;
      const compat = parsed.providers.vllm.modelOverrides["qwen3.8-27b"].compat;
      expect(compat.thinkingFormat).toBe("qwen-chat-template");
      expect(compat.reasoningContentField).toBe("reasoning_content");
      expect(compat.thinkingLoopGuard).toBe("deepseek");

      const second = patchSemanticLoopGuardModelConfig(root, { "vllm/qwen3.8-27b": "deepseek" }, false);
      expect(second.changed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("merges the checked-in F# server without replacing user LSP entries", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "persephone-omp-lsp-"));
    try {
      mkdirSync(root, { recursive: true });
      const file = path.join(root, "lsp.json");
      writeFileSync(file, `${JSON.stringify({ servers: { custom: {
        command: "custom-lsp",
        fileTypes: [".custom"],
        rootMarkers: [".git"],
      } } }, null, 2)}\n`);

      expect(patchFsharpLspProfileConfig(root, true).changed).toBe(true);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as any;
      expect(parsed.servers.custom.command).toBe("custom-lsp");
      expect(parsed.servers.fsautocomplete.command).toBe("fsautocomplete");
      expect(patchFsharpLspProfileConfig(root, false).changed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

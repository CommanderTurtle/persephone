import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { collectIntegrationInventory } from "../src/integration-inventory.ts";

const originalOmpHome = process.env.OMP_HOME;
const temporaryRoots: string[] = [];

afterEach(() => {
  if (originalOmpHome === undefined) delete process.env.OMP_HOME;
  else process.env.OMP_HOME = originalOmpHome;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("lists owner contracts and the OMP profiles where each MCP is active", () => {
  const root = mkdtempSync(path.join(tmpdir(), "persephone-inventory-"));
  temporaryRoots.push(root);
  const omp = path.join(root, ".omp");
  const services = path.join(root, "Hermes");
  const localflame = path.join(root, "Deepseek", "localflame");
  process.env.OMP_HOME = omp;

  writeMcp(path.join(omp, "agent"), {
    mcpServers: { localflame: {}, camofox: {}, retrieval: {}, "codebase-memory": {} },
    disabledServers: ["retrieval"],
  });
  writeMcp(path.join(omp, "profiles", "librarian", "agent"), {
    mcpServers: { "librarian-okf": {} },
    enabledServers: ["librarian-okf"],
  });
  writeContract(localflame, "install.sh");
  writeContract(path.join(services, "camofox-mcp"), "integrate.sh");
  writeContract(path.join(services, "librarian"), "integrate.sh");

  const config = structuredClone(DEFAULT_CONFIG);
  config.integrations.servicesRoot = services;
  config.integrations.localflameRoot = localflame;
  const inventory = collectIntegrationInventory(config);

  expect(inventory.reconcileOnSessionStart).toBe(true);
  expect(inventory.profiles.map((item) => item.profile)).toEqual(["default", "librarian"]);
  expect(entry(inventory, "localflame").activeProfiles).toEqual(["default"]);
  expect(entry(inventory, "camofox").activeProfiles).toEqual(["default"]);
  expect(entry(inventory, "librarian").activeProfiles).toEqual(["librarian"]);
  expect(entry(inventory, "retrieval").activeProfiles).toEqual([]);
  expect(entry(inventory, "codebaseMemory").activeProfiles).toEqual(["default"]);
  expect(entry(inventory, "localflame").ownerContractPresent).toBe(true);
  expect(entry(inventory, "codebaseMemory").ownerContractPresent).toBe(false);
});

function writeMcp(directory: string, value: unknown): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "mcp.json"), `${JSON.stringify(value)}\n`);
}

function writeContract(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), "#!/usr/bin/env bash\n");
}

function entry(inventory: ReturnType<typeof collectIntegrationInventory>, key: string) {
  const found = inventory.integrations.find((item) => item.key === key);
  if (!found) throw new Error(`missing integration ${key}`);
  return found;
}

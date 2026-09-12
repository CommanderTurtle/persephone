import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { ompAgentDir, ompHome } from "./paths.ts";
import type { PersephoneConfig } from "./types.ts";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  enabledServers?: string[];
  disabledServers?: string[];
}

interface IntegrationSpec {
  key: keyof Pick<
    PersephoneConfig["integrations"],
    "localflame" | "contextMode" | "librarian" | "retrieval" | "codebaseMemory" | "camofox"
  >;
  label: string;
  directory: string;
  contract: string;
  mcpNames: string[];
}

export interface IntegrationInventoryEntry {
  key: IntegrationSpec["key"];
  label: string;
  configured: boolean;
  directory: string;
  ownerContract: string;
  ownerContractPresent: boolean;
  mcpNames: string[];
  activeProfiles: string[];
}

export interface PersephoneIntegrationInventory {
  schemaVersion: "persephone.integration-inventory.v1";
  reconcileOnSessionStart: boolean;
  profiles: Array<{ profile: string; agentDir: string }>;
  integrations: IntegrationInventoryEntry[];
}

/**
 * Read the owner and OMP registration state without contacting a service or
 * changing either harness. This is shared by the CLI and OMP extension so the
 * installed plugin has the same inventory as the repository owner command.
 */
export function collectIntegrationInventory(config: PersephoneConfig): PersephoneIntegrationInventory {
  const profiles = discoverProfiles();
  const specs: IntegrationSpec[] = [
    {
      key: "localflame",
      label: "Localflame",
      directory: config.integrations.localflameRoot,
      contract: "install.sh",
      mcpNames: ["localflame"],
    },
    {
      key: "contextMode",
      label: "Context Mode",
      directory: path.join(config.integrations.servicesRoot, "context-mode"),
      contract: "integrate.sh",
      mcpNames: ["context-mode"],
    },
    {
      key: "librarian",
      label: "Librarian",
      directory: path.join(config.integrations.servicesRoot, "librarian"),
      contract: "integrate.sh",
      mcpNames: ["librarian", "librarian-okf"],
    },
    {
      key: "retrieval",
      label: "Retrieval",
      directory: path.join(config.integrations.servicesRoot, "retrieval"),
      contract: "integrate.sh",
      mcpNames: ["retrieval"],
    },
    {
      key: "codebaseMemory",
      label: "Codebase Memory",
      directory: path.join(config.integrations.servicesRoot, "codebase-memory-mcp"),
      contract: "integrate-local.sh",
      mcpNames: ["codebase-memory"],
    },
    {
      key: "camofox",
      label: "Camofox",
      directory: path.join(config.integrations.servicesRoot, "camofox-mcp"),
      contract: "integrate.sh",
      mcpNames: ["camofox"],
    },
  ];

  return {
    schemaVersion: "persephone.integration-inventory.v1",
    reconcileOnSessionStart: config.omp.reconcileOnSessionStart,
    profiles: profiles.map(({ profile, agentDir }) => ({ profile, agentDir })),
    integrations: specs.map((spec) => {
      const ownerContract = path.join(spec.directory, spec.contract);
      return {
        key: spec.key,
        label: spec.label,
        configured: config.integrations[spec.key],
        directory: spec.directory,
        ownerContract,
        ownerContractPresent: existsSync(ownerContract),
        mcpNames: spec.mcpNames,
        activeProfiles: profiles
          .filter(({ mcp }) => spec.mcpNames.some((name) => activeMcp(mcp, name)))
          .map(({ profile }) => profile),
      };
    }),
  };
}

function discoverProfiles(): Array<{ profile: string; agentDir: string; mcp: McpConfig | null }> {
  const values = new Map<string, string>([["default", ompAgentDir("default")]]);
  const profilesRoot = path.join(ompHome(), "profiles");
  if (existsSync(profilesRoot)) {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) values.set(entry.name, ompAgentDir(entry.name));
    }
  }
  return [...values]
    .map(([profile, agentDir]) => ({
      profile,
      agentDir,
      mcp: readMcpConfig(path.join(agentDir, "mcp.json")),
    }))
    .sort((left, right) => left.profile === "default" ? -1 : right.profile === "default" ? 1 : left.profile.localeCompare(right.profile));
}

function readMcpConfig(file: string): McpConfig | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(value) ? value as McpConfig : null;
  } catch {
    return null;
  }
}

function activeMcp(config: McpConfig | null, name: string): boolean {
  if (!config || !isRecord(config.mcpServers) || !Object.hasOwn(config.mcpServers, name)) return false;
  if (config.disabledServers?.includes(name)) return false;
  return !config.enabledServers?.length || config.enabledServers.includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { configPath, envPath } from "./config.ts";
import { controlRequest } from "./control-client.ts";
import { ompAgentDir, repoRoot } from "./paths.ts";
import type { PersephoneConfig } from "./types.ts";

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export async function doctor(config: PersephoneConfig, includeRuntime = true): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let pluginNames: string[] = [];
  const bun = Bun.which("bun");
  results.push({ check: "bun", ok: Boolean(bun), detail: bun ? `${bun} (${Bun.version})` : "not found" });
  const omp = path.isAbsolute(config.omp.command) ? config.omp.command : Bun.which(config.omp.command);
  if (omp) {
    const version = spawnSync(omp, ["--version"], { encoding: "utf8", env: { ...process.env, OTEL_SDK_DISABLED: "true" } });
    results.push({ check: "omp", ok: version.status === 0, detail: `${omp} ${`${version.stdout || version.stderr}`.trim()}`.trim() });
    const plugins = spawnSync(omp, ["plugin", "list", "--json"], {
      encoding: "utf8",
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    });
    pluginNames = plugins.status === 0 ? readPluginNames(plugins.stdout) : [];
    results.push({
      check: "plugin:persephone",
      ok: plugins.status === 0 && pluginNames.includes("@commanderturtle/persephone"),
      detail: plugins.status === 0 ? "OMP plugin registry" : `${plugins.stdout || ""}\n${plugins.stderr || ""}`.trim(),
    });
  } else results.push({ check: "omp", ok: false, detail: `${config.omp.command} was not found` });
  results.push({ check: "config", ok: existsSync(configPath()), detail: configPath() });
  results.push({ check: "environment", ok: existsSync(envPath()), detail: envPath() });
  results.push({ check: "repository", ok: existsSync(path.join(repoRoot(), "package.json")), detail: repoRoot() });

  const mcpFile = path.join(ompAgentDir(config.omp.profile), "mcp.json");
  const mcpNames = existsSync(mcpFile) ? readMcpNames(mcpFile) : [];
  for (const name of expectedMcpNames(config)) {
    results.push({ check: `mcp:${name}`, ok: mcpNames.includes(name), detail: mcpFile });
  }
  if (config.integrations.contextMode) {
    const packageFile = path.join(config.integrations.servicesRoot, "context-mode", "package.json");
    const packageName = readPackageName(packageFile);
    results.push({
      check: "plugin:context-mode",
      ok: Boolean(packageName) && pluginNames.includes(packageName),
      detail: packageName ? `${packageName} in OMP plugin registry` : packageFile,
    });
  }

  if (includeRuntime) {
    try {
      const status = await controlRequest<Record<string, unknown>>(config, "/health");
      results.push({ check: "daemon", ok: status.ok === true, detail: `http://${config.listen.host}:${config.listen.port}` });
    } catch (error) {
      results.push({ check: "daemon", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    if (config.signal.enabled) {
      try {
        const response = await fetch(`${config.signal.url}/api/v1/check`, { signal: AbortSignal.timeout(5000) });
        results.push({ check: "signal", ok: response.ok, detail: `${config.signal.url} HTTP ${response.status}` });
      } catch (error) {
        results.push({ check: "signal", ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

function readPluginNames(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as { npm?: Array<{ name?: unknown }> };
    return (parsed.npm || [])
      .map((entry) => (typeof entry.name === "string" ? entry.name : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readPackageName(file: string): string {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; omp?: unknown };
    return typeof parsed.name === "string" && parsed.omp ? parsed.name : "";
  } catch {
    return "";
  }
}

function readMcpNames(file: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers || {});
  } catch {
    return [];
  }
}

function expectedMcpNames(config: PersephoneConfig): string[] {
  return [
    config.integrations.librarian && "librarian",
    config.integrations.retrieval && "retrieval",
    config.integrations.codebaseMemory && "codebase-memory",
    config.integrations.camofox && "camofox",
  ].filter((value): value is string => Boolean(value));
}

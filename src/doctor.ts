import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { configPath, envPath, readEnvFile } from "./config.ts";
import { controlRequest } from "./control-client.ts";
import { DiscordClient } from "./discord.ts";
import { ompAgentDir, repoRoot } from "./paths.ts";
import { SlackClient } from "./slack.ts";
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
  const librarian = librarianIntegration(config);
  if (librarian) {
    const privateFile = path.join(ompAgentDir(librarian.profile), "mcp.json");
    results.push({
      check: "mcp:librarian-okf",
      ok: readMcpNames(privateFile).includes("librarian-okf"),
      detail: privateFile,
    });
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
    if (librarian && omp) {
      results.push(probeMcp(omp, librarian.profile, "librarian-okf"));
    }
    if (config.integrations.contextMode && omp) {
      results.push(probeMcp(omp, config.omp.profile, "context-mode"));
    }
    if (config.web.firecrawl.enabled) {
      results.push(await probeHttpService(
        "firecrawl",
        config.web.firecrawl.url,
        "/",
        config.web.firecrawl.apiKeyEnv,
        false,
      ));
    }
    if (config.integrations.camofox) {
      results.push(await probeHttpService(
        "camofox",
        config.web.camofox.url,
        "/health",
        config.web.camofox.apiKeyEnv,
        true,
      ));
    }
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
    if (config.discord.enabled) {
      const client = new DiscordClient(config.discord);
      results.push({
        check: "discord",
        ok: await client.health(),
        detail: `Discord bot token from ${config.discord.tokenEnv}`,
      });
    }
    if (config.slack.enabled) {
      const client = new SlackClient(config.slack);
      results.push({
        check: "slack",
        ok: await client.health(),
        detail: `Slack Socket Mode using ${config.slack.botTokenEnv} and ${config.slack.appTokenEnv}`,
      });
    }
    if (config.roboomp.enabled) {
      results.push(await probeHttpService("roboomp", config.roboomp.url, "/healthz", "", false));
    }
  }
  return results;
}

async function probeHttpService(
  check: string,
  baseUrl: string,
  pathname: string,
  apiKeyEnv: string,
  requireOkPayload: boolean,
): Promise<CheckResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}${pathname}`;
  const headers: Record<string, string> = {};
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { check, ok: false, detail: `${url} HTTP ${response.status}` };
    if (!requireOkPayload) return { check, ok: true, detail: `${url} HTTP ${response.status}` };
    const payload = (await response.json()) as { ok?: unknown; engine?: unknown; browserRunning?: unknown };
    const ok = payload.ok === true;
    const state = payload.browserRunning === false ? " (healthy, browser cold)" : "";
    return {
      check,
      ok,
      detail: `${url} ${typeof payload.engine === "string" ? payload.engine : "HTTP 200"}${state}`,
    };
  } catch (error) {
    return { check, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function librarianIntegration(config: PersephoneConfig): { profile: string } | null {
  if (!config.integrations.librarian) return null;
  const environment = readEnvFile(path.join(config.integrations.servicesRoot, "librarian", ".env"));
  return { profile: environment.OMP_PROFILE || "librarian" };
}

function probeMcp(omp: string, profile: string, server: string): CheckResult {
  const request = [
    JSON.stringify({ id: "protocol", type: "negotiate_protocol", protocolVersion: 2 }),
    JSON.stringify({ id: "probe", type: "prompt", message: `/mcp test ${server}` }),
    "",
  ].join("\n");
  const probe = spawnSync(omp, ["--profile", profile, "--mode", "rpc", "--no-session"], {
    encoding: "utf8",
    input: request,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OTEL_SDK_DISABLED: "true", VLLM_API_KEY: process.env.VLLM_API_KEY || "local" },
  });
  const output = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  const message = output
    .split(/\r?\n/)
    .map(readCommandOutput)
    .find((value) => value.includes(`Server "${server}"`));
  const ok = probe.status === 0 && Boolean(message?.includes(" connected ("));
  return {
    check: `mcp:${server}:runtime`,
    ok,
    detail: message || (probe.error?.message ?? `OMP RPC exited ${probe.status ?? "without a status"}`),
  };
}

function readCommandOutput(line: string): string {
  try {
    const value = JSON.parse(line) as { type?: unknown; text?: unknown };
    return value.type === "command_output" && typeof value.text === "string" ? value.text : "";
  } catch {
    return "";
  }
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
    config.integrations.contextMode && "context-mode",
    config.integrations.librarian && "librarian",
    config.integrations.retrieval && "retrieval",
    config.integrations.codebaseMemory && "codebase-memory",
    config.integrations.camofox && "camofox",
  ].filter((value): value is string => Boolean(value));
}

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { configPath, envPath, readEnvFile } from "./config.ts";
import { controlRequest } from "./control-client.ts";
import { DiscordClient } from "./discord.ts";
import { ompAgentDir, repoRoot, stateRoot } from "./paths.ts";
import { SlackClient } from "./slack.ts";
import { discoverOwnedProfiles, inspectOmpReconciliation } from "./omp-reconcile.ts";
import { inspectOmpNativeTools } from "./omp-native-tools.ts";
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
  const ownedProfiles = omp ? discoverOwnedProfiles(config) : [];
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
  const persephone = Bun.which("persephone");
  results.push({
    check: "cli:persephone",
    ok: Boolean(persephone),
    detail: persephone || "persephone was not found on PATH",
  });
  if (persephone) {
    const inventory = spawnSync(persephone, ["integrations"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    });
    results.push({
      check: "cli:persephone:integrations",
      ok: inventory.status === 0 && /\"integrations\"\s*:/.test(inventory.stdout),
      detail: inventory.status === 0
        ? "persephone integrations returned the owner inventory"
        : inventory.error?.message || `${inventory.stderr || inventory.stdout}`.trim(),
    });
  }
  if (omp) {
    for (const owned of ownedProfiles) {
      if (owned.profile === "default") continue;
      const plugins = spawnSync(omp, ["--profile", owned.profile, "plugin", "list", "--json"], {
        encoding: "utf8",
        env: { ...process.env, OTEL_SDK_DISABLED: "true" },
      });
      const names = plugins.status === 0 ? readPluginNames(plugins.stdout) : [];
      results.push({
        check: `plugin:persephone:${owned.profile}`,
        ok: plugins.status === 0 && names.includes("@commanderturtle/persephone"),
        detail: plugins.status === 0 ? "profile-scoped OMP plugin registry" : `${plugins.stderr || plugins.stdout}`.trim(),
      });
    }
  }
  results.push({ check: "config", ok: existsSync(configPath()), detail: configPath() });
  results.push({ check: "environment", ok: existsSync(envPath()), detail: envPath() });
  results.push({ check: "repository", ok: existsSync(path.join(repoRoot(), "package.json")), detail: repoRoot() });
  if (config.integrations.localflame) {
    const installer = path.join(config.integrations.localflameRoot, "install.sh");
    results.push({ check: "integration:localflame", ok: existsSync(installer), detail: installer });
  }
  if (config.integrations.contextMode) {
    const installer = path.join(config.integrations.servicesRoot, "context-mode", "integrate.sh");
    results.push({ check: "integration:context-mode", ok: existsSync(installer), detail: installer });
  }
  if (config.integrations.camofox) {
    const installer = path.join(config.integrations.servicesRoot, "camofox-mcp", "integrate.sh");
    results.push({ check: "integration:camofox", ok: existsSync(installer), detail: installer });
  }
  if (config.integrations.codebaseMemory) {
    const installer = path.join(config.integrations.servicesRoot, "codebase-memory-mcp", "integrate-local.sh");
    results.push({ check: "integration:codebase-memory", ok: existsSync(installer), detail: installer });
  }
  const delegatedOwnership = delegatedMcpOwnership();
  results.push({
    check: "integration:delegated-ownership",
    ok: delegatedOwnership.length === 0,
    detail: delegatedOwnership.length ? delegatedOwnership.join(", ") : "owned by each integration repository",
  });
  results.push(...inspectOmpReconciliation(config));
  if (config.omp.ensureLanguageServers) results.push(...inspectOmpNativeTools());

  const mcpFile = path.join(ompAgentDir(config.omp.profile), "mcp.json");
  const mcpNames = existsSync(mcpFile) ? readMcpNames(mcpFile) : [];
  for (const name of expectedMcpNames(config)) {
    results.push({ check: `mcp:${name}`, ok: mcpNames.includes(name), detail: mcpFile });
  }
  const librarian = librarianIntegration(config);
  if (librarian) {
    if (librarian.backend === "omp") {
      const privateFile = path.join(ompAgentDir(librarian.profile), "mcp.json");
      results.push({
        check: "mcp:librarian-okf",
        ok: readMcpNames(privateFile).includes("librarian-okf"),
        detail: privateFile,
      });
    } else {
      const hermes = Bun.which("hermes");
      const registry = hermes
        ? spawnSync(hermes, ["--profile", librarian.profile, "mcp", "list"], { encoding: "utf8" })
        : null;
      const output = registry ? `${registry.stdout || ""}\n${registry.stderr || ""}` : "";
      results.push({
        check: "mcp:librarian-okf",
        ok: registry?.status === 0 && /(^|\s)librarian-okf(\s|$)/m.test(output),
        detail: hermes ? `Hermes profile ${librarian.profile}` : "hermes was not found",
      });
    }
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
    if (omp) {
      for (const owned of ownedProfiles) {
        results.push(...probeOmpToolSurface(
          omp,
          owned.profile,
          owned.localflame,
          owned.camofox && config.web.camofox.replaceNativeBrowser,
        ));
        if (owned.managedProfile) {
          results.push(...probeImageModelInputs(omp, owned.profile, config.omp.imageModels));
        }
      }
    }
    if (librarian?.backend === "omp" && omp) {
      results.push(probeMcp(omp, librarian.profile, "librarian-okf"));
    } else if (librarian?.backend === "hermes") {
      const hermes = Bun.which("hermes");
      results.push(hermes
        ? probeHermesMcp(hermes, librarian.profile, "librarian-okf")
        : { check: "mcp:librarian-okf:runtime", ok: false, detail: "hermes was not found" });
    }
    if (config.integrations.contextMode && omp) {
      results.push(probeMcp(omp, config.omp.profile, "context-mode"));
    }
    if (omp) {
      for (const owned of ownedProfiles) {
        if (owned.localflame) results.push(probeMcp(omp, owned.profile, "localflame"));
        if (owned.camofox) results.push(probeMcp(omp, owned.profile, "camofox"));
      }
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

function probeOmpToolSurface(
  omp: string,
  profile: string,
  expectsLocalflame: boolean,
  expectsCamofox: boolean,
): CheckResult[] {
  const input = [
    JSON.stringify({ id: "protocol", type: "negotiate_protocol", protocolVersion: 2 }),
    JSON.stringify({ id: "state", type: "get_state" }),
    "",
  ].join("\n");
  const command = spawnSync(omp, [...profilePrefix(profile), "--mode", "rpc", "--no-session"], {
    encoding: "utf8",
    input,
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OTEL_SDK_DISABLED: "true", VLLM_API_KEY: process.env.VLLM_API_KEY || "local" },
  });
  const state = `${command.stdout || ""}\n${command.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type?: unknown;
          command?: unknown;
          success?: unknown;
          data?: { dumpTools?: Array<{ name?: unknown; description?: unknown }> };
        };
      } catch {
        return null;
      }
    })
    .find((value) => value?.type === "response" && value.command === "get_state" && value.success === true);
  const commandFrame = `${command.stdout || ""}\n${command.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type?: unknown;
          commands?: Array<{ name?: unknown; source?: unknown }>;
        };
      } catch {
        return null;
      }
    })
    .find((value) => value?.type === "available_commands_update");
  if (!state) {
    return [{
      check: `omp-tools:${profile}`,
      ok: false,
      detail: command.error?.message || `OMP RPC exited ${command.status ?? "without a status"}`,
    }];
  }
  const tools = state.data?.dumpTools || [];
  const commandNames = new Set((commandFrame?.commands || [])
    .map((item) => (typeof item.name === "string" ? item.name : ""))
    .filter(Boolean));
  const results: CheckResult[] = [
    {
      check: `omp-command:${profile}:persephone`,
      ok: commandNames.has("persephone"),
      detail: commandNames.has("persephone") ? "extension command is discoverable" : "command is absent from available_commands_update",
    },
    {
      check: `omp-command:${profile}:persephone-integrations`,
      ok: commandNames.has("persephone-integrations"),
      detail: commandNames.has("persephone-integrations") ? "direct inventory command is discoverable" : "command is absent from available_commands_update",
    },
    {
      check: `omp-command:${profile}:persephone-native`,
      ok: commandNames.has("persephone-native"),
      detail: commandNames.has("persephone-native") ? "live native OMP health command is discoverable" : "command is absent from available_commands_update",
    },
    {
      check: `omp-command:${profile}:persephone-reconcile`,
      ok: commandNames.has("persephone-reconcile"),
      detail: commandNames.has("persephone-reconcile") ? "direct maintenance command is discoverable" : "command is absent from available_commands_update",
    },
    {
      check: `omp-tool:${profile}:persephone_integrations`,
      ok: tools.some((tool) => tool.name === "persephone_integrations"),
      detail: "read-only owner inventory tool",
    },
    {
      check: `omp-tool:${profile}:persephone_reconcile_omp`,
      ok: tools.some((tool) => tool.name === "persephone_reconcile_omp"),
      detail: "approved owner maintenance tool",
    },
  ];
  if (expectsLocalflame) {
    results.push({
      check: `omp-tool:${profile}:web_search`,
      ok: tools.some((tool) => tool.name === "web_search"),
      detail: "native web_search enabled",
    });
  }
  if (expectsCamofox) {
    const browser = tools.find((tool) => tool.name === "browser");
    results.push({
      check: `omp-tool:${profile}:browser`,
      ok: typeof browser?.description === "string" && /local Camofox/i.test(browser.description),
      detail: typeof browser?.description === "string" ? firstLine(browser.description) : "browser is absent from the active tool surface",
    });
  }
  return results;
}

function probeImageModelInputs(omp: string, profile: string, declared: string[]): CheckResult[] {
  const exact = declared.filter((selector) => !selector.startsWith("@")).map(stripEffort);
  if (exact.length === 0) return [];
  const command = spawnSync(omp, [...profilePrefix(profile), "models", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OTEL_SDK_DISABLED: "true", VLLM_API_KEY: process.env.VLLM_API_KEY || "local" },
  });
  if (command.status !== 0) {
    return [{ check: `omp-models:${profile}:runtime`, ok: false, detail: `${command.stderr || command.stdout}`.trim() }];
  }
  try {
    const parsed = JSON.parse(command.stdout) as {
      models?: Array<{ provider?: unknown; id?: unknown; input?: unknown }>;
    };
    return exact.map((selector) => {
      const slash = selector.indexOf("/");
      const provider = selector.slice(0, slash);
      const id = selector.slice(slash + 1);
      const model = (parsed.models || []).find((candidate) => candidate.provider === provider && candidate.id === id);
      const input = Array.isArray(model?.input) ? model.input : [];
      return {
        check: `omp-model:${profile}:${selector}`,
        ok: input.includes("image"),
        detail: model ? `input=${JSON.stringify(input)}` : "model is absent from OMP's effective catalog",
      };
    });
  } catch (error) {
    return [{
      check: `omp-models:${profile}:runtime`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
}

function profilePrefix(profile: string): string[] {
  return profile === "default" ? [] : ["--profile", profile];
}

function stripEffort(selector: string): string {
  return selector.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] || value;
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

function librarianIntegration(config: PersephoneConfig): { backend: "hermes" | "omp"; profile: string } | null {
  if (!config.integrations.librarian) return null;
  const environment = readEnvFile(path.join(config.integrations.servicesRoot, "librarian", ".env"));
  const backend = environment.LIBRARIAN_AGENT_BACKEND === "omp" ? "omp" : "hermes";
  return {
    backend,
    profile: backend === "omp"
      ? environment.OMP_PROFILE || "librarian"
      : environment.LIBRARIAN_PROFILE || "librarian",
  };
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

function probeHermesMcp(hermes: string, profile: string, server: string): CheckResult {
  const probe = spawnSync(hermes, ["--profile", profile, "mcp", "test", server], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OTEL_SDK_DISABLED: "true" },
  });
  const output = `${probe.stdout || ""}\n${probe.stderr || ""}`.trim();
  return {
    check: `mcp:${server}:runtime`,
    ok: probe.status === 0,
    detail: output || (probe.error?.message ?? `Hermes MCP test exited ${probe.status ?? "without a status"}`),
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
    config.integrations.localflame && "localflame",
    config.integrations.contextMode && "context-mode",
    config.integrations.librarian && "librarian",
    config.integrations.retrieval && "retrieval",
    config.integrations.codebaseMemory && "codebase-memory",
    config.integrations.camofox && "camofox",
  ].filter((value): value is string => Boolean(value));
}

function delegatedMcpOwnership(): string[] {
  const file = path.join(stateRoot(), "integration-backup.json");
  if (!existsSync(file)) return [];
  const delegated = new Set(["context-mode", "retrieval", "localflame", "librarian", "librarian-okf", "camofox", "codebase-memory"]);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcp?: Record<string, Record<string, unknown>> };
    const entries: string[] = [];
    for (const [configFile, values] of Object.entries(parsed.mcp || {})) {
      for (const name of Object.keys(values || {})) {
        if (delegated.has(name)) entries.push(`${configFile}:${name}`);
      }
    }
    return entries.sort();
  } catch {
    return [`malformed:${file}`];
  }
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "./omp-api.ts";
import { loadConfig } from "./config.ts";
import { controlRequest } from "./control-client.ts";
import { collectIntegrationInventory } from "./integration-inventory.ts";
import { inspectOmpReconciliation, reconcileOmp } from "./omp-reconcile.ts";
import { inspectOmpNativeTools } from "./omp-native-tools.ts";
import { ompAgentDir, repoRoot } from "./paths.ts";
import type { PersephoneConfig } from "./types.ts";
import { CamofoxBrowserAdapter, type CamofoxBrowserParams } from "./camofox-browser.ts";

export default function persephoneExtension(pi: ExtensionAPI): void {
  pi.setLabel("Persephone");
  const { z } = pi.zod;
  let startupConfig: PersephoneConfig | null = null;
  try {
    startupConfig = loadConfig();
    if (startupConfig.integrations.localflame && activeProfileHasMcp("localflame")) {
      // OMP's native Firecrawl provider reads this at execution time. Keeping
      // the endpoint process-local avoids a second Localflame MCP process and
      // its separate in-memory resource index.
      process.env.FIRECRAWL_BASE_URL = startupConfig.web.firecrawl.url;
    }
  } catch {
    // Status/command calls below surface malformed Persephone configuration;
    // vanilla OMP must still be allowed to start.
  }

  const showIntegrations = (ctx: ExtensionCommandContext): void => {
    try {
      ctx.ui.notify(format(integrationReport(loadConfig())), "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const reconcileOwnedOmpState = (ctx: ExtensionCommandContext): void => {
    try {
      const results = reconcileOmp(loadConfig());
      ctx.ui.notify(format({ changed: results.filter((item) => item.status === "integrated").length, results }),
        results.some((item) => item.status === "failed") ? "error" : "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerCommand("persephone", {
    description: "Inspect Persephone or submit durable prompts",
    getArgumentCompletions: (prefix) =>
      ["status", "integrations", "native", "reconcile", "schedules", "routes", "help"]
        .filter((value) => value.startsWith(prefix || ""))
        .map((value) => ({ label: value, value })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = args.trim() || "status";
      try {
        const config = loadConfig();
        if (command === "status") {
          const status = await controlRequest(config, "/v1/status");
          ctx.ui.notify(format(status), "info");
        } else if (command === "integrations") {
          showIntegrations(ctx);
        } else if (command === "native") {
          ctx.ui.notify(format(nativeOmpReport(config)), "info");
        } else if (command === "reconcile") {
          reconcileOwnedOmpState(ctx);
        } else if (command === "schedules") {
          const schedules = await controlRequest(config, "/v1/schedules");
          ctx.ui.notify(format(schedules), "info");
        } else if (command === "routes") {
          const routes = await controlRequest(config, "/v1/routes");
          ctx.ui.notify(format(routes), "info");
        } else {
          ctx.ui.notify("/persephone status | integrations | native | reconcile | schedules | routes", "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("persephone-integrations", {
    description: "List integration owners and effective OMP maintenance state",
    handler: (_args, ctx) => showIntegrations(ctx),
  });

  pi.registerCommand("persephone-native", {
    description: "Show live native OMP, LSP, loop-guard, and memory ownership checks",
    handler: (_args, ctx) => {
      try {
        ctx.ui.notify(format(nativeOmpReport(loadConfig())), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("persephone-reconcile", {
    description: "Repair only Persephone-owned OMP configuration drift",
    handler: (_args, ctx) => reconcileOwnedOmpState(ctx),
  });

  pi.registerTool({
    name: "persephone_integrations",
    label: "Persephone integrations",
    description: "List every integration owner, its checked-in contract, active OMP profiles, and Persephone-owned OMP setting drift without contacting a model or web service.",
    parameters: z.object({}),
    approval: "read",
    loadMode: "essential",
    execute() {
      try {
        const report = integrationReport(loadConfig());
        return { content: [{ type: "text", text: format(report) }], details: report };
      } catch (error) {
        return { content: [{ type: "text", text: `Could not inspect integrations: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "persephone_reconcile_omp",
    label: "Reconcile Persephone OMP settings",
    description: "Repair only OMP settings and model/LSP metadata owned by Persephone. Correct values and unrelated OMP configuration are left unchanged.",
    parameters: z.object({}),
    approval: "write",
    loadMode: "essential",
    execute() {
      try {
        const results = reconcileOmp(loadConfig());
        const failed = results.some((item) => item.status === "failed");
        return {
          content: [{ type: "text", text: format({ changed: results.filter((item) => item.status === "integrated").length, results }) }],
          details: results,
          ...(failed ? { isError: true } : {}),
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Could not reconcile OMP: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "persephone_status",
    label: "Persephone status",
    description: "Inspect the local durable gateway, queues, workers, schedules, and Signal state.",
    parameters: z.object({}),
    approval: "read",
    loadMode: "discoverable",
    async execute() {
      try {
        const status = await controlRequest(loadConfig(), "/v1/status");
        return { content: [{ type: "text", text: format(status) }], details: status };
      } catch (error) {
        return { content: [{ type: "text", text: `Persephone unavailable: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  registerBrowserTool(pi, startupConfig);

  pi.registerTool({
    name: "persephone_submit",
    label: "Persephone durable prompt",
    description: "Queue a prompt in Persephone for durable execution in an explicitly named route.",
    parameters: z.object({
      route: z.string().min(1).describe("Stable route name"),
      message: z.string().min(1).describe("Prompt to queue"),
    }),
    approval: "write",
    loadMode: "discoverable",
    async execute(_toolCallId, rawParams) {
      const params = rawParams as { route: string; message: string };
      try {
        const result = await controlRequest(loadConfig(), "/v1/prompt", {
          method: "POST",
          body: JSON.stringify({ channel: "omp", peerId: params.route, message: params.message }),
        });
        return { content: [{ type: "text", text: format(result) }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: `Could not queue prompt: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  let sessionActive = false;
  pi.on("session_start", (_event, ctx) => {
    sessionActive = true;
    ctx.ui.setStatus("persephone", "Persephone: checking native OMP…");
    // Reconciliation invokes OMP's supported CLI repeatedly. Run it after the
    // session surface is live so plugin commands, RPC, and the TUI never wait
    // for the post-update audit to complete.
    void (async () => {
      let maintenance = "";
      let nativeTools = "";
      let memory = "";
      let config: PersephoneConfig;
      try {
        config = loadConfig();
        if (config.omp.reconcileOnSessionStart) {
          const result = await reconcileOmpInChild();
          maintenance = result.failed ? ` · OMP drift failed ${result.failed}` : result.changed ? ` · OMP repaired ${result.changed}` : " · OMP checked";
          if (sessionActive && result.failed) ctx.ui.notify(format({ ompReconcileFailure: result.output }), "warning");
        }
        if (config.omp.ensureLanguageServers) {
          const checks = inspectOmpNativeTools();
          const failed = checks.filter((item) => !item.ok);
          nativeTools = failed.length ? ` · LSP drift ${failed.length}` : " · LSP ready";
          if (sessionActive && failed.length) ctx.ui.notify(format({ ompNativeToolFailures: failed }), "warning");
        } else {
          nativeTools = " · LSP unmanaged";
        }
        memory = config.omp.memoryBackend === "sharpshooter"
          ? " · Sharpshooter"
          : ` · memory ${config.omp.memoryBackend}`;
      } catch (error) {
        if (sessionActive) {
          ctx.ui.setStatus("persephone", "Persephone: native OMP check failed");
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      if (!sessionActive) return;
      try {
        await controlRequest(config, "/health");
        if (sessionActive) ctx.ui.setStatus("persephone", `Persephone${maintenance}${nativeTools}${memory} · gateway ready`);
      } catch {
        if (sessionActive) ctx.ui.setStatus("persephone", `Persephone${maintenance}${nativeTools}${memory} · gateway offline`);
      }
    })();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    ctx.ui.setStatus("persephone", undefined);
  });
}

async function reconcileOmpInChild(): Promise<{ changed: number; failed: number; output: string }> {
  const child = Bun.spawn(
    [process.execPath, path.join(repoRoot(), "src", "cli.ts"), "reconcile"],
    {
      cwd: repoRoot(),
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 60_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  const combined = `${stdout}\n${stderr}`.trim();
  const output = combined.length > 1024 * 1024 ? combined.slice(-1024 * 1024) : combined;
  const lines = output.split(/\r?\n/);
  const changed = lines.filter((line) => /^integrated\s/.test(line)).length;
  const reportedFailures = lines.filter((line) => /^(?:failed|missing)\s/.test(line)).length;
  const failed = reportedFailures + (timedOut || code !== 0 ? 1 : 0);
  return {
    changed,
    failed,
    output: timedOut ? `${output}\nTimed out after 60 seconds`.trim() : output,
  };
}

function integrationReport(config: PersephoneConfig): Record<string, unknown> {
  return {
    ...collectIntegrationInventory(config),
    ...nativeOmpReport(config),
    ompReconciliation: inspectOmpReconciliation(config),
  };
}

function nativeOmpReport(config: PersephoneConfig): Record<string, unknown> {
  const checks = config.omp.ensureLanguageServers ? inspectOmpNativeTools() : [];
  return {
    liveOmp: {
      cwd: process.cwd(),
      memoryBackend: config.omp.memoryBackend,
      languageServersManaged: config.omp.ensureLanguageServers,
      languageServerChecks: checks,
      languageServerFailures: checks.filter((item) => !item.ok).length,
      note: "OMP lists only servers applicable to current project markers; stock OMP may move a launch from ~ into a temporary directory.",
    },
  };
}

function registerBrowserTool(pi: ExtensionAPI, config: PersephoneConfig | null): void {
  if (!config) return;
  const { z } = pi.zod;
  if (config.integrations.camofox && config.web.camofox.replaceNativeBrowser && activeProfileHasMcp("camofox")) {
    const camofox = new CamofoxBrowserAdapter(config);
    pi.registerTool({
      name: "browser",
      label: "Browser (local Camofox)",
      description: "Control the local Camofox anti-detection browser using OMP's native open, run, and close workflow. The tab/page helpers cover normal observation, navigation, interaction, evaluation, waits, and screenshots. Use mcp__camofox_* tools for Camofox's specialist extraction, download, profile, and batch operations.",
      parameters: z.object({
        action: z.enum(["open", "close", "run"]),
        name: z.string().optional(),
        url: z.string().optional(),
        app: z.object({
          path: z.string().optional(),
          cdp_url: z.string().optional(),
          relay: z.boolean().optional(),
          args: z.array(z.string()).optional(),
          target: z.string().optional(),
        }).optional(),
        viewport: z.object({
          width: z.number(),
          height: z.number(),
          scale: z.number().optional(),
        }).optional(),
        wait_until: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
        dialogs: z.enum(["accept", "dismiss"]).optional(),
        code: z.string().optional(),
        timeout: z.number().optional(),
        all: z.boolean().optional(),
        kill: z.boolean().optional(),
      }),
      approval: "exec",
      loadMode: "essential",
      strict: true,
      async execute(_toolCallId, rawParams, signal) {
        try {
          const response = await camofox.execute(rawParams as CamofoxBrowserParams, signal);
          return { content: [{ type: "text", text: response.text }], details: response.details };
        } catch (error) {
          if (signal?.aborted) throw error;
          return {
            content: [{ type: "text", text: `Local Camofox browser failed: ${error instanceof Error ? error.message : String(error)}` }],
            details: { backend: "camofox", local: true },
            isError: true,
          };
        }
      },
    });
  }
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function activeProfileHasMcp(name: string): boolean {
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
  const profile = profileFromArgv(process.argv)
    || process.env.OMP_PROFILE?.trim()
    || process.env.PI_PROFILE?.trim()
    || "default";
  const agentDir = explicit ? path.resolve(explicit) : ompAgentDir(profile);
  const file = path.join(agentDir, "mcp.json");
  if (!existsSync(file)) return false;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers?: Record<string, unknown>;
      enabledServers?: string[];
      disabledServers?: string[];
    };
    if (!value.mcpServers || !Object.hasOwn(value.mcpServers, name)) return false;
    if (value.disabledServers?.includes(name)) return false;
    return !value.enabledServers?.length || value.enabledServers.includes(name);
  } catch {
    return false;
  }
}

function profileFromArgv(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--profile") return argv[index + 1]?.trim() || undefined;
    if (value.startsWith("--profile=")) return value.slice("--profile=".length).trim() || undefined;
  }
  return undefined;
}

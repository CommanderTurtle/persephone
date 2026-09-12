import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "./omp-api.ts";
import { loadConfig } from "./config.ts";
import { controlRequest } from "./control-client.ts";
import { collectIntegrationInventory } from "./integration-inventory.ts";
import { inspectOmpReconciliation, reconcileOmp } from "./omp-reconcile.ts";
import { ompAgentDir } from "./paths.ts";
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
      ["status", "integrations", "reconcile", "schedules", "routes", "help"]
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
        } else if (command === "reconcile") {
          reconcileOwnedOmpState(ctx);
        } else if (command === "schedules") {
          const schedules = await controlRequest(config, "/v1/schedules");
          ctx.ui.notify(format(schedules), "info");
        } else if (command === "routes") {
          const routes = await controlRequest(config, "/v1/routes");
          ctx.ui.notify(format(routes), "info");
        } else {
          ctx.ui.notify("/persephone status | integrations | reconcile | schedules | routes", "info");
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
    description: "Repair only OMP settings and image-model metadata owned by Persephone. Correct values and unrelated OMP configuration are left unchanged.",
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

  pi.on("session_start", async (_event, ctx) => {
    let maintenance = "";
    try {
      const config = loadConfig();
      if (config.omp.reconcileOnSessionStart) {
        const results = reconcileOmp(config);
        const changed = results.filter((item) => item.status === "integrated").length;
        const failed = results.filter((item) => item.status === "failed");
        maintenance = failed.length ? ` · OMP drift failed ${failed.length}` : changed ? ` · OMP repaired ${changed}` : " · OMP checked";
        if (failed.length) ctx.ui.notify(format({ ompReconcileFailures: failed }), "warning");
      }
      await controlRequest(config, "/health");
      ctx.ui.setStatus("persephone", `Persephone: ready${maintenance}`);
    } catch {
      ctx.ui.setStatus("persephone", `Persephone: offline${maintenance}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("persephone", undefined);
  });
}

function integrationReport(config: PersephoneConfig): Record<string, unknown> {
  return {
    ...collectIntegrationInventory(config),
    ompReconciliation: inspectOmpReconciliation(config),
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

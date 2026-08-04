import type { ExtensionAPI, ExtensionCommandContext } from "./omp-api.ts";
import { loadConfig } from "./config.ts";
import { controlRequest } from "./control-client.ts";
import type { PersephoneConfig } from "./types.ts";
import { formatFirecrawlResult, searchLocalFirecrawl, type FirecrawlSearchParams } from "./web.ts";

export default function persephoneExtension(pi: ExtensionAPI): void {
  pi.setLabel("Persephone");
  const { z } = pi.zod;

  pi.registerCommand("persephone", {
    description: "Inspect Persephone or submit durable prompts",
    getArgumentCompletions: (prefix) =>
      ["status", "schedules", "routes", "help"]
        .filter((value) => value.startsWith(prefix || ""))
        .map((value) => ({ label: value, value })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = args.trim() || "status";
      try {
        const config = loadConfig();
        if (command === "status") {
          const status = await controlRequest(config, "/v1/status");
          ctx.ui.notify(format(status), "info");
        } else if (command === "schedules") {
          const schedules = await controlRequest(config, "/v1/schedules");
          ctx.ui.notify(format(schedules), "info");
        } else if (command === "routes") {
          const routes = await controlRequest(config, "/v1/routes");
          ctx.ui.notify(format(routes), "info");
        } else {
          ctx.ui.notify("/persephone status | schedules | routes", "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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

  registerWebTools(pi);

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
    try {
      await controlRequest(loadConfig(), "/health");
      ctx.ui.setStatus("persephone", "Persephone: ready");
    } catch {
      ctx.ui.setStatus("persephone", "Persephone: offline");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("persephone", undefined);
  });
}

function registerWebTools(pi: ExtensionAPI): void {
  let config: PersephoneConfig;
  try {
    config = loadConfig();
  } catch {
    // A bad Persephone config must not prevent vanilla OMP from starting. The
    // command and status tools surface the configuration error to the operator.
    return;
  }
  const { z } = pi.zod;
  if (config.web.firecrawl.enabled) {
    pi.registerTool({
      name: "web_search",
      label: "Web Search (local Firecrawl)",
      description: "Search the web through the operator's self-hosted Firecrawl API. Firecrawl may use local SearXNG internally; no hosted search provider is contacted unless nativeFallback is explicitly enabled.",
      parameters: z.object({
        query: z.string().min(1).describe("Search query"),
        recency: z.enum(["day", "week", "month", "year"]).optional(),
        limit: z.number().min(1).max(100).optional(),
        max_tokens: z.number().optional(),
        temperature: z.number().optional(),
        num_search_results: z.number().min(1).max(100).optional(),
      }),
      approval: "read",
      loadMode: "discoverable",
      strict: true,
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as FirecrawlSearchParams;
        try {
          const result = await searchLocalFirecrawl(config, params, { ...(signal ? { signal } : {}) });
          return {
            content: [{ type: "text", text: formatFirecrawlResult(result) }],
            details: { response: result, backend: "self-hosted" },
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          if (config.web.firecrawl.nativeFallback && ctx.invokeTool) {
            return ctx.invokeTool(rawParams as Record<string, unknown>, {
              ...(signal ? { signal } : {}),
              ...(onUpdate ? { onUpdate } : {}),
            });
          }
          return {
            content: [{ type: "text", text: `Local Firecrawl search failed: ${error instanceof Error ? error.message : String(error)}` }],
            details: { provider: "firecrawl", backend: "self-hosted", fallback: false },
            isError: true,
          };
        }
      },
    });
  }

  if (config.integrations.camofox && config.web.camofox.replaceNativeBrowser) {
    pi.registerTool({
      name: "browser",
      label: "Browser (Camofox MCP)",
      description: "OMP's Chromium/CDP browser is deliberately inactive. Use the mcp__camofox_* tools for the Camofox browser backend.",
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
      hidden: true,
      defaultInactive: true,
      approval: "read",
      loadMode: "discoverable",
      strict: false,
      async execute() {
        return {
          content: [{
            type: "text",
            text: "The native Chromium browser is disabled by Persephone. Use Camofox MCP: mcp__camofox_create_tab or mcp__camofox_navigate_and_snapshot, followed by mcp__camofox_click, mcp__camofox_type_text, mcp__camofox_snapshot, and related tools.",
          }],
          details: { backend: "camofox", nativeBrowser: false },
          isError: true,
        };
      },
    });
  }
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

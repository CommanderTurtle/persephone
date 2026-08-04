import type { ExtensionAPI, ExtensionCommandContext } from "./omp-api.ts";
import { loadConfig } from "./config.ts";
import { controlRequest } from "./control-client.ts";

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

function format(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

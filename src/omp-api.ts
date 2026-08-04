/**
 * The narrow OMP extension surface Persephone consumes.
 *
 * These are compile-time structural types only. OMP supplies the live API when
 * it loads `extension.ts`, so Persephone does not install a second harness copy
 * merely to obtain TypeScript declarations.
 */

export interface ExtensionUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface ExtensionCommandContext {
  ui: ExtensionUi;
}

interface StringSchema {
  min(length: number): StringSchema;
  describe(description: string): StringSchema;
}

interface SchemaFactory {
  string(): StringSchema;
  object(shape: Record<string, unknown>): unknown;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface CommandDefinition {
  description: string;
  getArgumentCompletions?: (prefix: string) => Array<{ label: string; value: string }>;
  handler: (args: string, context: ExtensionCommandContext) => Promise<void> | void;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  approval?: "read" | "write";
  loadMode?: "always" | "discoverable";
  execute: (toolCallId: string, params: unknown, ...rest: unknown[]) => Promise<ToolResult> | ToolResult;
}

type ExtensionEvent = "session_start" | "session_shutdown";

export interface ExtensionAPI {
  zod: { z: SchemaFactory };
  setLabel(label: string): void;
  registerCommand(name: string, definition: CommandDefinition): void;
  registerTool(definition: ToolDefinition): void;
  on(
    event: ExtensionEvent,
    handler: (event: unknown, context: ExtensionCommandContext) => Promise<void> | void,
  ): void;
}

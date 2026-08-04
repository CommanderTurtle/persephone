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

interface Schema {
  optional(): Schema;
  describe(description: string): Schema;
}

interface StringSchema extends Schema {
  min(length: number): StringSchema;
}

interface NumberSchema extends Schema {
  min(value: number): NumberSchema;
  max(value: number): NumberSchema;
  int(): NumberSchema;
}

interface SchemaFactory {
  string(): StringSchema;
  number(): NumberSchema;
  boolean(): Schema;
  enum(values: readonly string[]): Schema;
  array(value: unknown): Schema;
  object(shape: Record<string, unknown>): Schema;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

type ToolUpdate = (result: ToolResult) => void;

export interface ExtensionToolContext {
  invokeTool?<TDetails = unknown>(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: ToolUpdate },
  ): Promise<ToolResult & { details?: TDetails }>;
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
  hidden?: boolean;
  defaultInactive?: boolean;
  approval?: "read" | "write" | "exec";
  loadMode?: "essential" | "discoverable";
  strict?: boolean;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdate | undefined,
    context: ExtensionToolContext,
  ) => Promise<ToolResult> | ToolResult;
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

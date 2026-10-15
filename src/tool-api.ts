import { z } from "zod";

/**
 * Tool adapter (kata 4qqn): the v1 `tool()` helper's call shape on the v2
 * registry. v2 accepts any Standard Schema as a tool input, and zod 4 is one,
 * so the ported tool modules keep their zod schemas and execute bodies; this
 * adapter only bridges the shapes:
 *   - `args` shape -> `z.object(args)` input
 *   - v1 result (`{ title?, output, metadata?, attachments? }` | string) is
 *     kept internally; `toV2Result` converts it to `{ output, content,
 *     metadata }` with FileContent attachments at registration time.
 */

export type ToolAttachment = { type: "file"; mime: string; url: string; filename?: string };

export type ToolResult =
  | string
  | {
      title?: string;
      output: string;
      metadata?: Record<string, unknown>;
      attachments?: ToolAttachment[];
    };

/** Context as the v2 runtime calls it (signal), plus the v1 alias the ported
 * modules still read. */
export type ToolCallContextLike = { signal?: AbortSignal; abort?: AbortSignal };

/** Normalized context handed to the ported execute bodies. */
export type ToolExecuteContext = { signal: AbortSignal; abort: AbortSignal };

export type ToolDefinition = {
  description: string;
  input: z.ZodType;
  execute(input: unknown, context: ToolCallContextLike): Promise<ToolResult>;
};

export type V2ToolResult = { output?: unknown; content?: unknown; metadata?: Record<string, unknown> };

const toFileContent = (attachment: ToolAttachment): Record<string, unknown> => ({
  type: "file",
  uri: attachment.url,
  mime: attachment.mime,
  ...(attachment.filename !== undefined ? { name: attachment.filename } : {}),
});

/** v1 tool result -> v2 Tool.Result. */
export function toV2Result(result: ToolResult): V2ToolResult {
  if (typeof result === "string") return { output: result };
  return {
    output: result.output,
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    ...(result.attachments?.length ? { content: result.attachments.map(toFileContent) } : {}),
  };
}

type ToolInput<Args extends z.ZodRawShape> = {
  description: string;
  args: Args;
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolExecuteContext,
  ): Promise<ToolResult> | ToolResult;
};

export const tool: (<Args extends z.ZodRawShape>(def: ToolInput<Args>) => ToolDefinition) & {
  schema: typeof z;
} = Object.assign(
  <Args extends z.ZodRawShape>(def: ToolInput<Args>): ToolDefinition => ({
    description: def.description,
    input: z.object(def.args),
    execute: async (input, context) => {
      const signal = context.signal ?? context.abort ?? new AbortController().signal;
      return def.execute(input as z.infer<z.ZodObject<Args>>, { signal, abort: signal });
    },
  }),
  { schema: z },
);

export { z };

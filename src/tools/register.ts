/**
 * Tool Registration Wrapper
 *
 * Wraps MCP SDK's registerTool to prevent TS2589 "Type instantiation is excessively deep"
 * errors caused by Zod schema inference flowing into SDK generics.
 *
 * The SDK's type system tries to infer the full schema type recursively, which can
 * cause TypeScript to give up. This wrapper erases the complex inference while
 * preserving runtime behavior.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';

export interface ToolDefinition {
  title?: string;
  description: string;
  inputSchema: ZodRawShape;
}

/**
 * Register a tool with type erasure to prevent deep inference.
 *
 * Usage:
 *   registerTool(server, 'my_tool', {
 *     description: '...',
 *     inputSchema: { foo: z.string() }
 *   }, async ({ foo }) => { ... });
 */
export function registerTool<TArgs extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  definition: ToolDefinition,
  handler: (args: TArgs) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
): void {
  // Cast to any to prevent SDK from inferring the full Zod schema type tree
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, definition, handler);
}

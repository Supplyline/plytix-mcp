import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixResult, PlytixFamilyAttribute, PlytixRelationshipDefinition, PlytixAttributeDetail } from './types.js';
import { registerTool } from './tools/register.js';
import { toolAnnotations } from './tool-annotations.js';

export interface CatalogClient {
  call<T = unknown>(path: string, init?: RequestInit): Promise<PlytixResult<T>>;
  getAttributeByLabel(label: string): Promise<PlytixAttributeDetail | null>;
  getFamilyAttributes(id: string): Promise<PlytixResult<PlytixFamilyAttribute>>;
  getRelationship(id: string): Promise<PlytixResult<PlytixRelationshipDefinition>>;
}
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a Plytix ObjectId');
export const page = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1);
export const pageSize = z.number().int().min(1).max(100).default(25);
export const post = (body: unknown): RequestInit => ({method: 'POST', body: JSON.stringify(body)});

export function result(value: unknown, isError = false) {
  return {content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}], isError};
}

// Compile both advertised schemas and the dispatch validator from the same shape.
export function catalogTool<S extends z.ZodRawShape>(
  name: string, description: string, shape: S,
  handle: (args: z.output<z.ZodObject<S>>, client: CatalogClient) => Promise<ReturnType<typeof result>>,
) {
  const schema = z.strictObject(shape);
  const annotations = toolAnnotations(name);
  async function run(args: unknown, client: CatalogClient) {
    try { return await handle(schema.parse(args), client); }
    catch (error) { return result({error: error instanceof Error ? error.message : String(error)}, true); }
  }
  return {
    definition: {name, description, annotations, inputSchema: z.toJSONSchema(schema, {io: 'input'}) as {type: 'object'; properties: Record<string, unknown>}},
    run,
    register(server: McpServer, client: CatalogClient) {
      registerTool(server, name, {description, inputSchema: shape}, args => run(args, client));
    },
  };
}

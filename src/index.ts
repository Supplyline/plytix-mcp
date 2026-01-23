/**
 * Plytix MCP Server
 *
 * Model Context Protocol server for Plytix PIM integration.
 * Provides tools for products, families, attributes, assets, categories, and variants.
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlytixClient } from './client.js';
import { registerProductTools } from './tools/products.js';
import { registerFamilyTools } from './tools/families.js';
import { registerAttributeTools } from './tools/attributes.js';
import { registerAssetTools } from './tools/assets.js';
import { registerCategoryTools } from './tools/categories.js';
import { registerVariantTools } from './tools/variants.js';
import { registerIdentifierTools } from './tools/identifier.js';

async function main() {
  const server = new McpServer({
    name: 'plytix-mcp',
    version: '0.2.0',
  });

  const client = new PlytixClient();

  // Register all tools
  registerProductTools(server, client);
  registerFamilyTools(server, client);
  registerAttributeTools(server, client);
  registerAssetTools(server, client);
  registerCategoryTools(server, client);
  registerVariantTools(server, client);
  registerIdentifierTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

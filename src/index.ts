#!/usr/bin/env node
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
import { registerProductAttributeTools } from './tools/product-attributes.js';
import { registerRelationshipTools } from './tools/relationships.js';

const VERSION = '0.2.1';

function printUsage(): void {
  process.stdout.write(
    `plytix-mcp ${VERSION}\n` +
      'Model Context Protocol server for Plytix PIM (runs over stdio).\n\n' +
      'Requires PLYTIX_API_KEY and PLYTIX_API_PASSWORD environment variables\n' +
      '(see .env.example).\n\n' +
      'Options:\n' +
      '  -h, --help     Show this help and exit\n' +
      '  -v, --version  Show version and exit\n'
  );
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    printUsage();
    return;
  }
  if (arg === '--version' || arg === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const server = new McpServer({
    name: 'plytix-mcp',
    version: VERSION,
  });

  const client = new PlytixClient();

  // Register all tools
  registerProductTools(server, client);
  registerFamilyTools(server, client);
  registerAttributeTools(server, client);
  registerAssetTools(server, client);
  registerCategoryTools(server, client);
  registerVariantTools(server, client);
  registerProductAttributeTools(server, client);
  registerRelationshipTools(server, client);
  registerIdentifierTools(server);

  // Optional: deployment-specific tools. To enable, import registerCustomTools from
  // './extensions/index.js' and call it here: registerCustomTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

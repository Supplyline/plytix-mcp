
import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlytixClient } from "./plytixClient.js";
import { registerProductTools } from "./tools/products.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerVariantTools } from "./tools/variants.js";

async function main() {
  const server = new Server({ name: "plytix-mcp", version: "0.1.0" });
  const client = new PlytixClient();

  // Register core tools
  registerProductTools(server, client);

  // Pre-register read-only helpers for next steps (safe list endpoints)
  registerAssetTools(server, client);
  registerCategoryTools(server, client);
  registerVariantTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

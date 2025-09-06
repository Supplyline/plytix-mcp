
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlytixClient } from "../plytixClient.js";

export function registerAssetTools(server: McpServer, client: PlytixClient) {
  // LIST product assets
  server.registerTool(
    "assets.list",
    {
      title: "List Assets",
      description: "List assets linked to a product (Plytix v2)",
      inputSchema: {
        product_id: z.string().min(1).describe("The product ID to fetch assets for")
      }
    },
    async ({ product_id }) => {
      try {
        const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}/assets`);
        return { 
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }] 
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `Error fetching assets: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }],
          isError: true,
        };
      }
    }
  );

  // TODO: assets.link / assets.unlink will be added after confirming payload shapes
}

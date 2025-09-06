
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlytixClient } from "../plytixClient.js";

export function registerVariantTools(server: McpServer, client: PlytixClient) {
  // LIST product variants
  server.registerTool(
    "variants.list",
    {
      title: "List Variants",
      description: "List variants linked to a product (Plytix v2)",
      inputSchema: {
        product_id: z.string().min(1).describe("The product ID to fetch variants for")
      }
    },
    async ({ product_id }) => {
      try {
        const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}/variants`);
        return { 
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }] 
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `Error fetching variants: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }],
          isError: true,
        };
      }
    }
  );

  // TODO: variants.link / variants.unlink / variants.resync as needed
}

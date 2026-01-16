
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlytixClient } from '../client.js';

export function registerCategoryTools(server: McpServer, client: PlytixClient) {
  // LIST product categories
  server.registerTool(
    "categories_list",
    {
      title: "List Categories",
      description: "List categories linked to a product (Plytix v2)",
      inputSchema: {
        product_id: z.string().min(1).describe("The product ID to fetch categories for")
      }
    },
    async ({ product_id }) => {
      try {
        const result = await client.getProductCategories(product_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `Error fetching categories: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }],
          isError: true,
        };
      }
    }
  );

  // TODO: categories.link / categories.unlink after verifying payload shapes
}

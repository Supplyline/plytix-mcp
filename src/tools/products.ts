
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlytixClient } from "../plytixClient.js";

export function registerProductTools(server: McpServer, client: PlytixClient) {
  // GET product
  server.registerTool(
    "products.get",
    {
      title: "Get Product",
      description: "Get a single product by product_id (Plytix v2)",
      inputSchema: {
        product_id: z.string().min(1).describe("The product ID to fetch")
      }
    },
    async ({ product_id }) => {
      try {
        const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `Error fetching product: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }],
          isError: true,
        };
      }
    }
  );

  // SEARCH products
  server.registerTool(
    "products.search",
    {
      title: "Search Products",
      description: "Search products (Plytix v2). Pass-through body for v2 search API.",
      inputSchema: {
        attributes: z.array(z.string()).optional().describe("List of attributes to return (max 50)"),
        filters: z.array(z.any()).optional().describe("Search filters"),
        pagination: z.object({
          page: z.number().int().positive().default(1),
          page_size: z.number().int().positive().max(100).default(25)
        }).optional(),
        sort: z.any().optional().describe("Sorting options")
      }
    },
    async (args) => {
      try {
        // NOTE: v2 allows up to 50 attributes and expects custom attrs prefixed with 'attributes.'
        const data = await client.call(`/api/v2/products/search`, {
          method: "POST",
          body: JSON.stringify(args),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `Error searching products: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }],
          isError: true,
        };
      }
    }
  );
}

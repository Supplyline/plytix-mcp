
import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PlytixClient } from "../plytixClient.js";

export function registerProductTools(server: Server, client: PlytixClient) {
  // GET product
  server.tool(
    {
      name: "products.get",
      description: "Get a single product by product_id (Plytix v2)",
      inputSchema: z.object({
        product_id: z.string().min(1),
      }),
    },
    async ({ product_id }) => {
      const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    }
  );

  // SEARCH products
  server.tool(
    {
      name: "products.search",
      description: "Search products (Plytix v2). Pass-through body for v2 search API.",
      inputSchema: z.object({
        attributes: z.array(z.string()).optional(),
        filters: z.any().optional(),
        pagination: z
          .object({
            page: z.number().int().positive().default(1),
            page_size: z.number().int().positive().max(100).default(25),
          })
          .optional(),
        sort: z.any().optional(),
      }),
    },
    async (body) => {
      // NOTE: v2 allows up to 50 attributes and expects custom attrs prefixed with 'attributes.'
      const data = await client.call(`/api/v2/products/search`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    }
  );
}

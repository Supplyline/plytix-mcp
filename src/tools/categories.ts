
import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PlytixClient } from "../plytixClient.js";

export function registerCategoryTools(server: Server, client: PlytixClient) {
  // LIST product categories
  server.tool(
    {
      name: "categories.list",
      description: "List categories linked to a product (Plytix v2)",
      inputSchema: z.object({
        product_id: z.string().min(1),
      }),
    },
    async ({ product_id }) => {
      const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}/categories`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  // TODO: categories.link / categories.unlink after verifying payload shapes
}

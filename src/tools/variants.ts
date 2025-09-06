
import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PlytixClient } from "../plytixClient.js";

export function registerVariantTools(server: Server, client: PlytixClient) {
  // LIST product variants
  server.tool(
    {
      name: "variants.list",
      description: "List variants for a product (Plytix v2)",
      inputSchema: z.object({
        product_id: z.string().min(1),
      }),
    },
    async ({ product_id }) => {
      const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}/variants`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  // TODO: variants.link / variants.unlink / variants.resync as needed
}

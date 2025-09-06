
import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PlytixClient } from "../plytixClient.js";

export function registerAssetTools(server: Server, client: PlytixClient) {
  // LIST product assets
  server.tool(
    {
      name: "assets.list",
      description: "List assets linked to a product (Plytix v2)",
      inputSchema: z.object({
        product_id: z.string().min(1),
      }),
    },
    async ({ product_id }) => {
      const data = await client.call(`/api/v2/products/${encodeURIComponent(product_id)}/assets`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  // TODO: assets.link / assets.unlink will be added after confirming payload shapes
}

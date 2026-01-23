/**
 * Asset Tools
 *
 * Tools for listing assets linked to products.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';

export function registerAssetTools(server: McpServer, client: PlytixClient) {
  // LIST product assets
  registerTool<{ product_id: string }>(
    server,
    'assets_list',
    {
      title: 'List Assets',
      description: 'List assets linked to a product (Plytix v2)',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to fetch assets for'),
      },
    },
    async ({ product_id }) => {
      try {
        const result = await client.getProductAssets(product_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching assets: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // TODO: assets.link / assets.unlink will be added after confirming payload shapes
}

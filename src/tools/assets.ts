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

  // LINK asset to product
  registerTool<{ product_id: string; asset_id: string; attribute_label?: string }>(
    server,
    'assets_link',
    {
      title: 'Link Asset',
      description:
        'Link an existing asset to a product. Optionally target a specific media attribute.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        asset_id: z.string().min(1).describe('The asset ID to link'),
        attribute_label: z
          .string()
          .optional()
          .describe('Optional media attribute label to assign the asset to'),
      },
    },
    async ({ product_id, asset_id, attribute_label }) => {
      try {
        const result = await client.linkProductAsset(product_id, asset_id, attribute_label);
        const linked = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  asset: linked ? { id: linked.id, name: linked.name, url: linked.url } : { id: asset_id },
                  ...(attribute_label ? { attribute_label } : {}),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error linking asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // UNLINK asset from product
  registerTool<{ product_id: string; asset_id: string }>(
    server,
    'assets_unlink',
    {
      title: 'Unlink Asset',
      description: 'Remove an asset link from a product. The asset itself is not deleted.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        asset_id: z.string().min(1).describe('The asset ID to unlink'),
      },
    },
    async ({ product_id, asset_id }) => {
      try {
        await client.unlinkProductAsset(product_id, asset_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  asset_id,
                  action: 'unlinked',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error unlinking asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

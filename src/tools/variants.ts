/**
 * Variant Tools
 *
 * Tools for listing and managing product variants.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';

export function registerVariantTools(server: McpServer, client: PlytixClient) {
  // LIST product variants
  registerTool<{ product_id: string }>(
    server,
    'variants_list',
    {
      title: 'List Variants',
      description: 'List variants linked to a product (Plytix v2)',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to fetch variants for'),
      },
    },
    async ({ product_id }) => {
      try {
        const result = await client.getProductVariants(product_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching variants: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // RESYNC variant attributes to parent
  registerTool<{ parent_product_id: string; attribute_labels: string[]; variant_ids: string[] }>(
    server,
    'variants_resync',
    {
      title: 'Resync Variants',
      description:
        'Resync variant attributes to inherit values from the parent product. ' +
        'Restores overwritten attributes on specified variants to use the parent\'s value instead.',
      inputSchema: {
        parent_product_id: z.string().min(1).describe('The parent product ID containing the variants'),
        attribute_labels: z
          .array(z.string())
          .min(1)
          .describe('List of attribute labels to reset (must be attributes at parent level)'),
        variant_ids: z
          .array(z.string())
          .min(1)
          .describe('List of variant product IDs to resync (must be variants of the specified parent)'),
      },
    },
    async ({ parent_product_id, attribute_labels, variant_ids }) => {
      try {
        await client.resyncVariants(parent_product_id, attribute_labels, variant_ids);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  parent_product_id,
                  attributes_reset: attribute_labels,
                  variants_affected: variant_ids.length,
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
              text: `Error resyncing variants: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

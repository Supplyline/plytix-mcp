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
      description: 'List variants for a product.',
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
      description: 'Resync variant inheritance from the parent.',
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

  // CREATE variant under parent
  registerTool<{
    parent_product_id: string;
    sku: string;
    label?: string;
    attributes?: Record<string, unknown>;
  }>(
    server,
    'variants_create',
    {
      title: 'Create Variant',
      description: 'Create a variant under a parent product.',
      inputSchema: {
        parent_product_id: z.string().min(1).describe('The parent product ID'),
        sku: z.string().min(1).describe('SKU for the new variant'),
        label: z.string().optional().describe('Optional label for the new variant'),
        attributes: z
          .record(z.unknown())
          .optional()
          .describe('Optional attributes to set or override on the variant'),
      },
    },
    async ({ parent_product_id, sku, label, attributes }) => {
      try {
        const result = await client.createVariant(parent_product_id, {
          sku,
          ...(label !== undefined ? { label } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
        });
        const variant = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'created',
                  parent_product_id,
                  variant: variant
                    ? { id: variant.id, sku: variant.sku, label: variant.label }
                    : undefined,
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
              text: `Error creating variant: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // LINK existing product as variant
  registerTool<{ parent_product_id: string; variant_product_id: string }>(
    server,
    'variants_link',
    {
      title: 'Link Variant',
      description: 'Link an existing product as a variant.',
      inputSchema: {
        parent_product_id: z.string().min(1).describe('The parent product ID'),
        variant_product_id: z
          .string()
          .min(1)
          .describe('The existing product ID to link as a variant'),
      },
    },
    async ({ parent_product_id, variant_product_id }) => {
      try {
        await client.linkVariant(parent_product_id, variant_product_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'linked',
                  parent_product_id,
                  variant_product_id,
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
              text: `Error linking variant: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // UNLINK variant from parent (product is not deleted)
  registerTool<{ parent_product_id: string; variant_product_id: string }>(
    server,
    'variants_unlink',
    {
      title: 'Unlink Variant',
      description: 'Unlink a variant from its parent.',
      inputSchema: {
        parent_product_id: z.string().min(1).describe('The parent product ID'),
        variant_product_id: z.string().min(1).describe('The variant product ID to unlink'),
      },
    },
    async ({ parent_product_id, variant_product_id }) => {
      try {
        await client.unlinkVariant(parent_product_id, variant_product_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'unlinked',
                  parent_product_id,
                  variant_product_id,
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
              text: `Error unlinking variant: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

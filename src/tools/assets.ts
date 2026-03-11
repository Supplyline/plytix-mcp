/**
 * Asset Tools
 *
 * Tools for listing assets linked to products.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import type { FilterOperator } from '../types.js';
import { registerTool } from './register.js';

const filterOperatorSchema = z.enum([
  'eq',
  '!eq',
  'like',
  'in',
  '!in',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  '!exists',
  'text_search',
]);

export function registerAssetTools(server: McpServer, client: PlytixClient) {
  // GET single asset by ID
  registerTool<{ asset_id: string }>(
    server,
    'assets_get',
    {
      title: 'Get Asset',
      description: 'Get one asset by ID.',
      inputSchema: {
        asset_id: z.string().min(1).describe('The asset ID'),
      },
    },
    async ({ asset_id }) => {
      try {
        const result = await client.getAsset(asset_id);
        const asset = result.data?.[0];

        if (!asset) {
          return {
            content: [{ type: 'text', text: `Asset not found: ${asset_id}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(asset, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // SEARCH assets
  registerTool<{
    filters?: Array<Array<{ field: string; operator: FilterOperator; value?: unknown }>>;
    pagination?: { page?: number; page_size?: number; order?: string };
    sort?: unknown;
  }>(
    server,
    'assets_search',
    {
      title: 'Search Assets',
      description: 'Search assets.',
      inputSchema: {
        filters: z
          .array(
            z.array(
              z.object({
                field: z.string(),
                operator: filterOperatorSchema,
                value: z.unknown().optional(),
              })
            )
          )
          .optional()
          .describe('Search filters in Plytix OR-of-ANDs format'),
        pagination: z
          .object({
            page: z.number().int().positive().optional(),
            page_size: z.number().int().positive().max(100).optional(),
            order: z.string().optional(),
          })
          .optional()
          .describe('Pagination options'),
        sort: z.unknown().optional().describe('Optional sort payload'),
      },
    },
    async ({ filters, pagination, sort }) => {
      try {
        const result = await client.searchAssets({
          ...(filters !== undefined ? { filters } : {}),
          ...(pagination !== undefined ? { pagination } : {}),
          ...(sort !== undefined ? { sort } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  assets: result.data,
                  pagination: result.pagination,
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
              text: `Error searching assets: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // UPDATE asset metadata (filename and categories only)
  registerTool<{ asset_id: string; filename?: string; categories?: string[] }>(
    server,
    'assets_update',
    {
      title: 'Update Asset',
      description: 'Update asset filename or categories.',
      inputSchema: {
        asset_id: z.string().min(1).describe('The asset ID'),
        filename: z.string().optional().describe('New filename for the asset'),
        categories: z.array(z.string()).optional().describe('Category IDs to assign to the asset'),
      },
    },
    async ({ asset_id, filename, categories }) => {
      try {
        if (filename === undefined && categories === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error updating asset: provide at least one of filename or categories',
              },
            ],
            isError: true,
          };
        }

        await client.updateAsset(asset_id, {
          ...(filename !== undefined ? { filename } : {}),
          ...(categories !== undefined ? { categories } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'updated',
                  asset_id,
                  ...(filename !== undefined ? { filename } : {}),
                  ...(categories !== undefined ? { categories } : {}),
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
              text: `Error updating asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // LIST product assets
  registerTool<{ product_id: string }>(
    server,
    'assets_list',
    {
      title: 'List Assets',
      description: 'List assets linked to a product.',
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
      description: 'Link an asset to a product.',
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
      description: 'Unlink an asset from a product.',
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

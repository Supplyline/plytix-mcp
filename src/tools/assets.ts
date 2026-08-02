/**
 * Asset Tools
 *
 * Read + write operations on assets. Assets in Plytix are media files
 * (images, swatches, PDFs) organized via File Categories (asset folders).
 * Assets attach to products via SPECIFIC media attributes (thumbnail,
 * additional_images, material_swatch_image) — when you link, you specify
 * which attribute receives the asset.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import {
  makeDryRunResult,
  consumeToken,
  sessionCapAvailable,
  recordDelete,
  MAX_DELETES_PER_SESSION,
} from '../safety.js';

export function registerAssetTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // assets.list - per-product
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string }>(
    server,
    'assets_list',
    {
      title: 'List Product Assets',
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

  // ─────────────────────────────────────────────────────────────
  // assets.get - single by ID
  // ─────────────────────────────────────────────────────────────

  registerTool<{ asset_id: string }>(
    server,
    'assets_get',
    {
      title: 'Get Asset',
      description: 'Get a single asset by ID — returns filename, download URL, category links, etc.',
      inputSchema: { asset_id: z.string().describe('Asset ID') },
    },
    async ({ asset_id }) => {
      try {
        const asset = await client.getAsset(asset_id);
        if (!asset) {
          return {
            content: [{ type: 'text', text: `Asset not found: ${asset_id}` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(asset, null, 2) }] };
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

  // ─────────────────────────────────────────────────────────────
  // assets.search - org-wide
  // ─────────────────────────────────────────────────────────────

  registerTool<{ page: number; page_size: number; filters?: unknown[] }>(
    server,
    'assets_search',
    {
      title: 'Search Assets',
      description:
        'Search assets across the org. Returns ids, filenames, URLs, categories. ' +
        'Optional `filters` follow Plytix search filter format ([[{field, operator, value}], ...]).',
      inputSchema: {
        page: z.number().int().positive().default(1),
        page_size: z.number().int().positive().max(100).default(25),
        filters: z.array(z.unknown()).optional().describe('Optional filter set'),
      },
    },
    async ({ page, page_size, filters }) => {
      try {
        const body: Record<string, unknown> = { pagination: { page, page_size } };
        if (filters) body.filters = filters;
        const result = await client.searchAssets(body);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { assets: result.data ?? [], pagination: result.pagination ?? null },
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

  // ─────────────────────────────────────────────────────────────
  // assets.create_from_url - upload by giving Plytix a public URL
  // ─────────────────────────────────────────────────────────────

  registerTool<{ url: string; filename?: string }>(
    server,
    'assets_create_from_url',
    {
      title: 'Create Asset from URL',
      description:
        'Create a new asset by giving Plytix a public URL to download. ' +
        'Preferred over base64 upload (which is known to be flaky in Plytix).',
      inputSchema: {
        url: z.string().url().describe('Public URL Plytix will fetch'),
        filename: z.string().optional().describe('Override filename (defaults to URL basename)'),
      },
    },
    async ({ url, filename }) => {
      try {
        const result = await client.createAssetFromUrl({ url, filename });
        const asset = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, id: asset?.id, filename: asset?.filename ?? filename, asset },
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
              text: `Error creating asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // assets.update - filename, public flag, file-category assignment
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    asset_id: string;
    filename?: string;
    public?: boolean;
    category_ids?: string[];
  }>(
    server,
    'assets_update',
    {
      title: 'Update Asset',
      description:
        'Update an asset\'s filename, public/private flag, and/or file-category folder assignments. ' +
        'Pass only the fields you want to change. `category_ids` REPLACES the existing category set.',
      inputSchema: {
        asset_id: z.string().describe('Asset ID'),
        filename: z.string().optional(),
        public: z.boolean().optional().describe('Public download flag'),
        category_ids: z
          .array(z.string())
          .optional()
          .describe('File-category IDs (replaces existing). Use file_categories_* tools to manage these.'),
      },
    },
    async (args) => {
      try {
        const data: { filename?: string; public?: boolean; category_ids?: string[] } = {};
        if (args.filename !== undefined) data.filename = args.filename;
        if (args.public !== undefined) data.public = args.public;
        if (args.category_ids !== undefined) data.category_ids = args.category_ids;
        const result = await client.updateAsset(args.asset_id, data);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, id: args.asset_id, asset: result.data?.[0] ?? null },
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

  // ─────────────────────────────────────────────────────────────
  // assets.delete
  // ─────────────────────────────────────────────────────────────

  registerTool<{ asset_id: string; dry_run?: boolean; confirm_token?: string }>(
    server,
    'assets_delete',
    {
      title: 'Delete Asset (two-step)',
      description:
        'Delete an asset. TWO-STEP GATE: dry_run:true first → confirm_token to execute. ' +
        `Session cap: ${MAX_DELETES_PER_SESSION} deletes per MCP process. ` +
        'WARNING: any product references to this asset will break. ' +
        'You MUST surface the preview to the user and get explicit confirmation before executing.',
      inputSchema: {
        asset_id: z.string().describe('Asset ID'),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
    },
    async ({ asset_id, dry_run, confirm_token }) => {
      try {
        const asset = await client.getAsset(asset_id);
        if (!asset) {
          return {
            content: [{ type: 'text', text: `Asset not found: ${asset_id}` }],
            isError: true,
          };
        }
        const preview = {
          id: asset_id,
          filename: (asset as { filename?: string }).filename,
          url: (asset as { url?: string }).url,
          public: (asset as { public?: boolean }).public,
        };
        if (dry_run) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(makeDryRunResult('assets_delete', asset_id, preview), null, 2),
              },
            ],
          };
        }
        const tokenCheck = consumeToken('assets_delete', asset_id, confirm_token);
        if (!tokenCheck.ok) return { content: [{ type: 'text', text: tokenCheck.reason }], isError: true };
        const capCheck = sessionCapAvailable();
        if (!capCheck.ok) return { content: [{ type: 'text', text: capCheck.reason }], isError: true };

        const deleted = await client.deleteAsset(asset_id);
        const count = recordDelete();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  deleted,
                  id: asset_id,
                  session_deletes_used: count,
                  session_deletes_remaining: MAX_DELETES_PER_SESSION - count,
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
              text: `Error deleting asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // assets.link_to_product - attach asset to a product media attribute
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    product_id: string;
    asset_id: string;
    attribute_label: string;
  }>(
    server,
    'assets_link_to_product',
    {
      title: 'Link Asset to Product',
      description:
        'Attach an existing asset to a specific media attribute on a product. ' +
        'Common attribute_label values: "thumbnail", "additional_images", "material_swatch_image".',
      inputSchema: {
        product_id: z.string().describe('Product ID'),
        asset_id: z.string().describe('Asset ID'),
        attribute_label: z
          .string()
          .describe('Snake_case label of the media attribute to attach to'),
      },
    },
    async ({ product_id, asset_id, attribute_label }) => {
      try {
        await client.linkAssetToProduct(product_id, asset_id, attribute_label);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, product_id, asset_id, attribute_label },
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

  // ─────────────────────────────────────────────────────────────
  // assets.unlink_from_product
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string; product_asset_id: string }>(
    server,
    'assets_unlink_from_product',
    {
      title: 'Unlink Asset from Product',
      description:
        'Detach an asset from a product. The asset itself remains in Plytix — just removed from this product. ' +
        '`product_asset_id` is the ID returned in the product\'s assets[] array (NOT the global asset ID).',
      inputSchema: {
        product_id: z.string().describe('Product ID'),
        product_asset_id: z
          .string()
          .describe('Product-asset ID (from the product\'s assets[] array)'),
      },
    },
    async ({ product_id, product_asset_id }) => {
      try {
        await client.unlinkAssetFromProduct(product_id, product_asset_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, product_id, product_asset_id }, null, 2),
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

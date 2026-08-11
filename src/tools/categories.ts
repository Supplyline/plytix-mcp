/**
 * Category Tools
 *
 * Tools for listing categories linked to products.
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

export function registerCategoryTools(server: McpServer, client: PlytixClient) {
  // SEARCH categories
  registerTool<{ query?: string; pagination?: { page?: number; page_size?: number } }>(
    server,
    'categories_search',
    {
      title: 'Search Categories',
      description: 'Search product categories.',
      inputSchema: {
        query: z.string().optional().describe('Search query to filter categories by name'),
        pagination: z
          .object({
            page: z.number().int().positive().optional(),
            page_size: z.number().int().positive().max(100).optional(),
          })
          .optional()
          .describe('Pagination options'),
      },
    },
    async ({ query, pagination }) => {
      try {
        const result = await client.searchCategories({
          ...(pagination !== undefined ? { pagination } : {}),
          ...(query ? { filters: [[{ field: 'name', operator: 'like', value: query }]] } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  categories: result.data,
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
              text: `Error searching categories: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // LIST product categories
  registerTool<{ product_id: string }>(
    server,
    'categories_list',
    {
      title: 'List Categories',
      description: 'List categories linked to a product.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to fetch categories for'),
      },
    },
    async ({ product_id }) => {
      try {
        const result = await client.getProductCategories(product_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching categories: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // LINK category to product
  registerTool<{ product_id: string; category_id: string }>(
    server,
    'categories_link',
    {
      title: 'Link Category',
      description: 'Link a category to a product.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        category_id: z.string().min(1).describe('The category ID to link'),
      },
    },
    async ({ product_id, category_id }) => {
      try {
        const result = await client.linkProductCategory(product_id, category_id);
        const linked = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  category: linked
                    ? { id: linked.id, name: linked.name, path: linked.path }
                    : { id: category_id },
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
              text: `Error linking category: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // UNLINK category from product
  registerTool<{ product_id: string; category_id: string }>(
    server,
    'categories_unlink',
    {
      title: 'Unlink Category',
      description: 'Unlink a category from a product.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        category_id: z.string().min(1).describe('The category ID to unlink'),
      },
    },
    async ({ product_id, category_id }) => {
      try {
        await client.unlinkProductCategory(product_id, category_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  category_id,
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
              text: `Error unlinking category: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // FILE CATEGORIES — used for ASSET folder organization.
  // Distinct from product categories. Plytix stores these at
  // /api/v1/categories/file.
  // ─────────────────────────────────────────────────────────────

  // file_categories.search
  registerTool<{ page: number; page_size: number }>(
    server,
    'file_categories_search',
    {
      title: 'Search File Categories (asset folders)',
      description:
        'Search/list all file categories — these are the asset folder structure used to organize media files (product photos, swatches, pattern files).',
      inputSchema: {
        page: z.number().int().positive().default(1),
        page_size: z.number().int().positive().max(100).default(25),
      },
    },
    async ({ page, page_size }) => {
      try {
        const result = await client.searchFileCategories({ pagination: { page, page_size } });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { categories: result.data ?? [], pagination: result.pagination ?? null },
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
              text: `Error searching file categories: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // file_categories.create
  registerTool<{ name: string; parent_id?: string }>(
    server,
    'file_categories_create',
    {
      title: 'Create File Category (asset folder)',
      description:
        'Create a new asset folder. Optionally pass `parent_id` to create as a sub-folder. ' +
        'Useful for organizing assets by type ("Product Photos", "Swatches", "Lifestyle Photos", "Brand").',
      inputSchema: {
        name: z.string().min(1).describe('Folder name'),
        parent_id: z.string().optional().describe('Parent folder ID for nesting'),
      },
    },
    async ({ name, parent_id }) => {
      try {
        const result = await client.createFileCategory({ name, parent_id });
        const cat = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, id: cat?.id, name: cat?.name ?? name, parent_id },
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
              text: `Error creating file category: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // file_categories.update
  registerTool<{ category_id: string; name?: string; parent_id?: string }>(
    server,
    'file_categories_update',
    {
      title: 'Update File Category',
      description: 'Rename a file category or change its parent (move folder).',
      inputSchema: {
        category_id: z.string().describe('File category ID'),
        name: z.string().min(1).optional().describe('New name'),
        parent_id: z.string().optional().describe('New parent folder ID'),
      },
    },
    async ({ category_id, name, parent_id }) => {
      try {
        const data: { name?: string; parent_id?: string } = {};
        if (name !== undefined) data.name = name;
        if (parent_id !== undefined) data.parent_id = parent_id;
        const result = await client.updateFileCategory(category_id, data);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, id: category_id, category: result.data?.[0] ?? null },
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
              text: `Error updating file category: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // file_categories.delete (two-step gated)
  registerTool<{ category_id: string; dry_run?: boolean; confirm_token?: string }>(
    server,
    'file_categories_delete',
    {
      title: 'Delete File Category (two-step)',
      description:
        'Delete an asset folder. TWO-STEP GATE: dry_run:true first → confirm_token to execute. ' +
        `Session cap: ${MAX_DELETES_PER_SESSION} deletes per MCP process. ` +
        'Assets in the folder are NOT deleted — they just lose this category association. ' +
        'You MUST surface the preview to the user and get explicit confirmation before executing.',
      inputSchema: {
        category_id: z.string().describe('File category ID'),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
    },
    async ({ category_id, dry_run, confirm_token }) => {
      try {
        // No single-get for file categories; use search-by-id-equivalent
        const lookup = await client.searchFileCategories({
          pagination: { page: 1, page_size: 1 },
          filters: [[{ field: 'id', operator: 'eq', value: category_id }]],
        });
        const cat = lookup.data?.[0] as { id?: string; name?: string; parent_id?: string } | undefined;
        const preview = {
          id: category_id,
          name: cat?.name ?? '(unknown — lookup unavailable)',
          parent_id: cat?.parent_id ?? null,
        };
        if (dry_run) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  makeDryRunResult('file_categories_delete', category_id, preview),
                  null,
                  2
                ),
              },
            ],
          };
        }
        const tokenCheck = consumeToken('file_categories_delete', category_id, confirm_token);
        if (!tokenCheck.ok) return { content: [{ type: 'text', text: tokenCheck.reason }], isError: true };
        const capCheck = sessionCapAvailable();
        if (!capCheck.ok) return { content: [{ type: 'text', text: capCheck.reason }], isError: true };

        const deleted = await client.deleteFileCategory(category_id);
        const count = recordDelete();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  deleted,
                  id: category_id,
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
              text: `Error deleting file category: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

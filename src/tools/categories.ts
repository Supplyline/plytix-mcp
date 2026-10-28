/**
 * Category Tools
 *
 * Tools for the product category tree (search, create, rename, move, sort,
 * delete) and for linking categories to products.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import {
  categoriesCreate,
  categoriesDelete,
  categoriesSortRoot,
  categoriesUpdate,
} from '../schema-write-ops.js';

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
  // Category tree writes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ name: string; parent_id?: string }>(
    server,
    'categories_create',
    {
      title: 'Create Category',
      description: 'Create a product category: a root category, or a subcategory when parent_id is given.',
      inputSchema: {
        name: z.string().min(1).describe('Category name'),
        parent_id: z.string().optional().describe('Parent category ID (omit for a root category)'),
      },
    },
    async (input) => categoriesCreate(client, input)
  );

  registerTool<{ category_id: string; name?: string; parent_id?: string; sort_children?: string[] }>(
    server,
    'categories_update',
    {
      title: 'Update Category',
      description:
        'Rename a category, move it (parent_id; "" makes it a root category), or reorder its direct children (sort_children must list every child ID). parent_id and sort_children cannot be combined in one call.',
      inputSchema: {
        category_id: z.string().min(1).describe('The category ID'),
        name: z.string().min(1).optional().describe('New name'),
        parent_id: z.string().optional().describe('New parent category ID, or "" to make it a root category'),
        sort_children: z
          .array(z.string().min(1))
          .optional()
          .describe('Every direct child ID in the desired order'),
      },
    },
    async (input) => categoriesUpdate(client, input)
  );

  registerTool<{ category_ids: string[] }>(
    server,
    'categories_sort_root',
    {
      title: 'Sort Root Categories',
      description: 'Reorder the root-level categories. category_ids must list every root category ID exactly once.',
      inputSchema: {
        category_ids: z.array(z.string().min(1)).min(1).describe('Every root category ID in the desired order'),
      },
    },
    async (input) => categoriesSortRoot(client, input)
  );

  registerTool<{ category_id: string; dry_run?: boolean; confirm_token?: string; move_children_to?: string }>(
    server,
    'categories_delete',
    {
      title: 'Delete Category',
      description:
        'Delete a category. Two-step: call with dry_run: true to get a preview (including direct children) and a confirm_token, then call again with the token. Plytix deletes the whole subtree; pass move_children_to (a category ID, or "" for root) to move the direct children out first so only this category is removed.',
      inputSchema: {
        category_id: z.string().min(1).describe('The category ID'),
        dry_run: z.boolean().optional().describe('Preview and get a confirm_token without deleting'),
        confirm_token: z.string().optional().describe('Token from the dry run; required to execute'),
        move_children_to: z
          .string()
          .optional()
          .describe('Move direct children under this category ID first ("" = root) so they survive'),
      },
    },
    async (input) => categoriesDelete(client, input)
  );
}

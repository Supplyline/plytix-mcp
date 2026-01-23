/**
 * Category Tools
 *
 * Tools for listing categories linked to products.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';

export function registerCategoryTools(server: McpServer, client: PlytixClient) {
  // LIST product categories
  registerTool<{ product_id: string }>(
    server,
    'categories_list',
    {
      title: 'List Categories',
      description: 'List categories linked to a product (Plytix v2)',
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
      description: 'Link an existing category to a product',
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
      description: 'Remove a category link from a product. The category itself is not deleted.',
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
}

/**
 * Product Relationship Tools
 *
 * Atomic write operations for linking/unlinking products through a relationship.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';

export function registerRelationshipTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // relationships_get - Get one relationship definition
  // ─────────────────────────────────────────────────────────────

  registerTool<{ relationship_id: string }>(
    server,
    'relationships_get',
    {
      title: 'Get Relationship',
      description: 'Get one relationship definition.',
      inputSchema: {
        relationship_id: z.string().min(1).describe('The relationship definition ID'),
      },
    },
    async ({ relationship_id }) => {
      try {
        const result = await client.getRelationship(relationship_id);
        const relationship = result.data?.[0];

        if (!relationship) {
          return {
            content: [{ type: 'text', text: `Relationship not found: ${relationship_id}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(relationship, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching relationship: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // relationships_search - Search/list relationship definitions
  // ─────────────────────────────────────────────────────────────

  registerTool<{ query?: string; pagination?: { page?: number; page_size?: number } }>(
    server,
    'relationships_search',
    {
      title: 'Search Relationships',
      description: 'Search relationship definitions.',
      inputSchema: {
        query: z.string().optional().describe('Search query to filter relationships by label'),
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
        const result = await client.searchRelationships({
          ...(pagination !== undefined ? { pagination } : {}),
          ...(query ? { filters: [[{ field: 'label', operator: 'like', value: query }]] } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  relationships: result.data,
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
              text: `Error searching relationships: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // relationships_link_product - Link one related product
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    product_id: string;
    relationship_id: string;
    related_product_id: string;
    quantity?: number;
  }>(
    server,
    'relationships_link_product',
    {
      title: 'Link Related Product',
      description: 'Link a related product.',
      inputSchema: {
        product_id: z.string().min(1).describe('Primary product ID'),
        relationship_id: z.string().min(1).describe('Relationship definition ID'),
        related_product_id: z.string().min(1).describe('Related product ID to link'),
        quantity: z.number().positive().optional().describe('Optional relationship quantity'),
      },
    },
    async ({ product_id, relationship_id, related_product_id, quantity }) => {
      try {
        await client.linkProductRelationship(product_id, relationship_id, [
          {
            product_id: related_product_id,
            ...(quantity !== undefined ? { quantity } : {}),
          },
        ]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'linked',
                  product_id,
                  relationship_id,
                  related_product_id,
                  ...(quantity !== undefined ? { quantity } : {}),
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
              text: `Error linking relationship: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // relationships_unlink_product - Unlink one related product
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    product_id: string;
    relationship_id: string;
    related_product_id: string;
  }>(
    server,
    'relationships_unlink_product',
    {
      title: 'Unlink Related Product',
      description: 'Unlink a related product.',
      inputSchema: {
        product_id: z.string().min(1).describe('Primary product ID'),
        relationship_id: z.string().min(1).describe('Relationship definition ID'),
        related_product_id: z.string().min(1).describe('Related product ID to unlink'),
      },
    },
    async ({ product_id, relationship_id, related_product_id }) => {
      try {
        await client.unlinkProductRelationship(product_id, relationship_id, [related_product_id]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'unlinked',
                  product_id,
                  relationship_id,
                  related_product_id,
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
              text: `Error unlinking relationship: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // relationships_set_quantity - Update one relationship row
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    product_id: string;
    relationship_id: string;
    related_product_id: string;
    quantity: number;
  }>(
    server,
    'relationships_set_quantity',
    {
      title: 'Set Relationship Quantity',
      description:
        'Set quantity for a single related product row in a relationship.',
      inputSchema: {
        product_id: z.string().min(1).describe('Primary product ID'),
        relationship_id: z.string().min(1).describe('Relationship definition ID'),
        related_product_id: z.string().min(1).describe('Related product ID to update'),
        quantity: z.number().nonnegative().describe('Quantity value to store'),
      },
    },
    async ({ product_id, relationship_id, related_product_id, quantity }) => {
      try {
        await client.updateProductRelationship(product_id, relationship_id, [
          { product_id: related_product_id, quantity },
        ]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'quantity_updated',
                  product_id,
                  relationship_id,
                  related_product_id,
                  quantity,
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
              text: `Error updating relationship quantity: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

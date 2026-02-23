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
      description:
        'Link one product to another under a specific relationship. ' +
        'If quantity is provided, it is stored in the relationship row.',
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
      description:
        'Unlink one related product from a relationship on the primary product.',
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

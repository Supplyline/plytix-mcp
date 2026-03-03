/**
 * Product Attribute Write Tools
 *
 * Atomic write operations for setting and clearing a single product attribute.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import { stripAttributesPrefix } from '../utils/attribute-labels.js';
import { validateAttributeValue } from '../utils/validate-attribute.js';

export function registerProductAttributeTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // products_set_attribute - Set a single attribute value
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string; attribute_label: string; value: unknown }>(
    server,
    'products_set_attribute',
    {
      title: 'Set Product Attribute',
      description:
        'Set a single product attribute value atomically. ' +
        'Use snake_case labels (e.g., "head_material"). The "attributes." prefix is optional.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to update'),
        attribute_label: z
          .string()
          .min(1)
          .describe('Attribute label (snake_case, e.g., "head_material" or "attributes.head_material")'),
        value: z.unknown().describe('Attribute value to set'),
      },
    },
    async ({ product_id, attribute_label, value }) => {
      try {
        if (value === null) {
          return {
            content: [{ type: 'text', text: 'Value cannot be null. Use products_clear_attribute instead.' }],
            isError: true,
          };
        }

        const normalizedLabel = stripAttributesPrefix(attribute_label);
        if (!normalizedLabel) {
          return {
            content: [{ type: 'text', text: 'attribute_label cannot be empty' }],
            isError: true,
          };
        }
        const attribute = await client.getAttributeByLabel(normalizedLabel);

        if (!attribute) {
          return {
            content: [{ type: 'text', text: `Attribute not found: ${normalizedLabel}` }],
            isError: true,
          };
        }

        const validationError = validateAttributeValue(attribute, value);
        if (validationError) {
          return {
            content: [{ type: 'text', text: validationError }],
            isError: true,
          };
        }

        const result = await client.updateProduct(product_id, {
          attributes: { [normalizedLabel]: value },
        });
        const updated = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  attribute_label: normalizedLabel,
                  action: 'set',
                  modified: updated?.modified,
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
              text: `Error setting attribute: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products_clear_attribute - Clear a single attribute value
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string; attribute_label: string }>(
    server,
    'products_clear_attribute',
    {
      title: 'Clear Product Attribute',
      description:
        'Clear a single product attribute value atomically by setting it to null. ' +
        'Use snake_case labels (e.g., "head_material"). The "attributes." prefix is optional.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to update'),
        attribute_label: z
          .string()
          .min(1)
          .describe('Attribute label (snake_case, e.g., "head_material" or "attributes.head_material")'),
      },
    },
    async ({ product_id, attribute_label }) => {
      try {
        const normalizedLabel = stripAttributesPrefix(attribute_label);
        if (!normalizedLabel) {
          return {
            content: [{ type: 'text', text: 'attribute_label cannot be empty' }],
            isError: true,
          };
        }
        const attribute = await client.getAttributeByLabel(normalizedLabel);

        if (!attribute) {
          return {
            content: [{ type: 'text', text: `Attribute not found: ${normalizedLabel}` }],
            isError: true,
          };
        }

        const result = await client.updateProduct(product_id, {
          attributes: { [normalizedLabel]: null },
        });
        const updated = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  attribute_label: normalizedLabel,
                  action: 'cleared',
                  modified: updated?.modified,
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
              text: `Error clearing attribute: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

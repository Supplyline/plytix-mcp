/**
 * Sync Tools for Supplyline
 *
 * MCP tools for syncing Plytix Channel exports.
 * These tools handle parsing, normalization, and preparation for Supabase.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../../client.js';
import {
  parseChannelExport,
  normalizeProduct,
  resolveParentIds,
  buildFamilyLabelMap,
} from './channel.js';
import type { ChannelProduct, NormalizedProduct } from './types.js';

export function registerSyncTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // channel.parse - Parse Channel JSON export
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'channel_parse',
    {
      title: 'Parse Channel Export',
      description:
        'Parse a Plytix Channel JSON export and normalize it for Supabase sync. ' +
        'Handles SKU Level parsing, deduplication of _1 suffix fields, and checksum generation. ' +
        'Returns normalized products ready for database upsert.',
      inputSchema: {
        products: z
          .array(z.record(z.unknown()))
          .describe('Array of products from Channel JSON export'),
        deduplicate: z
          .boolean()
          .default(true)
          .describe('Remove _1 suffix duplicate fields (default: true)'),
        resolve_parents: z
          .boolean()
          .default(true)
          .describe('Resolve parent_id from group_id relationships (default: true)'),
        resolve_families: z
          .boolean()
          .default(false)
          .describe(
            'Fetch families from API to resolve family_id (default: false, requires API calls)'
          ),
      },
    },
    async ({ products, deduplicate, resolve_parents, resolve_families }) => {
      try {
        // Parse the channel export
        const result = parseChannelExport(products as ChannelProduct[], {
          deduplicate,
        });

        // Resolve parent IDs if requested
        let parentMap: Map<string, string> | null = null;
        if (resolve_parents) {
          parentMap = resolveParentIds(result.products);

          // Apply parent IDs to products
          for (const product of result.products) {
            const parentId = parentMap.get(product.id);
            if (parentId) {
              product.parent_id = parentId;
            }
          }
        }

        // Resolve family IDs if requested
        let familyMap: Map<string, string> | null = null;
        if (resolve_families) {
          try {
            const familiesResult = await client.getFamilies();
            if (familiesResult.data) {
              familyMap = buildFamilyLabelMap(
                familiesResult.data.map((f) => ({
                  id: f.id,
                  label: f.name, // Plytix: name is the snake_case identifier
                  name: f.name,
                }))
              );

              // Apply family IDs to products
              for (const product of result.products) {
                if (product.family_label && familyMap.has(product.family_label)) {
                  product.family_id = familyMap.get(product.family_label)!;
                }
              }
            }
          } catch (error) {
            // Add warning but don't fail
            result.errors.push({
              index: -1,
              error: `Failed to fetch families: ${error instanceof Error ? error.message : 'Unknown error'}`,
            });
          }
        }

        // Prepare summary
        const summary = {
          total: result.stats.total,
          parsed: result.stats.parsed,
          failed: result.stats.failed,
          by_sku_level: result.stats.bySkuLevel,
          parents_resolved: parentMap?.size ?? 0,
          families_resolved: familyMap
            ? result.products.filter((p) => p.family_id).length
            : 0,
        };

        // Return results
        // For large exports, return summary + first few products as sample
        const MAX_INLINE_PRODUCTS = 10;
        const isLargeExport = result.products.length > MAX_INLINE_PRODUCTS;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  summary,
                  errors:
                    result.errors.length > 0
                      ? result.errors.slice(0, 10)
                      : [],
                  products: isLargeExport
                    ? {
                        _note: `Large export (${result.products.length} products). Showing first ${MAX_INLINE_PRODUCTS} as sample.`,
                        sample: result.products.slice(0, MAX_INLINE_PRODUCTS),
                        total: result.products.length,
                      }
                    : result.products,
                  // Include full products array for programmatic access
                  _all_products: result.products,
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
              text: `Error parsing channel export: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // channel.fetch - Fetch and parse Channel from URL
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'channel_fetch',
    {
      title: 'Fetch Channel Export',
      description:
        'Fetch a Plytix Channel JSON export from URL and parse it. ' +
        'Use the channel feed URL from Plytix (e.g., /channels/{id}/feed). ' +
        'Returns normalized products ready for Supabase sync.',
      inputSchema: {
        url: z
          .string()
          .url()
          .describe('Channel feed URL (e.g., https://pim.plytix.com/channels/{id}/feed)'),
        deduplicate: z
          .boolean()
          .default(true)
          .describe('Remove _1 suffix duplicate fields'),
        resolve_parents: z
          .boolean()
          .default(true)
          .describe('Resolve parent_id from group_id relationships'),
      },
    },
    async ({ url, deduplicate, resolve_parents }) => {
      try {
        // Fetch the channel JSON
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch channel: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Handle both array and object with data property
        let products: ChannelProduct[];
        if (Array.isArray(data)) {
          products = data;
        } else if (data.data && Array.isArray(data.data)) {
          products = data.data;
        } else {
          throw new Error('Unexpected channel format: expected array or { data: [...] }');
        }

        // Parse the export
        const result = parseChannelExport(products, { deduplicate });

        // Resolve parent IDs if requested
        if (resolve_parents) {
          const parentMap = resolveParentIds(result.products);
          for (const product of result.products) {
            const parentId = parentMap.get(product.id);
            if (parentId) {
              product.parent_id = parentId;
            }
          }
        }

        // Return summary
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  source: url,
                  fetched_at: new Date().toISOString(),
                  summary: {
                    total: result.stats.total,
                    parsed: result.stats.parsed,
                    failed: result.stats.failed,
                    by_sku_level: result.stats.bySkuLevel,
                  },
                  errors: result.errors.slice(0, 5),
                  sample: result.products.slice(0, 3),
                  _note:
                    result.products.length > 3
                      ? `Showing 3 of ${result.products.length} products. Use channel_parse for full data.`
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
              text: `Error fetching channel: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // inheritance.fetch - Fetch overwritten_attributes for a product
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'inheritance_fetch',
    {
      title: 'Fetch Inheritance Data',
      description:
        'Fetch overwritten_attributes for one or more products via API. ' +
        'This data shows which attributes are explicitly set vs inherited from family. ' +
        'Use sparingly due to API rate limits (one request per product).',
      inputSchema: {
        product_ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Array of Plytix product IDs (max 20 per request)'),
      },
    },
    async ({ product_ids }) => {
      const results: Array<{
        id: string;
        sku?: string;
        overwritten_attributes: string[] | null;
        error?: string;
      }> = [];

      for (const productId of product_ids) {
        try {
          const result = await client.getProduct(productId);
          const product = result.data?.[0];

          if (product) {
            results.push({
              id: productId,
              sku: product.sku,
              overwritten_attributes: product.overwritten_attributes ?? [],
            });
          } else {
            results.push({
              id: productId,
              overwritten_attributes: null,
              error: 'Product not found',
            });
          }
        } catch (error) {
          results.push({
            id: productId,
            overwritten_attributes: null,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      const successful = results.filter((r) => r.overwritten_attributes !== null);
      const failed = results.filter((r) => r.error);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                summary: {
                  requested: product_ids.length,
                  successful: successful.length,
                  failed: failed.length,
                },
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────
  // inheritance.check - Check if specific attribute is inherited
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'inheritance_check',
    {
      title: 'Check Attribute Inheritance',
      description:
        'Check if a specific attribute is inherited or explicitly set on a product. ' +
        'Fetches overwritten_attributes from API if not already known.',
      inputSchema: {
        product_id: z.string().describe('Plytix product ID'),
        attribute_label: z.string().describe('Attribute label to check (e.g., "head_material")'),
      },
    },
    async ({ product_id, attribute_label }) => {
      try {
        const result = await client.getProduct(product_id);
        const product = result.data?.[0];

        if (!product) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'Product not found' }, null, 2),
              },
            ],
            isError: true,
          };
        }

        const overwritten = product.overwritten_attributes ?? [];
        const fullKey = `attributes.${attribute_label}`;
        const isOverwritten = overwritten.includes(fullKey);
        const isInherited = !isOverwritten;

        // Get the current value
        const currentValue = product.attributes?.[attribute_label] ?? product[attribute_label];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  product_id,
                  product_sku: product.sku,
                  attribute_label,
                  is_inherited: isInherited,
                  is_overwritten: isOverwritten,
                  current_value: currentValue,
                  family_id: product.product_family_id,
                  all_overwritten_attributes: overwritten,
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
              text: `Error checking inheritance: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

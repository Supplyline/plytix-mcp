/**
 * Product Tools
 *
 * Tools for searching, retrieving, and looking up products.
 * Includes smart lookup with automatic identifier detection.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import type { PlytixProduct } from '../types.js';
import { PlytixLookup } from '../lookup/index.js';
import { registerTool } from './register.js';
import type { IdentifierType } from '../lookup/identifier.js';

export function registerProductTools(server: McpServer, client: PlytixClient) {
  // Create lookup instance for smart search
  const lookup = new PlytixLookup(client);

  // ─────────────────────────────────────────────────────────────
  // products.lookup - Smart identifier-based lookup
  // ─────────────────────────────────────────────────────────────

  registerTool<{ identifier: string; type?: IdentifierType; limit: number }>(
    server,
    'products_lookup',
    {
      title: 'Smart Product Lookup',
      description: 'Find the best product match for an identifier.',
      inputSchema: {
        identifier: z.string().min(1).describe('Product identifier (ID, SKU, MPN, GTIN, or label)'),
        type: z
          .enum(['id', 'sku', 'mpn', 'mno', 'gtin', 'label'])
          .optional()
          .describe('Explicit identifier type (auto-detected if not provided)'),
        limit: z.number().int().positive().max(20).default(5).describe('Max results to return'),
      },
    },
    async ({ identifier, type, limit }) => {
      try {
        const result = await lookup.findByIdentifier(identifier, type, limit);

        // If we have a selected match, fetch full product details
        let fullProduct = null;
        if (result.selected) {
          try {
            const productResult = await client.getProduct(result.selected.id);
            fullProduct = productResult.data?.[0] ?? null;
          } catch {
            // Use the raw data from search if full fetch fails
            fullProduct = result.selected.raw;
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  selected: result.selected
                    ? {
                        id: result.selected.id,
                        sku: result.selected.sku,
                        label: result.selected.label,
                        confidence: result.selected.confidence,
                        reason: result.selected.reason,
                        matchedField: result.selected.matchedField,
                      }
                    : null,
                  product: fullProduct,
                  alternativeMatches: result.matches.slice(1, 5).map((m) => ({
                    id: m.id,
                    sku: m.sku,
                    label: m.label,
                    confidence: m.confidence,
                  })),
                  searchPlan: result.plan,
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
              text: `Error looking up product: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.get - Fetch single product by ID
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string }>(
    server,
    'products_get',
    {
      title: 'Get Product',
      description: 'Get one product by ID.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to fetch'),
      },
    },
    async ({ product_id }) => {
      try {
        const result = await client.getProduct(product_id);

        if (!result.data?.[0]) {
          return {
            content: [{ type: 'text', text: `Product not found: ${product_id}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching product: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.get_full - Product + family + variants + categories + assets
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string }>(
    server,
    'products_get_full',
    {
      title: 'Get Product (Full)',
      description: 'Get one product with related data.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to fetch'),
      },
    },
    async ({ product_id }) => {
      try {
        const productResult = await client.getProduct(product_id);
        const product = productResult.data?.[0] as PlytixProduct | undefined;

        if (!product) {
          return {
            content: [{ type: 'text', text: `Product not found: ${product_id}` }],
            isError: true,
          };
        }

        const familyId = product.product_family_id;
        const [familyResult, variantsResult, categoriesResult, assetsResult] =
          await Promise.allSettled([
            familyId ? client.getFamily(familyId) : Promise.resolve(null),
            client.getProductVariants(product_id),
            client.getProductCategories(product_id),
            client.getProductAssets(product_id),
          ]);

        const errors: string[] = [];
        const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error));

        const family =
          familyResult.status === 'fulfilled'
            ? (familyResult.value?.data?.[0] ?? null)
            : (errors.push(`family: ${errMsg(familyResult.reason)}`), null);

        const variants =
          variantsResult.status === 'fulfilled'
            ? (variantsResult.value?.data ?? [])
            : (errors.push(`variants: ${errMsg(variantsResult.reason)}`), []);

        const categories =
          categoriesResult.status === 'fulfilled'
            ? (categoriesResult.value?.data ?? [])
            : (errors.push(`categories: ${errMsg(categoriesResult.reason)}`), []);

        const assets =
          assetsResult.status === 'fulfilled'
            ? (assetsResult.value?.data ?? [])
            : (errors.push(`assets: ${errMsg(assetsResult.reason)}`), []);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  product,
                  family,
                  variants,
                  categories,
                  assets,
                  ...(errors.length > 0 ? { _errors: errors } : {}),
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
              text: `Error fetching product: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.search - Advanced search with filters
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    attributes?: string[];
    filters?: unknown[];
    pagination?: { page: number; page_size: number };
    sort?: unknown;
  }>(
    server,
    'products_search',
    {
      title: 'Search Products',
      description: 'Search products with filters.',
      inputSchema: {
        attributes: z
          .array(z.string())
          .optional()
          .describe('List of attributes to return (max 50). Custom attrs need "attributes." prefix.'),
        filters: z
          .array(z.any())
          .optional()
          .describe(
            'Search filters. Each filter is an array of conditions (OR within, AND between). ' +
              'Format: [[{field, operator, value}], [{field, operator, value}]]'
          ),
        pagination: z
          .object({
            page: z.number().int().positive().default(1),
            page_size: z.number().int().positive().max(100).default(25),
          })
          .optional(),
        sort: z.any().optional().describe('Sorting options'),
      },
    },
    async (args) => {
      try {
        const result = await client.searchProducts(args as Parameters<typeof client.searchProducts>[0]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  products: result.data,
                  pagination: result.pagination,
                  attributes_returned: result.attributes,
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
              text: `Error searching products: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.find - Multi-criteria search
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    sku?: string;
    mpn?: string;
    mno?: string;
    gtin?: string;
    label?: string;
    fuzzy_search?: string;
    limit: number;
  }>(
    server,
    'products_find',
    {
      title: 'Find Products',
      description: 'Find products by common identifiers.',
      inputSchema: {
        sku: z.string().optional().describe('Exact SKU match'),
        mpn: z.string().optional().describe('Manufacturer part number'),
        mno: z.string().optional().describe('Model number'),
        gtin: z.string().optional().describe('GTIN/UPC/EAN'),
        label: z.string().optional().describe('Product label (partial match)'),
        fuzzy_search: z.string().optional().describe('Fuzzy text search across all fields'),
        limit: z.number().int().positive().max(50).default(10).describe('Max results'),
      },
    },
    async ({ sku, mpn, mno, gtin, label, fuzzy_search, limit }) => {
      try {
        const result = await lookup.findProducts({
          sku,
          mpn,
          mno,
          gtin,
          label,
          fuzzySearch: fuzzy_search,
          limit,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  selected: result.selected
                    ? {
                        id: result.selected.id,
                        sku: result.selected.sku,
                        label: result.selected.label,
                        confidence: result.selected.confidence,
                      }
                    : null,
                  matches: result.matches.map((m) => ({
                    id: m.id,
                    sku: m.sku,
                    label: m.label,
                    confidence: m.confidence,
                  })),
                  count: result.matches.length,
                  searchPlan: result.plan,
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
              text: `Error finding products: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.create - Create a new product
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    sku: string;
    label?: string;
    status?: string;
    attributes?: Record<string, unknown>;
    category_ids?: string[];
    asset_ids?: string[];
  }>(
    server,
    'products_create',
    {
      title: 'Create Product',
      description: 'Create a product.',
      inputSchema: {
        sku: z.string().min(1).describe('Product SKU (required, must be unique)'),
        label: z.string().optional().describe('Product label/name'),
        status: z.string().optional().describe('Product status'),
        attributes: z
          .record(z.unknown())
          .optional()
          .describe('Custom attributes as key-value pairs (use attribute labels as keys)'),
        category_ids: z
          .array(z.string().min(1))
          .optional()
          .describe('Category IDs to link to this product'),
        asset_ids: z.array(z.string().min(1)).optional().describe('Asset IDs to link to this product'),
      },
    },
    async ({ sku, label, status, attributes, category_ids, asset_ids }) => {
      try {
        const data: Parameters<typeof client.createProduct>[0] = { sku };
        if (label !== undefined) data.label = label;
        if (status !== undefined) data.status = status;
        if (attributes !== undefined) data.attributes = attributes;
        if (category_ids?.length) data.categories = category_ids.map((id) => ({ id }));
        if (asset_ids?.length) data.assets = asset_ids.map((id) => ({ id }));

        const result = await client.createProduct(data);
        const created = result.data?.[0];

        if (!created?.id) {
          return {
            content: [
              { type: 'text', text: 'Product creation failed: no ID returned from API' },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: created.id,
                  created: created.created,
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
              text: `Error creating product: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.update - Update product attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    product_id: string;
    label?: string;
    status?: string;
    attributes?: Record<string, unknown>;
  }>(
    server,
    'products_update',
    {
      title: 'Update Product',
      description: 'Update a product.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to update'),
        label: z.string().optional().describe('New product label/name'),
        status: z.string().optional().describe('New product status'),
        attributes: z
          .record(z.unknown())
          .optional()
          .describe('Attributes to update (use attribute labels as keys, null to clear)'),
      },
    },
    async ({ product_id, label, status, attributes }) => {
      try {
        const data: Parameters<typeof client.updateProduct>[1] = {};
        if (label !== undefined) data.label = label;
        if (status !== undefined) data.status = status;
        if (attributes !== undefined) data.attributes = attributes;

        if (Object.keys(data).length === 0) {
          return {
            content: [{ type: 'text', text: 'No fields provided to update' }],
            isError: true,
          };
        }

        const result = await client.updateProduct(product_id, data);
        const updated = result.data?.[0];

        if (!updated?.id) {
          return {
            content: [
              { type: 'text', text: `Product update failed: no response for ${product_id}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: updated.id,
                  modified: updated.modified,
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
              text: `Error updating product: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // products.assign_family - Assign/unassign family
  // ─────────────────────────────────────────────────────────────

  registerTool<{ product_id: string; family_id: string }>(
    server,
    'products_assign_family',
    {
      title: 'Assign Product Family',
      description: 'Assign or unassign a family.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        family_id: z
          .string()
          .describe('The family ID to assign (empty string to unassign)'),
      },
    },
    async ({ product_id, family_id }) => {
      try {
        const result = await client.assignProductFamily(product_id, family_id);
        const updated = result.data?.[0];

        if (!updated?.id) {
          return {
            content: [
              { type: 'text', text: `Family assignment failed: no response for ${product_id}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: updated.id,
                  family_id: family_id || null,
                  action: family_id ? 'assigned' : 'unassigned',
                  modified: updated.modified,
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
              text: `Error assigning family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * Plytix MCP Server - Cloudflare Worker Entry Point
 *
 * Remote MCP server for Plytix PIM access.
 * Uses BYOK (Bring Your Own Key) model - API credentials come from request headers.
 *
 * Endpoints:
 * - POST /mcp - MCP JSON-RPC endpoint
 * - GET /health - Health check
 * - GET / - Server info
 */

import { WorkerPlytixClient } from './worker-client.js';
import { WorkerPlytixLookup } from './worker-lookup.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface Env {
  PLYTIX_API_BASE?: string;
  PLYTIX_AUTH_URL?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolHandler {
  (args: Record<string, unknown>, client: WorkerPlytixClient): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

// ─────────────────────────────────────────────────────────────
// CORS Configuration
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://claude.ai',
  'https://app.claude.ai',
  'https://console.anthropic.com',
  // Mobile app origins
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Plytix-API-Key, X-Plytix-API-Password, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  // Only allow specific origins (Claude clients and local development)
  if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.claude.ai')) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  // For requests without an allowed origin, don't set Access-Control-Allow-Origin
  // This will cause browsers to block cross-origin requests from unauthorized sites

  return headers;
}

// ─────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    name: 'products_lookup',
    description:
      'Smart product lookup that auto-detects identifier type (ID, SKU, MPN, GTIN, label). ' +
      'Uses staged search strategies with confidence scoring. ' +
      'Returns the best match along with the search plan used.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Product identifier (ID, SKU, MPN, GTIN, or label)',
        },
        type: {
          type: 'string',
          enum: ['id', 'sku', 'mpn', 'mno', 'gtin', 'label'],
          description: 'Explicit identifier type (auto-detected if not provided)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 5, max: 20)',
          default: 5,
        },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'products_get',
    description:
      'Get a single product by ID. Returns full product data including ' +
      'overwritten_attributes (attributes explicitly set, not inherited from family).',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The product ID to fetch',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'products_search',
    description:
      'Search products with filters, pagination, and sorting. ' +
      'Custom attributes should be prefixed with "attributes." (e.g., "attributes.head_material").',
    inputSchema: {
      type: 'object',
      properties: {
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attributes to return (max 50)',
        },
        filters: {
          type: 'array',
          description: 'Search filters. Format: [[{field, operator, value}]]',
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number', default: 1 },
            page_size: { type: 'number', default: 25 },
          },
        },
        sort: {
          description: 'Sorting options',
        },
      },
    },
  },
  {
    name: 'products_find',
    description:
      'Find products by multiple criteria (SKU, MPN, MNO, GTIN, label, or fuzzy search). ' +
      'Simpler than products_search - just specify the fields you know.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact SKU match' },
        mpn: { type: 'string', description: 'Manufacturer part number' },
        mno: { type: 'string', description: 'Model number' },
        gtin: { type: 'string', description: 'GTIN/UPC/EAN' },
        label: { type: 'string', description: 'Product label (partial match)' },
        fuzzy_search: { type: 'string', description: 'Fuzzy text search across all fields' },
        limit: { type: 'number', default: 10, description: 'Max results' },
      },
    },
  },
  {
    name: 'families_list',
    description: 'List or search product families. Returns family IDs, names, and linked attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to filter families by name' },
        page: { type: 'number', default: 1 },
        page_size: { type: 'number', default: 25 },
      },
    },
  },
  {
    name: 'families_get',
    description: 'Get a single product family by ID. Returns the family name and linked attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        family_id: { type: 'string', description: 'The product family ID' },
      },
      required: ['family_id'],
    },
  },
  {
    name: 'attributes_list',
    description:
      'List all available product attributes (system and custom). ' +
      'Returns attribute keys, types, labels, and options for dropdown fields.',
    inputSchema: {
      type: 'object',
      properties: {
        include_options: {
          type: 'boolean',
          default: true,
          description: 'Include dropdown/multiselect options in response',
        },
      },
    },
  },
  {
    name: 'attributes_filters',
    description: 'Get all available search filters for product queries.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'assets_list',
    description: 'List assets linked to a product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'categories_list',
    description: 'List categories linked to a product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'variants_list',
    description: 'List variants for a product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'variants_resync',
    description:
      'Resync variant attributes to inherit values from the parent product. ' +
      'Restores overwritten attributes on specified variants to use the parent\'s value instead.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_product_id: {
          type: 'string',
          description: 'The parent product ID containing the variants',
        },
        attribute_labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attribute labels to reset (must be attributes at parent level)',
        },
        variant_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of variant product IDs to resync (must be variants of the specified parent)',
        },
      },
      required: ['parent_product_id', 'attribute_labels', 'variant_ids'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────

const toolHandlers: Record<string, ToolHandler> = {
  async products_lookup(args, client) {
    const lookup = new WorkerPlytixLookup(client);
    const identifier = args.identifier as string;
    const type = args.type as string | undefined;
    const limit = Math.min((args.limit as number) || 5, 20);

    const result = await lookup.findByIdentifier(
      identifier,
      type as 'id' | 'sku' | 'mpn' | 'mno' | 'gtin' | 'label' | undefined,
      limit
    );

    let fullProduct = null;
    if (result.selected) {
      try {
        const productResult = await client.getProduct(result.selected.id);
        fullProduct = productResult.data?.[0] ?? null;
      } catch {
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
  },

  async products_get(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProduct(productId);

    if (!result.data?.[0]) {
      return {
        content: [{ type: 'text', text: `Product not found: ${productId}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
    };
  },

  async products_search(args, client) {
    const result = await client.searchProducts(args as Record<string, unknown>);

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
  },

  async products_find(args, client) {
    const lookup = new WorkerPlytixLookup(client);
    const result = await lookup.findProducts({
      sku: args.sku as string | undefined,
      mpn: args.mpn as string | undefined,
      mno: args.mno as string | undefined,
      gtin: args.gtin as string | undefined,
      label: args.label as string | undefined,
      fuzzySearch: args.fuzzy_search as string | undefined,
      limit: (args.limit as number) || 10,
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
  },

  async families_list(args, client) {
    const body: Record<string, unknown> = {
      pagination: {
        page: (args.page as number) || 1,
        page_size: (args.page_size as number) || 25,
      },
    };

    if (args.query) {
      body.filters = [[{ field: 'name', operator: 'like', value: args.query }]];
    }

    const result = await client.searchFamilies(body);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              families: result.data,
              pagination: result.pagination,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async families_get(args, client) {
    const familyId = args.family_id as string;
    const result = await client.getFamily(familyId);

    if (!result.data?.[0]) {
      return {
        content: [{ type: 'text', text: `Family not found: ${familyId}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
    };
  },

  async attributes_list(args, client) {
    const { system, custom } = await client.getProductAttributes();
    const includeOptions = args.include_options !== false;

    const result = {
      system_attributes: system,
      custom_attributes: custom.map((attr) => ({
        key: attr.field,
        label: attr.label,
        type: attr.type,
        ...(includeOptions && attr.options ? { options: attr.options } : {}),
      })),
      summary: {
        system_count: system.length,
        custom_count: custom.length,
        total: system.length + custom.length,
      },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  async attributes_filters(args, client) {
    const result = await client.getAvailableFilters();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              filters: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async assets_list(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProductAssets(productId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              assets: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async categories_list(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProductCategories(productId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              categories: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async variants_list(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProductVariants(productId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              variants: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async variants_resync(args, client) {
    const parentProductId = args.parent_product_id as string;
    const attributeLabels = args.attribute_labels as string[];
    const variantIds = args.variant_ids as string[];

    await client.resyncVariants(parentProductId, attributeLabels, variantIds);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              parent_product_id: parentProductId,
              attributes_reset: attributeLabels,
              variants_affected: variantIds.length,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};

// ─────────────────────────────────────────────────────────────
// MCP Protocol Handler
// ─────────────────────────────────────────────────────────────

async function handleMcpRequest(
  request: JsonRpcRequest,
  client: WorkerPlytixClient | null
): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'plytix-mcp',
              version: '0.2.0',
            },
          },
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            tools: TOOLS,
          },
        };
      }

      case 'tools/call': {
        if (!client) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32600,
              message: 'Authentication required for tool calls. Provide API credentials.',
            },
          };
        }

        const toolName = (params?.name as string) ?? '';
        const args = (params?.arguments as Record<string, unknown>) ?? {};

        const handler = toolHandlers[toolName];
        if (!handler) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`,
            },
          };
        }

        try {
          const result = await handler(args, client);
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result,
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      case 'notifications/initialized':
      case 'ping': {
        // Notifications don't require a response, but we'll acknowledge ping
        if (method === 'ping') {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {},
          };
        }
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {},
        };
      }

      default: {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
      }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Request Handler
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Server info
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'plytix-mcp',
          version: '0.2.0',
          description: 'Remote MCP server for Plytix PIM',
          endpoints: {
            mcp: '/mcp',
            health: '/health',
          },
          authentication: {
            methods: [
              {
                type: 'headers',
                required: ['X-Plytix-API-Key', 'X-Plytix-API-Password'],
              },
              {
                type: 'bearer',
                format: 'Bearer <api_key>:<api_password>',
                note: 'For Craft Agents and other MCP clients',
              },
            ],
          },
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // MCP endpoint
    if (url.pathname === '/mcp' && request.method === 'POST') {
      // Parse JSON-RPC request first to check if auth is needed
      let body: JsonRpcRequest | JsonRpcRequest[];
      let bodyText: string;
      try {
        bodyText = await request.text();
        body = JSON.parse(bodyText);
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: Invalid JSON' },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // Methods that don't require authentication (for MCP client discovery)
      const publicMethods = ['initialize', 'notifications/initialized', 'tools/list'];
      const requests = Array.isArray(body) ? body : [body];
      const allPublic = requests.every(
        (req) => req && typeof req === 'object' && typeof req.method === 'string' && publicMethods.includes(req.method)
      );

      // Extract API credentials from headers
      // Supports two formats:
      // 1. Custom headers: X-Plytix-API-Key and X-Plytix-API-Password
      // 2. Bearer token: Authorization: Bearer <api_key>:<api_password>
      let apiKey = request.headers.get('X-Plytix-API-Key');
      let apiPassword = request.headers.get('X-Plytix-API-Password');

      // Fallback to Bearer token format for Craft Agents compatibility
      if (!apiKey || !apiPassword) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7); // Remove 'Bearer ' prefix
          const colonIndex = token.indexOf(':');
          if (colonIndex > 0) {
            apiKey = token.slice(0, colonIndex);
            apiPassword = token.slice(colonIndex + 1);
          }
        }
      }

      // Only require auth for non-public methods
      if (!allPublic && (!apiKey || !apiPassword)) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message:
                'Missing Plytix API credentials. Provide either X-Plytix-API-Key and X-Plytix-API-Password headers, or Authorization: Bearer <api_key>:<api_password>',
            },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // Create client with request credentials (only if we have them)
      let client: WorkerPlytixClient | null = null;
      if (apiKey && apiPassword) {
        try {
          client = new WorkerPlytixClient({
            apiKey,
            apiPassword,
            baseUrl: env.PLYTIX_API_BASE,
            authUrl: env.PLYTIX_AUTH_URL,
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32600,
                message: error instanceof Error ? error.message : 'Failed to initialize client',
              },
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }
      }

      // Handle batch requests
      if (Array.isArray(body)) {
        const responses = await Promise.all(
          body.map((req) => handleMcpRequest(req, client))
        );
        return new Response(JSON.stringify(responses), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Handle single request
      const response = await handleMcpRequest(body, client);
      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 404 for unknown paths
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};

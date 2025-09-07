
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlytixClient } from "../plytixClient.js";
import { hydrateRelationships } from "../hydration.js";
import { hydrateHierarchy } from "../hierarchy.js";
import {
  Product,
  ResolveMode,
  RelationshipName,
  HierarchyName,
  Env,
} from "../types.js";

export function registerProductTools(server: McpServer, client: PlytixClient) {
  // GET product
  server.registerTool(
    "products.get",
    {
      title: "Get Product",
      description: "Get a single product by id (Plytix v2)",
      inputSchema: {
        id: z.string().min(1).describe("The product ID to fetch"),
        resolve: z
          .enum(["none", "relationships", "hierarchy", "all"])
          .default("none")
          .describe("Resolve related products/hierarchy"),
        relationshipFilter: z
          .array(
            z.enum(["replaces", "includes", "modules", "has_optional_accessory"])
          )
          .optional()
          .describe("Only hydrate these relationship fields"),
        hierarchyFilter: z
          .array(z.enum(["brand", "family", "parent", "variant"]))
          .optional()
          .describe("Only hydrate these hierarchy levels"),
        includeBrand: z.boolean().optional().default(false),
      },
    },
    async ({
      id,
      resolve = "none",
      relationshipFilter,
      hierarchyFilter,
      includeBrand,
    }) => {
      try {
        const product = (await client.getProductById(id)) as unknown as Product;
        let out: any = product;
        if ((resolve as ResolveMode) === "hierarchy" || resolve === "all") {
          const { hierarchy } = await hydrateHierarchy(product, {
            client,
            env: process.env as Env,
            hierarchyFilter: hierarchyFilter as HierarchyName[] | undefined,
            includeBrand: Boolean(includeBrand),
          });
          out = { ...out, hierarchy };
        }
        if ((resolve as ResolveMode) === "relationships" || resolve === "all") {
          out = await hydrateRelationships(out, {
            relationshipFilter: relationshipFilter as RelationshipName[] | undefined,
            client,
            env: process.env as Env,
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error fetching product: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }],
          isError: true,
        };
      }
    }
  );

  // SEARCH products
  server.registerTool(
    "products.search",
    {
      title: "Search Products",
      description: "Search products (Plytix v2). Pass-through body for v2 search API.",
      inputSchema: {
        attributes: z.array(z.string()).optional().describe("List of attributes to return (max 50)"),
        filters: z.array(z.any()).optional().describe("Search filters"),
        pagination: z.object({
          page: z.number().int().positive().default(1),
          page_size: z.number().int().positive().max(100).default(25)
        }).optional(),
        sort: z.any().optional().describe("Sorting options"),
        resolve: z
          .enum(["none", "relationships", "hierarchy", "all"])
          .default("none")
          .describe("Resolve related products/hierarchy"),
        relationshipFilter: z
          .array(
            z.enum(["replaces", "includes", "modules", "has_optional_accessory"])
          )
          .optional()
          .describe("Only hydrate these relationship fields"),
        hierarchyFilter: z
          .array(z.enum(["brand", "family", "parent", "variant"]))
          .optional()
          .describe("Only hydrate these hierarchy levels"),
        includeBrand: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      try {
        const {
          resolve = "none",
          relationshipFilter,
          hierarchyFilter,
          includeBrand,
          ...body
        } = args as any;
        const data = await client.call(`/api/v2/products/search`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const list = Array.isArray((data as any)?.items)
          ? (data as any).items
          : Array.isArray((data as any)?.data)
          ? (data as any).data
          : Array.isArray(data)
          ? data
          : [];

        if (resolve === "hierarchy" || resolve === "all") {
          const hydrated = await Promise.all(
            list.map(async (p: any) => {
              const { hierarchy } = await hydrateHierarchy(p, {
                client,
                env: process.env as Env,
                hierarchyFilter: hierarchyFilter as HierarchyName[] | undefined,
                includeBrand: Boolean(includeBrand),
              });
              return { ...p, hierarchy };
            })
          );
          list.splice(0, list.length, ...hydrated);
        }

        if (resolve === "relationships" || resolve === "all") {
          const hydrated = await Promise.all(
            list.map((p: any) =>
              hydrateRelationships(p as Product, {
                relationshipFilter: relationshipFilter as RelationshipName[] | undefined,
                client,
                env: process.env as Env,
              })
            )
          );
          list.splice(0, list.length, ...hydrated);
        }

        if (Array.isArray((data as any)?.items)) {
          (data as any).items = list;
        } else if (Array.isArray((data as any)?.data)) {
          (data as any).data = list;
        } else if (Array.isArray(data)) {
          (data as any) = list;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error searching products: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }],
          isError: true,
        };
      }
    }
  );
}

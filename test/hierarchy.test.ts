import { describe, it, expect, vi } from "vitest";
import { hydrateHierarchy } from "../src/hierarchy.js";
import { PlytixClient, PlytixProduct } from "../src/plytixClient.js";
import { registerProductTools } from "../src/tools/products.js";
import { Product } from "../src/types.js";

const env = {
  SKU_LEVEL_ATTR_SLUG: "sku_level",
  PARENT_SKU_ATTR_SLUG: "parent_sku",
  VARIANT_SKU_ATTR_SLUG: "variant_sku",
  FAMILY_SKU_REGEX: "^([^-]+-[^-]+)",
} as any;

describe("hydrateHierarchy", () => {
  const product = {
    id: "SIB1",
    sku: "LMI-PD12-220-SUB",
    attributes: {
      sku_level: 4,
      parent_sku: "LMI-PD12-220",
      variant_sku: "LMI-PD12-220-BASE",
    },
  };

  it("hydrates variant, parent, family for a level-4 sibling", async () => {
    const client: PlytixClient = {
      getProductById: vi.fn(),
      getProductsByIds: vi.fn(),
      getProductBySku: vi.fn(),
      getProductsBySkus: vi
        .fn()
        .mockResolvedValue<PlytixProduct[]>([
          {
            id: "FAM",
            sku: "LMI-PD12",
            attributes: { name: "LMI-PD12", mpn: "LMI-PD12", list_price: "0" },
          },
          {
            id: "PAR",
            sku: "LMI-PD12-220",
            attributes: { name: "Parent", mpn: "PD12-220", list_price: "999" },
          },
          {
            id: "VAR",
            sku: "LMI-PD12-220-BASE",
            attributes: { name: "Variant", mpn: "BASE", list_price: 123 },
          },
        ]),
      call: vi.fn(),
    } as any;

    const out = await hydrateHierarchy(product, {
      client,
      env,
      hierarchyFilter: ["variant", "parent", "family"],
      includeBrand: false,
    });

    expect(out.hierarchy.level).toBe(4);
    expect(out.hierarchy.family?.sku).toBe("LMI-PD12");
    expect(out.hierarchy.parent?.sku).toBe("LMI-PD12-220");
    expect(out.hierarchy.variant?.sku).toBe("LMI-PD12-220-BASE");
  });

  it("respects hierarchyFilter and leaves missing pointers as null", async () => {
    const client: PlytixClient = {
      getProductById: vi.fn(),
      getProductsByIds: vi.fn(),
      getProductBySku: vi.fn(),
      getProductsBySkus: vi.fn().mockResolvedValue<PlytixProduct[]>([]),
      call: vi.fn(),
    } as any;

    const out = await hydrateHierarchy(
      { id: "X", sku: "ABC-DEF-1", attributes: { sku_level: 3 } } as any,
      { client, env, hierarchyFilter: ["family"], includeBrand: false }
    );

    expect(out.hierarchy.level).toBe(3);
    expect(out.hierarchy.family).toBeNull();
    expect(out.hierarchy.parent).toBeUndefined();
  });
});

describe("products.get hierarchy", () => {
  it("returns hierarchy when resolve is hierarchy", async () => {
    const server = { registerTool: vi.fn() } as any;
    const baseProduct: Product = {
      id: "SIB1",
      sku: "LMI-PD12-220-SUB",
      attributes: {
        sku_level: 4,
        parent_sku: "LMI-PD12-220",
        variant_sku: "LMI-PD12-220-BASE",
      },
    };
    const client: PlytixClient = {
      getProductById: vi.fn().mockResolvedValue(baseProduct as any),
      getProductsByIds: vi.fn(),
      getProductBySku: vi.fn(),
      getProductsBySkus: vi.fn().mockResolvedValue<PlytixProduct[]>([
        { id: "FAM", sku: "LMI-PD12", attributes: {} },
        { id: "PAR", sku: "LMI-PD12-220", attributes: {} },
        { id: "VAR", sku: "LMI-PD12-220-BASE", attributes: {} },
      ]),
      call: vi.fn(),
    } as any;

    registerProductTools(server, client);
    const handler = server.registerTool.mock.calls.find(
      (c: any[]) => c[0] === "products.get"
    )[2];
    const result = await handler({ id: "SIB1", resolve: "hierarchy" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.hierarchy.family.id).toBe("FAM");
    expect(parsed.hierarchy.parent.id).toBe("PAR");
    expect(parsed.hierarchy.variant.id).toBe("VAR");
  });
});

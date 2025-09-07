import { describe, it, expect, vi } from "vitest";
import { hydrateRelationships } from "../src/hydration.js";
import { Product } from "../src/types.js";
import { registerProductTools } from "../src/tools/products.js";
import { PlytixClient, PlytixProduct } from "../src/plytixClient.js";

describe("hydrateRelationships", () => {
  const env = {} as any;

  it("hydrates relationship fields", async () => {
    const product: Product = {
      id: "A",
      includes: ["X", "Y"],
      replaces: ["Z"],
    };
    const client: PlytixClient = {
      getProductById: vi.fn(),
      getProductsByIds: vi.fn().mockResolvedValue<ReadonlyArray<PlytixProduct>>([
        { id: "X", sku: "XSKU", attributes: { mpn: "XMPN", name: "X", list_price: "10" } },
        { id: "Y", attributes: {} },
        { id: "Z", attributes: { mpn: "ZMPN", name: "Z", list_price: 12 } },
      ]),
      call: vi.fn(),
    } as any;

    const out = await hydrateRelationships(product, { client, env });
    expect(out.includes).toEqual([
      { id: "X", sku: "XSKU", mpn: "XMPN", label: "X", listPrice: 10 },
      { id: "Y", sku: null, mpn: null, label: null, listPrice: null },
    ]);
    expect(out.replaces).toEqual([
      { id: "Z", sku: null, mpn: "ZMPN", label: "Z", listPrice: 12 },
    ]);
  });

  it("honors relationshipFilter", async () => {
    const product: Product = {
      id: "A",
      includes: ["X"],
      replaces: ["Y"],
    };
    const client: PlytixClient = {
      getProductById: vi.fn(),
      getProductsByIds: vi.fn().mockResolvedValue<PlytixProduct[]>([
        { id: "X", attributes: { name: "X" } },
        { id: "Y", attributes: { name: "Y" } },
      ]),
      call: vi.fn(),
    } as any;

    const out = await hydrateRelationships(product, {
      client,
      env,
      relationshipFilter: ["includes"],
    });
    expect(out.includes).toHaveLength(1);
    expect((out.includes as any)[0].id).toBe("X");
    expect(out.replaces).toEqual(["Y"]);
  });

  it("fills missing attributes with null", async () => {
    const product: Product = { id: "A", includes: ["X"] };
    const client: PlytixClient = {
      getProductById: vi.fn(),
      getProductsByIds: vi.fn().mockResolvedValue<PlytixProduct[]>([
        { id: "X", attributes: {} },
      ]),
      call: vi.fn(),
    } as any;
    const out = await hydrateRelationships(product, { client, env });
    expect(out.includes).toEqual([
      { id: "X", sku: null, mpn: null, label: null, listPrice: null },
    ]);
  });

  it("dedupes IDs across fields", async () => {
    const product: Product = {
      id: "A",
      includes: ["X"],
      replaces: ["X"],
    };
    const client: PlytixClient = {
      getProductById: vi.fn(),
      getProductsByIds: vi.fn().mockResolvedValue<PlytixProduct[]>([
        { id: "X", attributes: { name: "X" } },
      ]),
      call: vi.fn(),
    } as any;

    await hydrateRelationships(product, { client, env });
    expect(client.getProductsByIds).toHaveBeenCalledWith(["X"]);
  });
});

describe("products.get", () => {
  it("returns ID arrays when resolve is none", async () => {
    const server = { registerTool: vi.fn() } as any;
    const product = { id: "A", includes: ["X"] };
    const client: PlytixClient = {
      getProductById: vi.fn().mockResolvedValue(product as any),
      getProductsByIds: vi.fn(),
      call: vi.fn(),
    } as any;
    registerProductTools(server, client);
    const handler = server.registerTool.mock.calls.find((c: any[]) => c[0] === "products.get")[2];
    const result = await handler({ id: "A", resolve: "none" });
    expect(JSON.parse(result.content[0].text)).toEqual(product);
  });
});

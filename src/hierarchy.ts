import { Env, HierarchyName, HierarchyRefs } from "./types.js";
import { PlytixClient, PlytixProduct } from "./plytixClient.js";
import { mapToHydratedRef } from "./mappers.js";

function toNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? (n as number) : null;
}

function rx(envVal: string | undefined, fallback: string): RegExp {
  try {
    return new RegExp(envVal || fallback);
  } catch {
    return new RegExp(fallback);
  }
}

function deriveByRegex(sku: string | undefined, pattern: RegExp): string | null {
  if (!sku) return null;
  const m = sku.match(pattern);
  return m?.[1] ?? null;
}

export async function hydrateHierarchy(
  product: PlytixProduct,
  opts: {
    client: PlytixClient;
    env: Env;
    hierarchyFilter?: HierarchyName[];
    includeBrand?: boolean;
  }
): Promise<{ hierarchy: HierarchyRefs }> {
  const { client, env } = opts;
  const filter =
    opts.hierarchyFilter && opts.hierarchyFilter.length
      ? new Set(opts.hierarchyFilter)
      : new Set<HierarchyName>(["variant", "parent", "family"]);

  const sku = product.sku ?? (product.attributes?.["sku"] as string | undefined);
  const attrs = product.attributes ?? {};
  const lvlKey = env.SKU_LEVEL_ATTR_SLUG || "sku_level";
  const famKey = env.FAMILY_SKU_ATTR_SLUG;
  const parKey = env.PARENT_SKU_ATTR_SLUG || "parent_sku";
  const varKey = env.VARIANT_SKU_ATTR_SLUG || "variant_sku";
  const brandKey = env.BRAND_SKU_ATTR_SLUG || "brand_sku";

  const level = toNum(attrs[lvlKey]) as HierarchyRefs["level"];

  const famRx = rx(env.FAMILY_SKU_REGEX, "^([^-]+-[^-]+)");
  const parRx = rx(env.PARENT_SKU_REGEX, "^(.*?)-[^-]+$");
  const varRx = rx(env.VARIANT_SKU_REGEX, "^(.*?)-[^-]+$");

  const targets = new Map<HierarchyName, string | null>();

  if (
    filter.has("family") &&
    (level === 1 || level === 2 || level === 3 || level === 4)
  ) {
    const familySku =
      (typeof famKey === "string" && typeof attrs[famKey] === "string"
        ? (attrs[famKey] as string)
        : null) ?? deriveByRegex(sku, famRx);
    targets.set("family", familySku);
  }

  if (filter.has("parent") && (level === 3 || level === 4)) {
    const parentSku =
      (typeof attrs[parKey] === "string" ? (attrs[parKey] as string) : null) ??
      deriveByRegex(sku, parRx);
    targets.set("parent", parentSku);
  }

  if (filter.has("variant") && level === 4) {
    const variantSku =
      (typeof attrs[varKey] === "string" ? (attrs[varKey] as string) : null) ??
      deriveByRegex(sku, varRx);
    targets.set("variant", variantSku);
  }

  if (opts.includeBrand) {
    const brandSku =
      typeof attrs[brandKey] === "string" ? (attrs[brandKey] as string) : null;
    targets.set("brand", brandSku);
  }

  const skuSet = new Set<string>();
  for (const s of targets.values()) if (s) skuSet.add(s);

  let fetchedBySku = new Map<string, PlytixProduct>();
  if (skuSet.size > 0) {
    const skus = Array.from(skuSet);
    const found = await client.getProductsBySkus(skus);
    fetchedBySku = new Map(
      found.map((p) => [p.sku ?? "", p]).filter(([k]) => !!k)
    );
  }

  const hierarchy: HierarchyRefs = { level } as HierarchyRefs;
  for (const [name, targetSku] of targets.entries()) {
    if (!targetSku) {
      (hierarchy as any)[name] = null;
      continue;
    }
    const rec = fetchedBySku.get(targetSku) ?? null;
    (hierarchy as any)[name] = rec ? mapToHydratedRef(rec as any, env) : null;
  }

  return { hierarchy };
}

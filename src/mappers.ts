import { HydratedRef, Env } from "./types.js";
import { PlytixProduct } from "./plytixClient.js";

export function toNumberOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function mapToHydratedRef(p: PlytixProduct, env: Env): HydratedRef {
  const attrs = p.attributes ?? {};
  const mpnKey = env.PLYTIX_MPN_ATTR_SLUG || "mpn";
  const labelKey = env.PLYTIX_LABEL_ATTR_SLUG || "name";
  const priceKey = env.PLYTIX_LIST_PRICE_ATTR_SLUG || "list_price";
  return {
    id: p.id,
    sku: (p as any).sku ?? attrs["sku"] ?? null,
    mpn: (attrs as any)[mpnKey] ?? null,
    label: (attrs as any)[labelKey] ?? null,
    listPrice: toNumberOrNull((attrs as any)[priceKey]),
  };
}

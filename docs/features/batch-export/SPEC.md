# SPEC - Batch Product Export tools

> **Status:** Draft for review
> **Date:** 2026-06-09
> **Consumer:** operator/agent live Plytix snapshots for ETL and sync diffs

## Summary

Add batch product export tools over documented Plytix product read APIs.

This is not production sync scheduling and not a replacement for `supplyline-sync`'s
channel-feed queue. It is an operator/agent tool for live Plytix snapshots, diff prep,
small SKU refreshes, and pre/post checks around `products_batch_update`.

Tools:

- **`products_batch_export`** - capped inline export for small interactive reads;
  available on stdio and the Cloudflare Worker.
- **`products_batch_export_to_file`** - stdio-only file export that writes JSONL/NDJSON
  rows to disk and returns metadata, hashes, failures, and a small preview.

No public first-party async product export endpoint is documented in
`docs/solutions/api-quirks/plytix-api.md`. v1 reuses existing product reads:

- `POST /api/v2/products/search`
- `GET /api/v2/products/:product_id`

If Plytix later documents a supported export/job endpoint, it may become an internal
implementation optimization behind the same contract.

## Load-bearing Constraint

**Do not thread large product snapshots through the model context.**

The read-side failure mode mirrors batch updates: thousands of product rows can be larger
than the useful working context even when the API calls themselves are cheap.

Consequences:

- Inline export is only for small interactive reads.
- Large exports must write rows to disk and return metadata plus a small preview.
- The result must never echo all rows when a file export succeeds or fails.
- The tool is for operators and agents. Production sync paths should keep using their own
  queue/R2/import plumbing.

## Selectors

Both tools accept the same selector shape. Exactly one selector mode is allowed.

```ts
type ProductExportSelector =
  | {
      mode: "search",
      filters?: unknown[],
      sort?: unknown,
      confirm_full_catalog?: boolean
    }
  | {
      mode: "skus",
      skus: string[]
    }
  | {
      mode: "product_ids",
      product_ids: string[]
    };
```

Rules:

- `mode: "search"` uses `POST /api/v2/products/search`.
- `mode: "skus"` resolves exact SKUs with `sku in [...]`, pages through every result page,
  and exports matched product rows.
- `mode: "product_ids"` calls `GET /api/v2/products/:product_id` for each ID.
- Search with no filters is rejected unless `confirm_full_catalog: true`.
- SKU/product ID selectors preserve input order in the output where possible.
- Duplicate `skus` or duplicate `product_ids` are rejected before API calls.
- Ambiguous SKU matches are row failures with `stage: "resolve"`.
- Missing SKU or missing product ID is a row failure with `stage: "resolve"` or
  `stage: "fetch"` respectively.
- No related entity expansion in v1. Product rows only; assets, categories, variants, and
  relationships remain separate tools.

## Shared Input Contract

```ts
type ProductBatchExportInput = ProductExportSelector & {
  attributes?: string[];
  max_rows?: number;
  page_size?: number;
  preview_rows?: number;
};
```

Rules:

- `attributes` follows existing `products_search` behavior, max 50. Custom attributes need
  the `attributes.` prefix when Plytix requires it. It is supported for `mode: "search"`
  and `mode: "skus"`.
- `mode: "product_ids"` rejects `attributes` in v1 because `GET /api/v2/products/:id`
  returns the full product and does not support server-side projection.
- `page_size` defaults to 100 and may not exceed 100.
- `preview_rows` defaults to 5 and may not exceed 20.
- Inline `mode: "search"` defaults `max_rows` to the inline row cap.
- File `mode: "search"` requires explicit `max_rows`, even with filters. This prevents
  accidental full-catalog dumps.
- `confirm_full_catalog: true` only permits an empty-filter search. It does not remove
  file export's explicit `max_rows` requirement.
- `sort` is allowed only in `mode: "search"`. Use cautiously: Plytix has documented
  system limits around sorted result windows, so large exports should avoid order unless a
  caller has a specific reason.

## Inline Export Contract

`products_batch_export` input:

```ts
ProductBatchExportInput
```

Caps:

- Stdio inline: max **250 rows** and **512 KB** serialized response payload.
- Worker inline: max **100 rows** and **256 KB** serialized response payload.

Result includes `products` only when the response stays under the cap. If the row cap or
byte cap is exceeded, return `status: "rejected"` with a clear instruction to use
`products_batch_export_to_file` on stdio.

The Worker exposes only this inline tool. It cannot write to the caller's filesystem.

## File Export Contract

`products_batch_export_to_file` input:

```ts
ProductBatchExportInput & {
  output_path: string;
  format?: "jsonl" | "ndjson";
  overwrite?: boolean;
}
```

Rules:

- Stdio-only.
- Default format is `jsonl`.
- Require `.jsonl` or `.ndjson` extension.
- Write UTF-8 only.
- Parent directory must already exist.
- Do not overwrite an existing file unless `overwrite: true`.
- Write to a temporary file in the same directory, then atomically rename into place.
- Hard cap file exports at **100,000 rows** and **256 MB** output bytes.
- Never echo row payloads in errors. Return counts, keys, paths, and error messages only.
- Return a small `preview` array from the first `preview_rows` products, subject to the
  preview cap.

Output file format:

- One product JSON object per line.
- No metadata header line. Keep the file directly streamable into diff tools, `jq`, or
  ETL readers.
- The returned `export_sha256` is the SHA-256 of the exact file bytes.

## Hashes

Return both:

- `query_sha256` - SHA-256 of a canonical JSON object containing selector mode, filters,
  sort, identifiers, attributes, max rows, and page size. Exclude `output_path`,
  `overwrite`, and preview settings.
- `export_sha256` - SHA-256 of exported product rows:
  - inline: SHA-256 of canonical JSONL bytes for the returned products,
  - file: SHA-256 of the exact bytes written to disk.

These hashes let the caller record what was asked for and what was actually exported
without storing row payloads in the chat transcript.

## Response Shapes

Rejected:

```ts
{
  status: "rejected",
  summary: {
    requested?: number,
    exported: 0,
    failed: number,
    truncated: boolean
  },
  failures: ProductBatchExportFailure[],
  metadata?: ProductBatchExportMetadata
}
```

Finished:

```ts
{
  status: "finished",
  mode: "inline" | "file",
  products?: PlytixProduct[],
  preview: PlytixProduct[],
  summary: {
    requested?: number,
    exported: number,
    failed: number,
    truncated: boolean
  },
  failures: ProductBatchExportFailure[],
  metadata: ProductBatchExportMetadata
}
```

Failure:

```ts
interface ProductBatchExportFailure {
  key: string; // sku, product_id, or search page label
  index?: number;
  stage: "validation" | "resolve" | "fetch" | "write" | "limit";
  errors: Array<{ field?: string, msg: string }>;
}
```

Metadata:

```ts
interface ProductBatchExportMetadata {
  selector_mode: "search" | "skus" | "product_ids";
  output_path?: string;
  row_count: number;
  page_size: number;
  pages_read?: number;
  started_at: string;
  completed_at: string;
  query_sha256?: string;
  export_sha256?: string;
  attributes_returned?: string[];
}
```

## Mechanism

### Search mode

1. Validate selector, caps, and byte/file guardrails.
2. Reject empty filter search unless `confirm_full_catalog: true`.
3. Call `POST /api/v2/products/search` with `page_size <= 100`.
4. Page until:
   - Plytix reports no remaining pages,
   - `max_rows` is reached,
   - the file export byte cap is reached.
5. Set `summary.truncated: true` when file export stops because of `max_rows` or the
   file byte cap.
6. Inline export must reject before returning if the row cap or serialized response byte
   cap would be exceeded. Do not return partial inline products for an over-cap result.
7. Hash the canonical query and exported rows.

### SKU mode

1. Reject duplicate SKUs.
2. Resolve SKUs in chunks of 100 with exact `sku in [...]`, no `pagination.order`, and
   page through every chunk until `pagination.pages` is exhausted.
3. Missing SKU becomes a `resolve` failure.
4. Multiple products for the same SKU becomes a `resolve` failure.
5. Export resolved products in input order.

### Product ID mode

1. Reject duplicate product IDs.
2. Fetch each product by `GET /api/v2/products/:product_id` with bounded concurrency and
   request pacing.
3. Missing or failed fetch becomes a row failure.
4. Export fetched products in input order.

## Pacing and Retries

- Reuse existing auth, timeout, 401 refresh, and 429 backoff in `client.ts` and
  `worker-client.ts`.
- Use bounded concurrency for `product_ids` fetch mode. Default concurrency should match
  batch update's conservative default unless tests justify otherwise.
- Search mode is naturally page-sequential. Do not fire all pages concurrently because
  pagination can drift under concurrent catalog changes.
- Retry transient 5xx/timeouts a small number of times; after exhaustion, record a row
  failure.

## Drift and Snapshot Semantics

This is a live API export, not a database snapshot. For high-churn catalogs, products can
change during a multi-page export.

The tool should make that explicit:

- Return `started_at` and `completed_at`.
- Return `truncated`.
- Do not claim snapshot isolation.
- For precise read-modify-write flows, use export output as the read side and
  `products_batch_update` with `expected_attributes` / `if_match` as the write-side guard.

## File Plan

| Layer | Change |
|---|---|
| `src/types.ts` | Add product batch export input/result/failure metadata types. |
| `src/batch/export.ts` *(new)* | Shared export execution, selectors, hashing, row shaping, preview handling. |
| `src/batch/export-file.ts` *(new)* | Stdio-only JSONL writer, output guardrails, SHA-256 file hashing. |
| `src/client.ts` | Reuse `searchProducts()` / `getProduct()`; add small wrapper if useful. |
| `src/worker-client.ts` | Reuse existing Worker product reads for inline export. |
| `src/tools/products.ts` | Register `products_batch_export` and stdio-only `products_batch_export_to_file`. |
| `src/worker.ts` | Mirror `products_batch_export` only, with lower caps. |
| `src/__tests__/batch-export.test.ts` *(new)* | Unit tests for selectors, pagination, caps, hashing, file writes, and Worker parity. |
| `CLAUDE.md`, `README.md`, `docs/features/worker-parity/SPEC.md` | Document tool counts and stdio-only file export exception. |

## Testing

Unit tests with no live API:

- Validation: no selector, multiple selectors, empty search without confirmation,
  duplicate SKUs, duplicate product IDs, invalid output extension, existing output file
  without overwrite.
- Search pagination: reads all pages, honors `max_rows`, marks `truncated`, computes
  `query_sha256` and `export_sha256`.
- SKU mode: exact SKU chunking, paginated resolution, missing SKU failure, ambiguous SKU
  failure, input order preservation.
- Product ID mode: successful fetches, missing product failures, input order
  preservation, retryable error handling.
- Inline caps: row cap and serialized-byte cap reject with no row payload echo.
- File export: writes JSONL, hashes exact file bytes, preview is capped, temp file is
  renamed into place, failures do not include row payloads.
- Worker parity: Worker exposes inline export and omits file export.

Live verification after implementation:

1. Run a tiny inline export for 2-4 known SKUs.
2. Run a file export for the same SKUs and compare row count/hash stability.
3. Run a filtered search export with a low `max_rows` and confirm `truncated: true`.
4. Confirm Worker tools list includes inline export and omits file export.

## Review Decisions

1. Do not add a separate `products_batch_get` in v1. Deterministic `sku[]` and
   `product_id[]` exports are selector modes on the two export tools. Add an alias later
   only if repeated usage shows the ergonomics are worth another tool name.
2. File-first is mandatory for large exports. The inline tool is intentionally small.
3. Do not add related-entity expansion in v1. Product rows are the common denominator and
   already enough for live snapshot -> diff -> guarded batch update.
4. Do not wire this into production sync scheduling. It is an operator/agent tool.

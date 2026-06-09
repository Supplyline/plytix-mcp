# PLAN - Batch Product Update implementation

## Decisions To Carry Forward

- Build v1 around documented `PATCH /api/v2/products/:product_id`.
- Keep Step 0 first, but treat it as an acceleration probe. Lack of an async bulk
  endpoint does not block the feature.
- Keep all feature docs under `docs/features/batch-update`; avoid implying a native
  Plytix bulk API.
- Ship two tools:
  - `products_batch_update` for inline small batches on stdio and Worker.
  - `products_batch_update_manifest` for stdio-only local manifests.
- Use `product_id` for the PATCH target when present and `sku` as the preferred ledger
  and failure key. Allow both on the same item.
- Verify `sku` and `product_id` point to the same product before PATCH when both are
  present.
- Add `dry_run` to both tools.
- Keep the 10,000 item cap for manifest runs. Stdio inline runs cap at 250 items and
  512 KB serialized payload; Worker inline runs cap at 50 items and 256 KB.
- Long runs must tolerate token expiry, rate pacing, and retryable upstream failures.

## Step 0 - Endpoint Evidence

1. Check the Plytix Postman collection or official API evidence for a supported async
   product update endpoint.
2. Record the evidence in `docs/features/batch-update/REST-EVIDENCE.md`:
   - endpoint paths,
   - auth/version,
   - request body,
   - status/poll shape,
   - per-row success/failure shape,
   - conclusion: `use_patch_loop` or `async_endpoint_confirmed`.
3. Continue with the PATCH-loop implementation unless the async endpoint is fully
   confirmed from first-party evidence. A browser capture of an internal UI/import
   endpoint is evidence only; it does not justify shipping against that endpoint in this
   public MCP repo.

## Step 1 - Shared Types And Helpers

1. Add batch types in `src/types.ts`:
   - `BatchUpdateItem`
   - `BatchUpdateFailure`
   - `BatchUpdateSummary`
   - `BatchUpdateMetadata`
   - `BatchUpdateResult`
2. Create `src/batch/helpers.ts` with pure functions:
   - `getBatchItemKey(item)`
   - `buildPatchBody(item)`
   - `validateBatchItems(items, { maxItems })`
   - `detectDuplicateTargets(items)`
   - `parsePlytixErrors(error)`
   - `aggregateBatchResults(...)`
   - `measureSerializedBytes(value)`
3. Keep helpers network-free so most behavior is unit-testable.

## Step 2 - Client Execution

1. In `src/client.ts`, add `resolveProductIdsBySku(skus)`:
   - use `POST /api/v2/products/search`,
   - filter by exact `sku in [...]` where supported,
   - request only minimal fields,
   - use no `pagination.order`,
   - keep `page_size <= 100`,
   - chunk SKU searches to stay within page-size limits,
   - page through every chunk until `pagination.pages` is exhausted,
   - fail unresolved or ambiguous SKUs per row.
2. Add `batchUpdateProducts(items, options?)`:
   - validate inputs,
   - resolve missing product IDs,
   - verify all `sku + product_id` pairs by resolving SKU and comparing IDs,
   - reject post-resolution duplicate product IDs,
   - PATCH with bounded concurrency and pacing,
   - refresh auth on expiry/401 during long runs,
   - retry transient 5xx/timeouts before recording row failure,
   - return the common `finished`/`rejected` result shape.
3. Repeat the same methods in `src/worker-client.ts`.

## Step 3 - Tool Surfaces

1. In `src/tools/products.ts`, register:
   - `products_batch_update({ items, dry_run? })`
   - `products_batch_update_manifest({ manifest_path, dry_run? })`
2. Manifest tool behavior:
   - read UTF-8 JSON from disk,
   - require a `.json` path and `schema_version: 1`,
   - reject files over 32 MB,
   - require an object with `items`,
   - compute `manifest_sha256`,
   - pass metadata into the result,
   - use the 10,000 item cap.
3. Inline tool behavior:
   - use the stdio 250 item and 512 KB cap,
   - return JSON text like existing product write tools.
4. In `src/worker.ts`, expose only `products_batch_update` with the 50 item and 256 KB
   cap.

## Step 4 - Tests

1. Add `src/__tests__/batch-update.test.ts`.
2. Cover validation and duplicate behavior.
3. Cover manifest parsing, missing files, malformed JSON, metadata, and SHA-256.
4. Mock client search/PATCH behavior for:
   - all success,
   - mixed resolve and patch failures,
   - `sku + product_id` items,
   - Plytix structured error parsing,
   - oversized inline and manifest requests.
   - dry-run resolution with zero PATCH calls.
5. Add a Worker tool-list or schema assertion showing manifest is intentionally omitted.

## Step 5 - Docs And Verification

1. Update `CLAUDE.md` tool lists.
2. Update `docs/features/worker-parity/SPEC.md` counts and intentional stdio-only
   manifest exception.
3. Run:
   - `npm test`
   - `npm run typecheck`
   - `npm run typecheck:worker`
4. With credentials, smoke-test a 2-4 product batch before running any production
   manifest.

## Notes For Implementation

- Do not add CSV import tools in v1.
- Do not add job/status tools without a first-party async endpoint.
- Do not persist idempotency state in this repo; the ETL ledger owns version-aware skip
  behavior.
- Keep the implementation boring: search missing IDs, patch products, aggregate results.

# SPEC - Batch Product Update tools

> **Status:** Design approved after review
> **Date:** 2026-06-09
> **Consumer:** supplyline-etl B-projection backfill manifest contract

## Summary

Add manifest-driven batch product update tools over documented Plytix product PATCH
operations.

This is not a CSV-import automation layer, and v1 does not depend on undocumented
bulk/import/job endpoints. If a supported async bulk endpoint is later confirmed, the
client may use it as an internal optimization while preserving the same response
contract.

Tools:

- **`products_batch_update`** - inline small/interactive batch update; available on stdio
  and the Cloudflare Worker.
- **`products_batch_update_manifest`** - stdio-only local manifest update; reads payloads
  from disk so large validated payload bytes never flow through the model context.

The work was prompted by a real consumer: the supplyline-etl `LMI-PD`
`box_n`/`opt_n`/`google_detail` backfill. The current sample is about 240 products, and
the larger series need remains real. A bounded PATCH loop is acceptable even if it takes
minutes on stdio.

Docs live under `docs/features/batch-update/` to avoid implying a confirmed native
Plytix bulk-write API.

## Load-bearing constraint

**Do not thread validated payload bytes through the model's context.**

The failure mode is not only HTTP round trips. Large `google_detail` payloads assembled
inside one giant tool call still burn context and make the agent brittle. Consequences:

- Inline `items[]` is only for compact interactive batches.
- Backfills use `products_batch_update_manifest`, where the tool reads a JSON manifest
  from disk and submits the already-validated items.
- The ETL owns projection, validation, and its version-aware `did_push` ledger. This
  server remains stateless.

## Item Contract

Update-only. No bulk create, delete, import-profile, or CSV-import execution in v1.

Each item:

```ts
interface BatchUpdateItem {
  product_id?: string;   // preferred PATCH target when known
  sku?: string;          // used to resolve product_id when needed; preferred result key
  label?: string;
  status?: string;
  attributes?: Record<string, unknown>; // null clears an attribute
  expected_attributes?: Record<string, unknown>; // attribute drift guard
  if_match?: Record<string, unknown>; // field-path drift guard, e.g. status or attributes.foo
}
```

Validation before any write:

- At least one of `product_id` or `sku` is required.
- Both `product_id` and `sku` are allowed. This is the expected manifest shape: patch by
  `product_id`, report by `sku`.
- At least one of `label`, `status`, or non-empty `attributes` is required.
- `attributes` must be a plain object when present.
- `attributes: {}` is invalid unless `label` or `status` is present.
- `expected_attributes` and `if_match` must be non-empty plain objects when present.
- `null` values inside `attributes` are allowed because they clear attributes.
- `sku` itself is not patchable in v1.
- Attribute format/value validation is out of scope; Plytix rejects are surfaced per row.
- Duplicate or conflicting identities are rejected before any mutation:
  duplicate `sku`, duplicate `product_id`, post-resolution duplicate `product_id`,
  same `sku` with conflicting `product_id`, or same `product_id` under conflicting `sku`.
- When both `sku` and `product_id` are present, resolve the SKU and verify it maps to the
  same product before PATCH. Mismatches become row failures with `stage: "verify"` and
  that row is skipped.
- When `expected_attributes` or `if_match` is present, read the live product immediately
  before PATCH. If any expected value differs, skip the row with `stage: "conflict"`.
  `expected_attributes` compares keys inside `product.attributes`; `if_match` compares
  top-level fields or `attributes.<label>` paths.

If any item is structurally invalid, reject the whole call and return the offending
indices. Do not partially apply a structurally invalid batch.

## Manifest Contract

`products_batch_update_manifest` input:

```ts
{
  manifest_path: string
}
```

Manifest file:

```jsonc
{
  "schema_version": 1,
  "series_id": "LMI-PD",
  "config_snapshot_hash": "<hash>",
  "items": [
    {
      "sku": "LMI-PD041929NI",
      "product_id": "5e0110bb...",
      "attributes": {
        "opt_1": "...",
        "google_detail": "..."
      }
    }
  ]
}
```

Rules:

- `schema_version: 1` is required.
- `items` follows the same item contract as inline input.
- `series_id` and `config_snapshot_hash` are metadata only. Echo them back for the ETL
  ledger; do not make tool behavior depend on them.
- Compute and return `manifest_sha256` so the caller can record exactly what was pushed.
- Hard cap manifest submissions at **10,000 items**. This is a runaway guardrail; known
  Supplyline series sizes are below it. Split larger pushes explicitly.
- Read UTF-8 JSON only.
- Require a `.json` path.
- Reject files larger than **32 MB**.
- Never echo manifest payload contents in errors. Return only metadata, counts, row keys,
  and error messages.

The Cloudflare Worker does not expose this tool because it cannot read the caller's local
filesystem. This is an intentional stdio-only exception to worker parity.

## Inline Contract

`products_batch_update` input:

```ts
{
  items: BatchUpdateItem[],
  dry_run?: boolean,
  return_successes?: boolean
}
```

Rules:

- Same validation and response shape as the manifest tool.
- Stdio inline cap: **250 items** and **512 KB** serialized payload.
- Worker inline cap: **50 items** and **256 KB** serialized payload.
- Large or text-heavy updates should use the stdio manifest tool even when under the item
  cap.
- `return_successes: true` includes one success row per patched product for exact caller
  ledger updates. It defaults off to keep large responses compact.

`products_batch_update_manifest` also accepts `dry_run?: boolean` and
`return_successes?: boolean`.

Dry run:

- parses and validates the manifest/input,
- computes `manifest_sha256` when applicable,
- resolves SKUs,
- verifies `sku`/`product_id` pairs,
- checks `expected_attributes` and `if_match` against current live product data,
- detects duplicate targets,
- returns the same result shape with `dry_run: true`,
- performs zero PATCH calls.

## Mechanism

Primary v1 implementation uses documented product APIs from
`docs/solutions/api-quirks/plytix-api.md`:

1. Validate all items.
2. Resolve missing `product_id` values by exact SKU search:
   `POST /api/v2/products/search`, with no `pagination.order`, `page_size <= 100`,
   and paging through each chunk until `pagination.pages` is exhausted.
3. For rows with `expected_attributes` or `if_match`, read the live product and compare
   expected values immediately before PATCH. Drift is returned as `stage: "conflict"`.
4. PATCH each product with bounded concurrency:
   `PATCH /api/v2/products/:product_id`.
5. Reuse existing auth, timeout, 401 retry, and 429 backoff in `client.ts` and
   `worker-client.ts`.
6. Return per-key success/failure results.

Step 0 remains first, but it is an acceleration probe, not a build gate:

- Check whether Plytix exposes a supported first-party async product update endpoint via
  the Postman collection or official API evidence.
- If confirmed, record the submit/status/result shapes and optionally implement it behind
  the same batch-update contract.
- If not confirmed, ship the documented PATCH loop. Do not infer endpoints from
  third-party wrappers alone.
- A browser capture of an internal UI/import endpoint is not enough to set
  `async_endpoint_confirmed`. Private UI/import endpoints are evidence only; the
  conclusion remains `use_patch_loop`.

## Response Shapes

Structural rejection:

```ts
{
  status: "rejected",
  summary: { total: number, succeeded: 0, failed: number, skipped: number },
  failures: Array<{
    index: number,
    key: string,
    stage: "validation" | "duplicate",
    errors: Array<{ field?: string, msg: string }>
  }>,
  metadata?: BatchMetadata
}
```

Completed run:

```ts
{
  status: "finished",
  dry_run?: boolean,
  summary: { total: number, succeeded: number, failed: number, skipped: number },
  failures: Array<{
    index: number,
    key: string,
    product_id?: string,
    stage: "resolve" | "verify" | "conflict" | "patch",
    errors: Array<{ field?: string, msg: string }>
  }>,
  successes?: Array<{
    index: number,
    key: string,
    product_id: string,
    modified?: string
  }>,
  metadata?: BatchMetadata
}
```

```ts
interface BatchMetadata {
  series_id?: string;
  config_snapshot_hash?: string;
  manifest_sha256?: string;
}
```

`key` is `sku` when present, otherwise `product_id`. Never report blanket success when a
row failed.

No `running` state and no synthetic job handles in v1. If a real async endpoint is later
confirmed, add status/polling only with the actual API shape.

Result rules:

- Validation or duplicate batch-level errors return `status: "rejected"` with no API
  mutations.
- Unresolved SKU or `sku`/`product_id` mismatch is a row failure and skipped PATCH.
- `expected_attributes` or `if_match` mismatches are row failures with
  `stage: "conflict"` and skipped PATCH.
- PATCH failure is a row failure.
- Success only means the PATCH request succeeded for that row.

## Error Handling

- Structural validation errors reject the whole call before any API request.
- SKU resolution failures are row failures with `stage: "resolve"`.
- SKU/product ID mismatches are row failures with `stage: "verify"`.
- Optimistic-concurrency guard mismatches are row failures with `stage: "conflict"`.
- Plytix PATCH rejects are row failures with `stage: "patch"` and the Plytix
  `{ field, msg }` details when available.
- Unexpected or unparsable Plytix errors still include a clear message and the row key.
- `429` and token refresh behavior stay in the existing request path. Long manifest runs
  must tolerate token expiry through 401 refresh/retry, and request pacing must limit
  concurrency rather than firing all PATCHes at once.
- Retry transient 5xx/timeouts a small number of times; after exhaustion, record a row
  failure.
- `google_detail` feeds customer-facing Google Merchant output; surface failures
  prominently.
- Absent custom attributes on read-back are not proof of unchanged values, because Plytix
  omits empty/absent custom attributes in search responses.

## File Plan

| Layer | Change |
|---|---|
| `src/types.ts` | Add batch item/result/failure metadata types. |
| `src/batch/helpers.ts` *(new)* | Pure validation, duplicate detection, metadata shaping, byte-size checks, error parsing, concurrency helper. |
| `src/client.ts` | Add `resolveProductIdsBySku()` and `batchUpdateProducts()` using documented search + PATCH. |
| `src/worker-client.ts` | Add the same methods for Worker runtime. |
| `src/tools/products.ts` | Register `products_batch_update` and stdio-only `products_batch_update_manifest`. |
| `src/worker.ts` | Mirror `products_batch_update` only. |
| `src/__tests__/batch-update.test.ts` *(new)* | Unit tests for helpers and mocked client execution. |
| `CLAUDE.md`, `docs/features/worker-parity/SPEC.md` | Document the new tools and stdio-only manifest exception. |

## Testing

Unit tests with no live API:

- Validation: missing key, missing update fields, non-object attributes, empty
  attributes-only update, duplicate keys, invalid manifest JSON, oversized
  inline/manifest requests.
- `product_id` + `sku` together is valid and reports by `sku`.
- SKU resolution and verification: found, not found, duplicate SKU result, mismatch
  between `sku` and `product_id`, and fallback/error mapping.
- Optimistic-concurrency guards: matching live values, drifted live values, and no PATCH
  after a guard conflict.
- PATCH aggregation: mixed successes/failures, preserved indices, correct
  `succeeded`/`failed`/`skipped` counts.
- Optional success rows: `return_successes` reports exact patched keys/product IDs.
- Error parsing: Plytix `{ error: { errors: [...] } }`, top-level messages, and unknown
  errors.
- Manifest read: valid file, missing file, non-JSON path, oversized file, malformed JSON,
  schema version, metadata echo, SHA-256.
- Dry run performs resolution/verification but zero PATCH calls.
- Worker parity: Worker exposes inline batch update with lower caps and intentionally
  omits manifest.

Live verification after implementation:

1. Run Step 0 probe and record whether a real async endpoint exists.
2. Run a tiny 2-4 product batch through documented PATCH.
3. Confirm returned failures/successes match Plytix state before using the tool on the
   full manifest.

## Review Decisions

1. Include the off-context disk-submit path in v1, but expose it as
   `products_batch_update_manifest` instead of a `manifest_path` branch on the Worker-
   mirrored inline tool. This keeps the APIs smaller and avoids a remote input that can
   never work.
2. Use **10,000** as the manifest cap. The known sample is about 240, the previously
   discussed 620 still fits easily, and a larger-than-10,000 push should be deliberately
   split.
3. Rename the public feature/tools from "bulk" to "batch" to avoid implying a confirmed
   Plytix bulk-write API.
4. Do not ship `products_bulk_status` or any job handle until a real async endpoint is
   proven.

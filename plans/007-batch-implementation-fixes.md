# Plan 007: Post-ship fixes for the batch update/export implementation (review of 2026-06-10)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (spec-conformance fixes + additive tests)
- **Depends on**: none
- **Category**: bug + tests
- **Planned at**: commit `fb8935e`, 2026-06-10
- **Status**: DONE (executed the same night — this file is the record of what was found,
  what was fixed, and what was deliberately rejected)

## Context

PRs #24–#27 (2026-06-09) shipped `products_batch_update`, `products_batch_update_manifest`,
`products_batch_export`, `products_batch_export_to_file` (~4,800 lines) against
`docs/features/batch-update/SPEC.md` and `docs/features/batch-export/SPEC.md`. Two parallel
reviewers swept the implementation against those specs plus the ETL contract
(`docs/etl-projection-bulk-handoff.md`); the advisor re-read every cited site.

## Findings fixed (this session)

1. **SKU chunking tied to caller `page_size`** — `src/batch/export.ts` `exportBySkus` used
   `input.pageSize` as the SKU chunk size; SPEC line 328 requires "chunks of 100". A
   `page_size: 10` caller got 10-SKU chunks → up to 10× the API calls. Fixed: chunk at
   `MAX_EXPORT_PAGE_SIZE` (100); `page_size` now governs result paging only. Regression
   test pins `[100, 50]` chunks for 150 SKUs at `page_size: 10`.
2. **`normalizePositiveInt` returned over-max values** (`src/batch/export.ts`) — the
   pushed validation failure rejects the call today, but the function's postcondition was
   one refactor away from leaking an uncapped `page_size`/`max_rows` into a run. Fixed:
   clamp to `max`.
3. **Dry-run `skipped` over-count** — `src/batch/runner.ts` dry-run returned
   `skipped: total` even when rows failed, so `failed + skipped > total`. Fixed:
   `skipped = total - failures`; `rejectedResult`'s conservative `skipped: total` is now
   commented as intentional.
4. **Missing contractual tests** (SPEC Testing sections) — added:
   - `parsePlytixErrors`: single-message `{error:{msg}}` body, plain `Error` fallback,
     opaque-throw fallback (the `google_detail` failure-reporting path).
   - Manifest read: missing file, malformed JSON, `items` not an array, oversized file
     (32 MB cap, sparse-file test).
   - Worker cap enforcement: 51-item batch → `status: "rejected"` with zero network calls.
   - Export: inline byte-cap rejection (no row echo) + the chunking regression test above.
5. **REST-EVIDENCE addendum** — appended the independent Step-0 probe results (Postman
   collection has no bulk endpoints; `/api/v1/jobs/...` exists but is 403 permission-gated
   for this account). Conclusion `use_patch_loop` unchanged.

## Findings rejected (do not re-flag)

- **`isTransientError` returns `true` for errors without a numeric status** (reviewer
  FINDING 1, 92% confidence) — REJECTED as by-design. The SPEC explicitly requires
  retrying timeouts ("Retry transient 5xx/timeouts a small number of times"), and timeouts
  surface as `PlytixError` with `status: undefined`. A real 401 carries `status: 401` and
  is correctly non-transient. The reviewer's sharpest case (401 escaping without status)
  does not occur in either client.
- **`sink.abort()` after `finish()` in the inline byte-cap path** — unreachable for the
  file sink (file mode has no `maxResponseBytes`); harmless no-op for the inline sink. The
  reviewer reclassified this itself during review.

## Verification

- `npm run typecheck` + `npm run typecheck:worker`: clean
- `npm test`: all suites green (batch-update 31, batch-export 14, plus existing)

## Maintenance notes

- The 4-SKU live verification (SPEC "Live verification" step 2-3) and the full LMI-PD
  manifest run remain operator steps — nothing in this plan touches live data.
- If the ETL ever consumes `summary.skipped` from a dry run, the new
  `failed + skipped = total` invariant is the contract.

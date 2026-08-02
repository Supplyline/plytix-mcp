# Plan 001: SUPERSEDED — bulk update tools shipped as `products_batch_update` (PRs #24–#27)

## Status

- **Status**: SUPERSEDED before execution (2026-06-10, same night it was written)
- **Planned at**: commit `18ded4c` — which turned out to be a **stale local main**;
  origin/main was already 4 commits ahead with the feature implemented.

## What happened

This plan specified `products_bulk_update`/`products_bulk_status` against Plytix's
undocumented async bulk-job API, per `docs/etl-projection-bulk-handoff.md`. While this plan
was being written against stale local state, the feature had already landed on origin/main
(2026-06-09) as PRs #24 (v0.3.0 batch update tools), #25 (v0.3.1 drift guards), #26 (batch
export tools), #27 (v0.3.3 nullish-equivalence guards), with a **more conservative design**:

- `docs/features/batch-update/REST-EVIDENCE.md` concluded `use_patch_loop` — no public
  first-party async bulk endpoint is documented, so v1 is a bounded, paced loop of
  documented `PATCH /api/v2/products/:id` calls behind a batch contract.
- Tools shipped: `products_batch_update` (stdio + worker, inline caps 250/512KB and
  50/256KB), `products_batch_update_manifest` (stdio-only, reads the ETL manifest from
  disk — the handoff's "shape 2"), plus `products_batch_export` / `products_batch_export_to_file`.
- The shipped spec (`docs/features/batch-update/SPEC.md`) independently resolved this
  plan's pressure-test amendments: both `sku`+`product_id` allowed per item (manifest
  shape), per-row failures keyed by sku, dry-run with zero PATCH calls, no synthetic job
  handles, ETL owns the ledger.

## What survives from this plan's Step-0 research (recorded 2026-06-10)

New evidence beyond REST-EVIDENCE.md, from read-only probes with the account credentials:

- The official public Postman collection (88 endpoints) contains **no** bulk/job/task
  endpoints — independently confirms the REST-EVIDENCE conclusion.
- `GET /api/v1/jobs/{id}` and `POST /api/v1/jobs/search` return **403 Forbidden** (route
  exists, permission-gated); all other guessed roots 404. If Plytix ever exposes the async
  path, the job-status family is `/api/v1/jobs/...` — and this account's API credential
  currently lacks that permission.
- Per the REST-EVIDENCE implementation rule, a 403 on an undocumented route is NOT enough
  to switch to `async_endpoint_confirmed`. `use_patch_loop` stands.

This evidence was appended to `docs/features/batch-update/REST-EVIDENCE.md`.

## Follow-up

Post-ship review of the implemented batch code → plan
`007-batch-implementation-fixes.md`.

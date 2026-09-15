# Plan 009: `products_bulk_update` + `products_bulk_status` on Plytix's async bulk endpoint

> **Executor instructions**: Follow step by step; verify each step; on any STOP condition,
> stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git fetch origin && git log --oneline origin/main -3`.
> This plan lands on top of #43 (guarded batch writes) and #38 (safety gate). Neither touches
> `src/batch/` or the batch tool definitions, so no semantic overlap is expected.

## Status

- **Priority**: P1 (unblocks single-submission catalog backfills)
- **Effort**: M
- **Risk**: MEDIUM — new write path against an undocumented (draft-doc) endpoint. Mitigated by
  the verified request/response shapes in `docs/features/batch-update/REST-EVIDENCE.md`
  (2026-09-15 addendum) and by keeping `products_batch_update` untouched as the guarded path.
- **Depends on**: REST-EVIDENCE `async_endpoint_confirmed` (done, `c6d1ed0`).
- **Planned at**: `c6d1ed0`, 2026-09-15. Decision: Path 2 (new tools, no guards) over Path 1
  (swap the batch runner's write phase) — the backfill goes straight to one submission; the
  guarded runner stays as-is for callers that need optimistic concurrency.

## What the endpoint is (verified)

- `POST /api/v1/bulk/products` `{ action: "update", products: [{ id | sku, data: { label?,
  status?, attributes: {…} } }] }` → `200` `{ data: [ { id (job_id), state: "CREATED", … } ] }`.
  ≤ 1,000 products per job. Mutation: retry on 429 only.
- `GET /api/v1/bulk/products/<job_id>` → `{ data: [ { status: "In progress" | "Finished",
  summary: { ok, error, cancelled } (strings), products: [{id, sku}], errors: [{ sku,
  errors: [{ <field>: msg }] }] } ] }`.
- **`Finished` is reported before `summary`/`products` are populated.** Terminal = status
  finished **and** `ok + error + cancelled ≥ rows submitted`. Otherwise keep polling.
- No optimistic-concurrency guard, no cancel, no job listing, no documented failure state.
  Unknown SKU → per-row `{ sku: "sku does not exist" }`, nothing created.

## Design

### Shared core — `src/batch/bulk.ts` (compiles under both tsconfigs)

```ts
export interface BulkUpdateOperations {
  submitBulkProductUpdate(rows: BulkProductRow[]): Promise<BulkJobRecord>;
  getBulkProductJob(jobId: string): Promise<BulkJobSummary>;
}
export async function executeBulkUpdate(ops, items: unknown, options): Promise<BulkUpdateResult>
export async function pollBulkJob(ops, jobId, options): Promise<BulkUpdateResult>   // status tool
export function toBulkRows(items: BatchUpdateItem[]): BulkProductRow[]
export function isBulkJobSettled(summary, submitted): boolean
```

`executeBulkUpdate`:
1. `validateBatchItems(items, { maxItems: BULK_MAX_ITEMS (1000), maxBytes })` — reused.
2. **Reject guards.** Any `expected_attributes` / `if_match` → `stage: "validation"`,
   `"optimistic guards are not supported by the bulk endpoint; use products_batch_update"`.
   Silently dropping a guard would be the worst failure mode here.
3. `detectDuplicateInputs` — reused.
4. Any validation/duplicate failure → `status: "rejected"`, nothing submitted (same rule as batch).
5. Rows: `product_id` → `{ id }`, else `{ sku }`; if both given, `id` wins and `sku` is kept for
   reporting only. `data` = `{ label?, status?, attributes? }` (only defined keys).
6. `dry_run` → return `finished` + `dry_run: true` with the rows that *would* be submitted
   (count only, no payload echo). **No network.** There is no server-side dry run.
7. Submit. Then, if `wait` (default true), `pollBulkJob` with `wait_timeout_ms` (default
   **45,000** — must stay under a typical MCP client timeout), interval 500 ms → 1 s → 2 s cap.
8. Map the summary → `BulkUpdateResult`:
   - server `errors[]` → `failures[]` with `stage: "bulk"`, `key` = sku, `errors` = the
     server's `{field: msg}` pairs as `{ field, msg }`.
   - `products[]` → `successes[]` (`{ key: sku, product_id: id }`) when `return_successes`.
   - `summary` = `{ total: submitted, succeeded: ok, failed: error, skipped: cancelled }`.
   - `job: { id, status, raw_summary: {ok, error, cancelled} }` always present.
9. Not settled within the timeout → `status: "pending"` with `job.id` and whatever counters
   exist, plus `next: "call products_bulk_status with job_id"`. Never throw on a slow job.

`pollBulkJob(ops, jobId, { submitted?, waitTimeoutMs })` is the same loop, used by both the
submit path and the status tool. `submitted` is optional for the status tool (caller may pass
`expected_total`); without it, settledness = status finished **and** `products.length +
errors.length > 0 || all counters 0 for ≥ 3 consecutive polls` — no, simpler and honest:
without an expected total the status tool returns the current snapshot with
`settled: null`, and documents that `expected_total` is needed to confirm completion.

### Clients (both)

- `submitBulkProductUpdate(rows)` — `POST /api/v1/bulk/products`, body
  `{ action: "update", products: rows }`; goes through `request()` so it is paced and
  429-retried, and `isMutation` keeps it off the 5xx retry path.
- `getBulkProductJob(jobId)` — `GET /api/v1/bulk/products/${encodeURIComponent(jobId)}`.
- `bulkUpdateProducts(items, options)` → `executeBulkUpdate(this, …)`.
- `getBulkUpdateStatus(jobId, options)` → `pollBulkJob(this, …)`.

### Tools

| Tool | stdio | worker | input |
|---|---|---|---|
| `products_bulk_update` | ✓ | ✓ | `items` (≤1,000; stdio 512 KB / worker 256 KB) **or** stdio-only `manifest_path` (exactly one); `dry_run`, `wait` (default true), `wait_timeout_ms`, `return_successes` |
| `products_bulk_status` | ✓ | ✓ | `job_id`, `expected_total?`, `wait?` (default false), `wait_timeout_ms?` |

Manifest path reuses `readBatchManifest` (schema_version 1) — the ETL contract already emits
it. `MANIFEST_MAX_ITEMS` (10,000) is irrelevant here: bulk caps at 1,000 per job, so a larger
manifest is rejected with "split into ≤1,000-row manifests" — chunking across jobs is the
caller's decision, not something this tool does silently.

### Types (`types.ts`)

`BulkProductRow`, `BulkJobRecord`, `BulkJobSummary` (server shapes, counters typed as
`string | number` and normalised), `BulkUpdateResult` (discriminated on
`rejected | finished | pending`), `BatchUpdateFailureStage` gains `'bulk'`.

### Not in scope

Swapping `products_batch_update`'s write phase (Path 1) — follow-up. Chunking > 1,000 rows
across jobs. The delete safety gate (#38) — this is an update, not a delete.

## Steps

1. Types + `src/batch/bulk.ts` with tests (`src/__tests__/bulk-update.test.ts`, fake ops).
2. Client methods on both clients + request-path tests (POST body shape; 5xx on submit is
   **not** retried; 429 is).
3. stdio tools in `src/tools/products.ts`; worker `TOOLS` + `toolHandlers`.
4. Docs: CLAUDE.md + README tool tables (worker count 46 → 48), batch-update SPEC §"bulk",
   CHANGELOG 0.4.0 (new tools = minor), api-quirks already has §16b.
5. Live verification (authorized, same 4 Archived SKUs): `products_bulk_update` via the built
   stdio server setting `box_1` to `FD` (no-op), then `products_bulk_status` on the job id.
6. PR → adversarial review loop with **Opus** (no Codex) → merge on green checks (capture rc).

## Test plan

`bulk-update.test.ts`:
1. happy path: 3 items → one submit call with the exact documented body; polls until settled;
   `finished`, summary from counters, successes when requested.
2. **Finished-before-summary**: fake returns `Finished` with zero counters for 2 polls, then
   populated → result waits for the populated one (regression for the verified gotcha).
3. server error rows → `failures[]` stage `bulk`, field/msg preserved, `succeeded` from `ok`.
4. guards present → `rejected`, no submit call.
5. duplicates → `rejected`, no submit call. 1,001 items → `rejected`.
6. dry_run → no ops calls at all; `dry_run: true`; `summary.total` = would-submit count.
7. `wait: false` → returns `pending` immediately after submit with `job.id`.
8. timeout → `pending` after `wait_timeout_ms` with the latest counters (fake timers).
9. `pollBulkJob` with `expected_total` settles; without it returns snapshot `settled: null`.
10. `product_id` + `sku` both given → row uses `id`, failure/success key is the sku.

Client tests (both): submit hits `POST /api/v1/bulk/products` with `action: "update"`; a 502
on submit is surfaced, not retried; a 429 on submit is retried. Worker surface test: both
tools listed; `products_bulk_update` with 1,001 items rejected before any fetch.

## Done criteria

- [ ] `npm test`, both typechecks, `npm run build`, `npm run test:mcp` green.
- [ ] Live: 4-row `products_bulk_update` returns `finished` with `succeeded: 4` (not `0`),
      i.e. the settledness rule holds against the real API.
- [ ] `products_bulk_status` on that job returns the same counters.
- [ ] Docs updated; `plans/README.md` row DONE with PR number.

## STOP conditions

- Submit returns anything other than `200` + a job `id` on the live run → capture and stop.
- The live job never reaches counters-sum-to-submitted within 45 s for 4 rows → the
  settledness rule is wrong; re-derive before shipping.
- Plytix accepts a row with a guard-shaped key inside `attributes` as an attribute write — not
  expected (we strip guards before building rows), but verify in the live run that only
  `box_1` changed.

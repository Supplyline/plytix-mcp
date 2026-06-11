# Plan 005: Collapse the attribute-cache N+1 using the search `attributes` parameter

> **Executor instructions**: Follow step by step; verify each step; on any STOP condition,
> stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 18ded4c..HEAD -- src/client.ts src/worker-client.ts`
> Plan 002 (and possibly 004) land first — locate `doBuildAttributeCache` in the live code;
> if 004 landed, the change goes in `src/core/client.ts` instead.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (read-path only; falls back to current behavior)
- **Depends on**: plans/002-stdio-client-hardening.md (test harness)
- **Category**: perf
- **Planned at**: commit `18ded4c`, 2026-06-10

## Why this matters

Building the attribute cache currently costs 1 paginated search (ids only) + **one GET per
attribute id**. On accounts with hundreds of attributes that's hundreds of requests against
a rate-limited API before the first `attributes_get`/`products_set_attribute` call can
answer. A live probe (2026-06-10, read-only) confirmed `POST
/api/v1/attributes/product/search` returns `label`, `name`, `type_class`, `groups`, and
`filter_type` directly when passed `"attributes": ["label","name","type_class","options","groups"]`
— so the N+1 can collapse to ~N/100 paginated search calls, with per-id fetches needed (at
most) only where `options` are not returned.

## Current state

- `src/client.ts:364-386` (`searchAttributeIds`) requests **no** `attributes` field → API
  returns minimal `{id, filter_type}` rows.
- `src/client.ts` `doBuildAttributeCache` (post-plan-002; mirrors
  `src/worker-client.ts:616-655`): batched per-id `getAttributeById` for every id.
- **Verified**: search with the `attributes` param returns label/name/type_class/groups.
  **Unverified**: whether `options` arrays are populated in search rows for
  dropdown/multiselect attributes (the probe hit only non-option attributes; Plytix omits
  empty/absent fields from search responses, so absence ≠ unsupported).
- `getAttributeOptions(label)` (client.ts:440-444) is the consumer that needs `options`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `npm run typecheck && npm run typecheck:worker` | exit 0 |
| Tests | `npm test` | all pass |

## Scope

**In scope**: `src/client.ts`, `src/worker-client.ts` (or `src/core/client.ts` post-004),
`src/__tests__/client.test.ts`.
**Out of scope**: lookup pipeline, tool handlers, anything else.

## Steps

### Step 0 (operator-assisted verification — read-only)

Run a one-off read-only probe (POST `/api/v1/attributes/product/search`, body
`{"attributes":["label","options","type_class"],"filters":[[{"field":"type_class","operator":"in","value":["DropdownAttribute","MultiSelectAttribute"]}]],"pagination":{"page":1,"page_size":5}}`
— adjust the filter if `type_class` isn't filterable) and record whether `options` come
back populated. If filters on type_class aren't supported, fetch one known dropdown
attribute by search and inspect. **If `options` are returned in search rows → Path A. If
not → Path B.**

### Step 1, Path A (options available in search)

Rewrite `doBuildAttributeCache` to paginate
`/api/v1/attributes/product/search` with `attributes: ["label","name","type_class","options","groups","filter_type"]`,
page_size 100, MAX_PAGES 50, building the byLabel map directly. Remove per-id fetching from
the cache build (keep `getAttributeById` — it's used elsewhere).

### Step 1, Path B (options not in search)

Same paginated full-field search, then per-id fetches ONLY for attributes whose
`type_class` indicates options (`DropdownAttribute`/`MultiSelectAttribute`), batched 10 at
a time (reuse the plan-002 batching).

**Verify (either path)**: `npm test` — update `client.test.ts` cache tests: dedup and
failure-threshold cases still pass; add a case asserting the build issues ≤
`ceil(N/100)` search calls (Path A) or only fetches option-typed ids per-id (Path B).

## Test plan

Extend `src/__tests__/client.test.ts` (mocked fetch): full-field rows in search response →
cache populated without per-id GETs (Path A) / per-id GETs only for option types (Path B);
`getAttributeOptions` returns options either way.

## Done criteria

- [ ] `npm test` green with updated cache tests
- [ ] Cache build for 250 mocked attributes issues ≤3 search calls (+ option fetches under
      Path B only)
- [ ] `plans/README.md` updated, including which path reality chose

## STOP conditions

- Step 0 shows search rows missing `label` (contradicts the recorded probe) — re-verify
  before touching code.
- Plytix paginates search differently than `pagination.page/page_size` for attributes.

## Maintenance notes

- If Plytix ever adds new option-bearing attribute types, Path B's type allowlist needs
  the new type_class values.

# Plan 002: Port worker-client hardening to the stdio client, add client unit tests, typecheck the worker in CI

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. On any STOP condition, stop
> and report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 18ded4c..HEAD -- src/client.ts src/lookup/lookup.ts .github/workflows/ci.yml src/__tests__/`
> On mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (ports already-tested behavior from the worker twin; additive tests)
- **Depends on**: none
- **Category**: bug + tests + dx
- **Planned at**: commit `18ded4c`, 2026-06-10

## Why this matters

`src/client.ts` (stdio) and `src/worker-client.ts` (worker) are near-twins that have
drifted: the worker version gained a pagination safety cap, concurrent-build deduplication,
batched attribute fetches, and a failure threshold that the stdio client never received.
Concretely, the stdio client's attribute-cache build fires **one parallel GET per attribute
id with no batching** (hundreds of simultaneous requests → 429 storms on large accounts)
and two concurrent callers both rebuild the cache. The client's auth/retry/backoff logic —
which every one of the 47 stdio tools depends on — has zero tests. Separately, CI runs
`npm run typecheck` but never `typecheck:worker`, so the 3,000-line worker surface can
break silently.

## Current state

- `src/client.ts:364-386` — `searchAttributeIds()` paginates with `while (true)`, no page
  cap:

  ```ts
  async searchAttributeIds(pageSize = 100): Promise<string[]> {
    const attrIds: string[] = [];
    let page = 1;
    while (true) {
      const result = await this.request<{ id: string; filter_type?: string }>(
  ```

- `src/client.ts:403-425` — `buildAttributeCache()`: checks `this.attributeCache`
  TTL, then

  ```ts
  const attrIds = await this.searchAttributeIds();
  const results = await Promise.allSettled(attrIds.map((id) => this.getAttributeById(id)));
  ```

  No in-flight dedup, no batching, no failure threshold, caches whatever succeeded.
- `src/worker-client.ts:564-655` — the target behavior to port: `MAX_PAGES = 50`;
  `attributeCachePromise` dedup (`buildAttributeCache` returns the in-flight promise);
  `doBuildAttributeCache` fetches in `BATCH_SIZE = 10` waves via `Promise.allSettled`,
  throws `PlytixError` when 0 attributes are found or when `failures > attrIds.length * 0.2`.
- `src/lookup/lookup.ts:124-129` — constructor merges `{ pageSize: 5, cacheEnabled: true,
  cacheTtlMs: 60_000, ...cfg }`: an explicit `undefined` in `cfg` overrides a default;
  `lookup.ts:213` then uses `this.cfg.cacheTtlMs!` (NaN expiry if undefined).
- `.github/workflows/ci.yml:28-30`:

  ```yaml
    - name: Run type checking
      run: npm run typecheck
  ```

  No `typecheck:worker` step anywhere in the workflow.
- Differences that are **intentional** and must remain: stdio cache has a 5-minute TTL
  (long-lived process); worker cache is per-request with no TTL. Keep the TTL.
- Test conventions: vitest; mocked-fetch precedent in `src/__tests__/worker-oauth.test.ts`
  (uses `vi.stubGlobal('fetch', …)` style mocks).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `npm run typecheck` | exit 0 |
| Worker typecheck | `npm run typecheck:worker` | exit 0 |
| Tests | `npm test` | all pass |

## Scope

**In scope**: `src/client.ts`, `src/lookup/lookup.ts`, `.github/workflows/ci.yml`,
`src/__tests__/client.test.ts` (create), `src/__tests__/lookup.test.ts` (extend only if
needed for the cfg fix).

**Out of scope**: `src/worker-client.ts` and `src/worker-lookup.ts` (already correct — the
source of truth for the port); any consolidation of the twins (plan 004); tool handler
files; retry semantics changes (port behavior, don't redesign).

## Steps

### Step 1: Pagination cap

In `src/client.ts` `searchAttributeIds`, mirror `worker-client.ts:564-587`: add
`const MAX_PAGES = 50;` and loop `while (page <= MAX_PAGES)`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Cache build — dedup, batching, failure threshold

Port `worker-client.ts:599-655` into `src/client.ts`, preserving the 5-minute TTL:
- Add `private attributeCachePromise?: Promise<Map<string, PlytixAttributeDetail>>`.
- `buildAttributeCache()`: return cached when TTL-valid → return in-flight promise if set →
  otherwise set the promise to `doBuildAttributeCache()`, await in try/finally clearing the
  promise field.
- `doBuildAttributeCache()`: BATCH_SIZE 10 waves; throw `PlytixError` on 0 ids; count
  failures; throw when `failures > attrIds.length * 0.2`; on success set
  `this.attributeCache = { byLabel, expires: now + CACHE_TTL_MS }`.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Lookup config undefined-spread fix

In `src/lookup/lookup.ts` constructor, drop `undefined` values before merging:

```ts
const defined = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined));
this.cfg = { pageSize: 5, cacheEnabled: true, cacheTtlMs: 60_000, ...defined };
```

and replace `this.cfg.cacheTtlMs!` at line 213 with `this.cfg.cacheTtlMs ?? 60_000`.

**Verify**: `npm run typecheck` → exit 0; `npm test` (existing lookup tests still green).

### Step 4: Client unit tests

Create `src/__tests__/client.test.ts` with a mocked global `fetch` (pattern:
`worker-oauth.test.ts`). Cases:
1. token fetched once and reused within expiry; refreshed when within 60s of expiry
2. 401 → token cleared → retried once with fresh token → succeeds
3. 429 with `x-ratelimit-reset` → backs off → retried once (use fake timers,
   `vi.useFakeTimers()` + advance)
4. `searchAttributeIds` stops at MAX_PAGES (mock always-full pages; expect exactly 50 calls)
5. concurrent `getAttributeByLabel('a')` + `getAttributeByLabel('b')` → exactly ONE
   attribute-search pagination pass (dedup)
6. cache-build failure threshold: >20% of detail fetches rejected → throws PlytixError
7. batching: with 25 attribute ids, max in-flight detail GETs never exceeds 10 (track with
   a counting mock)

**Verify**: `npm test` → all pass, 7+ new tests.

### Step 5: CI worker typecheck

In `.github/workflows/ci.yml`, after the "Run type checking" step add:

```yaml
    - name: Run worker type checking
      run: npm run typecheck:worker
```

**Verify**: `npm run typecheck:worker` locally → exit 0 (CI parity).

## Test plan

See Step 4 — that IS the test plan. Existing suites must stay green:
`npm test` → identifier, lookup, search-fields, worker-oauth all pass.

## Done criteria

- [ ] `npm run typecheck` && `npm run typecheck:worker` exit 0
- [ ] `npm test` exits 0; `client.test.ts` exists with the 7 cases above
- [ ] `grep -n "while (true)" src/client.ts` → no matches
- [ ] `grep -n "attributeCachePromise" src/client.ts` → present
- [ ] `grep -n "typecheck:worker" .github/workflows/ci.yml` → present
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` row updated

## STOP conditions

- `client.ts` excerpts don't match (drift since `18ded4c`).
- Porting forces a change to `request()` retry semantics — that's redesign, not porting.
- Fake-timer tests are flaky after two fix attempts — report rather than loosen assertions.

## Maintenance notes

- Plan 004 will merge the twins; this plan intentionally makes them *more* similar so the
  merge diff is smaller. Don't "improve" beyond the worker's behavior.
- Optional follow-up recorded here (not in scope): a manually-triggered CI job running
  `test-integration.js` with real credentials from GitHub secrets, for live-contract drift
  detection.

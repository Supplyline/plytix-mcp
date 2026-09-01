# Plan 008: Real 429 handling — body-aware backoff, client-level pacing, JWT-derived limits

> **Executor instructions**: Follow step by step; verify each step; on any STOP condition,
> stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git fetch origin && gh pr view 37 --json state,mergedAt`.
> PR #37 (`fix/429-backoff-cache-build`, open since 2026-08-11) touches the same
> `backoffOnRateLimit` / `request` code in `src/client.ts`. If it has merged, Step 1 is
> mostly done for stdio — diff against it and only add what's missing (body `ttl`, worker
> parity, `PlytixError.rateLimit`). If it is still open, **absorb it**: build on its branch or
> re-implement its two changes here and note that in the PR so #37 can be closed.
> PR #35 (write-tool suite, DRAFT) also edits `src/client.ts`; expect a merge conflict in
> the request path, not a semantic one.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW–MEDIUM (request path of both clients; behavior only changes on 429)
- **Depends on**: nothing hard. Plan 005 (attribute-cache collapse) removes the worst
  offender's request volume and should land too, but this plan is what makes *any* burst
  survivable.
- **Category**: bug / reliability
- **Planned at**: `ab31e92`, 2026-09-01

## Why this matters

Verified live against the Supplyline account on 2026-09-01:

- Plytix enforces **two windows**, both read from the auth JWT's
  `user_claims.account.rate_limit`: `{limit: 50, window_size: 10}` and
  `{limit: 5000, window_size: 3600}`.
- Plytix sends **no `x-ratelimit-limit` / `-remaining` / `-reset` headers** on v1 or v2.
  Every response header was dumped for both `/api/v1/attributes/product/search` and
  `/api/v2/products/search`; only `x-request-id`, CORS and HSTS came back.
- The 429 **body** carries `{"message": "API rate limit exceeded", "limit": 50,
  "window_size": 10}` and, per supplyline-etl's live notes, sometimes a `ttl` in ms.

Consequence in this repo today ([client.ts:141](../src/client.ts:141),
[worker-client.ts:207](../src/worker-client.ts:207)): `parseRateLimitHeaders` always returns
`undefined`, so `backoffOnRateLimit` returns immediately, so a 429 is retried **instantly,
once**, straight into the same blown window. The rate-limit code is dead against the real API.
supplyline-etl has documented the user-visible symptom for months: "`attributes_get` /
`attributes_list` are currently unusable — self-trips the 50 req/10s limit every call".

The batch runners are only partly insulated: `runWithConcurrency` paces handler *starts* at
one per 250 ms (≈ 40/10 s), but a manifest row is **two** requests (guard GET + PATCH), so a
full-speed manifest run is ≈ 80 req/10 s — over the burst cap by itself, before any other
traffic on the account.

## Current state

| | stdio `client.ts` | worker `worker-client.ts` |
|---|---|---|
| 429 retries | 1 (PR #37: 3) | 1 |
| Backoff source | headers only (PR #37: 4–6 s jitter when headers absent) | headers only |
| Reads 429 body | no | no |
| Proactive pacing | none (cache build batches 10 in `Promise.allSettled`) | none |
| Knows the account's limits | no | no |
| Batch runner retry | 2×, 500 ms · 2ⁱ (`runner.ts:379`, `export.ts:503`) | same code |

Shared: `RateLimitInfo {limit, remaining, reset}` in `types.ts:63` models headers that don't
exist. `PlytixError.rateLimitInfo` is therefore always `undefined`.

## Commands you will need

```bash
npm test                      # vitest; client.test.ts has fake-timer 429 harness at :108
npm run typecheck
npm run build && npm run test:mcp
# live probe (read-only, 1 request) — confirm headers/body shape hasn't changed:
#   see docs/solutions/api-quirks/plytix-api.md "Rate limits" after Step 5
```

## Scope

**In**: both clients' `request()` retry path; a shared pacer; JWT limit extraction; batch
runner defaults; types; docs; tests.
**Out**: Plan 005's cache-collapse (separate PR); any change to the OAuth/KV rate limiter in
`worker.ts` (that is *our* limit on *our* endpoints, unrelated); MCP Tasks / async progress.

## Steps

### Step 1: Make 429 backoff actually wait (both clients)

Replace `backoffOnRateLimit(rateLimitInfo?)` in both clients with a shared helper — put it in
`src/rate-limit.ts` (new; both clients import it, no Node-only APIs):

```ts
export interface RateLimitHit { limit?: number; windowSize?: number; ttlMs?: number }
export function parseRateLimitBody(body: string): RateLimitHit | undefined
export function backoffDelayMs(attempt: number, hit?: RateLimitHit, rand = Math.random): number
```

- `parseRateLimitBody`: JSON-parse; pick `limit`, `window_size`, `ttl` (ms). Also accept
  `Retry-After` (seconds or HTTP-date) if a caller passes it — cheap, and Plytix may add it.
- `backoffDelayMs`: `max(ttlMs ?? 0, base · 2^attempt) + jitter`, base 1 000 ms, jitter
  0–1 000 ms, **cap 15 000 ms per attempt**. Attempt schedule ≈ 1–2 s, 2–3 s, 4–5 s, 8–9 s.
  Rationale: the burst bucket refills within ~10 s, so anything past ~10 s per attempt is
  waste; the hourly bucket can't be waited out inside one MCP call anyway (see STOP).
- `request()`: on 429, `await response.text()` **before** deciding to retry, parse it, sleep
  `backoffDelayMs(attempt, hit)`, retry. Default 429 retries → **3** (total 4 attempts,
  worst case ≈ 20 s). Keep the 401 retry at **1** — do not let the shared `retries` counter
  give 401 three refresh attempts (PR #37 does this by accident; harmless but sloppy).
- On final failure, throw `PlytixError` with `status: 429` and the parsed hit attached
  (Step 3 renames the field).

Keep `parseRateLimitHeaders` — if Plytix ever ships headers, prefer `reset` over the
schedule — but it must no longer gate whether we wait.

### Step 2: Client-level pacing (token bucket) in both clients

A single pacer in front of `fetch` in `request()`, in `src/rate-limit.ts`:

```ts
export class TokenBucket { constructor(limit: number, windowMs: number); take(): Promise<void> }
```

- Sliding window over the last `windowMs`; `take()` resolves immediately if under `limit`,
  otherwise waits until the oldest timestamp ages out. One instance per client.
- Default **40 per 10 000 ms** (80 % of the known burst cap — leaves room for the UI, the
  sync, Shopware's importer, all of which share the account bucket). Overridable via
  `PlytixClientConfig.rateLimit?: {limit, windowMs}`.
- Auth requests bypass the bucket (they go to `auth.plytix.com`, a different limiter).
- Stdio client: this replaces the ad-hoc `BATCH_SIZE = 10` + `Promise.allSettled` gap in
  `doBuildAttributeCache` as the *safety* mechanism; leave the batching in place for now
  (Plan 005 deletes it).
- Worker client: `TokenBucket` is per-isolate, so it is per-request-ish. That's fine — it
  still prevents a single MCP call from self-tripping; cross-isolate fairness is what Step 1
  is for.

### Step 3: Learn the real limits from the JWT

Both clients already hold the token string. On successful auth, decode the payload
(`atob` is available in Node 18+ and Workers; `worker.ts:198` already does this) and read
`user_claims.account.rate_limit: Array<{limit, window_size}>`.

- Pick the entry with the **smallest** `window_size` as the bucket's configuration, at 80 %.
  Log the full list once at `debug` level (stdio: `console.error`; worker: nothing —
  no logger there yet).
- If absent / malformed → keep the 40/10 s default. Never throw on a decode problem.
- Expose it: `client.getRateLimits(): Array<{limit, windowSeconds}> | undefined` so a future
  `account_info`-style tool can surface "your account allows 50/10 s, 5 000/h" without a doc.
- Types: replace `RateLimitInfo` with
  `RateLimitWindow {limit: number; windowSeconds: number}` and
  `RateLimitHit` (Step 1); rename `PlytixError.rateLimitInfo` → `rateLimit?: RateLimitHit`.
  `grep -rn rateLimitInfo src` — the only consumers are the two clients.

### Step 4: Batch runner alignment

- `runner.ts` / `export.ts`: `isTransientError` should treat a **429 that already exhausted
  the client's retries** as transient still (it is — nothing landed), but the row-level retry
  should sleep `backoffDelayMs(attempt, error.rateLimit)` instead of the flat `500 · 2ⁱ`,
  and use **3** retries, not 2. Import from `src/rate-limit.ts`.
- `DEFAULT_BATCH_REQUEST_DELAY_MS` 250 → **500** and note in the constant's comment that a
  manifest row is two requests. With the Step 2 bucket this is belt-and-braces, but the
  runner delay is what keeps the *guard read* and the *PATCH* of different rows from
  interleaving into a burst.
- Failure text: a 429 that survives all retries must surface as
  `stage: 'patch'` / `stage: 'read'` with `errors[0].msg` starting `"429 rate limited after N
  attempts"` — **not** as `stage: 'conflict'`. supplyline-etl's runbooks currently tell
  operators that `conflict` 429s are transient; make that true by never producing them.
  Check `checkRowGuard` (`runner.ts:~240–265`): if the guard GET throws a 429 today it is
  reported as `conflict`. Catch and rethrow as a read-stage failure.

### Step 5: Docs

- `docs/solutions/api-quirks/plytix-api.md`: add a `## Rate limits` section after §16 with
  the two windows, the no-headers fact, the 429 body shape, and "read
  `user_claims.account.rate_limit` from the JWT". Bump the header note's date.
- `CLAUDE.md` Architecture Notes: "Rate limit detection with backoff on 429 responses" →
  "Token-bucket pacing (40/10 s default, learned from JWT) + body-aware 429 backoff".
- Cross-repo: `supplyline-etl/docs/context/plytix-idiosyncrasies.md` line "The `plytix-mcp`
  batch tools do NOT pace" and "attributes_get/attributes_list are currently unusable" become
  stale when this ships — leave a one-line "fixed in plytix-mcp vX.Y.Z (Plan 008)" there.
  `shopware/docs/reference/plytix-api-field-guide.md` §10 has the three-client comparison
  table; update the plytix-mcp column.

## Test plan

`src/__tests__/rate-limit.test.ts` (new, pure functions — no fetch stubs):
1. `parseRateLimitBody` — Plytix shape with and without `ttl`; garbage → `undefined`.
2. `backoffDelayMs` — monotone in `attempt`, honors `ttlMs` as a floor, respects cap, jitter
   bounded (inject `rand`).
3. `TokenBucket` — with fake timers: 40 immediate `take()`s, the 41st waits until the first
   ages out; window slides, not resets.

`src/__tests__/client.test.ts` (extend; same for a new `worker-client.test.ts` or a shared
parametrised suite — both clients must be covered):
4. **Header-less 429 → waits → retries → succeeds.** This is the regression test for the
   dead code: assert the second fetch does not happen before the fake clock advances ≥ 1 s.
5. Four 429s in a row → throws `PlytixError{status: 429, rateLimit: {limit: 50, …}}`, exactly
   4 fetches (+1 auth).
6. 429 with a `ttl: 3000` body → first retry waits ≥ 3 s.
7. 401 still refreshes exactly once, unaffected by the 429 retry count.
8. JWT with `rate_limit` → `getRateLimits()` returns both windows; bucket configured from the
   10 s one. JWT without → default 40/10 s; no throw.
9. Existing test at `client.test.ts:108` (header-driven backoff) keeps passing.

`batch-update.test.ts`: 10. a guard GET that 429s produces a `read`-stage failure, not
`conflict`. 11. row retry sleeps grow across attempts.

## Done criteria

- [ ] `npm test` green; `npm run typecheck` green; `npm run test:mcp` green.
- [ ] `grep -rn "rateLimitInfo" src` → 0 hits.
- [ ] Live (read-only, opt-in, needs creds): cold `attributes_list` on the Supplyline account
      (≈ 215 attributes) completes with **zero** lost attributes and no
      "Attribute cache build failed". Record wall time in the PR.
- [ ] Live: a 25-row `products_batch_update` dry-run (dry-run still does the guard reads)
      produces no 429 failures.
- [ ] Docs in Step 5 updated; `plans/README.md` row set to DONE with PR number.
- [ ] PR #37 either merged first (and this diff is on top of it) or closed with a comment
      pointing here.

## STOP conditions

- The live probe shows Plytix **has started sending `x-ratelimit-*` headers**, or the 429
  body shape has changed → stop, capture the new shape in the plan, then continue with
  `parseRateLimitBody` adjusted. Don't guess.
- The JWT `user_claims.account.rate_limit` is missing on the account under test → the
  self-configuration step is dead weight; ship Steps 1–2 and 4–5 with the static default and
  drop Step 3's decode (keep the config override).
- You find yourself wanting to wait out the **hourly** window inside a tool call → don't. An
  MCP call that sleeps minutes will hit the client's timeout and look like a hang. Fail fast
  with a clear "hourly quota exhausted, retry after ~N min" and let the operator re-push.
- PR #35 has merged and moved `request()` into a shared core (`src/core/…`, Plan 004 shape)
  → the plan's file paths are wrong but the steps are the same; re-locate and continue.

## Maintenance notes

- The 40/10 s default is a **share** of one account-wide bucket, not the whole thing. If a
  second heavy consumer appears (a nightly Shopware import running while an agent batch
  writes), lower the default or make the two coordinate — this repo can't see the other
  caller's traffic.
- When Plan 005 lands, the attribute cache goes from ~215 requests to ~3; the bucket then
  mostly protects batch tools and agent loops.
- Stdio and worker clients are still two copies of this logic (Plan 004 unifies them). Keep
  `src/rate-limit.ts` free of Node-only imports so it stays shareable.

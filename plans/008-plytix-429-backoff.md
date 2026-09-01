# Plan 008: Real 429 handling — body-aware backoff, client-level pacing, JWT-derived limits

> **Executor instructions**: Follow step by step; verify each step; on any STOP condition,
> stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git fetch origin && git log --oneline origin/main -3`.
> PR #37 (`fix: actually wait on 429s during attribute cache build`) **merged 2026-09-01 as
> `81da7dd`** — it gave the stdio client a fixed 4–6 s jittered wait when headers are absent
> and raised `retries` to 3. This plan replaces that stopgap with the real thing on both
> clients; Step 1 deletes its `backoffOnRateLimit` body rather than layering on it.
> PR #35 (write-tool suite, DRAFT) also edits `src/client.ts`; expect a textual merge conflict
> in the request path, not a semantic one.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW–MEDIUM (request path of both clients; behavior only changes on 429/5xx)
- **Depends on**: nothing hard. Plan 005 (attribute-cache collapse) removes the worst
  offender's request volume and should land too, but this plan is what makes *any* burst
  survivable.
- **Category**: bug / reliability
- **Planned at**: `ab31e92`, 2026-09-01. Revised same day after reviewing #37 and the
  Shopware (`DumkaSyncPlytix/PlytixApiService.php`) and supplyline-sync (`src/lib/plytix.ts`)
  clients — see "Lessons folded in".

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

Consequence in this repo before #37 ([client.ts:141](../src/client.ts:141),
[worker-client.ts:207](../src/worker-client.ts:207)): `parseRateLimitHeaders` always returned
`undefined`, so `backoffOnRateLimit` returned immediately, so a 429 was retried **instantly,
once**, straight into the same blown window. #37 fixed the stdio symptom with a flat wait; the
worker client is still dead code, nothing reads the body, and nothing paces. supplyline-etl has
documented the user-visible symptom for months: "`attributes_get` / `attributes_list` are
currently unusable — self-trips the 50 req/10s limit every call".

The batch runners are only partly insulated: `runWithConcurrency` paces handler *starts* at
one per 250 ms (≈ 40/10 s), but a manifest row is **two** requests (guard GET + PATCH), so a
full-speed manifest run is ≈ 80 req/10 s — over the burst cap by itself, before any other
traffic on the account.

## Lessons folded in (from the other two clients + adversarial pass)

From Sasha's `PlytixApiService.php` — the most complete of our three clients:
- **L1** Honor `Retry-After` (numeric seconds *or* HTTP-date) if it ever appears.
- **L2** Parse the 429 body two ways: free-text `retry after N milliseconds|seconds` and
  JSON `ttl` (ms). Take the **max** of server hint and our schedule, never the min.
- **L3** If the resulting delay exceeds the cap, **abort immediately** with the server's
  suggested wait in the error — don't sleep the cap and then fail anyway.
- **L4** Log every retry and every abort with structured context (`attempt`, `status`,
  `endpoint`, `delayMs`, `reason`). We currently log nothing on 429.
- **L5** Retry 5xx too — but see L6 for the boundary.
- (follow-up, not this plan) 428 "too large to sort" → drop `order` and continue unsorted.

From supplyline-sync `plytix.ts`:
- **L6** 429 is retryable for **every** request (Plytix did not process it). 5xx is retryable
  **only for non-mutating** requests — `GET`, and `POST` whose path ends in `/search`. A 502
  on a PATCH can mean "applied, response lost"; replaying it re-applies a stale delta.
- **L7** The auth mint itself can 429/5xx; retry it with the same schedule. One flaky auth
  call currently kills a whole batch.
- (follow-up) `redirect: 'manual'` so a stray trailing slash fails loudly instead of 401ing.

Adversarial findings on the first draft of this plan:
- **A1** A single 429 must **pause the whole client**, not just the caller that saw it —
  otherwise the other N−1 workers keep firing into the blown window (the stampede #37's
  jitter was trying to soften). The bucket gets a `penalize(untilMs)`.
- **A2** Restructure `request()` from recursion-with-one-counter into a loop with **separate**
  counters for 401 (max 1) and 429/5xx (max 3). #37 accidentally gave 401 three refreshes.
- **A3** Read the error body **once**; parse and attach it; don't consume the stream twice.
- **A4** Bucket must be **FIFO** (promise chain), not "whoever polls first", or a hot caller
  starves the others.
- **A5** JWT payload is **base64url**; `atob` wants standard base64 — translate and pad
  (`worker.ts:198` already does this correctly; reuse the pattern).
- **A6** stdio: **stdout is the MCP transport**. Any log line goes to `console.error`
  (stderr). Worker: `console.warn` is fine (wrangler tail).
- **A7** Total backoff budget must stay under a typical MCP client timeout (~60 s). Per-attempt
  cap 15 s, 3 retries → worst case ≈ 20 s waiting + 4 × 15 s fetch timeout. Do **not** wait
  out the hourly window inside a tool call (see STOP).
- **A8** Auth requests bypass the bucket (different host, different limiter) but respect
  `penalize` — no point minting a token into a blown window.
- **A9** Tests inject `rand` and use fake timers; no real sleeps, no `Math.random` in asserts.

## Current state (after #37)

| | stdio `client.ts` | worker `worker-client.ts` |
|---|---|---|
| 429 retries | 3 (flat 4–6 s jitter when headers absent) | 1 (headers only → effectively **0**) |
| Reads 429 body / Retry-After | no | no |
| 5xx retry | no | no |
| 401 refresh | up to 3 (shared counter) | 1 |
| Auth mint retry | no | no |
| Proactive pacing | none (cache build batches 10 in `Promise.allSettled`) | none |
| Knows the account's limits | no | no |
| Retry logging | none | none |
| Batch runner retry | 2×, 500 ms · 2ⁱ (`runner.ts:379`, `export.ts:503`) | same code |

Shared: `RateLimitInfo {limit, remaining, reset}` in `types.ts:63` models headers that don't
exist. `PlytixError.rateLimitInfo` is therefore always `undefined`.

## Commands you will need

```bash
npm test                      # vitest; client.test.ts has a fake-timer 429 harness at :108
npm run typecheck             # stdio tsconfig (lib DOM, types node)
npx tsc -p tsconfig.worker.json   # worker tsconfig (lib WebWorker) — shared module must pass both
npm run build && npm run test:mcp
```

## Scope

**In**: both clients' `request()` + auth retry path; a shared pacer; JWT limit extraction;
batch runner defaults and failure staging; types; docs; tests.
**Out**: Plan 005's cache-collapse (separate PR); the OAuth/KV rate limiter in `worker.ts`
(that is *our* limit on *our* endpoints); 428 sort fallback; `redirect: 'manual'`; MCP Tasks.

## Steps

### Step 1: `src/rate-limit.ts` — pure, shared, no Node-only imports

```ts
export interface RateLimitWindow { limit: number; windowSeconds: number }
export interface RateLimitHit { limit?: number; windowSeconds?: number; retryAfterMs?: number }

export function parseRetryAfterHeader(value: string | null, nowMs?: number): number | undefined  // L1
export function parseRateLimitBody(body: string): RateLimitHit | undefined                       // L2
export function backoffDelayMs(attempt: number, hit?: RateLimitHit, rand?: () => number): number | null  // L3
export function decodeJwtRateLimits(jwt: string): RateLimitWindow[] | undefined                  // A5
export function isRetryableMutation(method: string, path: string): boolean                       // L6

export class TokenBucket {                                                                       // A1 A4 A8
  constructor(limit: number, windowMs: number, now?: () => number)
  take(): Promise<void>            // FIFO; resolves when a slot is free and no penalty is active
  penalize(untilMs: number): void  // called on any 429; every waiter (and new takers) hold until then
  reconfigure(limit: number, windowMs: number): void  // Step 3 calls this after decoding the JWT
}
```

- `backoffDelayMs`: `max(retryAfterMs ?? 0, 1000 · 2^attempt) + rand() · 1000`; **returns
  `null` when that exceeds 15 000 ms** (L3). Schedule ≈ 1–2 s, 2–3 s, 4–5 s, 8–9 s.
- `parseRateLimitBody`: JSON → `limit`, `window_size`, `ttl` (ms → `retryAfterMs`); else regex
  `retry after (\d+) (milliseconds?|seconds?)`; else `undefined`.
- `decodeJwtRateLimits`: split on `.`, base64url→base64 + pad, `atob`, JSON, read
  `user_claims.account.rate_limit[]` → `{limit, windowSeconds: window_size}`; any failure →
  `undefined`, never throws.

### Step 2: Wire it into both clients (identical shape)

- One `TokenBucket` per client instance, default **40 / 10 000 ms** (80 % of the known cap —
  leaves headroom for the UI, sync, and Shopware's importer, which share the account bucket).
  Config override: `PlytixClientConfig.rateLimit?: {limit: number; windowMs: number}` (stdio
  also reads `PLYTIX_RATE_LIMIT="40/10"` if set — keep it simple, `limit/seconds`).
- `request()` becomes a loop (A2):
  ```
  for attempt in 0..:
    await bucket.take()
    token = await getToken()
    res = await fetch(...)
    401 && authRetries < 1      → clear token, authRetries++, continue
    429                          → body = await res.text() (A3); hit = parse(body) + Retry-After;
                                   delay = backoffDelayMs(rateRetries, hit)
                                   if delay === null || rateRetries >= 3 → throw PlytixError(429, body, hit)
                                   bucket.penalize(now + delay) (A1); log (L4, A6); sleep; rateRetries++; continue
    5xx && !isMutation && rateRetries < 3 → same schedule without penalize (L5, L6)
    204 → {data: []}; !ok → throw; ok → json
  ```
- Auth mint (L7, A8): same retry schedule on 429/5xx (max 3), honors `penalize`, does **not**
  `take()` from the bucket.
- Delete `parseRateLimitHeaders`/`backoffOnRateLimit`; keep a one-line `Retry-After` read via
  `parseRetryAfterHeader` (L1).
- Logging (L4, A6): stdio `console.error(JSON.stringify({event:'plytix.retry', …}))`; worker
  `console.warn(...)`. Events: `plytix.retry` `{attempt, status, endpoint, delayMs}` and
  `plytix.retry_aborted` `{attempt, status, endpoint, reason: 'delay_exceeds_cap'|'retries_exhausted', suggestedWaitMs}`.
- Stdio `doBuildAttributeCache`: leave the `BATCH_SIZE = 10` loop (Plan 005 deletes it); the
  bucket is now the safety mechanism.

### Step 3: Learn the real limits from the JWT

Right after a successful mint in both clients: `decodeJwtRateLimits(token)`; pick the entry
with the **smallest** `windowSeconds`; `bucket.reconfigure(floor(limit · 0.8), windowSeconds · 1000)`
**unless** the user passed an explicit `rateLimit` config (explicit wins). Store the full list;
expose `getRateLimits(): RateLimitWindow[] | undefined` so a future `account_info` tool can
say "50/10 s, 5 000/h" without a doc. Absent/malformed → keep default, never throw.

Types: replace `RateLimitInfo` with `RateLimitWindow` + `RateLimitHit`; rename
`PlytixError.rateLimitInfo` → `rateLimit?: RateLimitHit`. `grep -rn rateLimitInfo src` — the
only consumers are the two clients.

### Step 4: Batch runner alignment

- `runner.ts` / `export.ts`: row/read retry sleeps use `backoffDelayMs(attempt, error.rateLimit)`
  (fall back to the schedule when `null`), **3** retries not 2, import from `../rate-limit.js`.
  `isTransientError` unchanged (429 or ≥ 500) — by the time the runner sees a 429 the client
  has already spent its budget; the runner's retry is the *second* line, spaced further apart.
- `DEFAULT_BATCH_REQUEST_DELAY_MS` 250 → **500**, comment: "a manifest row is two requests".
- Failure staging: a guard GET that **throws** (429, 5xx, timeout) must not be reported as
  `stage: 'conflict'` — that stage means "live value drifted" and supplyline-etl's runbooks
  tell operators to treat conflict-429s as transient. Add `'read'` to `BatchUpdateFailureStage`
  (check `types.ts:~140`; export already has a read-ish stage — reuse its name if one exists)
  and use it in `checkRowGuard`'s catch. "No product returned" stays `conflict`.
- `errors[0].msg` for an exhausted 429 must start `429 rate limited after N attempts` so it is
  greppable in manifests' failure output.

### Step 5: Docs

- `docs/solutions/api-quirks/plytix-api.md`: `## Rate limits` section (two windows, no
  headers, 429 body shape, JWT field, our 80 % default). Bump the header note's date.
- `CLAUDE.md` Architecture Notes: "Rate limit detection with backoff on 429 responses" →
  "Token-bucket pacing (40/10 s default, learned from the auth JWT) + body-aware 429/5xx
  backoff; stdio logs retries to stderr as JSON". README line 14 likewise.
- `docs/features/batch-update/SPEC.md:237,283`: add `"read"` to the stage union; note that
  429s never surface as `conflict`.
- `CHANGELOG.md`: `## [0.3.4]` — Fixed / Changed entries; `package.json` version 0.3.4.
- Cross-repo (after merge, direct-to-main docs): `supplyline-etl/docs/context/plytix-idiosyncrasies.md`
  lines "The `plytix-mcp` batch tools do NOT pace" and "attributes_get/attributes_list are
  currently unusable" → append "fixed in plytix-mcp 0.3.4 (Plan 008)".
  `shopware/docs/reference/plytix-api-field-guide.md` §10 → update the plytix-mcp column.

## Test plan

`src/__tests__/rate-limit.test.ts` (new, pure — no fetch stubs):
1. `parseRateLimitBody`: Plytix JSON with/without `ttl`; text `retry after 1500 milliseconds`;
   `retry after 2 seconds`; garbage → `undefined`.
2. `parseRetryAfterHeader`: `"3"` → 3000; HTTP-date 5 s ahead → ≈ 5000; junk → `undefined`.
3. `backoffDelayMs`: monotone in `attempt` with `rand = () => 0`; `retryAfterMs` acts as a
   floor; `retryAfterMs: 20000` → `null`; attempt 4 (16 s) → `null`.
4. `decodeJwtRateLimits`: real-shaped payload (base64url, includes `-`/`_` chars) → both windows;
   no `rate_limit` → `undefined`; not a JWT → `undefined`.
5. `isRetryableMutation`: `GET /x` false, `POST /api/v2/products/search` false,
   `POST /api/v2/products` true, `PATCH …` true.
6. `TokenBucket` (fake timers): 40 immediate `take()`s, 41st resolves only after the first
   ages out; **sliding** not resetting; `penalize(now+5000)` holds a fresh `take()` 5 s;
   FIFO order preserved under contention; `reconfigure` to a smaller limit takes effect on the
   next `take()`.

`src/__tests__/client.test.ts` (extend) **and** `src/__tests__/worker-client.test.ts` (new —
the worker client has no request-path tests today; mirror the harness, stub `crypto.subtle`
is not needed since Node 24 has it):
7. **Header-less 429 → waits → retries → succeeds.** Regression test for the dead code:
   second fetch must not happen before the fake clock advances ≥ 1 s.
8. Four 429s → throws `PlytixError{status: 429, rateLimit: {limit: 50, windowSeconds: 10}}`,
   exactly 4 product fetches (+1 auth); a `plytix.retry_aborted` line was logged.
9. 429 body `ttl: 3000` → first retry waits ≥ 3 s. 429 with `Retry-After: 20` → **no** sleep,
   immediate throw with `suggestedWaitMs: 20000` in the message.
10. 401 refreshes exactly once even with 429 budget unspent; a second 401 throws.
11. 502 on `POST …/search` retries; 502 on `PATCH …/products/x` throws immediately.
12. Auth endpoint 429 once → retried → succeeds.
13. Concurrency: fire 3 requests, first returns 429 → the other two fetches are **not** issued
    until the penalty elapses (A1).
14. JWT with `rate_limit` → `getRateLimits()` returns both windows and the bucket is 40/10 s
    from the 50/10 s entry; JWT without → default; explicit `rateLimit` config wins over JWT.
15. Existing `:108` header-driven test: keep, but it now passes through `parseRetryAfterHeader`
    semantics — adjust the assertion to "waited ≥ 1 s" rather than the header math.

`batch-update.test.ts`: 16. guard GET throwing `PlytixError(429)` → `stage: 'read'`, not
`conflict`, `msg` starts `429 rate limited`. 17. row retry delays grow across attempts (spy on
`setTimeout`). `batch-export.test.ts`: 18. `getProduct` 429 ×3 then success → row succeeds.

## Done criteria

- [ ] `npm test`, `npm run typecheck`, `npx tsc -p tsconfig.worker.json`, `npm run test:mcp` all green.
- [ ] `grep -rn "rateLimitInfo\|backoffOnRateLimit\|parseRateLimitHeaders" src` → 0 hits.
- [ ] Live (read-only, opt-in, needs creds): cold `attributes_list` on the Supplyline account
      (≈ 215 attributes) completes with **zero** lost attributes and no
      "Attribute cache build failed". Record wall time in the PR.
- [ ] Live: a 25-row `products_batch_update` dry-run (guard reads only) → no 429 failures.
- [ ] Docs in Step 5 updated; `plans/README.md` row set to DONE with PR number.

## STOP conditions

- The live probe shows Plytix **has started sending `x-ratelimit-*` headers**, or the 429
  body shape has changed → stop, capture the new shape here, adjust `parseRateLimitBody`,
  continue. Don't guess.
- `user_claims.account.rate_limit` is missing on the account under test → ship with the static
  default; keep `decodeJwtRateLimits` (it's cheap and tested) but drop the reconfigure call.
- You want to wait out the **hourly** window inside a tool call → don't. Fail fast with
  "hourly quota exhausted, retry after ~N min"; the operator re-pushes.
- PR #35 has merged and moved `request()` into a shared core (Plan 004 shape) → paths are
  wrong, steps are the same; re-locate and continue.

## Maintenance notes

- 40/10 s is a **share** of one account-wide bucket. If a second heavy consumer appears (a
  nightly Shopware import running while an agent batch writes), lower the default or make
  them coordinate — this repo can't see the other caller's traffic.
- When Plan 005 lands, the attribute cache goes from ~215 requests to ~3; the bucket then
  mostly protects batch tools and agent loops.
- Stdio and worker clients are still two copies of the request loop (Plan 004 unifies them).
  Keep `src/rate-limit.ts` free of Node-only imports so it compiles under both tsconfigs.
- Follow-ups worth their own small PRs: 428 sort fallback (Shopware has the reference
  implementation), `redirect: 'manual'`, an `account_info` tool that surfaces `getRateLimits()`.

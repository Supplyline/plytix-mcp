# Plan 003: Harden public OAuth endpoints against abuse (rate limits, consent context, registration validation, shorter token TTL)

> **Executor instructions**: Follow step by step; verify each step; on any STOP condition,
> stop and report. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 18ded4c..HEAD -- src/worker.ts src/__tests__/worker-oauth.test.ts wrangler.toml`
> On mismatch with "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (auth-path changes; existing OAuth tests guard regressions)
- **Depends on**: none (touches `src/worker.ts` like plan 001 — coordinate; apply after 001
  to avoid merge conflicts, or rebase)
- **Category**: security
- **Planned at**: commit `18ded4c`, 2026-06-10

## Why this matters

The worker exposes three unauthenticated OAuth endpoints. `POST /authorize` forwards
arbitrary submitted credentials to Plytix's auth endpoint — an unthrottled
credential-testing oracle whose abuse traffic egresses from Cloudflare IPs and can burn the
worker's reputation with Plytix. `POST /register` accepts unlimited unauthenticated KV
writes with unvalidated `redirect_uris`. The consent page never shows *which* client or
*where* the auth code will be sent, which matters in a dynamic-client-registration model
where anyone can register a client named anything. Access tokens (which wrap encrypted PIM
write credentials) live 30 days with no revocation endpoint.

The core flow is sound (exact-match redirect validation, S256-only PKCE, one-time codes,
AES-GCM credential encryption at rest) — this plan adds the missing abuse controls, not a
redesign. Rejected during vetting (do not add): CSRF tokens on /authorize (no ambient
authority to ride — the form requires credentials each submit).

## Current state

- `src/worker.ts:2476-2512` — `POST /register`: stores
  `redirect_uris: regBody.redirect_uris || []` with no validation (type or scheme);
  `client_name: regBody.client_name || ''` unbounded; no rate limit.
- `src/worker.ts:2573-2676` — `POST /authorize`: validates redirect_uri registration and
  PKCE, then `fetch(authUrl, …)` with the submitted credentials (line 2630). No rate limit.
- `src/worker.ts:2680-2778` — `POST /token`: code lookup, one-time-use delete, PKCE check
  `expectedChallenge !== codeData.code_challenge` (line 2748), then
  `const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days` (line 2759). No rate limit.
- `src/worker.ts:226-285` — `renderAuthorizePage(params)`: hidden fields + credential
  inputs; subtitle is the static string "An application is requesting access to your
  Plytix PIM data." — `clientId`/`redirectUri` are in hidden fields only; `client_name` is
  never looked up.
- `src/worker.ts:204-215` — `isRegisteredRedirectUri`: exact-string match against the
  registered array; `Array.isArray` guard already present.
- `src/worker.ts:22-32` — `Env` interface: `OAUTH_KV?: KVNamespace`,
  `OAUTH_TOKEN_SECRET?: string`.
- Tests: `src/__tests__/worker-oauth.test.ts` (419 lines) covers discovery, registration,
  authorize GET/POST, token exchange, PKCE failures — uses a mock KV and mocked fetch.
  Extend it; match its helper style.
- KV is eventually consistent across edge locations — the rate limiter is a coarse abuse
  brake, not an exact counter. That's acceptable and should be commented as such.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Worker typecheck | `npm run typecheck:worker` | exit 0 |
| Tests | `npm test` | all pass |

## Scope

**In scope**: `src/worker.ts`, `src/__tests__/worker-oauth.test.ts`, `docs/remote-setup.md`
(document new env var), `wrangler.toml` (comment only, if needed).

**Out of scope**: stdio surface entirely; the `/mcp` endpoint auth model (intentional:
public initialize/tools/list, authed tools/call); a `/revoke` endpoint (deferred — coarse
revocation already exists: rotate `OAUTH_TOKEN_SECRET` to invalidate every stored token's
encrypted creds, or rotate the Plytix credentials themselves; document this in
docs/remote-setup.md instead); refresh tokens.

## Steps

### Step 1: KV rate limiter

Add near the OAuth helpers (`src/worker.ts:128-225`):

```ts
async function rateLimit(kv: KVNamespace, scope: string, key: string, limit: number, windowSeconds: number): Promise<boolean>
```

Implementation: KV key `rl:${scope}:${key}`, value = JSON `{count, windowStart}`; reset
when `now - windowStart > windowSeconds*1000`; `expirationTtl: windowSeconds * 2`. Returns
`false` when over limit. Client key: `request.headers.get('CF-Connecting-IP') || 'unknown'`.
Comment the eventual-consistency caveat. On limit, respond 429 JSON
`{error: 'rate_limited'}` with `Retry-After: <windowSeconds>`.

Apply: `POST /authorize` 10/300s per IP; `POST /register` 10/3600s per IP; `POST /token`
30/300s per IP. Skip enforcement when `CF-Connecting-IP` is absent AND `OAUTH_KV` is the
test mock? No — enforce uniformly; tests set distinct IPs via headers.

**Verify**: `npm run typecheck:worker` → exit 0.

### Step 2: Registration validation

In `POST /register` (worker.ts:2484-2498), before storing:
- `redirect_uris` must be an array of 1–10 strings, each a parseable URL with scheme
  `https:`, or `http:` only when hostname is `localhost` or `127.0.0.1`. Custom schemes for
  native apps (e.g. `cursor://…`) are NOT currently needed — reject them; revisit if a
  client requires it (record in maintenance notes).
- `client_name`: string, trim, cap 100 chars (truncate, don't reject).
- On invalid: 400 `{error: 'invalid_client_metadata', error_description: …}`.

**Verify**: `npm run typecheck:worker` → exit 0.

### Step 3: Consent page context

`GET /authorize` (worker.ts:2516-2571) already loads the client record via
`isRegisteredRedirectUri` — refactor minimally to fetch the registration once
(`kv.get('client:'+clientId)`), validate redirect, and pass `clientName` and
`new URL(redirectUri).host` into `renderAuthorizePage`. In the page, replace the static
subtitle with: client name (escaped, fallback "An application"), and an info line "After
you approve, an access code will be sent to <redirect host>". Keep `escapeHtml` on every
interpolation (XSS — client_name is attacker-controlled).

**Verify**: `npm run typecheck:worker` → exit 0.

### Step 4: Token TTL + timing-safe compare

- TTL: `const TOKEN_TTL_SECONDS = parseTtl(env.OAUTH_TOKEN_TTL_SECONDS) ?? 60 * 60 * 24 * 7;`
  (7-day default, env-overridable; add `OAUTH_TOKEN_TTL_SECONDS?: string` to `Env`).
  Clamp to [3600, 60*60*24*30].
- PKCE compare (line 2748): replace `!==` with a constant-time string compare helper
  (length check + XOR accumulate over char codes). One-line hygiene, zero behavior change
  for valid inputs.

**Verify**: `npm run typecheck:worker` → exit 0.

### Step 5: Tests

Extend `src/__tests__/worker-oauth.test.ts`:
1. 11th `POST /authorize` from same IP within window → 429 with Retry-After; different IP → allowed
2. register with `redirect_uris: ['javascript:alert(1)']` → 400
3. register with `redirect_uris: 'https://x'` (non-array) → 400
4. register with `http://localhost:3000/cb` → 201
5. consent page HTML contains escaped client_name and redirect host
6. token response `expires_in` equals 7 days by default
7. existing suites unchanged and green

**Verify**: `npm test` → all pass.

### Step 6: Docs

`docs/remote-setup.md`: document `OAUTH_TOKEN_TTL_SECONDS`, the rate limits, and the
emergency revocation procedure (rotate `OAUTH_TOKEN_SECRET` via
`wrangler secret put OAUTH_TOKEN_SECRET` → all outstanding tokens become undecryptable →
clients re-authorize).

**Verify**: `grep -n "OAUTH_TOKEN_TTL_SECONDS" docs/remote-setup.md` → present.

## Test plan

See Step 5; model on the existing `worker-oauth.test.ts` helpers (mock KV, request builder).

## Done criteria

- [ ] `npm run typecheck:worker` exits 0
- [ ] `npm test` exits 0 with the 6 new cases
- [ ] `grep -n "rateLimit(" src/worker.ts` shows enforcement at /authorize, /register, /token
- [ ] `grep -n "60 \* 60 \* 24 \* 30" src/worker.ts` no longer the active TTL default
- [ ] `git status`: only in-scope files modified
- [ ] `plans/README.md` row updated

## STOP conditions

- The OAuth section has drifted from the excerpts (especially if plan 001 landed first —
  re-locate line anchors before editing).
- An MCP client in real use registers with a custom scheme redirect (would be rejected by
  step 2) — report; don't silently allow.
- Rate limiting breaks the worker-oauth test suite in ways not fixed by setting distinct
  `CF-Connecting-IP` headers per test.

## Maintenance notes

- If Claude/MCP clients ever need custom-scheme redirects, extend step 2's allowlist
  deliberately (per-scheme, not wildcard).
- KV rate limiting is per-edge-location approximate; if real abuse is observed, move to
  Cloudflare WAF rate-limiting rules (zone-level, exact) and keep this as defense-in-depth.
- A proper RFC 7009 `/revoke` endpoint + refresh tokens remain deferred; revisit if tokens
  ever carry broader scopes.

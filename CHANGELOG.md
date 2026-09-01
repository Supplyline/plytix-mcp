# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.5] - 2026-09-01

### Changed
- Attribute cache builds from paginated search rows instead of one GET per attribute
  (Plan 005). Plytix returns `label`, `name`, `type_class`, `options`, `groups` and
  `description` directly on `POST /api/v1/attributes/product/search` when they are requested,
  so a 215-attribute account now costs **3 requests / ~4.6 s** instead of 216 requests / ~55 s
  — measured live. `options` for dropdown/multiselect arrive on the search rows, so
  `attributes_get_options` no longer needs a per-id fetch either.
- New `searchAttributeDetails()` on both clients returns fully populated rows;
  `searchAttributeIds()` is now a thin wrapper over it, and `getAttributeById()` is unchanged
  and still available for callers that need the GET-only fields.
- The cache's 20 % failure threshold now counts rows that arrive **without a label** (the key
  the cache is built on) rather than failed per-id fetches; the error message changed to
  `N/M attributes returned without a label`.
- Two fields are deliberately not cached: `created` (search never returns it) and
  `filter_type` (search and the per-id GET disagree — see
  `docs/solutions/api-quirks/plytix-api.md` §14). No tool surfaced either.

## [0.3.4] - 2026-09-01

### Fixed
- 429 handling was dead code against the real API: Plytix sends no `x-ratelimit-*` headers, so
  both clients retried a rate-limited request instantly (stdio: once; Worker: effectively never
  backed off). Both now share `src/rate-limit.ts`: a per-client token bucket (40 req / 10 s by
  default, re-tuned to 80 % of *every* window advertised in the auth JWT — burst and hourly),
  body-aware backoff (1–2 s, 2–3 s, 4–5 s; `ttl` / `Retry-After` as a floor; 3 retries = 4
  attempts), a shared penalty so one 429 parks every request admitted after it, and fail-fast
  when the server asks for a wait over 15 s. On the Worker the bucket is shared per credential
  pair per isolate, like the token cache, so concurrent requests for one account pace together.
- 5xx responses are retried for reads (`GET`, `POST …/search`) but never for mutations — in the
  clients and in the batch runners (a PATCH that 5xxs is not replayed).
- The auth mint itself is retried on 429/5xx.
- Batch update: a guard read that fails at the transport level is now `stage: "read"` instead
  of `stage: "conflict"`, so a 429 can no longer be mistaken for drift; the dry-run path gets
  the same row-level handling instead of rejecting the whole batch.

### Changed
- `PlytixClientConfig.rateLimit` / `WorkerClientConfig.rateLimit` and the stdio env override
  `PLYTIX_RATE_LIMIT="limit/seconds"` set explicit pacing (explicit wins over the JWT).
- `PlytixClient.getRateLimits()` / `WorkerPlytixClient.getRateLimits()` expose the account
  windows read from the JWT.
- `PlytixError.rateLimitInfo` (always `undefined`) is replaced by `rateLimit?: RateLimitHit`.
- Batch runners: default inter-request delay 250 → 500 ms (a guarded row is two requests);
  row-level retries use the shared schedule (3 retries).
- Retries are logged as JSON lines: stdio → stderr, Worker → `console.warn`.

## [0.3.3] - 2026-06-09

### Changed
- Batch update guards: an expected `null` in `expected_attributes` / `if_match` now matches a live
  value that is `null` **or absent** (nullish equivalence). JSON cannot express `undefined`, so
  `null` is the only way a manifest can assert "this attribute is currently empty" — required for
  fill-in-the-blanks (gap-fill) callers. A present empty string still does not match `null`.

## [0.3.2] - 2026-06-09

### Added
- Added `products_batch_export` for capped inline product snapshots by search, SKU, or
  product ID, available on stdio and the Worker.
- Added stdio-only `products_batch_export_to_file` for larger JSONL/NDJSON exports under
  `PLYTIX_MCP_EXPORT_DIR`, with canonical hashes, preview rows, path guardrails, and
  per-row failures.

### Changed
- Documented the batch-export contract and Worker parity exception for local filesystem
  exports.

## [0.3.1] - 2026-06-09

### Added
- Added per-item optimistic-concurrency guards for batch updates via
  `expected_attributes` and `if_match`, returning `stage: "conflict"` when live data
  drifts before PATCH.
- Added opt-in batch-update success rows with `return_successes` for exact caller ledgers.

### Fixed
- Guarded batch rows now read live product data immediately before PATCH and skip drifted
  rows instead of applying stale read-modify-write updates.

## [0.3.0] - 2026-06-09

### Added
- Added `products_batch_update` so agents can apply small product-update batches through
  the documented product PATCH path, with dry-run validation and per-row failure reporting.
- Added stdio-only `products_batch_update_manifest` so large local JSON manifests can run
  without sending manifest bytes through the model context.
- Added shared batch-update guardrails for SKU resolution, `sku`/`product_id` verification,
  duplicate detection, request pacing, retry handling, manifest hashing, and separate
  stdio/Worker payload caps.

### Changed
- Documented the batch-update implementation plan, REST evidence gate, and Worker parity
  exception for the stdio-only manifest tool.

### Fixed
- SKU resolution now pages through all search result pages before verification, so duplicate
  SKU matches cannot hide behind page 1 during batch updates.

## [0.2.2] - 2026-05-31

Follow-up fixes from post-merge code review. No breaking changes.

### Security
- The Worker request-body cap now measures UTF-8 byte length and checks `Content-Length`
  up front, instead of `String.length` (UTF-16 code units). A multi-byte JSON payload could
  previously exceed 256 KB on the wire while passing the character-count check.
- The token-cache key now derives from `JSON.stringify([apiKey, apiPassword])` instead of
  `` `${apiKey}:${apiPassword}` ``. The delimiter form was ambiguous — pairs like
  `("a:b","c")` and `("a","b:c")` hashed identically, which could let one credential pair
  reuse a token minted for another and undo the v0.2.1 cache-key hardening.

## [0.2.1] - 2026-05-31

Security hardening, bug fixes, and public-readiness cleanup. No breaking changes.

### Security
- Worker token cache is now keyed by a SHA-256 digest of the API key **and** password,
  not the key alone. A request with a correct key but a wrong or rotated password can no
  longer be handed a cached token without re-validation. Concurrent auth requests for the
  same credentials are de-duplicated to avoid a cold-isolate request burst.
- The remote Worker caps request bodies (256 KB) and JSON-RPC batch length (50), and
  includes an optional rate-limit hook (no-op unless a Cloudflare rate-limit binding is
  configured).
- CORS now requires `https` and an exact `claude.ai` host (parsed with `URL()`), replacing
  a permissive suffix match that also accepted plaintext and look-alike origins.
- Client-facing errors return a generic, status-based message; full upstream Plytix error
  detail is logged server-side only instead of being reflected to the caller.

### Fixed
- `products_set_attribute` / `products_clear_attribute` (stdio) now confirm the API returned
  the updated product before reporting success, and reject an empty-string value (use
  `products_clear_attribute` to remove a value).
- `products_find` with no criteria no longer auto-selects an arbitrary product; it returns
  an unselected result set while still allowing a catalog browse.
- A numeric identifier that detects as a GTIN now also runs an exact SKU search, so numeric
  SKUs are no longer missed (stdio and Worker).
- Removed an unreachable MNO identifier-detection branch and corrected the docstring.
- `variants_create` (Worker) reports an error when the API returns no variant instead of
  claiming success.
- `categories_link` confirms the link took effect before reporting success.
- Relationship quantity is validated as a non-negative number (stdio schema and Worker
  handlers).
- Filter shorthand (`[field, operator, value]` tuples) is normalized consistently across
  `products_search`, `assets_search`, and the stdio path.

### Changed
- `products_assign_family` now carries an explicit data-loss warning in its tool description
  (a family reassignment can drop attribute values not present in the target family).
- Bumped `@modelcontextprotocol/sdk` to 1.29.0, clearing all `npm audit` advisories.
- The CLI now supports `--help` and `--version`, ships a `#!/usr/bin/env node` shebang, and
  builds on `prepack` so the published binary works.
- Renamed the deployment-specific tool stub to `src/extensions/` (`registerCustomTools`) and
  removed remaining deployment-specific branding from docs and tests.

### Removed
- Dropped a tracked `.DS_Store` and internal planning docs from the repository; added
  `.claude/*.local.json` to `.gitignore`.

## [0.2.0] - 2025-01-16

- Smart product lookup with automatic identifier detection (ID, SKU, MPN, GTIN, label).
- Family and inheritance tracking with `overwritten_attributes` support.
- Attribute metadata and filter discovery tools.
- Cloudflare Worker deployment with a bring-your-own-key (BYOK) model.

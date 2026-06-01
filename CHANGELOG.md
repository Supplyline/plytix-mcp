# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

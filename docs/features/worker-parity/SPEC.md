# SPEC — Worker MCP Parity

> **Status:** Implemented

## Summary

The Cloudflare Worker MCP server now exposes the full API-backed tool surface.

- `stdio`: 49 tools
- `remote worker`: 45 tools
- intentional remote omissions: `identifier_detect`, `identifier_normalize`, `match_score`,
  `products_batch_update_manifest`

The three identifier tools remain stdio-only because they are pure local utilities. Remote
clients should use `products_lookup`, which already incorporates the same identifier logic
for the practical lookup flow. `products_batch_update_manifest` is stdio-only because it
reads a user-local JSON file; the Worker has no caller filesystem access and exposes the
inline `products_batch_update` tool with lower caps instead.

## Current Parity Rules

1. Every API-backed tool added to `src/tools/*.ts` should also be added to `src/worker.ts`.
2. Shared stdio and worker tools should keep the same schema and response shape.
3. Pure local utilities may remain stdio-only if the omission is intentional and documented.
4. Public docs must be updated when tool counts or remote availability change.

## Intentional Stdio-Only Tools

| Tool | Reason |
|------|--------|
| `identifier_detect` | Pure utility for analyzing raw identifier format |
| `identifier_normalize` | Pure utility for string normalization |
| `match_score` | Pure utility for local identifier-to-product scoring |
| `products_batch_update_manifest` | Reads a local JSON manifest from the user's filesystem |

## Historical Note

The earlier worker parity gap around product writes, attribute metadata reads, category linking, and attribute validation has already been closed. This document now records the steady-state contract: remote mirrors stdio except for the local identifier helpers and the local-filesystem manifest batch tool above.

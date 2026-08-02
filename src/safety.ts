/**
 * Safety Gate for Destructive Operations
 *
 * Two-call protection for the *_delete tools:
 *
 *   1. Caller invokes the delete tool with `dry_run: true` and a target
 *      identifier. The gate stores a single-use, target-scoped token
 *      with a 5-minute TTL and returns it (along with the would-delete
 *      preview).
 *
 *   2. To actually execute the delete, the caller must invoke the same
 *      tool again with `confirm_token` equal to that token. The gate
 *      validates the token (target match, not expired, not consumed)
 *      and consumes it on success.
 *
 * Session-level cap: after MAX_DELETES_PER_SESSION successful deletes
 * the gate refuses further deletes until the MCP server restarts.
 *
 * Tokens are generated server-side and cannot be predicted by the
 * caller, which forces the visible intermediate step (dry-run output
 * in chat) before execution.
 */

import { randomBytes } from 'node:crypto';

interface PendingDelete {
  tool: string;
  target: string;
  preview: Record<string, unknown>;
  expires: number;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;
export const MAX_DELETES_PER_SESSION = 3;

const pending = new Map<string, PendingDelete>();
let sessionDeleteCount = 0;

function generateToken(): string {
  return randomBytes(16).toString('hex');
}

function gc(now: number) {
  for (const [token, entry] of pending.entries()) {
    if (entry.expires <= now) pending.delete(token);
  }
}

/**
 * Create a dry-run response. Stores a token + preview internally.
 */
export function makeDryRunResult(
  tool: string,
  target: string,
  preview: Record<string, unknown>
): {
  dry_run: true;
  would_delete: Record<string, unknown>;
  confirm_token: string;
  token_expires_in_minutes: number;
  next_step: string;
  session_deletes_remaining: number;
} {
  const now = Date.now();
  gc(now);
  const token = generateToken();
  pending.set(token, {
    tool,
    target,
    preview,
    expires: now + TOKEN_TTL_MS,
  });
  return {
    dry_run: true,
    would_delete: preview,
    confirm_token: token,
    token_expires_in_minutes: TOKEN_TTL_MS / 1000 / 60,
    next_step: `To execute, call ${tool} again with the SAME identifier and confirm_token="${token}". DO NOT call without first surfacing this preview to the user and receiving explicit confirmation.`,
    session_deletes_remaining: MAX_DELETES_PER_SESSION - sessionDeleteCount,
  };
}

/**
 * Validate and consume a confirm token. On success, returns ok=true and
 * the preview that was stored at dry-run time. On failure, returns a
 * structured error.
 */
export function consumeToken(
  tool: string,
  target: string,
  token: string | undefined
):
  | { ok: true; preview: Record<string, unknown> }
  | { ok: false; reason: string } {
  if (!token) {
    return {
      ok: false,
      reason: `confirm_token required. Call ${tool} with dry_run:true first to get a token, then call again with that token to execute. This two-step pattern prevents accidental deletion.`,
    };
  }
  const now = Date.now();
  gc(now);
  const entry = pending.get(token);
  if (!entry) {
    return {
      ok: false,
      reason: 'Invalid or already-used confirm_token. Tokens are single-use and expire after 5 minutes. Call with dry_run:true to get a fresh token.',
    };
  }
  if (entry.tool !== tool) {
    return {
      ok: false,
      reason: `Token belongs to ${entry.tool}, not ${tool}. Tokens are tool-specific.`,
    };
  }
  if (entry.target !== target) {
    return {
      ok: false,
      reason: `Token was issued for target "${entry.target}" but execution requested target "${target}". Tokens are target-specific to prevent replay against a different item.`,
    };
  }
  if (entry.expires <= now) {
    pending.delete(token);
    return {
      ok: false,
      reason: 'Token expired. Tokens are valid for 5 minutes. Re-run dry_run.',
    };
  }
  pending.delete(token);
  return { ok: true, preview: entry.preview };
}

/**
 * Check whether the session-level delete cap has been reached.
 */
export function sessionCapAvailable():
  | { ok: true; remaining: number }
  | { ok: false; reason: string } {
  if (sessionDeleteCount >= MAX_DELETES_PER_SESSION) {
    return {
      ok: false,
      reason: `Session delete cap reached (${MAX_DELETES_PER_SESSION}/${MAX_DELETES_PER_SESSION} deletes already performed this MCP process). Restart the MCP server to unlock further deletes, or use the Plytix UI for additional cleanup.`,
    };
  }
  return { ok: true, remaining: MAX_DELETES_PER_SESSION - sessionDeleteCount };
}

/**
 * Record that a delete succeeded.
 */
export function recordDelete(): number {
  sessionDeleteCount += 1;
  return sessionDeleteCount;
}

/**
 * Current session counter — for inclusion in success responses.
 */
export function getSessionDeleteCount(): number {
  return sessionDeleteCount;
}

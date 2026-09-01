import { afterEach, describe, expect, it, vi } from 'vitest';

type SafetyModule = typeof import('../safety.js');

/** Fresh module instance so the pending-token map and delete counter start empty. */
async function loadSafety(): Promise<SafetyModule> {
  vi.resetModules();
  return import('../safety.js');
}

const TOOL = 'attributes_delete';
const OTHER_TOOL = 'families_delete';
const TARGET = 'attr_abc123';
const OTHER_TARGET = 'attr_def456';
const PREVIEW = { id: TARGET, name: 'Colour', type_class: 'DropdownAttribute' };

/** Issue a token, asserting the dry-run succeeded. */
function tokenFrom(result: ReturnType<SafetyModule['makeDryRunResult']>): string {
  if (!result.ok) throw new Error(`expected dry-run to succeed, got: ${result.reason}`);
  return result.result.confirm_token;
}

const originalMax = process.env.PLYTIX_MCP_MAX_DELETES;

afterEach(() => {
  if (originalMax === undefined) delete process.env.PLYTIX_MCP_MAX_DELETES;
  else process.env.PLYTIX_MCP_MAX_DELETES = originalMax;
  vi.useRealTimers();
});

describe('token issuance', () => {
  it('returns the preview, a token and the remaining budget', async () => {
    const safety = await loadSafety();
    const result = safety.makeDryRunResult(TOOL, TARGET, PREVIEW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.dry_run).toBe(true);
    expect(result.result.would_delete).toEqual(PREVIEW);
    expect(result.result.confirm_token).toMatch(/^[0-9a-f]{32}$/);
    expect(result.result.token_expires_in_minutes).toBe(5);
    expect(result.result.session_deletes_remaining).toBe(3);
  });

  it('issues a distinct token each time', async () => {
    const safety = await loadSafety();
    const first = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));
    const second = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    expect(first).not.toBe(second);
  });
});

describe('token consumption', () => {
  it('accepts a token once and rejects it thereafter', async () => {
    const safety = await loadSafety();
    const token = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    const first = safety.authorizeDelete(TOOL, TARGET, token);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.preview).toEqual(PREVIEW);

    const second = safety.authorizeDelete(TOOL, TARGET, token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/single-use|already-used/i);
  });

  it('rejects a token issued for a different tool', async () => {
    const safety = await loadSafety();
    const token = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    const result = safety.authorizeDelete(OTHER_TOOL, TARGET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(TOOL);
  });

  it('rejects a token issued for a different target', async () => {
    const safety = await loadSafety();
    const token = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    const result = safety.authorizeDelete(TOOL, OTHER_TARGET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(OTHER_TARGET);
  });

  it('does not consume the token when the tool or target is wrong', async () => {
    const safety = await loadSafety();
    const token = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    expect(safety.authorizeDelete(OTHER_TOOL, TARGET, token).ok).toBe(false);
    expect(safety.authorizeDelete(TOOL, OTHER_TARGET, token).ok).toBe(false);
    expect(safety.authorizeDelete(TOOL, TARGET, token).ok).toBe(true);
  });

  it('requires a token', async () => {
    const safety = await loadSafety();
    safety.makeDryRunResult(TOOL, TARGET, PREVIEW);

    const result = safety.authorizeDelete(TOOL, TARGET, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/confirm_token required/);
  });

  it('rejects an unknown token', async () => {
    const safety = await loadSafety();

    const result = safety.authorizeDelete(TOOL, TARGET, 'f'.repeat(32));
    expect(result.ok).toBe(false);
  });
});

describe('token expiry', () => {
  it('rejects a token once its 5-minute TTL has elapsed', async () => {
    vi.useFakeTimers();
    const safety = await loadSafety();
    const token = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const result = safety.authorizeDelete(TOOL, TARGET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
  });

  it('accepts a token just before expiry', async () => {
    vi.useFakeTimers();
    const safety = await loadSafety();
    const token = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));

    vi.advanceTimersByTime(5 * 60 * 1000 - 1000);

    expect(safety.authorizeDelete(TOOL, TARGET, token).ok).toBe(true);
  });
});

describe('session cap', () => {
  it('defaults to 3 deletes', async () => {
    delete process.env.PLYTIX_MCP_MAX_DELETES;
    const safety = await loadSafety();

    expect(safety.maxDeletesPerSession()).toBe(3);
    expect(safety.DEFAULT_MAX_DELETES_PER_SESSION).toBe(3);
  });

  it('blocks once the cap is reached', async () => {
    const safety = await loadSafety();

    for (let i = 0; i < 3; i += 1) {
      expect(safety.sessionCapAvailable().ok).toBe(true);
      safety.recordDelete();
    }

    const capped = safety.sessionCapAvailable();
    expect(capped.ok).toBe(false);
    expect(safety.getSessionDeleteCount()).toBe(3);
  });

  it('honours PLYTIX_MCP_MAX_DELETES', async () => {
    process.env.PLYTIX_MCP_MAX_DELETES = '10';
    const safety = await loadSafety();

    expect(safety.maxDeletesPerSession()).toBe(10);
    for (let i = 0; i < 10; i += 1) safety.recordDelete();
    expect(safety.sessionCapAvailable().ok).toBe(false);
  });

  it('treats 0 as "deletes disabled"', async () => {
    process.env.PLYTIX_MCP_MAX_DELETES = '0';
    const safety = await loadSafety();

    const cap = safety.sessionCapAvailable();
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.reason).toMatch(/disabled/i);
    expect(safety.makeDryRunResult(TOOL, TARGET, PREVIEW).ok).toBe(false);
  });

  it.each(['not-a-number', '-1', '2.5', ''])(
    'falls back to the default when the value is %o',
    async (value) => {
      process.env.PLYTIX_MCP_MAX_DELETES = value;
      const safety = await loadSafety();

      expect(safety.maxDeletesPerSession()).toBe(3);
    }
  );

  it('issues no token once the cap is reached', async () => {
    process.env.PLYTIX_MCP_MAX_DELETES = '1';
    const safety = await loadSafety();
    safety.recordDelete();

    const result = safety.makeDryRunResult(TOOL, TARGET, PREVIEW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cap reached/i);
  });

  it('does not consume a valid token when the cap blocks execution', async () => {
    process.env.PLYTIX_MCP_MAX_DELETES = '1';
    const safety = await loadSafety();

    // Two tokens issued while budget remains.
    const spent = tokenFrom(safety.makeDryRunResult(TOOL, TARGET, PREVIEW));
    const stranded = tokenFrom(safety.makeDryRunResult(TOOL, OTHER_TARGET, PREVIEW));

    expect(safety.authorizeDelete(TOOL, TARGET, spent).ok).toBe(true);
    safety.recordDelete();

    // At the cap: rejected for the cap, not for the token.
    const blocked = safety.authorizeDelete(TOOL, OTHER_TARGET, stranded);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/cap reached/i);

    // Raising the cap proves the token survived the rejection.
    process.env.PLYTIX_MCP_MAX_DELETES = '5';
    expect(safety.authorizeDelete(TOOL, OTHER_TARGET, stranded).ok).toBe(true);
  });
});

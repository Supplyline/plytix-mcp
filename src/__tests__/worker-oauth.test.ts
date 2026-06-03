import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../worker.js';

// ─────────────────────────────────────────────────────────────
// Test harness: in-memory KV + helpers
// ─────────────────────────────────────────────────────────────

interface PutCall {
  key: string;
  value: string;
  opts?: { expirationTtl?: number };
}

function makeKV() {
  const store = new Map<string, string>();
  const putCalls: PutCall[] = [];
  return {
    store,
    putCalls,
    async get(key: string, type?: 'json' | 'text') {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      putCalls.push({ key, value, opts });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const SECRET = 'unit-test-oauth-secret-0123456789abcdef';
const ORIGIN = 'https://mcp.example.com';
const REGISTERED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ATTACKER_REDIRECT = 'https://attacker.example.com/callback';
const API_KEY = 'PLYTIX_KEY_DISTINCTIVE_VALUE';
const API_PASSWORD = 'PLYTIX_PASS_DISTINCTIVE_VALUE';

function makeEnv(kv: ReturnType<typeof makeKV>, overrides: Record<string, unknown> = {}) {
  return {
    PLYTIX_API_BASE: 'https://pim.example.com',
    PLYTIX_AUTH_URL: 'https://auth.example.com/get-token',
    OAUTH_KV: kv,
    OAUTH_TOKEN_SECRET: SECRET,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(env: any, path: string, init?: RequestInit) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

// Mirror the worker's S256 derivation so happy-path verifiers match.
function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function s256(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function registerClient(env: any, redirectUris: string[]): Promise<string> {
  const res = await call(env, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'test-client' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

// Stub Plytix credential validation (and any downstream Plytix call) as success.
function stubPlytixOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ access_token: 'plytix-tok', expires_in: 900 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────
// redirect_uri allowlist (the HIGH finding)
// ─────────────────────────────────────────────────────────────

describe('OAuth redirect_uri allowlist', () => {
  it('GET /authorize rejects an unregistered redirect_uri before rendering the form', async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);

    const challenge = await s256('verifier-abc');
    const res = await call(
      env,
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
        ATTACKER_REDIRECT
      )}&code_challenge=${challenge}&code_challenge_method=S256`
    );

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('<form'); // never shows the credential form
    expect(JSON.parse(text).error).toBe('invalid_request');
  });

  it('GET /authorize renders the form for a registered redirect_uri', async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);

    const challenge = await s256('verifier-abc');
    const res = await call(
      env,
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
        REGISTERED_REDIRECT
      )}&code_challenge=${challenge}&code_challenge_method=S256`
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('<form');
  });

  it('POST /authorize rejects an unregistered redirect_uri WITHOUT redirecting to it', async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);
    const challenge = await s256('verifier-abc');

    const res = await call(
      env,
      '/authorize',
      form({
        client_id: clientId,
        redirect_uri: ATTACKER_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        api_key: API_KEY,
        api_password: API_PASSWORD,
      })
    );

    expect(res.status).toBe(400); // not a 302
    expect(res.headers.get('Location')).toBeNull();
    expect((await res.json()).error).toBe('invalid_request');
    // No code minted for the attacker.
    expect([...kv.store.keys()].some((k) => k.startsWith('code:'))).toBe(false);
  });

  it('POST /authorize rejects an unknown client_id', async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const challenge = await s256('verifier-abc');

    const res = await call(
      env,
      '/authorize',
      form({
        client_id: 'never-registered',
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        api_key: API_KEY,
        api_password: API_PASSWORD,
      })
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// S256 enforcement
// ─────────────────────────────────────────────────────────────

describe('OAuth PKCE S256 enforcement', () => {
  it('GET /authorize rejects a non-S256 code_challenge_method', async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);

    const res = await call(
      env,
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
        REGISTERED_REDIRECT
      )}&code_challenge=plainchallenge&code_challenge_method=plain`
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});

// ─────────────────────────────────────────────────────────────
// Full flow: encryption at rest, token TTL, PKCE verification
// ─────────────────────────────────────────────────────────────

describe('OAuth authorization-code flow (encryption + TTL + PKCE)', () => {
  async function authorizeAndGetCode(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any,
    clientId: string,
    challenge: string
  ): Promise<string> {
    const res = await call(
      env,
      '/authorize',
      form({
        client_id: clientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        api_key: API_KEY,
        api_password: API_PASSWORD,
      })
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).toBeTruthy();
    const url = new URL(location as string);
    expect(url.searchParams.get('state')).toBe('xyz');
    return url.searchParams.get('code') as string;
  }

  it('stores credentials encrypted (no plaintext) in the auth code and token records', async () => {
    stubPlytixOk();
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);
    const verifier = 'verifier-1234567890-abcdefghijklmnop';
    const challenge = await s256(verifier);

    const code = await authorizeAndGetCode(env, clientId, challenge);

    // Auth code record: encrypted blob present, no plaintext credentials.
    const codeRecord = kv.store.get(`code:${code}`) as string;
    expect(codeRecord).toContain('enc_creds');
    expect(codeRecord).not.toContain(API_KEY);
    expect(codeRecord).not.toContain(API_PASSWORD);

    // Exchange the code.
    const tokenRes = await call(
      env,
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REGISTERED_REDIRECT,
      })
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokenBody.token_type).toBe('bearer');
    expect(tokenBody.expires_in).toBe(60 * 60 * 24 * 30);

    // Token record: encrypted blob, no plaintext, and a bounded TTL.
    const tokenRecord = kv.store.get(`token:${tokenBody.access_token}`) as string;
    expect(tokenRecord).toContain('enc_creds');
    expect(tokenRecord).not.toContain(API_KEY);
    expect(tokenRecord).not.toContain(API_PASSWORD);
    const tokenPut = kv.putCalls.find((c) => c.key === `token:${tokenBody.access_token}`);
    expect(tokenPut?.opts?.expirationTtl).toBe(60 * 60 * 24 * 30);

    // Code is one-time use (deleted on redemption).
    expect(kv.store.has(`code:${code}`)).toBe(false);
  });

  it('rejects token exchange when the PKCE verifier is wrong', async () => {
    stubPlytixOk();
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);
    const challenge = await s256('the-real-verifier');
    const code = await authorizeAndGetCode(env, clientId, challenge);

    const tokenRes = await call(
      env,
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'WRONG-verifier',
        client_id: clientId,
        redirect_uri: REGISTERED_REDIRECT,
      })
    );

    expect(tokenRes.status).toBe(400);
    expect((await tokenRes.json()).error).toBe('invalid_grant');
  });

  it('rejects token exchange when redirect_uri does not match the code', async () => {
    stubPlytixOk();
    const kv = makeKV();
    const env = makeEnv(kv);
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);
    const verifier = 'verifier-aaa';
    const challenge = await s256(verifier);
    const code = await authorizeAndGetCode(env, clientId, challenge);

    const tokenRes = await call(
      env,
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: ATTACKER_REDIRECT,
      })
    );

    expect(tokenRes.status).toBe(400);
    expect((await tokenRes.json()).error).toBe('invalid_grant');
  });
});

// ─────────────────────────────────────────────────────────────
// MCP auth gate via OAuth bearer token
// ─────────────────────────────────────────────────────────────

describe('MCP auth gate with OAuth tokens', () => {
  async function mintToken(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any
  ): Promise<string> {
    const clientId = await registerClient(env, [REGISTERED_REDIRECT]);
    const verifier = 'verifier-mcp-test';
    const challenge = await s256(verifier);
    const authRes = await call(
      env,
      '/authorize',
      form({
        client_id: clientId,
        redirect_uri: REGISTERED_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        api_key: API_KEY,
        api_password: API_PASSWORD,
      })
    );
    const code = new URL(authRes.headers.get('Location') as string).searchParams.get('code') as string;
    const tokenRes = await call(
      env,
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REGISTERED_REDIRECT,
      })
    );
    return ((await tokenRes.json()) as { access_token: string }).access_token;
  }

  it('rejects an unknown OAuth bearer token on a non-public method', async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    const res = await call(env, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'products_get', params: {} }),
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it('accepts a valid OAuth bearer token (resolves encrypted creds, passes the auth gate)', async () => {
    stubPlytixOk();
    const kv = makeKV();
    const env = makeEnv(kv);
    const token = await mintToken(env);

    const res = await call(env, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });

    // The decrypted credentials let the request past the auth gate, so it must
    // NOT be the -32600 "Authentication required" 401.
    expect(res.status).not.toBe(401);
  });
});

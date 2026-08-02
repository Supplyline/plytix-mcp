import { describe, it, expect } from 'vitest';
import worker from '../worker.js';
import {
  ERROR_HEADER_MISMATCH,
  ERROR_INVALID_PARAMS,
  ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  LATEST_LEGACY_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  MODERN_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  clientExtensions,
  decodeHeaderValue,
  decorateModernResult,
  expectedNameHeader,
  isModernRequest,
  negotiateLegacyVersion,
  validateModernRequest,
} from '../protocol.js';

const ORIGIN = 'https://mcp.example.com';

function headersOf(record: Record<string, string>) {
  return new Headers(record);
}

/** A well-formed modern request body for `method`. */
function modernBody(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
        [META_CLIENT_CAPABILITIES]: {},
      },
    },
  };
}

/** The headers the transport requires a client to mirror for `body`. */
function modernHeaders(body: ReturnType<typeof modernBody>) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    'Mcp-Method': body.method,
  };
  const name = expectedNameHeader(body);
  if (name !== undefined) headers['Mcp-Name'] = name;
  return headers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENV = { PLYTIX_API_BASE: 'https://pim.example.com' } as any;

function post(body: unknown, headers: Record<string, string>) {
  return worker.fetch(
    new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) }),
    ENV
  );
}

describe('decodeHeaderValue', () => {
  it('returns plain ASCII values unchanged', () => {
    expect(decodeHeaderValue('products_lookup')).toBe('products_lookup');
  });

  it('decodes the base64 sentinel back to UTF-8', () => {
    // "Hello, 世界" per the spec's encoding examples.
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
  });

  it('round-trips a value that itself looks like the sentinel', () => {
    // Clients must encode plain-ASCII values matching the sentinel pattern to
    // avoid ambiguity. Note the standard-alphabet '/' — not URL-safe base64.
    expect(decodeHeaderValue('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')).toBe('=?base64?literal?=');
  });

  it('returns malformed sentinels verbatim so comparison fails instead of throwing', () => {
    expect(decodeHeaderValue('=?base64?not-valid-base64!!?=')).toBe(
      '=?base64?not-valid-base64!!?='
    );
  });
});

describe('era detection', () => {
  it('treats a request declaring the modern version in _meta as modern', () => {
    expect(isModernRequest(modernBody('tools/list'), headersOf({}))).toBe(true);
  });

  it('treats a bare legacy initialize as legacy', () => {
    const legacy = { jsonrpc: '2.0' as const, id: 1, method: 'initialize', params: {} };
    expect(isModernRequest(legacy, headersOf({}))).toBe(false);
  });

  it('does not treat a legacy MCP-Protocol-Version header as modern', () => {
    // 2025-06-18 and later legacy revisions also send this header; only the
    // modern value may flip the era.
    const legacy = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: {} };
    expect(isModernRequest(legacy, headersOf({ 'MCP-Protocol-Version': '2025-11-25' }))).toBe(
      false
    );
  });

  it('treats a modern header with no _meta as modern so it gets -32602, not legacy service', () => {
    const malformed = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: {} };
    expect(
      isModernRequest(malformed, headersOf({ 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION }))
    ).toBe(true);
  });

  it('treats a future revision as modern so it can renegotiate down', () => {
    // A client newer than us must reach the modern path to receive
    // -32022 with our supported list, not be silently served legacy.
    const future = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION]: '2027-01-01', [META_CLIENT_CAPABILITIES]: {} } },
    };
    expect(isModernRequest(future, headersOf({ 'MCP-Protocol-Version': '2027-01-01' }))).toBe(true);
    expect(
      isModernRequest(
        { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: {} },
        headersOf({ 'MCP-Protocol-Version': '2027-01-01' })
      )
    ).toBe(true);
  });

  it('treats a malformed protocolVersion value as modern-shaped, not legacy', () => {
    // Regression: era detection must key on presence of the key, not on it
    // holding a usable string. Reading a non-string as "absent" classified the
    // request legacy and served it a 200 instead of a 400.
    const malformed = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION]: 12345, [META_CLIENT_CAPABILITIES]: {} } },
    };
    expect(isModernRequest(malformed, headersOf({}))).toBe(true);
    expect(validateModernRequest(malformed, headersOf({}))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('treats a null protocolVersion value as modern-shaped', () => {
    const nulled = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION]: null, [META_CLIENT_CAPABILITIES]: {} } },
    };
    expect(isModernRequest(nulled, headersOf({}))).toBe(true);
  });

  it('treats _meta declaring a legacy version as modern-shaped', () => {
    // The key itself only exists in the modern revision, so its presence is
    // decisive regardless of the value it carries.
    const odd = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION]: '2025-11-25', [META_CLIENT_CAPABILITIES]: {} } },
    };
    expect(isModernRequest(odd, headersOf({}))).toBe(true);
  });
});

describe('validateModernRequest', () => {
  it('accepts a well-formed request', () => {
    const body = modernBody('tools/list');
    expect(validateModernRequest(body, headersOf(modernHeaders(body)))).toEqual({ ok: true });
  });

  it('accepts tools/call when Mcp-Name mirrors params.name', () => {
    const body = modernBody('tools/call', { name: 'products_lookup', arguments: {} });
    expect(validateModernRequest(body, headersOf(modernHeaders(body)))).toEqual({ ok: true });
  });

  it('accepts a base64-encoded Mcp-Name that decodes to params.name', () => {
    const body = modernBody('tools/call', { name: 'Hello, 世界', arguments: {} });
    const headers = { ...modernHeaders(body), 'Mcp-Name': '=?base64?SGVsbG8sIOS4lueVjA==?=' };
    expect(validateModernRequest(body, headersOf(headers))).toEqual({ ok: true });
  });

  it.each([
    ['MCP-Protocol-Version', { 'Mcp-Method': 'tools/list' }],
    ['Mcp-Method', { 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION }],
  ])('rejects a missing %s header with -32020', (_label, headers) => {
    const result = validateModernRequest(modernBody('tools/list'), headersOf(headers));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result).toMatchObject({ error: { code: ERROR_HEADER_MISMATCH } });
  });

  it('rejects a Mcp-Method header that disagrees with the body', () => {
    const body = modernBody('tools/list');
    const headers = { ...modernHeaders(body), 'Mcp-Method': 'tools/call' };
    const result = validateModernRequest(body, headersOf(headers));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { code: ERROR_HEADER_MISMATCH },
    });
  });

  it('rejects a Mcp-Name header that disagrees with the body', () => {
    const body = modernBody('tools/call', { name: 'products_lookup', arguments: {} });
    const headers = { ...modernHeaders(body), 'Mcp-Name': 'products_update' };
    const result = validateModernRequest(body, headersOf(headers));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { code: ERROR_HEADER_MISMATCH },
    });
  });

  it('requires Mcp-Name on tools/call', () => {
    const body = modernBody('tools/call', { name: 'products_lookup', arguments: {} });
    const headers = modernHeaders(body);
    delete headers['Mcp-Name'];
    expect(validateModernRequest(body, headersOf(headers))).toMatchObject({
      ok: false,
      error: { code: ERROR_HEADER_MISMATCH },
    });
  });

  it('requires Mcp-Name on tools/call even when the body omits params.name', () => {
    // Requirement follows the method. Deriving it from the body let a
    // malformed tools/call skip header validation and come back from the
    // dispatcher as an "unknown tool" instead.
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        arguments: {},
        _meta: {
          [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: {},
        },
      },
    };
    expect(expectedNameHeader(body)).toBeUndefined();
    expect(
      validateModernRequest(
        body,
        headersOf({
          'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
          'Mcp-Method': 'tools/call',
        })
      )
    ).toMatchObject({ ok: false, status: 400, error: { code: ERROR_HEADER_MISMATCH } });
  });

  it('rejects tools/call whose params.name is not a string', () => {
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: 42,
        _meta: {
          [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: {},
        },
      },
    };
    expect(
      validateModernRequest(
        body,
        headersOf({
          'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': '42',
        })
      )
    ).toMatchObject({ ok: false, status: 400, error: { code: ERROR_HEADER_MISMATCH } });
  });

  it('does not require Mcp-Name on methods that have no name to mirror', () => {
    const body = modernBody('tools/list');
    expect(expectedNameHeader(body)).toBeUndefined();
    expect(validateModernRequest(body, headersOf(modernHeaders(body)))).toEqual({ ok: true });
  });

  it('rejects a header/body protocol version mismatch', () => {
    const body = modernBody('tools/list');
    const headers = { ...modernHeaders(body), 'MCP-Protocol-Version': '2025-11-25' };
    expect(validateModernRequest(body, headersOf(headers))).toMatchObject({
      ok: false,
      error: { code: ERROR_HEADER_MISMATCH },
    });
  });

  it('rejects an unsupported version with -32022 and lists what it supports', () => {
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: {
        _meta: { [META_PROTOCOL_VERSION]: '1900-01-01', [META_CLIENT_CAPABILITIES]: {} },
      },
    };
    const result = validateModernRequest(
      body,
      headersOf({ 'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'tools/list' })
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: {
        code: ERROR_UNSUPPORTED_PROTOCOL_VERSION,
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: '1900-01-01' },
      },
    });
  });

  it('rejects a missing _meta protocolVersion with -32602', () => {
    const body = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: {} };
    const result = validateModernRequest(
      body,
      headersOf({
        'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
      })
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { code: ERROR_INVALID_PARAMS },
    });
  });

  it('rejects modern framing that names a legacy version', () => {
    // Self-contradictory: the handshake era has no `_meta`. Accepting it would
    // apply 2026 semantics and stamp a response version never requested.
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: {
        _meta: { [META_PROTOCOL_VERSION]: '2025-11-25', [META_CLIENT_CAPABILITIES]: {} },
      },
    };
    const result = validateModernRequest(
      body,
      headersOf({ 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' })
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { code: ERROR_UNSUPPORTED_PROTOCOL_VERSION, data: { requested: '2025-11-25' } },
    });
    // Legacy revisions stay advertised — they remain reachable via initialize.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
  });

  it('rejects array-valued clientCapabilities with -32602', () => {
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: [],
        },
      },
    };
    expect(
      validateModernRequest(
        body,
        headersOf({
          'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
          'Mcp-Method': 'tools/list',
        })
      )
    ).toMatchObject({ ok: false, status: 400, error: { code: ERROR_INVALID_PARAMS } });
  });

  it('rejects a missing _meta clientCapabilities with -32602', () => {
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: { _meta: { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION } },
    };
    const result = validateModernRequest(
      body,
      headersOf({
        'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
      })
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { code: ERROR_INVALID_PARAMS },
    });
  });
});

describe('clientExtensions', () => {
  it('reads negotiated extensions from client capabilities', () => {
    const body = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
          [META_CLIENT_CAPABILITIES]: {
            extensions: { 'io.modelcontextprotocol/tasks': {} },
          },
        },
      },
    };
    expect(clientExtensions(body)).toEqual({ 'io.modelcontextprotocol/tasks': {} });
  });

  it('returns an empty map when none are declared', () => {
    expect(clientExtensions(modernBody('tools/list'))).toEqual({});
  });
});

describe('decorateModernResult', () => {
  const info = { name: 'plytix-mcp', version: '9.9.9' };

  it('stamps resultType and serverInfo', () => {
    expect(decorateModernResult({ tools: [] }, info)).toEqual({
      resultType: 'complete',
      tools: [],
      _meta: { [META_SERVER_INFO]: info },
    });
  });

  it('preserves an existing _meta and an explicit resultType', () => {
    const decorated = decorateModernResult(
      { resultType: 'task', taskId: 't1', _meta: { keep: true } },
      info
    ) as Record<string, unknown>;
    expect(decorated.resultType).toBe('task');
    expect(decorated._meta).toEqual({ keep: true, [META_SERVER_INFO]: info });
  });

  it('leaves non-object results alone', () => {
    expect(decorateModernResult(null, info)).toBeNull();
  });
});

describe('negotiateLegacyVersion', () => {
  it('echoes a legacy version we support', () => {
    expect(negotiateLegacyVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateLegacyVersion('2024-11-05')).toBe('2024-11-05');
  });

  it('falls back to the newest legacy version for anything unknown', () => {
    expect(negotiateLegacyVersion('1900-01-01')).toBe(LATEST_LEGACY_PROTOCOL_VERSION);
    expect(negotiateLegacyVersion(undefined)).toBe(LATEST_LEGACY_PROTOCOL_VERSION);
  });

  it('never echoes the modern version to a handshake-based client', () => {
    expect(negotiateLegacyVersion(MODERN_PROTOCOL_VERSION)).toBe(LATEST_LEGACY_PROTOCOL_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────
// End-to-end: the worker must serve both eras on one endpoint
// ─────────────────────────────────────────────────────────────

describe('worker: legacy era still works', () => {
  it('answers initialize and echoes the requested version', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { 'Content-Type': 'application/json' }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe('2025-06-18');
    expect(json.result.serverInfo.name).toBe('plytix-mcp');
  });

  it('does not stamp modern-only result fields on a legacy response', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'Content-Type': 'application/json' }
    );
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.result.tools.length).toBeGreaterThan(0);
    expect(json.result.resultType).toBeUndefined();
    expect(json.result._meta).toBeUndefined();
  });

  it('still accepts a legacy request with no mirrored headers at all', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
      { 'Content-Type': 'application/json' }
    );
    expect(res.status).toBe(200);
  });
});

describe('worker: modern era', () => {
  it('serves server/discover with supported versions and capabilities', async () => {
    const body = modernBody('server/discover');
    const res = await post(body, modernHeaders(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.supportedVersions).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.resultType).toBe('complete');
    expect(json.result._meta[META_SERVER_INFO].name).toBe('plytix-mcp');
  });

  it('stamps resultType and serverInfo on tools/list', async () => {
    const body = modernBody('tools/list');
    const res = await post(body, modernHeaders(body));
    expect(res.status).toBe(200);
    expect(res.headers.get('MCP-Protocol-Version')).toBe(MODERN_PROTOCOL_VERSION);
    const json = (await res.json()) as any;
    expect(json.result.resultType).toBe('complete');
    expect(json.result._meta[META_SERVER_INFO]).toEqual({
      name: 'plytix-mcp',
      version: '0.3.3',
    });
  });

  it('rejects a header/body mismatch with 400 and -32020', async () => {
    const body = modernBody('tools/list');
    const res = await post(body, { ...modernHeaders(body), 'Mcp-Method': 'tools/call' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(ERROR_HEADER_MISMATCH);
    expect(json.id).toBe(1);
  });

  it('rejects an unsupported version with 400 and -32022 listing what it supports', async () => {
    // A client from a future revision: it must be able to discover our
    // supported set from the error and retry, rather than get legacy service.
    const body = {
      jsonrpc: '2.0' as const,
      id: 3,
      method: 'tools/list',
      params: {
        _meta: { [META_PROTOCOL_VERSION]: '2027-01-01', [META_CLIENT_CAPABILITIES]: {} },
      },
    };
    const res = await post(body, {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2027-01-01',
      'Mcp-Method': 'tools/list',
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(ERROR_UNSUPPORTED_PROTOCOL_VERSION);
    expect(json.error.data.requested).toBe('2027-01-01');
    expect(json.error.data.supported).toContain(MODERN_PROTOCOL_VERSION);
    expect(json.id).toBe(3);
  });

  it('returns 404 with -32601 for an unknown method', async () => {
    const body = modernBody('nonexistent/method');
    const res = await post(body, modernHeaders(body));
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32601);
  });

  it('rejects a modern request missing required _meta with 400 and -32602', async () => {
    const body = { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} };
    const res = await post(body, {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/list',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(ERROR_INVALID_PARAMS);
  });

  it('still acknowledges notifications with 202 and no body', async () => {
    const res = await post(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {
          _meta: {
            [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
            [META_CLIENT_CAPABILITIES]: {},
          },
        },
      },
      { 'Content-Type': 'application/json', 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION }
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('requires auth for tool calls even when the envelope is valid', async () => {
    const body = modernBody('tools/call', { name: 'products_lookup', arguments: { identifier: 'X' } });
    const res = await post(body, modernHeaders(body));
    expect(res.status).toBe(401);
  });
});

describe('worker: initialize is legacy-only', () => {
  it('answers a modern-framed initialize with 404, not a decorated handshake', async () => {
    // The modern revision removed the handshake. Serving it here would hand
    // the client a "handshake succeeded" result for a method this era does
    // not define.
    const body = modernBody('initialize', { protocolVersion: MODERN_PROTOCOL_VERSION });
    const res = await post(body, modernHeaders(body));
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32601);
    expect(json.result).toBeUndefined();
  });

  it('still answers a legacy initialize normally', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { 'Content-Type': 'application/json' }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe('2025-11-25');
  });
});

describe('worker: modern batches are rejected', () => {
  it('rejects a batch carrying the modern header with 400', async () => {
    // Would otherwise fall through to legacy batch handling, skipping
    // mirrored-header and _meta validation for every entry.
    const res = await post(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ],
      { 'Content-Type': 'application/json', 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION }
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32600);
  });

  it('rejects a batch whose entries carry modern _meta even with no header', async () => {
    const res = await post([modernBody('tools/list')], { 'Content-Type': 'application/json' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32600);
  });

  it('still serves a purely legacy batch', async () => {
    const res = await post(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} },
      ],
      { 'Content-Type': 'application/json' }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toHaveLength(2);
    expect(json[0].result.tools.length).toBeGreaterThan(0);
  });

  it('still serves a legacy batch that sends a legacy version header', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }], {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
    });
    expect(res.status).toBe(200);
  });
});

describe('worker: malformed bodies are rejected, not crashed on', () => {
  // Each of these parses as valid JSON but is not a JSON-RPC message. Before
  // the guard they reached era detection or the dispatcher, which dereferenced
  // them and rejected the Worker promise with a TypeError.
  it.each([
    ['null', null],
    ['a bare string', 'hello'],
    ['a number', 42],
    ['a boolean', true],
  ])('rejects %s with 400 and -32600', async (_label, payload) => {
    const res = await post(payload, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32600);
  });

  it('rejects a batch containing a null entry', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null], {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32600);
  });

  it('rejects a null body sent with modern headers', async () => {
    const res = await post(null, {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/list',
    });
    expect(res.status).toBe(400);
  });
});

describe('worker: 404 is reserved for unknown JSON-RPC methods', () => {
  it('returns 200 for an unknown tool name, since tools/call is implemented', async () => {
    // -32601 from tools/call means "no such tool", not "no such method".
    // Mapping it to 404 would tell a client the endpoint lacks tools/call.
    const body = modernBody('tools/call', { name: 'no_such_tool', arguments: {} });
    const res = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          ...modernHeaders(body),
          'X-Plytix-API-Key': 'k',
          'X-Plytix-API-Password': 'p',
        },
        body: JSON.stringify(body),
      }),
      ENV
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32601);
    expect(json.error.message).toContain('Unknown tool');
  });

  it('still returns 404 for a genuinely unknown method', async () => {
    const body = modernBody('nonexistent/method');
    const res = await post(body, modernHeaders(body));
    expect(res.status).toBe(404);
  });
});

describe('worker: removed transport mechanics', () => {
  it.each(['GET', 'DELETE'])('answers %s /mcp with 405', async (method) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method }), ENV);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('POST');
  });

  it('exposes MCP-Protocol-Version to browser clients via CORS', async () => {
    // Not a CORS-safelisted response header: without Expose-Headers a browser
    // transport cannot read the version we answered with.
    const body = modernBody('tools/list');
    const res = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { ...modernHeaders(body), Origin: 'https://claude.ai' },
        body: JSON.stringify(body),
      }),
      ENV
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://claude.ai');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('MCP-Protocol-Version');
    expect(res.headers.get('MCP-Protocol-Version')).toBe(MODERN_PROTOCOL_VERSION);
  });

  it('ignores Mcp-Session-Id rather than minting or echoing one', async () => {
    const body = modernBody('tools/list');
    const res = await post(body, { ...modernHeaders(body), 'Mcp-Session-Id': 'stale-session' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Mcp-Session-Id')).toBeNull();
  });
});

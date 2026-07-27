/**
 * MCP protocol-version handling for the Streamable HTTP worker.
 *
 * The `2026-07-28` revision ("modern") removed the `initialize` handshake and
 * the `Mcp-Session-Id` session: every request now carries its protocol version
 * and client capabilities in `_meta`, and the transport mirrors selected body
 * fields into HTTP headers so intermediaries can route without parsing bodies.
 *
 * Clients in the wild still speak the older handshake-based revisions
 * ("legacy"), so this server is *dual-era*: it selects behaviour from how the
 * client opens the request, per the spec's compatibility matrix. A request
 * carrying modern `_meta` is served statelessly under this revision; an
 * `initialize` request selects legacy semantics.
 *
 * Only the modern path gets the strict HTTP status codes (400/404) and the
 * `resultType`/`serverInfo` result fields — legacy responses stay byte-for-byte
 * what they were, so upgrading cannot break an already-connected client.
 */

export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Handshake-based revisions we still answer. `2025-11-25` is the newest and is
 * what we fall back to when a legacy client requests something we don't know.
 */
export const LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const LATEST_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];

export const SUPPORTED_PROTOCOL_VERSIONS: string[] = [
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
];

// Reserved `_meta` keys (spec: Base Protocol § General fields).
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/**
 * Error codes from the `-32020..-32099` sub-range the spec reserves for itself.
 * `-32002` (resource not found) is retired in this revision — implementations
 * MUST NOT emit it; `-32602` is used instead.
 */
export const ERROR_HEADER_MISMATCH = -32020;
export const ERROR_MISSING_CLIENT_CAPABILITY = -32021;
export const ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_METHOD_NOT_FOUND = -32601;

/** Methods whose `Mcp-Name` header mirrors a body field. */
const NAME_HEADER_METHODS: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

export interface HeaderSource {
  get(name: string): string | null;
}

export interface ProtocolRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type ModernValidation =
  | { ok: true }
  | { ok: false; status: number; error: JsonRpcErrorBody };

/**
 * Decode an `Mcp-Name` / `Mcp-Param-*` header value.
 *
 * Values that cannot be represented as plain ASCII are carried as
 * `=?base64?<base64 of UTF-8>?=`. Servers MUST decode before comparing to the
 * body. A malformed sentinel is returned verbatim so it fails the subsequent
 * comparison rather than throwing.
 */
export function decodeHeaderValue(raw: string): string {
  if (!raw.startsWith(BASE64_SENTINEL_PREFIX) || !raw.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return raw;
  }
  const encoded = raw.slice(
    BASE64_SENTINEL_PREFIX.length,
    raw.length - BASE64_SENTINEL_SUFFIX.length
  );
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

function readMeta(request: ProtocolRequest): Record<string, unknown> | undefined {
  const meta = request.params?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

/**
 * The protocol version a request declares in `_meta`, if any.
 */
export function bodyProtocolVersion(request: ProtocolRequest): string | undefined {
  const value = readMeta(request)?.[META_PROTOCOL_VERSION];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Decide which era a request belongs to.
 *
 * Detection keys on *shape*, not on a specific version value, so that a client
 * speaking a revision newer than ours still lands on the modern path and gets
 * an `UnsupportedProtocolVersionError` listing what we support — the
 * renegotiation the spec expects — instead of being silently served legacy
 * semantics.
 *
 * Two signals mark a request as modern:
 *
 *  - `_meta` carries the `protocolVersion` key at all. Handshake-based
 *    revisions never emit this key, so its presence is decisive whatever its
 *    value. This also routes a malformed modern request (header set, `_meta`
 *    missing its required fields) to `-32602` rather than legacy service.
 *  - The `MCP-Protocol-Version` header names something that is not a known
 *    legacy revision. Legacy `2025-06-18` and `2025-11-25` clients do send
 *    this header, so mere presence is not enough — the value must be one we
 *    do not recognise as legacy.
 */
export function isModernRequest(request: ProtocolRequest, headers: HeaderSource): boolean {
  if (bodyProtocolVersion(request) !== undefined) return true;

  const header = headers.get('MCP-Protocol-Version');
  if (!header) return false;
  return !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(header);
}

function headerMismatch(message: string): ModernValidation {
  return { ok: false, status: 400, error: { code: ERROR_HEADER_MISMATCH, message } };
}

/**
 * The value a request's `Mcp-Name` header must mirror, or undefined when the
 * method does not use one.
 */
export function expectedNameHeader(request: ProtocolRequest): string | undefined {
  const field = request.method ? NAME_HEADER_METHODS[request.method] : undefined;
  if (!field) return undefined;
  const value = request.params?.[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Full modern-era request validation, in the order the spec defines: header
 * mirroring first (so intermediaries and the server can never disagree about
 * what a request is), then version support, then required `_meta` fields.
 *
 * Returns the JSON-RPC error body and HTTP status to send on failure. Unknown
 * methods are *not* checked here — that is `404` + `-32601` and is decided by
 * the dispatcher, which knows what it implements.
 */
export function validateModernRequest(
  request: ProtocolRequest,
  headers: HeaderSource
): ModernValidation {
  // ── Header mirroring ──────────────────────────────────────────
  const versionHeader = headers.get('MCP-Protocol-Version');
  if (!versionHeader) {
    return headerMismatch('Missing required header: MCP-Protocol-Version');
  }

  const declaredVersion = bodyProtocolVersion(request);
  if (declaredVersion !== undefined && declaredVersion !== versionHeader) {
    return headerMismatch(
      `Header mismatch: MCP-Protocol-Version header value '${versionHeader}' does not match body value '${declaredVersion}'`
    );
  }

  const methodHeader = headers.get('Mcp-Method');
  if (!methodHeader) {
    return headerMismatch('Missing required header: Mcp-Method');
  }
  if (methodHeader !== request.method) {
    return headerMismatch(
      `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${request.method ?? ''}'`
    );
  }

  const expectedName = expectedNameHeader(request);
  if (expectedName !== undefined) {
    const nameHeader = headers.get('Mcp-Name');
    if (!nameHeader) {
      return headerMismatch('Missing required header: Mcp-Name');
    }
    if (decodeHeaderValue(nameHeader) !== expectedName) {
      return headerMismatch(
        `Header mismatch: Mcp-Name header value '${nameHeader}' does not match body value '${expectedName}'`
      );
    }
  }

  // ── Version support ───────────────────────────────────────────
  // The header is authoritative for routing; the body is the source of truth.
  // They are equal by this point when both are present.
  const requested = declaredVersion ?? versionHeader;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return {
      ok: false,
      status: 400,
      error: {
        code: ERROR_UNSUPPORTED_PROTOCOL_VERSION,
        message: 'Unsupported protocol version',
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested },
      },
    };
  }

  // ── Required `_meta` fields ───────────────────────────────────
  const meta = readMeta(request);
  if (declaredVersion === undefined) {
    return {
      ok: false,
      status: 400,
      error: {
        code: ERROR_INVALID_PARAMS,
        message: `Invalid params: missing required _meta field '${META_PROTOCOL_VERSION}'`,
      },
    };
  }

  const capabilities = meta?.[META_CLIENT_CAPABILITIES];
  if (capabilities === undefined || typeof capabilities !== 'object' || capabilities === null) {
    return {
      ok: false,
      status: 400,
      error: {
        code: ERROR_INVALID_PARAMS,
        message: `Invalid params: missing required _meta field '${META_CLIENT_CAPABILITIES}'`,
      },
    };
  }

  return { ok: true };
}

/**
 * Client capabilities declared on a modern request, used to negotiate
 * extensions (MCP Apps, Tasks). Legacy requests declare none.
 */
export function clientExtensions(request: ProtocolRequest): Record<string, unknown> {
  const capabilities = readMeta(request)?.[META_CLIENT_CAPABILITIES];
  if (!capabilities || typeof capabilities !== 'object') return {};
  const extensions = (capabilities as Record<string, unknown>).extensions;
  return extensions && typeof extensions === 'object' && !Array.isArray(extensions)
    ? (extensions as Record<string, unknown>)
    : {};
}

/**
 * Stamp a modern result with the fields every response carries: `resultType`
 * (clients treat an absent value as `"complete"`, but we are explicit) and the
 * server's self-reported identity in `_meta`.
 *
 * Applied only on the modern path — legacy results are left exactly as they
 * were so an upgrade cannot perturb a connected client.
 */
export function decorateModernResult(
  result: unknown,
  serverInfo: { name: string; version: string }
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;

  const record = result as Record<string, unknown>;
  const existingMeta =
    record._meta && typeof record._meta === 'object' && !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : {};

  return {
    resultType: 'complete',
    ...record,
    _meta: { ...existingMeta, [META_SERVER_INFO]: serverInfo },
  };
}

/**
 * Pick the protocol version to echo from a legacy `initialize`.
 *
 * The legacy lifecycle requires the server to respond with the requested
 * version when it supports it, and otherwise with a version it does support.
 * Modern is never echoed here: a client that sent `initialize` cannot speak it.
 */
export function negotiateLegacyVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_LEGACY_PROTOCOL_VERSION;
}

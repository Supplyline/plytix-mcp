import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { adminTools } from '../catalog-admin.js';
import { PlytixClient } from '../client.js';
import worker from '../worker.js';

it('submits and verifies the same synthetic DAM upload through both MCP handlers', async () => {
  const id = 'a'.repeat(24);
  const calls: string[] = [];
  const env = {
    PLYTIX_API_BASE: 'https://fixture.invalid',
    PLYTIX_AUTH_URL: 'https://fixture.invalid/token',
  };
  vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/token') return Response.json({ data: [{ access_token: 'fixture-token' }] });
    calls.push((opts.method ?? 'GET') + ' ' + path);
    if (path === '/api/v1/assets' && opts.method === 'POST') {
      expect(JSON.parse(opts.body as string)).toEqual({ filename: 'fixture.txt', content: 'YQ==' });
      return Response.json({ data: [{ id }] }, { status: 201 });
    }
    if (path === '/api/v1/assets/' + id)
      return Response.json({ data: [{ id, filename: 'fixture.txt', file_size: 1 }] });
    throw new Error('Unexpected fixture route ' + path);
  });
  const server = new McpServer({ name: 'fixture', version: '1' });
  const sdk = new Client({ name: 'transport-check', version: '1' });
  try {
    const native = new PlytixClient({
      apiKey: 'fixture',
      apiPassword: 'fixture',
      baseUrl: env.PLYTIX_API_BASE,
      authUrl: env.PLYTIX_AUTH_URL,
    });
    for (const tool of adminTools) tool.register(server, native);
    const [caller, service] = InMemoryTransport.createLinkedPair();
    await server.connect(service);
    await sdk.connect(caller);
    const params = { name: 'assets_create', arguments: { filename: 'fixture.txt', content: 'YQ==' } };
    const local = await sdk.callTool(params);
    const response = await worker.fetch(
      new Request('https://worker.invalid/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Plytix-API-Key': 'fixture',
          'X-Plytix-API-Password': 'fixture',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
      }),
      env,
    );
    const remote = (await response.json()).result;
    expect(local.isError).toBe(false);
    expect(remote.content).toEqual(local.content);
    expect(JSON.parse(remote.content[0].text)).toMatchObject({ id, outcome: 'verified' });
    expect(calls).toEqual(
      Array(2)
        .fill(['POST /api/v1/assets', 'GET /api/v1/assets/' + id])
        .flat(),
    );
  } finally {
    await sdk.close();
    await server.close();
    vi.unstubAllGlobals();
  }
});

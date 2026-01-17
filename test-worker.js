#!/usr/bin/env node

/**
 * Test script for the Plytix MCP Worker
 *
 * Tests the remote MCP server endpoints:
 * - Health check
 * - Server info
 * - MCP protocol (initialize, tools/list, tools/call)
 *
 * Usage:
 *   node test-worker.js                           # Test local dev server (localhost:8787)
 *   node test-worker.js https://your-worker.workers.dev  # Test deployed worker
 *
 * Environment:
 *   PLYTIX_API_KEY      - Your Plytix API key
 *   PLYTIX_API_PASSWORD - Your Plytix API password
 */

const BASE_URL = process.argv[2] || 'http://localhost:8787';
const API_KEY = process.env.PLYTIX_API_KEY;
const API_PASSWORD = process.env.PLYTIX_API_PASSWORD;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

function log(status, message) {
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '•';
  const color = status === 'pass' ? colors.green : status === 'fail' ? colors.red : colors.blue;
  console.log(`${color}${icon}${colors.reset} ${message}`);
}

async function testEndpoint(name, fn) {
  try {
    await fn();
    log('pass', name);
    return true;
  } catch (error) {
    log('fail', `${name}: ${error.message}`);
    return false;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY && API_PASSWORD
        ? {
            'X-Plytix-API-Key': API_KEY,
            'X-Plytix-API-Password': API_PASSWORD,
          }
        : {}),
      ...options.headers,
    },
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok && !json.jsonrpc) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(json)}`);
  }

  return { response, json };
}

async function mcpRequest(method, params = {}) {
  const { json } = await fetchJson(`${BASE_URL}/mcp`, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });

  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }

  return json.result;
}

async function runTests() {
  console.log(`\n${colors.blue}Testing Plytix MCP Worker${colors.reset}`);
  console.log(`${colors.dim}Base URL: ${BASE_URL}${colors.reset}\n`);

  let passed = 0;
  let failed = 0;

  // Test 1: Health check
  if (
    await testEndpoint('Health check (/health)', async () => {
      const { json } = await fetchJson(`${BASE_URL}/health`);
      if (json.status !== 'ok') throw new Error('Health check failed');
    })
  ) {
    passed++;
  } else {
    failed++;
  }

  // Test 2: Server info
  if (
    await testEndpoint('Server info (/)', async () => {
      const { json } = await fetchJson(BASE_URL);
      if (json.name !== 'plytix-mcp') throw new Error('Invalid server name');
      if (!json.endpoints?.mcp) throw new Error('Missing MCP endpoint info');
    })
  ) {
    passed++;
  } else {
    failed++;
  }

  // Test 3: MCP without credentials (should fail gracefully)
  if (
    await testEndpoint('MCP without credentials (should require auth)', async () => {
      const response = await fetch(`${BASE_URL}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        }),
      });

      if (response.status !== 401) {
        throw new Error(`Expected 401, got ${response.status}`);
      }
    })
  ) {
    passed++;
  } else {
    failed++;
  }

  // Tests requiring credentials
  if (!API_KEY || !API_PASSWORD) {
    console.log(`\n${colors.yellow}Skipping authenticated tests (no credentials)${colors.reset}`);
    console.log(`${colors.dim}Set PLYTIX_API_KEY and PLYTIX_API_PASSWORD to run all tests${colors.reset}\n`);
  } else {
    // Test 4: MCP initialize
    if (
      await testEndpoint('MCP initialize', async () => {
        const result = await mcpRequest('initialize');
        if (!result.protocolVersion) throw new Error('Missing protocolVersion');
        if (!result.serverInfo?.name) throw new Error('Missing serverInfo');
      })
    ) {
      passed++;
    } else {
      failed++;
    }

    // Test 5: MCP tools/list
    if (
      await testEndpoint('MCP tools/list', async () => {
        const result = await mcpRequest('tools/list');
        if (!Array.isArray(result.tools)) throw new Error('tools is not an array');
        if (result.tools.length === 0) throw new Error('No tools returned');

        const expectedTools = [
          'products_lookup',
          'products_get',
          'products_search',
          'families_list',
          'attributes_list',
        ];
        for (const tool of expectedTools) {
          if (!result.tools.find((t) => t.name === tool)) {
            throw new Error(`Missing tool: ${tool}`);
          }
        }
      })
    ) {
      passed++;
    } else {
      failed++;
    }

    // Test 6: MCP tools/call - attributes_filters (doesn't need product ID)
    if (
      await testEndpoint('MCP tools/call (attributes_filters)', async () => {
        const result = await mcpRequest('tools/call', {
          name: 'attributes_filters',
          arguments: {},
        });

        if (!result.content || !Array.isArray(result.content)) {
          throw new Error('Invalid response format');
        }

        const text = result.content[0]?.text;
        if (!text) throw new Error('No content returned');

        const data = JSON.parse(text);
        if (!Array.isArray(data.filters)) throw new Error('No filters returned');
      })
    ) {
      passed++;
    } else {
      failed++;
    }

    // Test 7: MCP tools/call - families_list
    if (
      await testEndpoint('MCP tools/call (families_list)', async () => {
        const result = await mcpRequest('tools/call', {
          name: 'families_list',
          arguments: { page_size: 5 },
        });

        if (!result.content || !Array.isArray(result.content)) {
          throw new Error('Invalid response format');
        }

        const text = result.content[0]?.text;
        if (!text) throw new Error('No content returned');

        const data = JSON.parse(text);
        if (!Array.isArray(data.families)) throw new Error('No families array');
      })
    ) {
      passed++;
    } else {
      failed++;
    }

    // Test 8: MCP tools/call - products_search
    if (
      await testEndpoint('MCP tools/call (products_search)', async () => {
        const result = await mcpRequest('tools/call', {
          name: 'products_search',
          arguments: {
            pagination: { page: 1, page_size: 3 },
          },
        });

        if (!result.content || !Array.isArray(result.content)) {
          throw new Error('Invalid response format');
        }

        const text = result.content[0]?.text;
        if (!text) throw new Error('No content returned');

        const data = JSON.parse(text);
        if (!Array.isArray(data.products)) throw new Error('No products array');
      })
    ) {
      passed++;
    } else {
      failed++;
    }

    // Test 9: Unknown tool handling
    if (
      await testEndpoint('MCP unknown tool handling', async () => {
        const { json } = await fetchJson(`${BASE_URL}/mcp`, {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'nonexistent_tool',
              arguments: {},
            },
          }),
        });

        if (!json.error) throw new Error('Expected error for unknown tool');
        if (json.error.code !== -32601) throw new Error('Wrong error code');
      })
    ) {
      passed++;
    } else {
      failed++;
    }
  }

  // Summary
  console.log(`\n${colors.dim}─────────────────────────────────────${colors.reset}`);
  console.log(
    `${colors.green}Passed: ${passed}${colors.reset} | ${colors.red}Failed: ${failed}${colors.reset}`
  );

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error(`\n${colors.red}Test runner error:${colors.reset}`, error);
  process.exit(1);
});

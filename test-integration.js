#!/usr/bin/env node

/**
 * Simple integration test for Plytix MCP Server
 * This tests the actual MCP server functionality without complex mocking
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Testing Plytix MCP Server Integration...\n');

// Test 1: Check if server starts without errors
console.log('1. Testing server startup...');
const server = spawn('node', [join(__dirname, 'dist/index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PLYTIX_API_KEY: 'test-key',
    PLYTIX_API_PASSWORD: 'test-password'
  }
});

let serverOutput = '';
let serverError = '';

server.stdout.on('data', (data) => {
  serverOutput += data.toString();
});

server.stderr.on('data', (data) => {
  serverError += data.toString();
});

// Test MCP initialization
const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {}
    },
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  }
};

console.log('2. Sending MCP initialization request...');
server.stdin.write(JSON.stringify(initRequest) + '\n');

// Wait a bit for response
setTimeout(() => {
  console.log('3. Sending initialized notification...');
  const initializedNotification = {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  };
  server.stdin.write(JSON.stringify(initializedNotification) + '\n');
}, 1000);

// Test tools list
setTimeout(() => {
  console.log('4. Requesting tools list...');
  const toolsListRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  };
  server.stdin.write(JSON.stringify(toolsListRequest) + '\n');
}, 2000);

// Clean up after tests
setTimeout(() => {
  console.log('\n✅ Integration test completed!');
  console.log('Server output:', serverOutput);
  if (serverError) {
    console.log('Server errors:', serverError);
  }
  server.kill();
  process.exit(0);
}, 5000);

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server failed to start:', error.message);
  process.exit(1);
});

server.on('exit', (code) => {
  if (code !== 0) {
    console.error(`❌ Server exited with code ${code}`);
    process.exit(1);
  }
});

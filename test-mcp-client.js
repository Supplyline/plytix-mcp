#!/usr/bin/env node

/**
 * Test script to verify MCP server works with a simple client
 * This simulates how Claude Desktop would interact with the server
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔧 Testing MCP Server with simulated client...\n');

// Check if .env file exists
import { existsSync } from 'fs';
if (!existsSync('.env')) {
  console.log('⚠️  No .env file found. Please copy .env.example to .env and add your credentials.');
  console.log('   This test will use dummy credentials and expect auth failures.');
}

const server = spawn('node', [join(__dirname, 'dist/index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PLYTIX_API_KEY: process.env.PLYTIX_API_KEY || 'dummy-key',
    PLYTIX_API_PASSWORD: process.env.PLYTIX_API_PASSWORD || 'dummy-password'
  }
});

let responses = [];

server.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(line => line.trim());
  lines.forEach(line => {
    try {
      const response = JSON.parse(line);
      responses.push(response);
      console.log('📨 Received:', JSON.stringify(response, null, 2));
    } catch (e) {
      console.log('📨 Raw output:', line);
    }
  });
});

server.stderr.on('data', (data) => {
  console.log('⚠️  Server stderr:', data.toString());
});

// MCP Protocol handshake
const steps = [
  {
    name: 'Initialize',
    message: {
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
    }
  },
  {
    name: 'Initialized notification',
    message: {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }
  },
  {
    name: 'List tools',
    message: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    }
  },
  {
    name: 'Test products.get (will fail without real credentials)',
    message: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'products.get',
        arguments: {
          product_id: 'test-product-123'
        }
      }
    }
  }
];

let stepIndex = 0;

function sendNextStep() {
  if (stepIndex >= steps.length) {
    console.log('\n✅ All test steps completed!');
    console.log(`📊 Total responses received: ${responses.length}`);
    server.kill();
    return;
  }

  const step = steps[stepIndex];
  console.log(`\n🚀 Step ${stepIndex + 1}: ${step.name}`);
  console.log('📤 Sending:', JSON.stringify(step.message, null, 2));
  
  server.stdin.write(JSON.stringify(step.message) + '\n');
  stepIndex++;
}

// Start the test sequence
sendNextStep();

// Send next step after a delay
const interval = setInterval(() => {
  sendNextStep();
}, 2000);

// Clean up
setTimeout(() => {
  clearInterval(interval);
  if (!server.killed) {
    console.log('\n⏰ Test timeout - cleaning up...');
    server.kill();
  }
  process.exit(0);
}, 15000);

server.on('error', (error) => {
  console.error('❌ Server error:', error.message);
  clearInterval(interval);
  process.exit(1);
});

server.on('exit', (code) => {
  console.log(`\n🏁 Server exited with code ${code}`);
  clearInterval(interval);
  process.exit(code);
});

#!/usr/bin/env node
/**
 * MCP Tool Test Runner - calls tools via JSON-RPC stdio protocol
 * Supports --db flag to auto-select database before the tool call.
 * Usage: node scripts/mcp-test.cjs [--db name] <tool_name> [json_args]
 */
const { spawn } = require('child_process');
const path = require('path');

// Parse args
let dbName = null;
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === '--db') {
  dbName = rawArgs[1];
  rawArgs.splice(0, 2);
}

const toolName = rawArgs[0];
const argsStr = rawArgs[1] || '{}';

if (!toolName) {
  console.error('Usage: node scripts/mcp-test.cjs [--db name] <tool_name> [json_args]');
  process.exit(1);
}

let toolArgs;
try {
  toolArgs = JSON.parse(argsStr);
} catch (e) {
  console.error('Invalid JSON:', argsStr);
  process.exit(1);
}

const serverPath = path.join(__dirname, '..', 'dist', 'index.js');
const child = spawn('node', [serverPath], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let resolved = false;
// The final response ID depends on whether we do a db select first
const targetId = dbName ? 3 : 2;

child.stdout.on('data', (data) => {
  stdout += data.toString();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || resolved) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id === targetId) {
        resolved = true;
        if (msg.result && msg.result.content) {
          for (const block of msg.result.content) {
            if (block.type === 'text') {
              console.log(block.text);
            }
          }
        } else if (msg.error) {
          console.error('MCP Error:', JSON.stringify(msg.error, null, 2));
        } else {
          console.log(JSON.stringify(msg, null, 2));
        }
        child.kill();
      }
    } catch {
      // incomplete JSON line
    }
  }
});

child.stderr.on('data', () => {}); // suppress stderr

child.on('close', () => {
  if (!resolved) {
    console.error('Server closed without response');
    process.exit(1);
  }
});

// Step 1: Initialize
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
}) + '\n');

if (dbName) {
  // Step 2: Select database, then Step 3: Call tool
  setTimeout(() => {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'ocr_db_select', arguments: { database_name: dbName } }
    }) + '\n');
  }, 300);
  setTimeout(() => {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    }) + '\n');
  }, 600);
} else {
  // Step 2: Call tool directly
  setTimeout(() => {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    }) + '\n');
  }, 300);
}

// Timeout - 5 minutes for long operations
setTimeout(() => {
  if (!resolved) {
    resolved = true;
    child.kill();
    console.error('Timeout after 300s');
    process.exit(1);
  }
}, 300000);

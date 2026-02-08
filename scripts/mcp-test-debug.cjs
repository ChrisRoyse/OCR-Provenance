#!/usr/bin/env node
/**
 * MCP Tool Test Runner with stderr logging for debugging
 */
const { spawn } = require('child_process');
const path = require('path');

let dbName = null;
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === '--db') {
  dbName = rawArgs[1];
  rawArgs.splice(0, 2);
}

const toolName = rawArgs[0];
const argsStr = rawArgs[1] || '{}';
let toolArgs;
try { toolArgs = JSON.parse(argsStr); } catch { console.error('Bad JSON'); process.exit(1); }

const serverPath = path.join(__dirname, '..', 'dist', 'index.js');
const child = spawn('node', [serverPath], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let resolved = false;
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
        console.log('\n=== MCP RESPONSE ===');
        if (msg.result && msg.result.content) {
          for (const block of msg.result.content) {
            if (block.type === 'text') console.log(block.text);
          }
        } else {
          console.log(JSON.stringify(msg, null, 2));
        }
        child.kill();
      }
    } catch {}
  }
});

// Show stderr for debugging
child.stderr.on('data', (data) => {
  process.stderr.write(data);
});

child.on('close', () => {
  if (!resolved) { console.error('Server closed without response'); process.exit(1); }
});

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
}) + '\n');

if (dbName) {
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
  setTimeout(() => {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    }) + '\n');
  }, 300);
}

setTimeout(() => {
  if (!resolved) { resolved = true; child.kill(); console.error('Timeout 300s'); process.exit(1); }
}, 300000);

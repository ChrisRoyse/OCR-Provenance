#!/usr/bin/env npx ts-node
/**
 * MCP Tool Test Runner
 * Calls the MCP server via JSON-RPC over stdio - the same protocol Claude Code uses.
 * Usage: npx ts-node scripts/mcp-test-runner.ts <tool_name> [json_args]
 */
import { spawn } from 'child_process';
import * as path from 'path';

async function callMCPTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'dist', 'index.js');
    const child = spawn('node', [serverPath], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      // Look for complete JSON-RPC responses
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.trim() && !resolved) {
          try {
            const msg = JSON.parse(line.trim());
            if (msg.id === 2) {
              resolved = true;
              child.kill();
              resolve(msg);
            }
          } catch {
            // Not a complete JSON line yet
          }
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', () => {
      if (!resolved) {
        reject(new Error(`Server closed without response. stderr: ${stderr.slice(-2000)}`));
      }
    });

    child.on('error', reject);

    // Initialize MCP
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-test-runner', version: '1.0.0' },
      },
    });

    // Call the tool
    const callMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    });

    child.stdin.write(initMsg + '\n');
    // Small delay to let init complete
    setTimeout(() => {
      child.stdin.write(callMsg + '\n');
    }, 500);

    // Timeout after 120s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error(`Timeout after 120s. stderr: ${stderr.slice(-2000)}`));
      }
    }, 120000);
  });
}

async function main() {
  const toolName = process.argv[2];
  const argsStr = process.argv[3] || '{}';

  if (!toolName) {
    console.error('Usage: npx ts-node scripts/mcp-test-runner.ts <tool_name> [json_args]');
    console.error('Example: npx ts-node scripts/mcp-test-runner.ts ocr_db_stats \'{"database_name":"manual-test-2026-02-08"}\'');
    process.exit(1);
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    console.error(`Invalid JSON args: ${argsStr}`);
    process.exit(1);
  }

  try {
    const result = await callMCPTool(toolName, args);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

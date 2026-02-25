/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes OCR, search, provenance, and clustering tools via JSON-RPC.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module index
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Load .env from multiple candidate locations (first found wins):
// 1. OCR_PROVENANCE_ENV_FILE env var (explicit override)
// 2. CWD/.env (project-local)
// 3. Package root/.env (development)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  process.env.OCR_PROVENANCE_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
].filter((p): p is string => typeof p === 'string');

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
    break;
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './server/register-tools.js';
import { validateStartupDependencies } from './server/startup.js';

// =============================================================================
// SERVER INITIALIZATION
// =============================================================================

const server = new McpServer({
  name: 'ocr-provenance-mcp',
  version: '1.0.0',
});

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

const toolCount = registerAllTools(server);

// =============================================================================
// SERVER STARTUP
// =============================================================================

async function main(): Promise<void> {
  validateStartupDependencies();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`OCR Provenance MCP Server running on stdio`);
  console.error(`Tools registered: ${toolCount}`);
}

// Log memory usage every 5 minutes for observability (stderr only - safe for MCP)
setInterval(() => {
  const mem = process.memoryUsage();
  console.error(
    `[Memory] RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB ` +
      `Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}/${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB ` +
      `External=${(mem.external / 1024 / 1024).toFixed(1)}MB`
  );
}, 300_000).unref();

// Graceful shutdown handler
function handleShutdown(signal: string): void {
  console.error(`[Shutdown] Received ${signal}, shutting down gracefully...`);
  // Close the MCP server connection
  server
    .close()
    .then(() => {
      console.error('[Shutdown] Server closed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[Shutdown] Error closing server: ${err}`);
      process.exit(1);
    });
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    console.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});

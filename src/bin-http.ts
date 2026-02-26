#!/usr/bin/env node
/**
 * OCR Provenance MCP Server - Unified Docker Entry Point
 *
 * Transport selection via MCP_TRANSPORT environment variable:
 *   - (unset or "stdio") -> stdio transport (default, for "docker run -i --rm")
 *   - "http"             -> HTTP transport (for remote/multi-user deployments)
 *
 * Environment variables:
 *   MCP_TRANSPORT              - Transport mode: "stdio" (default) or "http"
 *   MCP_HTTP_PORT              - Port for HTTP mode (default: 3100)
 *   MCP_SESSION_TTL            - Session TTL in seconds for HTTP mode (default: 3600)
 *   OCR_PROVENANCE_DATABASES_PATH - Override default database storage path
 *   DATALAB_API_KEY            - Required for OCR processing
 *   GEMINI_API_KEY             - Required for VLM processing
 *   EMBEDDING_DEVICE           - Embedding device: auto | cuda | cpu | mps
 *
 * CRITICAL: In stdio mode, NEVER use console.log() - stdout is reserved for JSON-RPC.
 * Use console.error() for all logging in both modes.
 *
 * @module bin-http
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Load .env from multiple candidate locations (same logic as index.ts)
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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools, getToolCount } from './server/register-tools.js';
import { validateStartupDependencies } from './server/startup.js';

// =============================================================================
// DOCKER VOLUME WRITABILITY CHECK
// Detect UID mismatch early when running in Docker (/.dockerenv exists or
// MCP_TRANSPORT is set). If /data is not writable, fail fast with a clear
// error message explaining the UID mismatch and how to fix it.
// =============================================================================
const isDocker = fs.existsSync('/.dockerenv') || !!process.env.MCP_TRANSPORT;
if (isDocker) {
  const dataDir = process.env.OCR_PROVENANCE_DATABASES_PATH || '/data';
  if (fs.existsSync(dataDir)) {
    try {
      const testFile = path.join(dataDir, '.write-test-' + process.pid);
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
    } catch (_writeErr) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
      console.error(
        `[FATAL] ${dataDir} directory is not writable by current user (UID ${uid}, GID ${gid}). ` +
          `This usually means a Docker volume was created by a container with a different UID. ` +
          `Fix with: docker exec --user root <container> chown -R 999:999 ${dataDir}`
      );
      process.exit(1);
    }
  }
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const TRANSPORT = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
const PORT = (() => {
  const raw = Number(process.env.MCP_HTTP_PORT);
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : 3100;
})();
const SESSION_TTL_S = (() => {
  const raw = Number(process.env.MCP_SESSION_TTL);
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
})();

// =============================================================================
// STDIO MODE
// =============================================================================

async function startStdio(): Promise<void> {
  const server = new McpServer({
    name: 'ocr-provenance-mcp',
    version: '1.0.0',
  });

  const toolCount = registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`OCR Provenance MCP Server running on stdio`);
  console.error(`Tools registered: ${toolCount}`);

  function handleShutdown(signal: string): void {
    console.error(`[Shutdown] Received ${signal}, shutting down gracefully...`);
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
    setTimeout(() => {
      console.error('[Shutdown] Forced exit after timeout');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

// =============================================================================
// HTTP MODE
//
// Follows the official MCP SDK pattern (simpleStreamableHttp.js example):
// - One StreamableHTTPServerTransport + one McpServer per session
// - onsessioninitialized callback registers transport in sessions Map
// - Session lookup by Mcp-Session-Id header for subsequent requests
// - The SDK handles session validation internally (404 for invalid, 400 for missing)
// =============================================================================

/** Tracked session: transport + server + activity timestamp for TTL */
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const sessions = new Map<string, SessionEntry>();

/** Cached tool count for health endpoint */
let cachedToolCount = 0;

/**
 * Create a new session: McpServer + StreamableHTTPServerTransport.
 * The transport's onsessioninitialized callback registers it in the sessions Map.
 * Returns the entry (session ID is assigned asynchronously by the SDK during initialize).
 */
function createSessionEntry(): SessionEntry {
  const server = new McpServer({
    name: 'ocr-provenance-mcp',
    version: '1.0.0',
  });

  registerAllTools(server);

  const entry: SessionEntry = {
    transport: null as unknown as StreamableHTTPServerTransport, // set below
    server,
    lastActivity: Date.now(),
  };

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      // SDK calls this after processing the initialize request.
      // At this point, transport.sessionId is set.
      console.error(`[HTTP] Session initialized: ${sessionId}`);
      sessions.set(sessionId, entry);
    },
  });

  // Clean up session when transport closes (e.g., DELETE request)
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && sessions.has(sid)) {
      console.error(`[HTTP] Transport closed for session ${sid}`);
      sessions.delete(sid);
    }
  };

  entry.transport = transport;

  return entry;
}

async function startHttp(): Promise<void> {
  if (cachedToolCount === 0) cachedToolCount = getToolCount();
  const toolCount = cachedToolCount;

  // Cleanup expired sessions every 60 seconds
  setInterval(() => {
    const now = Date.now();
    const ttlMs = SESSION_TTL_S * 1000;
    for (const [id, entry] of sessions) {
      if (now - entry.lastActivity > ttlMs) {
        console.error(`[HTTP] Expiring session ${id}`);
        entry.transport.close().catch(() => {});
        entry.server.close().catch(() => {});
        sessions.delete(id);
      }
    }
  }, 60_000).unref();

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint (not part of MCP protocol)
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          transport: 'http',
          tools: toolCount,
          sessions: sessions.size,
          uptime: process.uptime(),
        })
      );
      return;
    }

    // All MCP traffic goes to /mcp
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is /mcp' }));
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session: forward request to its transport
        const entry = sessions.get(sessionId)!;
        entry.lastActivity = Date.now();
        await entry.transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'POST' && !sessionId) {
        // New session: create transport+server, connect, then handle request.
        // Following the official SDK example pattern:
        // 1. Create entry with transport
        // 2. Connect server to transport BEFORE handling the request
        // 3. Handle the request (which triggers initialize -> onsessioninitialized)
        const entry = createSessionEntry();
        await entry.server.connect(entry.transport);
        await entry.transport.handleRequest(req, res);
        return;
      }

      // Session ID provided but not found, or non-POST without session
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        })
      );
    } catch (error) {
      console.error(
        '[HTTP] Request error:',
        error instanceof Error ? error.message : String(error)
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.error(`OCR Provenance MCP Server (HTTP) listening on 0.0.0.0:${PORT}`);
    console.error(`Tools registered: ${toolCount}`);
    console.error(`Session TTL: ${SESSION_TTL_S}s`);
    console.error(`Health: http://localhost:${PORT}/health`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
  });

  function handleShutdown(signal: string): void {
    console.error(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    httpServer.close(() => {
      console.error('[Shutdown] HTTP server closed');
      const closePromises: Promise<void>[] = [];
      for (const [id, entry] of sessions) {
        closePromises.push(entry.transport.close().catch(() => {}));
        closePromises.push(entry.server.close().catch(() => {}));
        sessions.delete(id);
      }
      Promise.all(closePromises).then(() => {
        console.error('[Shutdown] All sessions closed');
        process.exit(0);
      });
    });
    setTimeout(() => {
      console.error('[Shutdown] Forced exit after timeout');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

// =============================================================================
// MAIN
// =============================================================================

// Log memory usage every 5 minutes
setInterval(() => {
  const mem = process.memoryUsage();
  console.error(
    `[Memory] RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB ` +
      `Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}/${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB ` +
      `External=${(mem.external / 1024 / 1024).toFixed(1)}MB`
  );
}, 300_000).unref();

async function main(): Promise<void> {
  validateStartupDependencies();

  if (TRANSPORT === 'http') {
    console.error('[Transport] Starting in HTTP mode (MCP_TRANSPORT=http)');
    await startHttp();
  } else if (TRANSPORT === 'stdio') {
    // Default: stdio mode -- used by AI clients with "docker run -i --rm"
    await startStdio();
  } else {
    console.error(
      `[FATAL] Unknown MCP_TRANSPORT value: "${TRANSPORT}". Must be "stdio" or "http".`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});

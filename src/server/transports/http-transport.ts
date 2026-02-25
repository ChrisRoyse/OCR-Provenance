/**
 * Streamable HTTP Transport for MCP
 *
 * Implements MCP Streamable HTTP transport (2025-03-26):
 * - HTTP POST for client->server messages
 * - SSE for server->client streaming
 * - Mcp-Session-Id header for session management
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module server/transports/http-transport
 */

import http from 'http';
import { randomUUID } from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HttpTransportConfig {
  port: number;
  sessionTtlMs: number;
}

interface Session {
  id: string;
  createdAt: number;
  lastActivity: number;
  sseResponse: http.ServerResponse | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════════

export class HttpTransport {
  private sessions = new Map<string, Session>();
  private server: http.Server | null = null;
  private config: HttpTransportConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private messageHandler: ((sessionId: string, message: unknown) => Promise<unknown>) | null = null;

  constructor(config?: Partial<HttpTransportConfig>) {
    this.config = {
      port: config?.port ?? (Number(process.env.MCP_HTTP_PORT) || 3100),
      sessionTtlMs: config?.sessionTtlMs ?? (Number(process.env.MCP_SESSION_TTL) || 3600) * 1000,
    };
  }

  /** Set the handler for incoming messages */
  onMessage(handler: (sessionId: string, message: unknown) => Promise<unknown>): void {
    this.messageHandler = handler;
  }

  /** Start the HTTP server */
  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        if (req.method === 'POST' && req.url === '/mcp') {
          await this.handlePost(req, res);
        } else if (req.method === 'GET' && req.url === '/mcp/sse') {
          await this.handleSSE(req, res);
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', sessions: this.sessions.size }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (error) {
        console.error(
          '[HttpTransport] Request error:',
          error instanceof Error ? error.message : String(error)
        );
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        console.error(`[HttpTransport] Listening on port ${this.config.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });

    // Session cleanup every 60s
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60000);
    this.cleanupTimer.unref();
  }

  /** Stop the HTTP server */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.sessions.clear();
    console.error('[HttpTransport] Stopped');
  }

  private async handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Get or create session
    let sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && !this.sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid session ID' }));
      return;
    }

    if (!sessionId) {
      sessionId = randomUUID();
      this.sessions.set(sessionId, {
        id: sessionId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        sseResponse: null,
      });
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();

    // Read body
    const body = await new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk;
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    if (!this.messageHandler) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No message handler registered' }));
      return;
    }

    const message = JSON.parse(body);
    const response = await this.messageHandler(sessionId, message);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    });
    res.end(JSON.stringify(response));
  }

  private async handleSSE(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(400);
      res.end('Invalid session');
      return;
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    session.sseResponse = res;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Mcp-Session-Id': sessionId,
    });

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(keepAlive);
      if (session.sseResponse === res) {
        session.sseResponse = null;
      }
    });
  }

  /** Send SSE event to a session */
  sendEvent(sessionId: string, event: string, data: unknown): void {
    const session = this.sessions.get(sessionId);
    if (session?.sseResponse) {
      try {
        session.sseResponse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        console.error(
          `[HttpTransport] SSE send failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        session.sseResponse = null;
      }
    }
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.config.sessionTtlMs) {
        console.error(`[HttpTransport] Expiring session ${id}`);
        if (session.sseResponse) {
          try {
            session.sseResponse.end();
          } catch {
            /* ignore close errors */
          }
        }
        this.sessions.delete(id);
      }
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}

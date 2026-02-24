/**
 * Session Manager - Scoped state per MCP session
 *
 * Each session tracks its own currentDatabase, userId, and active operations.
 * Stdio transport uses a default "local" session.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module server/transports/session-manager
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionState {
  sessionId: string;
  currentDatabase: string | null;
  userId: string | null;
  activeOperations: number;
  createdAt: number;
  lastActivity: number;
  metadata: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private static readonly LOCAL_SESSION_ID = 'local';

  /** Get or create session state */
  getSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        currentDatabase: null,
        userId: null,
        activeOperations: 0,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        metadata: {},
      };
      this.sessions.set(sessionId, session);
    }
    session.lastActivity = Date.now();
    return session;
  }

  /** Get the local (stdio) session */
  getLocalSession(): SessionState {
    return this.getSession(SessionManager.LOCAL_SESSION_ID);
  }

  /** Remove a session */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Set user for a session */
  setSessionUser(sessionId: string, userId: string): void {
    const session = this.getSession(sessionId);
    session.userId = userId;
  }

  /** Get all active sessions */
  listSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /** Get session count */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Clean up expired sessions */
  cleanupExpired(ttlMs: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (id !== SessionManager.LOCAL_SESSION_ID && now - session.lastActivity > ttlMs) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

/** Singleton session manager */
export const sessionManager = new SessionManager();

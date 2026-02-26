/**
 * Document Lock Operations
 *
 * Provides database operations for document-level locking to prevent
 * concurrent edits. Supports exclusive and shared lock types with
 * automatic expiry via TTL.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module database/lock-operations
 */

import type Database from 'better-sqlite3';
import { ensureUserExists } from './user-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface LockRow {
  document_id: string;
  user_id: string;
  session_id: string;
  lock_type: string;
  reason: string | null;
  acquired_at: string;
  expires_at: string;
}

export interface AcquireLockParams {
  document_id: string;
  user_id: string;
  session_id: string;
  lock_type: string;
  reason?: string;
  ttl_minutes?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCK OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Acquire a lock on a document.
 *
 * Exclusive locks prevent any other lock. Shared locks allow other shared
 * locks but block exclusive locks. Expired locks are cleaned up first.
 *
 * @param conn - Database connection
 * @param params - Lock parameters
 * @returns The acquired lock row
 * @throws Error if document not found or lock conflict
 */
export function acquireLock(conn: Database.Database, params: AcquireLockParams): LockRow {
  // Validate document exists
  const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(params.document_id);
  if (!doc) {
    throw new Error(`Document not found: ${params.document_id}`);
  }

  // Auto-provision user if not yet in users table (FK: document_locks.user_id -> users.id)
  ensureUserExists(conn, params.user_id);

  // Clean expired locks first
  conn.prepare(`DELETE FROM document_locks WHERE expires_at < datetime('now')`).run();

  // Check for existing lock
  const existing = conn
    .prepare('SELECT * FROM document_locks WHERE document_id = ?')
    .get(params.document_id) as LockRow | undefined;

  if (existing) {
    // Same user can re-acquire their own lock
    if (existing.user_id === params.user_id) {
      // Update existing lock
      const ttlMinutes = params.ttl_minutes ?? 30;
      conn
        .prepare(
          `
        UPDATE document_locks
        SET session_id = ?, lock_type = ?, reason = ?, acquired_at = datetime('now'), expires_at = datetime('now', '+' || ? || ' minutes')
        WHERE document_id = ?
      `
        )
        .run(
          params.session_id,
          params.lock_type,
          params.reason ?? null,
          ttlMinutes,
          params.document_id
        );

      return conn
        .prepare('SELECT * FROM document_locks WHERE document_id = ?')
        .get(params.document_id) as LockRow;
    }

    if (existing.lock_type === 'exclusive') {
      throw new Error(
        `Document ${params.document_id} is exclusively locked by user ${existing.user_id} until ${existing.expires_at}`
      );
    }
    if (params.lock_type === 'exclusive') {
      throw new Error(
        `Cannot acquire exclusive lock: document ${params.document_id} has a shared lock by user ${existing.user_id}`
      );
    }
  }

  const ttlMinutes = params.ttl_minutes ?? 30;
  conn
    .prepare(
      `
    INSERT OR REPLACE INTO document_locks (document_id, user_id, session_id, lock_type, reason, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' minutes'))
  `
    )
    .run(
      params.document_id,
      params.user_id,
      params.session_id,
      params.lock_type,
      params.reason ?? null,
      ttlMinutes
    );

  return conn
    .prepare('SELECT * FROM document_locks WHERE document_id = ?')
    .get(params.document_id) as LockRow;
}

/**
 * Release a lock on a document.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @throws Error if no lock found
 */
export function releaseLock(conn: Database.Database, documentId: string): void {
  const existing = conn
    .prepare('SELECT * FROM document_locks WHERE document_id = ?')
    .get(documentId);
  if (!existing) {
    throw new Error(`No lock found for document: ${documentId}`);
  }
  conn.prepare('DELETE FROM document_locks WHERE document_id = ?').run(documentId);
}

/**
 * Get the current lock status for a document.
 * Cleans up expired locks before checking.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @returns Lock row or null if no active lock
 */
export function getLockStatus(conn: Database.Database, documentId: string): LockRow | null {
  // Clean expired locks first
  conn.prepare(`DELETE FROM document_locks WHERE expires_at < datetime('now')`).run();

  return (
    (conn
      .prepare('SELECT * FROM document_locks WHERE document_id = ?')
      .get(documentId) as LockRow) ?? null
  );
}

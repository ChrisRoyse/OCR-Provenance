/**
 * Audit Logger - Records user actions in audit_log table
 *
 * Call this from tool handlers to track mutations.
 * Audit logging is best-effort: failures are logged but never break the main operation.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/audit
 */

import { hasDatabase, requireDatabase } from '../server/state.js';
import { insertAuditLog } from './storage/database/user-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log an action to the audit_log table.
 *
 * Best-effort: if no database is selected or the insert fails,
 * the error is logged to stderr and the function returns silently.
 * Audit logging should NEVER break the main operation.
 */
export function logAudit(params: {
  userId?: string | null;
  sessionId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}): void {
  if (!hasDatabase()) return;
  try {
    const { db } = requireDatabase();
    const conn = db.getConnection();
    insertAuditLog(conn, {
      user_id: params.userId ?? null,
      session_id: params.sessionId ?? null,
      action: params.action,
      entity_type: params.entityType ?? null,
      entity_id: params.entityId ?? null,
      details_json: JSON.stringify(params.details ?? {}),
    });
  } catch (error) {
    console.error(
      `[AUDIT] Failed to log audit record for action "${params.action}": ${error instanceof Error ? error.message : String(error)}`
    );
    throw new Error(`Audit logging failed for action "${params.action}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

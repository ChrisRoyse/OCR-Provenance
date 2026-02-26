/**
 * Workflow State Database Operations
 *
 * Provides operations for the workflow state machine that tracks document
 * lifecycle states. Enforces valid state transitions to prevent invalid
 * workflow progression.
 *
 * State machine:
 *   '' -> draft -> submitted -> in_review -> approved -> executed -> archived
 *                                         \-> changes_requested -> submitted
 *                                         \-> rejected -> archived
 *                             approved -> expired (auto, past due_date)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module database/workflow-operations
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ensureUserExists } from './user-operations.js';

// =============================================================================
// TYPES
// =============================================================================

export interface WorkflowStateRow {
  id: string;
  document_id: string;
  state: string;
  assigned_to: string | null;
  assigned_by: string | null;
  reason: string | null;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  metadata_json: string | null;
}

export interface CreateWorkflowStateParams {
  document_id: string;
  state: string;
  assigned_to?: string | null;
  assigned_by?: string | null;
  reason?: string | null;
  due_date?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface WorkflowQueueFilters {
  assigned_to?: string;
  state?: string;
  due_before?: string;
  limit?: number;
  offset?: number;
}

// =============================================================================
// VALID STATE TRANSITIONS
// =============================================================================

/**
 * Map of current state -> allowed next states.
 * Empty string key represents "no existing state" (initial transition).
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  '': ['draft'],
  draft: ['submitted'],
  submitted: ['in_review'],
  in_review: ['approved', 'rejected', 'changes_requested'],
  changes_requested: ['submitted'],
  approved: ['executed', 'expired', 'archived'],
  rejected: ['archived'],
  executed: ['archived'],
};

// =============================================================================
// WORKFLOW STATE OPERATIONS
// =============================================================================

/**
 * Get the most recent workflow state for a document.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @returns Latest workflow state row or null if no workflow history
 */
export function getLatestWorkflowState(
  conn: Database.Database,
  documentId: string
): WorkflowStateRow | null {
  return (
    (conn
      .prepare(
        'SELECT * FROM workflow_states WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      )
      .get(documentId) as WorkflowStateRow) ?? null
  );
}

/**
 * Create a new workflow state for a document.
 *
 * Enforces valid state transitions. If the document has no prior workflow
 * state, only 'draft' is allowed. Otherwise the new state must be in the
 * VALID_TRANSITIONS map for the current state.
 *
 * @param conn - Database connection
 * @param params - Workflow state creation parameters
 * @returns The created workflow state row
 * @throws Error if document not found or transition is invalid
 */
export function createWorkflowState(
  conn: Database.Database,
  params: CreateWorkflowStateParams
): WorkflowStateRow {
  // Validate document exists
  const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(params.document_id);
  if (!doc) {
    throw new Error(`Document not found: ${params.document_id}`);
  }

  // Get current state to validate transition
  const current = getLatestWorkflowState(conn, params.document_id);
  const currentState = current?.state ?? '';

  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed || !allowed.includes(params.state)) {
    const currentDisplay = currentState || '(none)';
    const allowedDisplay = allowed ? allowed.join(', ') : '(none)';
    throw new Error(
      `Invalid workflow transition: cannot move from "${currentDisplay}" to "${params.state}". ` +
        `Allowed transitions from "${currentDisplay}": [${allowedDisplay}]`
    );
  }

  // Auto-provision users if referenced (FK: workflow_states.assigned_to/assigned_by -> users.id)
  if (params.assigned_to) {
    ensureUserExists(conn, params.assigned_to);
  }
  if (params.assigned_by) {
    ensureUserExists(conn, params.assigned_by);
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

  conn
    .prepare(
      `
    INSERT INTO workflow_states (id, document_id, state, assigned_to, assigned_by, reason, due_date, completed_at, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      id,
      params.document_id,
      params.state,
      params.assigned_to ?? null,
      params.assigned_by ?? null,
      params.reason ?? null,
      params.due_date ?? null,
      null, // completed_at set when reaching terminal states
      now,
      metadataJson
    );

  return conn.prepare('SELECT * FROM workflow_states WHERE id = ?').get(id) as WorkflowStateRow;
}

/**
 * List documents pending review with optional filters.
 *
 * Finds the latest workflow state per document and filters by the given
 * criteria. Useful for building reviewer queues.
 *
 * @param conn - Database connection
 * @param filters - Optional query filters
 * @returns Paginated workflow states and total count
 */
export function listWorkflowQueue(
  conn: Database.Database,
  filters: WorkflowQueueFilters
): { items: WorkflowStateRow[]; total: number } {
  // Use a CTE to get the latest state per document
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.state) {
    conditions.push('ws.state = ?');
    params.push(filters.state);
  }
  if (filters.assigned_to) {
    conditions.push('ws.assigned_to = ?');
    params.push(filters.assigned_to);
  }
  if (filters.due_before) {
    conditions.push('ws.due_date IS NOT NULL AND ws.due_date <= ?');
    params.push(filters.due_before);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  // Get latest state per document using MAX(rowid) which is strictly monotonic
  // (avoids duplicates when multiple states share the same created_at timestamp)
  const countSql = `
    SELECT COUNT(*) as c FROM (
      SELECT ws.* FROM workflow_states ws
      INNER JOIN (
        SELECT MAX(rowid) as max_rowid
        FROM workflow_states GROUP BY document_id
      ) latest ON ws.rowid = latest.max_rowid
      ${whereClause}
    )
  `;

  const totalRow = conn.prepare(countSql).get(...params) as { c: number };

  const dataSql = `
    SELECT ws.* FROM workflow_states ws
    INNER JOIN (
      SELECT MAX(rowid) as max_rowid
      FROM workflow_states GROUP BY document_id
    ) latest ON ws.rowid = latest.max_rowid
    ${whereClause}
    ORDER BY ws.due_date ASC NULLS LAST, ws.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const items = conn.prepare(dataSql).all(...params, limit, offset) as WorkflowStateRow[];

  return { items, total: totalRow.c };
}

/**
 * Get the full workflow history for a document.
 *
 * Returns all workflow state rows ordered by creation time (oldest first),
 * showing the complete state progression.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @returns Array of workflow state rows
 */
export function getWorkflowHistory(
  conn: Database.Database,
  documentId: string
): WorkflowStateRow[] {
  return conn
    .prepare('SELECT * FROM workflow_states WHERE document_id = ? ORDER BY created_at ASC')
    .all(documentId) as WorkflowStateRow[];
}

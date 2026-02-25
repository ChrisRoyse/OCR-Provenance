/**
 * Approval Chain Database Operations
 *
 * Provides operations for creating reusable approval chains and tracking
 * per-document approval progress through multi-step review processes.
 *
 * An approval chain defines a sequence of steps (roles) that must approve
 * a document. When applied to a document, individual approval_steps rows
 * are created. Steps are processed in order - the next step becomes active
 * only when the previous step is approved.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module database/approval-operations
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// TYPES
// =============================================================================

export interface ApprovalChainRow {
  id: string;
  name: string;
  description: string | null;
  steps_json: string;
  created_at: string;
  created_by: string | null;
}

export interface ApprovalStepRow {
  id: string;
  document_id: string;
  chain_id: string;
  step_order: number;
  required_role: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

export interface ApprovalChainStep {
  role: string;
  required_approvals?: number;
  auto_advance?: boolean;
}

export interface CreateApprovalChainParams {
  name: string;
  description?: string | null;
  steps: ApprovalChainStep[];
  created_by?: string | null;
}

export interface ApprovalProgress {
  chain_id: string;
  chain_name: string;
  document_id: string;
  steps: ApprovalStepRow[];
  total_steps: number;
  completed_steps: number;
  current_step: ApprovalStepRow | null;
  is_complete: boolean;
  is_rejected: boolean;
}

// =============================================================================
// APPROVAL CHAIN OPERATIONS
// =============================================================================

/**
 * Create a reusable approval chain with ordered steps.
 *
 * @param conn - Database connection
 * @param params - Chain creation parameters
 * @returns The created approval chain row
 * @throws Error if name is empty or no steps provided
 */
export function createApprovalChain(
  conn: Database.Database,
  params: CreateApprovalChainParams
): ApprovalChainRow {
  if (!params.steps || params.steps.length === 0) {
    throw new Error('Approval chain must have at least one step');
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const stepsJson = JSON.stringify(params.steps);

  conn
    .prepare(
      `
    INSERT INTO approval_chains (id, name, description, steps_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(id, params.name, params.description ?? null, stepsJson, now, params.created_by ?? null);

  return conn.prepare('SELECT * FROM approval_chains WHERE id = ?').get(id) as ApprovalChainRow;
}

/**
 * Get an approval chain by ID.
 *
 * @param conn - Database connection
 * @param chainId - Approval chain ID
 * @returns The approval chain row or null
 */
export function getApprovalChain(
  conn: Database.Database,
  chainId: string
): ApprovalChainRow | null {
  return (
    (conn.prepare('SELECT * FROM approval_chains WHERE id = ?').get(chainId) as ApprovalChainRow) ??
    null
  );
}

/**
 * List all approval chains.
 *
 * @param conn - Database connection
 * @returns Array of approval chain rows
 */
export function listApprovalChains(conn: Database.Database): ApprovalChainRow[] {
  return conn
    .prepare('SELECT * FROM approval_chains ORDER BY created_at DESC')
    .all() as ApprovalChainRow[];
}

/**
 * Apply an approval chain to a document, creating approval_steps rows.
 *
 * Creates one approval_steps row per step in the chain, all starting
 * with 'pending' status. Steps are ordered by step_order.
 *
 * @param conn - Database connection
 * @param documentId - Document ID to apply the chain to
 * @param chainId - Approval chain ID to apply
 * @returns Array of created approval step rows
 * @throws Error if document or chain not found, or chain already applied
 */
export function applyApprovalChain(
  conn: Database.Database,
  documentId: string,
  chainId: string
): ApprovalStepRow[] {
  // Validate document exists
  const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(documentId);
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }

  // Validate chain exists
  const chain = getApprovalChain(conn, chainId);
  if (!chain) {
    throw new Error(`Approval chain not found: ${chainId}`);
  }

  // Check if chain is already applied to this document
  const existing = conn
    .prepare('SELECT id FROM approval_steps WHERE document_id = ? AND chain_id = ? LIMIT 1')
    .get(documentId, chainId);
  if (existing) {
    throw new Error(`Approval chain "${chain.name}" is already applied to document ${documentId}`);
  }

  const steps: ApprovalChainStep[] = JSON.parse(chain.steps_json);
  const createdSteps: ApprovalStepRow[] = [];

  const insertStmt = conn.prepare(`
    INSERT INTO approval_steps (id, document_id, chain_id, step_order, required_role, status, decided_by, decided_at, reason)
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
  `);

  const getStmt = conn.prepare('SELECT * FROM approval_steps WHERE id = ?');

  for (let i = 0; i < steps.length; i++) {
    const stepId = uuidv4();
    insertStmt.run(stepId, documentId, chainId, i + 1, steps[i].role);
    createdSteps.push(getStmt.get(stepId) as ApprovalStepRow);
  }

  return createdSteps;
}

/**
 * Get the current (first pending) approval step for a document+chain.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @param chainId - Approval chain ID
 * @returns The first pending step, or null if all steps are decided
 */
export function getCurrentApprovalStep(
  conn: Database.Database,
  documentId: string,
  chainId: string
): ApprovalStepRow | null {
  return (
    (conn
      .prepare(
        `
    SELECT * FROM approval_steps
    WHERE document_id = ? AND chain_id = ? AND status = 'pending'
    ORDER BY step_order ASC
    LIMIT 1
  `
      )
      .get(documentId, chainId) as ApprovalStepRow) ?? null
  );
}

/**
 * Decide on an approval step (approve or reject).
 *
 * On approval: marks the step as 'approved' and returns it.
 * On rejection: marks the step as 'rejected' and skips all subsequent
 * pending steps (sets them to 'skipped').
 *
 * @param conn - Database connection
 * @param stepId - Approval step ID to decide on
 * @param decision - 'approved' or 'rejected'
 * @param userId - User ID making the decision
 * @param reason - Optional reason (required for rejection)
 * @returns The updated approval step row
 * @throws Error if step not found, not pending, or not the current step
 */
export function decideApprovalStep(
  conn: Database.Database,
  stepId: string,
  decision: 'approved' | 'rejected',
  userId: string,
  reason?: string | null
): ApprovalStepRow {
  const step = conn.prepare('SELECT * FROM approval_steps WHERE id = ?').get(stepId) as
    | ApprovalStepRow
    | undefined;

  if (!step) {
    throw new Error(`Approval step not found: ${stepId}`);
  }

  if (step.status !== 'pending') {
    throw new Error(`Approval step ${stepId} is already "${step.status}" and cannot be decided`);
  }

  // Ensure this is the current step (lowest pending step_order for this doc+chain)
  const currentStep = getCurrentApprovalStep(conn, step.document_id, step.chain_id);
  if (!currentStep || currentStep.id !== stepId) {
    throw new Error(
      `Step ${stepId} (order ${step.step_order}) is not the current step. ` +
        `Steps must be decided in order.`
    );
  }

  if (decision === 'rejected' && !reason) {
    throw new Error('Reason is required when rejecting an approval step');
  }

  const now = new Date().toISOString();

  // Update the step
  conn
    .prepare(
      `
    UPDATE approval_steps SET status = ?, decided_by = ?, decided_at = ?, reason = ?
    WHERE id = ?
  `
    )
    .run(decision, userId, now, reason ?? null, stepId);

  // On rejection, skip all subsequent pending steps
  if (decision === 'rejected') {
    conn
      .prepare(
        `
      UPDATE approval_steps
      SET status = 'skipped', decided_at = ?, reason = 'Skipped due to rejection at step ' || ?
      WHERE document_id = ? AND chain_id = ? AND step_order > ? AND status = 'pending'
    `
      )
      .run(now, step.step_order, step.document_id, step.chain_id, step.step_order);
  }

  return conn.prepare('SELECT * FROM approval_steps WHERE id = ?').get(stepId) as ApprovalStepRow;
}

/**
 * Get approval progress for a document and chain.
 *
 * Returns all steps with summary counts and the current pending step.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @param chainId - Approval chain ID
 * @returns Approval progress with steps and summary
 * @throws Error if chain not found or not applied to document
 */
export function getApprovalProgress(
  conn: Database.Database,
  documentId: string,
  chainId: string
): ApprovalProgress {
  const chain = getApprovalChain(conn, chainId);
  if (!chain) {
    throw new Error(`Approval chain not found: ${chainId}`);
  }

  const steps = conn
    .prepare(
      `
    SELECT * FROM approval_steps
    WHERE document_id = ? AND chain_id = ?
    ORDER BY step_order ASC
  `
    )
    .all(documentId, chainId) as ApprovalStepRow[];

  if (steps.length === 0) {
    throw new Error(
      `Approval chain "${chain.name}" has not been applied to document ${documentId}`
    );
  }

  const completedSteps = steps.filter(
    (s) => s.status === 'approved' || s.status === 'rejected' || s.status === 'skipped'
  ).length;

  const currentStep = steps.find((s) => s.status === 'pending') ?? null;
  const isRejected = steps.some((s) => s.status === 'rejected');
  const isComplete = currentStep === null;

  return {
    chain_id: chainId,
    chain_name: chain.name,
    document_id: documentId,
    steps,
    total_steps: steps.length,
    completed_steps: completedSteps,
    current_step: currentStep,
    is_complete: isComplete,
    is_rejected: isRejected,
  };
}

/**
 * Workflow and Approval Chain Tools
 *
 * Provides 8 MCP tools for document workflow state management and
 * multi-step approval chains:
 * - ocr_workflow_submit/review/assign/status/queue (5 workflow tools)
 * - ocr_approval_chain_create/apply (2 approval chain tools)
 * - ocr_approval_step_decide (1 approval step tool)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/workflow
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import { logAudit } from '../services/audit.js';
import {
  getLatestWorkflowState,
  createWorkflowState,
  listWorkflowQueue,
  getWorkflowHistory,
} from '../services/storage/database/workflow-operations.js';
import {
  createApprovalChain,
  applyApprovalChain,
  getCurrentApprovalStep,
  decideApprovalStep,
  getApprovalProgress,
} from '../services/storage/database/approval-operations.js';

// =============================================================================
// SCHEMAS
// =============================================================================

const WorkflowDecisionSchema = z.enum(['approved', 'rejected', 'changes_requested']);
const ApprovalDecisionSchema = z.enum(['approved', 'rejected']);

// =============================================================================
// TOOL 3.1: ocr_workflow_submit
// =============================================================================

async function handleWorkflowSubmit(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        assigned_to: z.string().min(1).optional(),
        due_date: z.string().min(1).optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Check current state - create draft first if no workflow history exists
    const current = getLatestWorkflowState(conn, input.document_id);
    if (!current) {
      // No workflow history - create draft first, then submit
      createWorkflowState(conn, {
        document_id: input.document_id,
        state: 'draft',
      });
    }

    // Now transition to submitted
    const submitted = createWorkflowState(conn, {
      document_id: input.document_id,
      state: 'submitted',
      assigned_to: input.assigned_to,
      due_date: input.due_date,
      metadata: input.metadata,
    });

    logAudit({
      action: 'workflow_transition',
      entityType: 'document',
      entityId: input.document_id,
      details: { old_state: current?.state ?? null, new_state: 'submitted' },
    });

    return formatResponse(
      successResult({
        workflow_state: submitted,
        next_steps: [
          { tool: 'ocr_workflow_status', description: 'Check workflow status for this document' },
          { tool: 'ocr_workflow_assign', description: 'Assign a reviewer to this document' },
          { tool: 'ocr_workflow_queue', description: 'View all pending review documents' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.2: ocr_workflow_review
// =============================================================================

async function handleWorkflowReview(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        decision: WorkflowDecisionSchema,
        reason: z.string().max(2000).optional(),
      }),
      params
    );

    // Reason required for reject/changes_requested
    if (
      (input.decision === 'rejected' || input.decision === 'changes_requested') &&
      !input.reason
    ) {
      throw new Error(`Reason is required when decision is "${input.decision}"`);
    }

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify current state is in_review
    const current = getLatestWorkflowState(conn, input.document_id);
    if (!current) {
      throw new Error(`No workflow history found for document ${input.document_id}`);
    }
    if (current.state !== 'in_review') {
      throw new Error(
        `Cannot review document ${input.document_id}: current state is "${current.state}", ` +
          `must be "in_review". Use ocr_workflow_status to check the current state.`
      );
    }

    const reviewed = createWorkflowState(conn, {
      document_id: input.document_id,
      state: input.decision,
      reason: input.reason,
      assigned_to: current.assigned_to,
    });

    logAudit({
      action: 'workflow_transition',
      entityType: 'document',
      entityId: input.document_id,
      details: { old_state: 'in_review', new_state: input.decision, reason: input.reason ?? null },
    });

    const nextSteps = [];
    if (input.decision === 'approved') {
      nextSteps.push(
        { tool: 'ocr_workflow_status', description: 'View updated workflow status' },
        {
          tool: 'ocr_approval_chain_apply',
          description: 'Apply an approval chain for formal sign-off',
        }
      );
    } else if (input.decision === 'changes_requested') {
      nextSteps.push(
        { tool: 'ocr_workflow_status', description: 'View updated workflow status' },
        {
          tool: 'ocr_annotation_create',
          description: 'Add annotations detailing requested changes',
        }
      );
    } else {
      nextSteps.push({ tool: 'ocr_workflow_status', description: 'View updated workflow status' });
    }

    return formatResponse(
      successResult({
        workflow_state: reviewed,
        decision: input.decision,
        next_steps: nextSteps,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.3: ocr_workflow_assign
// =============================================================================

async function handleWorkflowAssign(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        user_id: z.string().min(1),
        assigned_by: z.string().min(1).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Get current workflow state
    const current = getLatestWorkflowState(conn, input.document_id);
    if (!current) {
      throw new Error(`No workflow history found for document ${input.document_id}`);
    }

    // Only allow assignment when in submitted or in_review state
    if (current.state !== 'submitted' && current.state !== 'in_review') {
      throw new Error(
        `Cannot assign reviewer: document ${input.document_id} is in state "${current.state}". ` +
          `Document must be in "submitted" or "in_review" state.`
      );
    }

    // If submitted, transition to in_review with the assigned reviewer
    if (current.state === 'submitted') {
      const inReview = createWorkflowState(conn, {
        document_id: input.document_id,
        state: 'in_review',
        assigned_to: input.user_id,
        assigned_by: input.assigned_by,
        due_date: current.due_date,
      });

      logAudit({
        action: 'workflow_transition',
        entityType: 'document',
        entityId: input.document_id,
        details: { old_state: 'submitted', new_state: 'in_review', assigned_to: input.user_id },
      });

      return formatResponse(
        successResult({
          workflow_state: inReview,
          assigned_to: input.user_id,
          transitioned_to: 'in_review',
          next_steps: [
            {
              tool: 'ocr_workflow_review',
              description: 'Review this document (approve/reject/request changes)',
            },
            { tool: 'ocr_workflow_status', description: 'Check workflow status' },
          ],
        })
      );
    }

    // Already in_review - update assignment via metadata
    // We create a new in_review state with the updated assignment
    // (This is valid because in_review -> in_review is not in transitions,
    //  so we update the current row directly instead)
    conn
      .prepare(
        `
      UPDATE workflow_states SET assigned_to = ?, assigned_by = ?
      WHERE id = ?
    `
      )
      .run(input.user_id, input.assigned_by ?? null, current.id);

    const updated = conn
      .prepare('SELECT * FROM workflow_states WHERE id = ?')
      .get(current.id) as Record<string, unknown>;

    logAudit({
      action: 'workflow_reassign',
      entityType: 'document',
      entityId: input.document_id,
      details: { assigned_to: input.user_id, assigned_by: input.assigned_by ?? null },
    });

    return formatResponse(
      successResult({
        workflow_state: updated,
        assigned_to: input.user_id,
        reassigned: true,
        next_steps: [
          { tool: 'ocr_workflow_review', description: 'Review this document' },
          { tool: 'ocr_workflow_status', description: 'Check workflow status' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.4: ocr_workflow_status
// =============================================================================

async function handleWorkflowStatus(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists before querying workflow states
    const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    const current = getLatestWorkflowState(conn, input.document_id);
    const history = getWorkflowHistory(conn, input.document_id);

    if (!current) {
      return formatResponse(
        successResult({
          document_id: input.document_id,
          current_state: null,
          history: [],
          message: 'No workflow history for this document',
          next_steps: [
            { tool: 'ocr_workflow_submit', description: 'Submit this document for review' },
          ],
        })
      );
    }

    // Check for approval chains applied to this document
    const approvalSteps = conn
      .prepare('SELECT DISTINCT chain_id FROM approval_steps WHERE document_id = ?')
      .all(input.document_id) as { chain_id: string }[];

    const nextSteps = [];
    switch (current.state) {
      case 'draft':
        nextSteps.push({ tool: 'ocr_workflow_submit', description: 'Submit for review' });
        break;
      case 'submitted':
        nextSteps.push(
          { tool: 'ocr_workflow_assign', description: 'Assign a reviewer' },
          { tool: 'ocr_workflow_queue', description: 'View review queue' }
        );
        break;
      case 'in_review':
        nextSteps.push({ tool: 'ocr_workflow_review', description: 'Make a review decision' });
        break;
      case 'changes_requested':
        nextSteps.push({ tool: 'ocr_workflow_submit', description: 'Re-submit after changes' });
        break;
      case 'approved':
        nextSteps.push(
          { tool: 'ocr_approval_chain_apply', description: 'Apply an approval chain' },
          { tool: 'ocr_workflow_queue', description: 'View review queue' }
        );
        break;
      default:
        nextSteps.push({ tool: 'ocr_workflow_queue', description: 'View review queue' });
    }

    return formatResponse(
      successResult({
        document_id: input.document_id,
        current_state: current,
        history,
        approval_chains_applied: approvalSteps.map((s) => s.chain_id),
        next_steps: nextSteps,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.5: ocr_workflow_queue
// =============================================================================

async function handleWorkflowQueue(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        assigned_to: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        due_before: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const result = listWorkflowQueue(conn, {
      assigned_to: input.assigned_to,
      state: input.state,
      due_before: input.due_before,
      limit,
      offset,
    });

    const hasMore = offset + result.items.length < result.total;

    return formatResponse(
      successResult({
        items: result.items,
        total: result.total,
        limit,
        offset,
        has_more: hasMore,
        next_steps: hasMore
          ? [
              {
                tool: 'ocr_workflow_queue',
                description: `Get next page with offset=${offset + limit}`,
              },
            ]
          : [
              { tool: 'ocr_workflow_status', description: 'Get details for a specific document' },
              { tool: 'ocr_workflow_review', description: 'Review a document from the queue' },
              { tool: 'ocr_workflow_assign', description: 'Assign a reviewer to a document' },
            ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.6: ocr_approval_chain_create
// =============================================================================

async function handleApprovalChainCreate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        steps: z
          .array(
            z.object({
              role: z.string().min(1),
              required_approvals: z.number().int().min(1).optional(),
              auto_advance: z.boolean().optional(),
            })
          )
          .min(1),
        created_by: z.string().min(1).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const chain = createApprovalChain(conn, {
      name: input.name,
      description: input.description,
      steps: input.steps,
      created_by: input.created_by,
    });

    return formatResponse(
      successResult({
        chain,
        steps_count: input.steps.length,
        next_steps: [
          { tool: 'ocr_approval_chain_apply', description: 'Apply this chain to a document' },
          { tool: 'ocr_approval_chain_create', description: 'Create another approval chain' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.7: ocr_approval_chain_apply
// =============================================================================

async function handleApprovalChainApply(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        chain_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const steps = applyApprovalChain(conn, input.document_id, input.chain_id);
    const currentStep = steps.length > 0 ? steps[0] : null;

    return formatResponse(
      successResult({
        document_id: input.document_id,
        chain_id: input.chain_id,
        steps_created: steps.length,
        steps,
        current_step: currentStep,
        next_steps: [
          { tool: 'ocr_approval_step_decide', description: 'Decide on the current approval step' },
          {
            tool: 'ocr_workflow_status',
            description: 'View full workflow status including approvals',
          },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 3.8: ocr_approval_step_decide
// =============================================================================

async function handleApprovalStepDecide(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        chain_id: z.string().min(1),
        decision: ApprovalDecisionSchema,
        user_id: z.string().min(1),
        reason: z.string().max(2000).optional(),
      }),
      params
    );

    if (input.decision === 'rejected' && !input.reason) {
      throw new Error('Reason is required when rejecting an approval step');
    }

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Get the current step for this document+chain
    const currentStep = getCurrentApprovalStep(conn, input.document_id, input.chain_id);
    if (!currentStep) {
      // Check if chain is applied
      const anySteps = conn
        .prepare('SELECT id FROM approval_steps WHERE document_id = ? AND chain_id = ? LIMIT 1')
        .get(input.document_id, input.chain_id);

      if (!anySteps) {
        throw new Error(
          `No approval chain applied. Use ocr_approval_chain_apply first to apply chain ${input.chain_id} to document ${input.document_id}`
        );
      }

      throw new Error(
        `All approval steps for this chain have already been decided. No pending steps remain.`
      );
    }

    const decided = decideApprovalStep(
      conn,
      currentStep.id,
      input.decision,
      input.user_id,
      input.reason
    );

    // Get updated progress
    const progress = getApprovalProgress(conn, input.document_id, input.chain_id);

    const nextSteps = [];
    if (progress.current_step) {
      nextSteps.push({
        tool: 'ocr_approval_step_decide',
        description: `Decide on next step (${progress.current_step.required_role}, order ${progress.current_step.step_order})`,
      });
    }
    if (progress.is_complete && !progress.is_rejected) {
      nextSteps.push({ tool: 'ocr_workflow_status', description: 'View final workflow status' });
    }
    if (progress.is_rejected) {
      nextSteps.push({
        tool: 'ocr_workflow_status',
        description: 'View workflow status after rejection',
      });
    }
    if (nextSteps.length === 0) {
      nextSteps.push({ tool: 'ocr_workflow_status', description: 'View workflow status' });
    }

    return formatResponse(
      successResult({
        step: decided,
        progress: {
          total_steps: progress.total_steps,
          completed_steps: progress.completed_steps,
          is_complete: progress.is_complete,
          is_rejected: progress.is_rejected,
          current_step: progress.current_step,
        },
        next_steps: nextSteps,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL DEFINITIONS EXPORT
// =============================================================================

export const workflowTools: Record<string, ToolDefinition> = {
  ocr_workflow_submit: {
    description:
      '[MANAGE] Submit a document for review. Creates a draft state first if no workflow history exists, then transitions to submitted. Optionally assign a reviewer and set a due date.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to submit for review'),
      assigned_to: z.string().min(1).optional().describe('User ID of the reviewer to assign'),
      due_date: z.string().min(1).optional().describe('Due date for review (ISO 8601 datetime)'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Optional metadata object to attach to the workflow state'),
    },
    handler: handleWorkflowSubmit,
  },

  ocr_workflow_review: {
    description:
      '[MANAGE] Review a document: approve, reject, or request changes. Document must be in "in_review" state. Reason is required for reject or changes_requested decisions.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to review'),
      decision: WorkflowDecisionSchema.describe(
        'Review decision: approved, rejected, or changes_requested'
      ),
      reason: z
        .string()
        .max(2000)
        .optional()
        .describe('Reason for the decision (required for reject/changes_requested)'),
    },
    handler: handleWorkflowReview,
  },

  ocr_workflow_assign: {
    description:
      '[MANAGE] Assign or reassign a reviewer to a document. If the document is in "submitted" state, it transitions to "in_review". If already "in_review", updates the assignment.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to assign reviewer to'),
      user_id: z.string().min(1).describe('User ID of the reviewer to assign'),
      assigned_by: z
        .string()
        .min(1)
        .optional()
        .describe('User ID of the person making the assignment'),
    },
    handler: handleWorkflowAssign,
  },

  ocr_workflow_status: {
    description:
      '[STATUS] Get the current workflow state and full history for a document. Shows current state, all transitions, and any applied approval chains.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to check workflow status for'),
    },
    handler: handleWorkflowStatus,
  },

  ocr_workflow_queue: {
    description:
      '[STATUS] List documents in the workflow queue. Filter by assigned reviewer, state, or due date. Returns paginated results sorted by due date then creation time.',
    inputSchema: {
      assigned_to: z.string().min(1).optional().describe('Filter by assigned reviewer user ID'),
      state: z
        .string()
        .min(1)
        .optional()
        .describe('Filter by workflow state (e.g., "submitted", "in_review")'),
      due_before: z
        .string()
        .min(1)
        .optional()
        .describe('Filter documents due before this ISO 8601 datetime'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe('Max results (1-200, default 50)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    handler: handleWorkflowQueue,
  },

  ocr_approval_chain_create: {
    description:
      '[MANAGE] Create a reusable approval chain with ordered steps. Each step specifies a required role. Chains can be applied to multiple documents for formal multi-step approval.',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Name for the approval chain'),
      description: z.string().max(1000).optional().describe('Description of the approval chain'),
      steps: z
        .array(
          z.object({
            role: z
              .string()
              .min(1)
              .describe('Required role for this step (e.g., "reviewer", "legal", "manager")'),
            required_approvals: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('Number of approvals needed (default 1)'),
            auto_advance: z
              .boolean()
              .optional()
              .describe('Auto-advance to next step on approval (default true)'),
          })
        )
        .min(1)
        .describe('Ordered list of approval steps'),
      created_by: z.string().min(1).optional().describe('User ID of the chain creator'),
    },
    handler: handleApprovalChainCreate,
  },

  ocr_approval_chain_apply: {
    description:
      '[MANAGE] Apply an existing approval chain to a document. Creates pending approval steps for each step in the chain. Steps must be decided in order.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to apply the approval chain to'),
      chain_id: z.string().min(1).describe('Approval chain ID to apply'),
    },
    handler: handleApprovalChainApply,
  },

  ocr_approval_step_decide: {
    description:
      '[MANAGE] Decide on the current approval step for a document. Approve to advance to the next step, or reject to stop the chain (remaining steps are skipped). Reason is required for rejection.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      chain_id: z.string().min(1).describe('Approval chain ID'),
      decision: ApprovalDecisionSchema.describe('Decision: approved or rejected'),
      user_id: z.string().min(1).describe('User ID making the decision'),
      reason: z
        .string()
        .max(2000)
        .optional()
        .describe('Reason for the decision (required for rejection)'),
    },
    handler: handleApprovalStepDecide,
  },
};

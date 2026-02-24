/**
 * Document Collaboration Tools
 *
 * Provides 11 MCP tools for annotations, document locking, and search alerts:
 * - ocr_annotation_create/list/get/update/delete/summary (6 annotation tools)
 * - ocr_document_lock/unlock/lock_status (3 lock tools)
 * - ocr_search_alert_enable/check (2 search alert tools)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/collaboration
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import {
  createAnnotation,
  getAnnotationWithThread,
  listAnnotations,
  updateAnnotation,
  deleteAnnotation,
  getAnnotationSummary,
} from '../services/storage/database/annotation-operations.js';
import {
  acquireLock,
  releaseLock,
  getLockStatus,
} from '../services/storage/database/lock-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const AnnotationTypeSchema = z.enum(['comment', 'correction', 'question', 'highlight', 'flag', 'approval']);
const AnnotationStatusSchema = z.enum(['open', 'resolved', 'dismissed']);
const LockTypeSchema = z.enum(['exclusive', 'shared']);

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.1: ocr_annotation_create
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAnnotationCreate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        user_id: z.string().min(1).optional(),
        chunk_id: z.string().min(1).optional(),
        page_number: z.number().int().min(0).optional(),
        annotation_type: AnnotationTypeSchema,
        content: z.string().min(1).max(10000),
        parent_id: z.string().min(1).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const annotation = createAnnotation(conn, {
      document_id: input.document_id,
      user_id: input.user_id ?? null,
      chunk_id: input.chunk_id ?? null,
      page_number: input.page_number ?? null,
      annotation_type: input.annotation_type,
      content: input.content,
      parent_id: input.parent_id ?? null,
    });

    return formatResponse(
      successResult({
        annotation,
        next_steps: [
          { tool: 'ocr_annotation_list', description: 'List all annotations on this document' },
          { tool: 'ocr_annotation_get', description: 'Get this annotation with its thread replies' },
          { tool: 'ocr_annotation_update', description: 'Edit or resolve this annotation' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.2: ocr_annotation_list
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAnnotationList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        annotation_type: AnnotationTypeSchema.optional(),
        status: AnnotationStatusSchema.optional(),
        user_id: z.string().min(1).optional(),
        page_number: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const result = listAnnotations(conn, {
      document_id: input.document_id,
      annotation_type: input.annotation_type,
      status: input.status,
      user_id: input.user_id,
      page_number: input.page_number,
      limit: input.limit,
      offset: input.offset,
    });

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const hasMore = offset + result.annotations.length < result.total;

    return formatResponse(
      successResult({
        annotations: result.annotations,
        total: result.total,
        limit,
        offset,
        has_more: hasMore,
        next_steps: hasMore
          ? [{ tool: 'ocr_annotation_list', description: `Get next page with offset=${offset + limit}` }]
          : [
              { tool: 'ocr_annotation_create', description: 'Add a new annotation' },
              { tool: 'ocr_annotation_summary', description: 'Get annotation summary for this document' },
            ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.3: ocr_annotation_get
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAnnotationGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        annotation_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const result = getAnnotationWithThread(conn, input.annotation_id);
    if (!result) {
      throw new Error(`Annotation not found: ${input.annotation_id}`);
    }

    return formatResponse(
      successResult({
        annotation: result.annotation,
        replies: result.replies,
        reply_count: result.replies.length,
        next_steps: [
          { tool: 'ocr_annotation_create', description: 'Reply to this annotation (set parent_id)' },
          { tool: 'ocr_annotation_update', description: 'Edit or resolve this annotation' },
          { tool: 'ocr_annotation_delete', description: 'Delete this annotation' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.4: ocr_annotation_update
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAnnotationUpdate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        annotation_id: z.string().min(1),
        content: z.string().min(1).max(10000).optional(),
        status: AnnotationStatusSchema.optional(),
      }),
      params
    );

    if (input.content === undefined && input.status === undefined) {
      throw new Error('At least one of content or status must be provided');
    }

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const updated = updateAnnotation(conn, input.annotation_id, {
      content: input.content,
      status: input.status,
    });

    return formatResponse(
      successResult({
        annotation: updated,
        next_steps: [
          { tool: 'ocr_annotation_get', description: 'View this annotation with thread' },
          { tool: 'ocr_annotation_list', description: 'List annotations on this document' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.5: ocr_annotation_delete
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAnnotationDelete(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        annotation_id: z.string().min(1),
        confirm: z.literal(true),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    deleteAnnotation(conn, input.annotation_id);

    return formatResponse(
      successResult({
        deleted: true,
        annotation_id: input.annotation_id,
        next_steps: [
          { tool: 'ocr_annotation_list', description: 'List remaining annotations' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.6: ocr_annotation_summary
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAnnotationSummary(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const summary = getAnnotationSummary(conn, input.document_id);

    return formatResponse(
      successResult({
        ...summary,
        next_steps: [
          { tool: 'ocr_annotation_list', description: 'List annotations with filters' },
          { tool: 'ocr_annotation_create', description: 'Add a new annotation' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.7: ocr_document_lock
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDocumentLock(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        user_id: z.string().min(1),
        session_id: z.string().min(1),
        lock_type: LockTypeSchema.default('exclusive'),
        reason: z.string().max(500).optional(),
        ttl_minutes: z.number().int().min(1).max(1440).default(30),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const lock = acquireLock(conn, {
      document_id: input.document_id,
      user_id: input.user_id,
      session_id: input.session_id,
      lock_type: input.lock_type ?? 'exclusive',
      reason: input.reason,
      ttl_minutes: input.ttl_minutes,
    });

    return formatResponse(
      successResult({
        lock,
        next_steps: [
          { tool: 'ocr_document_unlock', description: 'Release this lock when done' },
          { tool: 'ocr_document_lock_status', description: 'Check lock status' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.8: ocr_document_unlock
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDocumentUnlock(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    releaseLock(conn, input.document_id);

    return formatResponse(
      successResult({
        released: true,
        document_id: input.document_id,
        next_steps: [
          { tool: 'ocr_document_lock_status', description: 'Verify lock was released' },
          { tool: 'ocr_document_get', description: 'View document details' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.9: ocr_document_lock_status
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDocumentLockStatus(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const lock = getLockStatus(conn, input.document_id);

    return formatResponse(
      successResult({
        is_locked: lock !== null,
        lock,
        next_steps: lock
          ? [
              { tool: 'ocr_document_unlock', description: 'Release this lock' },
              { tool: 'ocr_document_lock', description: 'Acquire a lock (if expired or not locked)' },
            ]
          : [
              { tool: 'ocr_document_lock', description: 'Acquire a lock on this document' },
            ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.10: ocr_search_alert_enable
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSearchAlertEnable(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        saved_search_id: z.string().min(1),
        enabled: z.boolean().default(true),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify saved search exists
    const row = conn.prepare(
      'SELECT id, name, query FROM saved_searches WHERE id = ?'
    ).get(input.saved_search_id) as { id: string; name: string; query: string } | undefined;

    if (!row) {
      throw new Error(`Saved search not found: ${input.saved_search_id}`);
    }

    conn.prepare(
      'UPDATE saved_searches SET alert_enabled = ? WHERE id = ?'
    ).run(input.enabled ? 1 : 0, input.saved_search_id);

    return formatResponse(
      successResult({
        saved_search_id: row.id,
        name: row.name,
        alert_enabled: input.enabled,
        next_steps: [
          { tool: 'ocr_search_alert_check', description: 'Check for new matches since last alert' },
          { tool: 'ocr_search_saved', description: 'List or execute saved searches' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2.11: ocr_search_alert_check
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSearchAlertCheck(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        saved_search_id: z.string().min(1).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // If specific search ID given, check just that one
    if (input.saved_search_id) {
      const row = conn.prepare(
        'SELECT id, name, query, search_type, result_count, result_ids, alert_enabled, last_alert_at FROM saved_searches WHERE id = ?'
      ).get(input.saved_search_id) as {
        id: string; name: string; query: string; search_type: string;
        result_count: number; result_ids: string; alert_enabled: number; last_alert_at: string | null;
      } | undefined;

      if (!row) {
        throw new Error(`Saved search not found: ${input.saved_search_id}`);
      }

      if (!row.alert_enabled) {
        throw new Error(`Alerts are not enabled for saved search "${row.name}". Use ocr_search_alert_enable first.`);
      }

      // Find new documents since last alert
      const since = row.last_alert_at ?? row.query; // If never alerted, use creation baseline
      const newDocs = conn.prepare(`
        SELECT id, file_name, created_at FROM documents
        WHERE created_at > ?
        ORDER BY created_at DESC
        LIMIT 50
      `).all(since) as { id: string; file_name: string; created_at: string }[];

      // Update last_alert_at
      conn.prepare(
        'UPDATE saved_searches SET last_alert_at = ? WHERE id = ?'
      ).run(new Date().toISOString(), row.id);

      return formatResponse(
        successResult({
          saved_search_id: row.id,
          name: row.name,
          query: row.query,
          new_documents_since_last_alert: newDocs.length,
          new_documents: newDocs,
          last_alert_at: row.last_alert_at,
          checked_at: new Date().toISOString(),
          next_steps: newDocs.length > 0
            ? [
                { tool: 'ocr_search', description: `Re-run search "${row.query}" to find matches in new documents` },
                { tool: 'ocr_search_saved', description: 'Execute saved search to get updated results' },
              ]
            : [
                { tool: 'ocr_search_saved', description: 'List saved searches' },
              ],
        })
      );
    }

    // No specific ID - check all alert-enabled searches
    const alertSearches = conn.prepare(
      'SELECT id, name, query, search_type, result_count, alert_enabled, last_alert_at FROM saved_searches WHERE alert_enabled = 1'
    ).all() as {
      id: string; name: string; query: string; search_type: string;
      result_count: number; alert_enabled: number; last_alert_at: string | null;
    }[];

    const results = alertSearches.map((row) => {
      const since = row.last_alert_at ?? '1970-01-01T00:00:00.000Z';
      const newDocCount = (conn.prepare(
        'SELECT COUNT(*) as c FROM documents WHERE created_at > ?'
      ).get(since) as { c: number }).c;

      return {
        saved_search_id: row.id,
        name: row.name,
        query: row.query,
        new_documents_since_last_alert: newDocCount,
        last_alert_at: row.last_alert_at,
      };
    });

    const totalNew = results.reduce((sum, r) => sum + r.new_documents_since_last_alert, 0);

    return formatResponse(
      successResult({
        alert_searches: results,
        total_alert_searches: results.length,
        total_new_documents: totalNew,
        checked_at: new Date().toISOString(),
        next_steps: results.length === 0
          ? [{ tool: 'ocr_search_alert_enable', description: 'Enable alerts on a saved search' }]
          : [
              { tool: 'ocr_search_alert_check', description: 'Check a specific search with saved_search_id' },
              { tool: 'ocr_search_saved', description: 'Execute a saved search' },
            ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const collaborationTools: Record<string, ToolDefinition> = {
  ocr_annotation_create: {
    description:
      '[MANAGE] Create an annotation on a document or chunk. Types: comment, correction, question, highlight, flag, approval. Set parent_id to reply to an existing annotation (threading).',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to annotate'),
      user_id: z.string().min(1).optional().describe('User ID of the annotator'),
      chunk_id: z.string().min(1).optional().describe('Chunk ID to annotate (optional, for chunk-level annotations)'),
      page_number: z.number().int().min(0).optional().describe('Page number (0-indexed) for page-level annotations'),
      annotation_type: AnnotationTypeSchema.describe('Type: comment, correction, question, highlight, flag, or approval'),
      content: z.string().min(1).max(10000).describe('Annotation text content'),
      parent_id: z.string().min(1).optional().describe('Parent annotation ID for threaded replies'),
    },
    handler: handleAnnotationCreate,
  },

  ocr_annotation_list: {
    description:
      '[STATUS] List annotations on a document with optional filters. Filter by type, status, user, or page. Returns paginated results.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to list annotations for'),
      annotation_type: AnnotationTypeSchema.optional().describe('Filter by type: comment, correction, question, highlight, flag, approval'),
      status: AnnotationStatusSchema.optional().describe('Filter by status: open, resolved, dismissed'),
      user_id: z.string().min(1).optional().describe('Filter by user ID'),
      page_number: z.number().int().min(0).optional().describe('Filter by page number'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max results (1-200)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    handler: handleAnnotationList,
  },

  ocr_annotation_get: {
    description:
      '[STATUS] Get an annotation with its threaded replies. Returns the annotation and all direct replies sorted by creation time.',
    inputSchema: {
      annotation_id: z.string().min(1).describe('Annotation ID to retrieve'),
    },
    handler: handleAnnotationGet,
  },

  ocr_annotation_update: {
    description:
      '[MANAGE] Edit annotation content or change status to resolved/dismissed. At least one of content or status must be provided.',
    inputSchema: {
      annotation_id: z.string().min(1).describe('Annotation ID to update'),
      content: z.string().min(1).max(10000).optional().describe('New annotation content'),
      status: AnnotationStatusSchema.optional().describe('New status: open, resolved, or dismissed'),
    },
    handler: handleAnnotationUpdate,
  },

  ocr_annotation_delete: {
    description:
      '[DESTRUCTIVE] Delete an annotation and its threaded replies. Requires confirm=true.',
    inputSchema: {
      annotation_id: z.string().min(1).describe('Annotation ID to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleAnnotationDelete,
  },

  ocr_annotation_summary: {
    description:
      '[STATUS] Get annotation statistics for a document. Returns counts by type and status (open/resolved/dismissed).',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to summarize annotations for'),
    },
    handler: handleAnnotationSummary,
  },

  ocr_document_lock: {
    description:
      '[MANAGE] Acquire a lock on a document to prevent concurrent edits. Lock types: exclusive (blocks all others) or shared (allows other shared locks). Locks auto-expire after ttl_minutes.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to lock'),
      user_id: z.string().min(1).describe('User ID acquiring the lock'),
      session_id: z.string().min(1).describe('Session ID for the lock'),
      lock_type: LockTypeSchema.default('exclusive').describe('Lock type: exclusive or shared'),
      reason: z.string().max(500).optional().describe('Reason for locking'),
      ttl_minutes: z.number().int().min(1).max(1440).default(30).describe('Lock TTL in minutes (1-1440, default 30)'),
    },
    handler: handleDocumentLock,
  },

  ocr_document_unlock: {
    description:
      '[MANAGE] Release a lock on a document. Removes the lock regardless of lock type or owner.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to unlock'),
    },
    handler: handleDocumentUnlock,
  },

  ocr_document_lock_status: {
    description:
      '[STATUS] Check the lock status of a document. Returns lock details if locked, or null if unlocked. Expired locks are auto-cleaned.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to check lock status'),
    },
    handler: handleDocumentLockStatus,
  },

  ocr_search_alert_enable: {
    description:
      '[MANAGE] Enable or disable alerts on a saved search. When enabled, use ocr_search_alert_check to detect new documents since the last alert.',
    inputSchema: {
      saved_search_id: z.string().min(1).describe('Saved search ID to enable/disable alerts on'),
      enabled: z.boolean().default(true).describe('Set true to enable alerts, false to disable'),
    },
    handler: handleSearchAlertEnable,
  },

  ocr_search_alert_check: {
    description:
      '[STATUS] Check for new documents since the last alert on alert-enabled saved searches. If saved_search_id is given, checks that one; otherwise checks all alert-enabled searches.',
    inputSchema: {
      saved_search_id: z.string().min(1).optional().describe('Specific saved search ID to check (omit to check all)'),
    },
    handler: handleSearchAlertCheck,
  },
};

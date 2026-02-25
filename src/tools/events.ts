/**
 * Event System and Export Tools
 *
 * Provides 6 MCP tools for webhook management and data exports:
 * - ocr_webhook_create/list/delete (3 webhook tools)
 * - ocr_export_obligations_csv (1 obligation export tool)
 * - ocr_export_audit_log (1 audit log export tool)
 * - ocr_export_annotations (1 annotation export tool)
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/events
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import { VALID_EVENT_TYPES } from '../server/events.js';

// =============================================================================
// SCHEMAS
// =============================================================================

const EventTypeSchema = z.enum([
  'document.ingested',
  'document.processed',
  'document.deleted',
  'workflow.state_changed',
  'annotation.created',
  'annotation.resolved',
  'search.alert_triggered',
  'obligation.overdue',
  'webhook.triggered',
  'user.created',
  '*',
]);

const ExportFormatSchema = z.enum(['csv', 'json']);

// =============================================================================
// CSV HELPERS
// =============================================================================

/**
 * Escape a value for RFC 4180 CSV.
 * Wraps in double quotes if the value contains commas, quotes, or newlines.
 */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of objects to RFC 4180 CSV string.
 */
function toCSV(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(',');
  const dataRows = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','));
  return [header, ...dataRows].join('\n');
}

// =============================================================================
// TOOL 5.1: ocr_webhook_create
// =============================================================================

async function handleWebhookCreate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        url: z.string().url('Must be a valid URL'),
        events: z.array(EventTypeSchema).min(1, 'At least one event type is required'),
        secret: z.string().min(1).max(256).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Validate all event types
    for (const evt of input.events) {
      if (evt !== '*' && !VALID_EVENT_TYPES.includes(evt as (typeof VALID_EVENT_TYPES)[number])) {
        throw new Error(
          `Invalid event type: ${evt}. Valid types: ${VALID_EVENT_TYPES.join(', ')}, *`
        );
      }
    }

    const eventsStr = input.events.join(',');

    const result = conn
      .prepare(
        `INSERT INTO webhooks (url, events, secret) VALUES (?, ?, ?) RETURNING id, url, events, is_active, created_at`
      )
      .get(input.url, eventsStr, input.secret ?? null) as {
      id: string;
      url: string;
      events: string;
      is_active: number;
      created_at: string;
    };

    return formatResponse(
      successResult({
        webhook: {
          id: result.id,
          url: result.url,
          events: result.events.split(','),
          is_active: result.is_active === 1,
          has_secret: input.secret !== undefined,
          created_at: result.created_at,
        },
        next_steps: [
          { tool: 'ocr_webhook_list', description: 'List all registered webhooks' },
          { tool: 'ocr_webhook_delete', description: 'Remove this webhook' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 5.2: ocr_webhook_list
// =============================================================================

async function handleWebhookList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        include_inactive: z.boolean().default(false),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const query = input.include_inactive
      ? 'SELECT id, url, events, is_active, created_at, last_triggered_at, failure_count FROM webhooks ORDER BY created_at DESC'
      : 'SELECT id, url, events, is_active, created_at, last_triggered_at, failure_count FROM webhooks WHERE is_active = 1 ORDER BY created_at DESC';

    const rows = conn.prepare(query).all() as {
      id: string;
      url: string;
      events: string;
      is_active: number;
      created_at: string;
      last_triggered_at: string | null;
      failure_count: number;
    }[];

    const webhooks = rows.map((row) => ({
      id: row.id,
      url: row.url,
      events: row.events.split(',').map((e) => e.trim()),
      is_active: row.is_active === 1,
      created_at: row.created_at,
      last_triggered_at: row.last_triggered_at,
      failure_count: row.failure_count,
    }));

    return formatResponse(
      successResult({
        webhooks,
        total: webhooks.length,
        next_steps:
          webhooks.length === 0
            ? [{ tool: 'ocr_webhook_create', description: 'Register a new webhook' }]
            : [
                { tool: 'ocr_webhook_create', description: 'Register a new webhook' },
                { tool: 'ocr_webhook_delete', description: 'Remove a webhook by ID' },
              ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 5.3: ocr_webhook_delete
// =============================================================================

async function handleWebhookDelete(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        webhook_id: z.string().min(1),
        confirm: z.literal(true),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify webhook exists
    const existing = conn
      .prepare('SELECT id, url FROM webhooks WHERE id = ?')
      .get(input.webhook_id) as { id: string; url: string } | undefined;

    if (!existing) {
      throw new Error(`Webhook not found: ${input.webhook_id}`);
    }

    conn.prepare('DELETE FROM webhooks WHERE id = ?').run(input.webhook_id);

    return formatResponse(
      successResult({
        deleted: true,
        webhook_id: input.webhook_id,
        url: existing.url,
        next_steps: [{ tool: 'ocr_webhook_list', description: 'List remaining webhooks' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 5.4: ocr_export_obligations_csv
// =============================================================================

async function handleExportObligationsCSV(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1).optional(),
        status: z.enum(['active', 'fulfilled', 'overdue', 'waived', 'expired']).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const conditions: string[] = [];
    const bindValues: unknown[] = [];

    if (input.document_id) {
      conditions.push('o.document_id = ?');
      bindValues.push(input.document_id);
    }
    if (input.status) {
      conditions.push('o.status = ?');
      bindValues.push(input.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = conn
      .prepare(
        `SELECT o.id, o.document_id, d.file_name, o.obligation_type, o.description,
                o.responsible_party, o.due_date, o.recurring, o.status, o.confidence,
                o.created_at
         FROM obligations o
         LEFT JOIN documents d ON o.document_id = d.id
         ${whereClause}
         ORDER BY o.due_date ASC NULLS LAST, o.created_at DESC`
      )
      .all(...bindValues) as Record<string, unknown>[];

    const columns = [
      'id',
      'document_id',
      'file_name',
      'obligation_type',
      'description',
      'responsible_party',
      'due_date',
      'recurring',
      'status',
      'confidence',
      'created_at',
    ];

    const csv = toCSV(rows, columns);

    return formatResponse(
      successResult({
        format: 'csv',
        row_count: rows.length,
        csv_data: csv,
        filters: {
          document_id: input.document_id ?? null,
          status: input.status ?? null,
        },
        next_steps: [
          { tool: 'ocr_export_audit_log', description: 'Export audit log entries' },
          { tool: 'ocr_export_annotations', description: 'Export document annotations' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 5.5: ocr_export_audit_log
// =============================================================================

async function handleExportAuditLog(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        format: ExportFormatSchema.default('json'),
        user_id: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        date_from: z.string().min(1).optional(),
        date_to: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(10000).default(1000),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const conditions: string[] = [];
    const bindValues: unknown[] = [];

    if (input.user_id) {
      conditions.push('a.user_id = ?');
      bindValues.push(input.user_id);
    }
    if (input.action) {
      conditions.push('a.action = ?');
      bindValues.push(input.action);
    }
    if (input.date_from) {
      conditions.push('a.created_at >= ?');
      bindValues.push(input.date_from);
    }
    if (input.date_to) {
      conditions.push('a.created_at <= ?');
      bindValues.push(input.date_to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = conn
      .prepare(
        `SELECT a.id, a.user_id, u.display_name as user_name, a.session_id,
                a.action, a.entity_type, a.entity_id, a.details_json,
                a.ip_address, a.created_at
         FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         ${whereClause}
         ORDER BY a.created_at DESC
         LIMIT ?`
      )
      .all(...bindValues, input.limit) as Record<string, unknown>[];

    const columns = [
      'id',
      'user_id',
      'user_name',
      'session_id',
      'action',
      'entity_type',
      'entity_id',
      'details_json',
      'ip_address',
      'created_at',
    ];

    let exportData: string;
    if (input.format === 'csv') {
      exportData = toCSV(rows, columns);
    } else {
      // Parse details_json for JSON output
      const parsed = rows.map((row) => {
        let details: unknown = {};
        if (typeof row.details_json === 'string') {
          try {
            details = JSON.parse(row.details_json);
          } catch {
            details = row.details_json;
          }
        }
        return { ...row, details, details_json: undefined };
      });
      exportData = JSON.stringify(parsed, null, 2);
    }

    return formatResponse(
      successResult({
        format: input.format,
        row_count: rows.length,
        [`${input.format}_data`]: exportData,
        filters: {
          user_id: input.user_id ?? null,
          action: input.action ?? null,
          date_from: input.date_from ?? null,
          date_to: input.date_to ?? null,
        },
        truncated: rows.length >= (input.limit ?? 1000),
        next_steps: [
          { tool: 'ocr_export_obligations_csv', description: 'Export obligations' },
          { tool: 'ocr_export_annotations', description: 'Export document annotations' },
          { tool: 'ocr_audit_query', description: 'Query audit log with more filters' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL 5.6: ocr_export_annotations
// =============================================================================

async function handleExportAnnotations(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        format: ExportFormatSchema.default('json'),
      }),
      params
    );

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists
    const doc = conn
      .prepare('SELECT id, file_name FROM documents WHERE id = ?')
      .get(input.document_id) as { id: string; file_name: string } | undefined;

    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    const rows = conn
      .prepare(
        `SELECT a.id, a.document_id, a.user_id, u.display_name as user_name,
                a.chunk_id, a.page_number, a.annotation_type, a.content,
                a.status, a.parent_id, a.created_at, a.updated_at
         FROM annotations a
         LEFT JOIN users u ON a.user_id = u.id
         WHERE a.document_id = ?
         ORDER BY a.created_at ASC`
      )
      .all(input.document_id) as Record<string, unknown>[];

    const columns = [
      'id',
      'document_id',
      'user_id',
      'user_name',
      'chunk_id',
      'page_number',
      'annotation_type',
      'content',
      'status',
      'parent_id',
      'created_at',
      'updated_at',
    ];

    let exportData: string;
    if (input.format === 'csv') {
      exportData = toCSV(rows, columns);
    } else {
      exportData = JSON.stringify(rows, null, 2);
    }

    return formatResponse(
      successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        format: input.format,
        row_count: rows.length,
        [`${input.format}_data`]: exportData,
        next_steps:
          rows.length === 0
            ? [
                {
                  tool: 'ocr_annotation_create',
                  description: 'Add annotations to this document',
                },
              ]
            : [
                { tool: 'ocr_export_audit_log', description: 'Export audit log' },
                { tool: 'ocr_export_obligations_csv', description: 'Export obligations' },
                {
                  tool: 'ocr_annotation_summary',
                  description: 'Get annotation summary for this document',
                },
              ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// =============================================================================
// TOOL DEFINITIONS EXPORT
// =============================================================================

export const eventTools: Record<string, ToolDefinition> = {
  ocr_webhook_create: {
    description:
      '[SETUP] Register a webhook URL to receive event notifications. Events: document.ingested, document.processed, document.deleted, workflow.state_changed, annotation.created, annotation.resolved, search.alert_triggered, obligation.overdue, user.created, or * for all. Optionally provide a secret for HMAC-SHA256 signing.',
    inputSchema: {
      url: z.string().url().describe('Webhook endpoint URL (must be valid HTTP/HTTPS URL)'),
      events: z
        .array(EventTypeSchema)
        .min(1)
        .describe('Event types to subscribe to. Use "*" for all events.'),
      secret: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('Shared secret for HMAC-SHA256 payload signing (X-Webhook-Signature header)'),
    },
    handler: handleWebhookCreate,
  },

  ocr_webhook_list: {
    description:
      '[STATUS] List registered webhooks with status, event subscriptions, and failure counts. Set include_inactive=true to show disabled webhooks.',
    inputSchema: {
      include_inactive: z
        .boolean()
        .default(false)
        .describe('Include disabled/inactive webhooks in results'),
    },
    handler: handleWebhookList,
  },

  ocr_webhook_delete: {
    description:
      '[DESTRUCTIVE] Remove a webhook registration. Requires confirm=true. The webhook will stop receiving event notifications immediately.',
    inputSchema: {
      webhook_id: z.string().min(1).describe('ID of the webhook to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleWebhookDelete,
  },

  ocr_export_obligations_csv: {
    description:
      '[STATUS] Export contract obligations as RFC 4180 CSV. Optionally filter by document_id or status (active/fulfilled/overdue/waived/expired). Returns CSV string in response.',
    inputSchema: {
      document_id: z.string().min(1).optional().describe('Filter obligations by document ID'),
      status: z
        .enum(['active', 'fulfilled', 'overdue', 'waived', 'expired'])
        .optional()
        .describe('Filter by obligation status'),
    },
    handler: handleExportObligationsCSV,
  },

  ocr_export_audit_log: {
    description:
      '[STATUS] Export audit log entries as CSV or JSON. Filter by user_id, action, date range. Default limit 1000 entries. Returns formatted data string in response.',
    inputSchema: {
      format: ExportFormatSchema.default('json').describe('Export format: csv or json'),
      user_id: z.string().min(1).optional().describe('Filter by user ID'),
      action: z.string().min(1).optional().describe('Filter by action type'),
      date_from: z
        .string()
        .min(1)
        .optional()
        .describe('Filter entries on or after this date (ISO 8601)'),
      date_to: z
        .string()
        .min(1)
        .optional()
        .describe('Filter entries on or before this date (ISO 8601)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(1000)
        .describe('Maximum entries to export (1-10000, default 1000)'),
    },
    handler: handleExportAuditLog,
  },

  ocr_export_annotations: {
    description:
      '[STATUS] Export all annotations for a document as CSV or JSON. Includes annotation content, type, status, user, and threading info. Returns formatted data string in response.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to export annotations for'),
      format: ExportFormatSchema.default('json').describe('Export format: csv or json'),
    },
    handler: handleExportAnnotations,
  },
};

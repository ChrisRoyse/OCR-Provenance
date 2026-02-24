/**
 * User Identity and Audit Log Tools
 *
 * Provides 2 MCP tools for user management and audit trail querying:
 * - ocr_user_info: Get/set current user identity
 * - ocr_audit_query: Query the audit log with filters
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/users
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import {
  createUser,
  getUser,
  getUserByExternalId,
  updateUserActivity,
  listUsers,
  queryAuditLog,
} from '../services/storage/database/user-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const UserRoleSchema = z.enum(['viewer', 'reviewer', 'editor', 'admin']);

const UserInfoInputSchema = z.object({
  user_id: z.string().min(1).optional().describe('Internal user ID to look up'),
  external_id: z.string().min(1).optional().describe('External user ID (e.g., SSO sub claim)'),
  display_name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Display name for the user (required when creating a new user)'),
  email: z.string().email().optional().describe('User email address'),
  role: UserRoleSchema.optional().describe('User role: viewer, reviewer, editor, or admin'),
});

const AuditQueryInputSchema = z.object({
  user_id: z.string().min(1).optional().describe('Filter by user ID'),
  action: z.string().min(1).optional().describe('Filter by action (e.g., "ingest", "delete", "search")'),
  entity_type: z
    .string()
    .min(1)
    .optional()
    .describe('Filter by entity type (e.g., "document", "chunk", "user")'),
  entity_id: z.string().min(1).optional().describe('Filter by entity ID'),
  date_from: z
    .string()
    .optional()
    .describe('Filter entries from this ISO 8601 datetime'),
  date_to: z
    .string()
    .optional()
    .describe('Filter entries up to this ISO 8601 datetime'),
  limit: z.number().int().min(1).max(500).default(50).describe('Max entries to return (1-500)'),
  offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 1: ocr_user_info
// ═══════════════════════════════════════════════════════════════════════════════

async function handleUserInfo(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(UserInfoInputSchema, params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Case 1: Look up by internal user_id
    if (input.user_id) {
      const user = getUser(conn, input.user_id);
      if (!user) {
        throw new Error(`User not found: ${input.user_id}`);
      }
      updateUserActivity(conn, user.id);
      return formatResponse(
        successResult({
          user,
          next_steps: [
            { tool: 'ocr_audit_query', description: 'View this user\'s activity log' },
          ],
        })
      );
    }

    // Case 2: Look up by external_id (or create if display_name provided)
    if (input.external_id) {
      const existing = getUserByExternalId(conn, input.external_id);
      if (existing) {
        updateUserActivity(conn, existing.id);
        return formatResponse(
          successResult({
            user: existing,
            created: false,
            next_steps: [
              { tool: 'ocr_audit_query', description: 'View this user\'s activity log' },
            ],
          })
        );
      }

      // external_id not found - create user if display_name provided
      if (input.display_name) {
        const newUser = createUser(conn, {
          display_name: input.display_name,
          external_id: input.external_id,
          email: input.email,
          role: input.role ?? 'viewer',
        });
        return formatResponse(
          successResult({
            user: newUser,
            created: true,
            next_steps: [
              { tool: 'ocr_audit_query', description: 'View audit log entries' },
              { tool: 'ocr_document_list', description: 'Browse documents' },
            ],
          })
        );
      }

      throw new Error(
        `User with external_id "${input.external_id}" not found. Provide display_name to create.`
      );
    }

    // Case 3: Create user with display_name only (no external_id)
    if (input.display_name) {
      const newUser = createUser(conn, {
        display_name: input.display_name,
        email: input.email,
        role: input.role ?? 'viewer',
      });
      return formatResponse(
        successResult({
          user: newUser,
          created: true,
          next_steps: [
            { tool: 'ocr_audit_query', description: 'View audit log entries' },
            { tool: 'ocr_document_list', description: 'Browse documents' },
          ],
        })
      );
    }

    // Case 4: No user_id, no external_id, no display_name - list all users
    const users = listUsers(conn);
    return formatResponse(
      successResult({
        users,
        total: users.length,
        next_steps:
          users.length === 0
            ? [
                {
                  tool: 'ocr_user_info',
                  description:
                    'Create a user by providing display_name (and optionally external_id, email, role)',
                },
              ]
            : [
                { tool: 'ocr_audit_query', description: 'View audit log for a specific user' },
                {
                  tool: 'ocr_user_info',
                  description: 'Get details for a specific user by user_id',
                },
              ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2: ocr_audit_query
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAuditQuery(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(AuditQueryInputSchema, params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const { entries, total } = queryAuditLog(conn, {
      user_id: input.user_id,
      action: input.action,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      date_from: input.date_from,
      date_to: input.date_to,
      limit,
      offset,
    });

    const hasMore = offset + entries.length < total;

    return formatResponse(
      successResult({
        entries,
        total,
        offset,
        limit,
        has_more: hasMore,
        next_steps: hasMore
          ? [
              {
                tool: 'ocr_audit_query',
                description: `Get next page with offset=${offset + limit}`,
              },
            ]
          : [
              { tool: 'ocr_user_info', description: 'Look up a user referenced in the audit log' },
              { tool: 'ocr_document_get', description: 'Get details for a referenced entity' },
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

export const userTools: Record<string, ToolDefinition> = {
  ocr_user_info: {
    description:
      '[MANAGE] Use to get, create, or list users. If user_id is provided, returns that user. If external_id is provided, looks up or creates (when display_name is also given). If only display_name is provided, creates a new user. If no params, lists all users.',
    inputSchema: {
      user_id: z.string().min(1).optional().describe('Internal user ID to look up'),
      external_id: z
        .string()
        .min(1)
        .optional()
        .describe('External user ID (e.g., SSO sub claim)'),
      display_name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Display name for the user (required when creating a new user)'),
      email: z.string().email().optional().describe('User email address'),
      role: UserRoleSchema.optional().describe(
        'User role: viewer, reviewer, editor, or admin'
      ),
    },
    handler: handleUserInfo,
  },

  ocr_audit_query: {
    description:
      '[STATUS] Use to query the audit log. Filter by user_id, action, entity_type, entity_id, and date range. Returns paginated entries ordered by newest first.',
    inputSchema: {
      user_id: z.string().min(1).optional().describe('Filter by user ID'),
      action: z
        .string()
        .min(1)
        .optional()
        .describe('Filter by action (e.g., "ingest", "delete", "search")'),
      entity_type: z
        .string()
        .min(1)
        .optional()
        .describe('Filter by entity type (e.g., "document", "chunk", "user")'),
      entity_id: z.string().min(1).optional().describe('Filter by entity ID'),
      date_from: z
        .string()
        .optional()
        .describe('Filter entries from this ISO 8601 datetime'),
      date_to: z
        .string()
        .optional()
        .describe('Filter entries up to this ISO 8601 datetime'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Max entries to return (1-500)'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Offset for pagination'),
    },
    handler: handleAuditQuery,
  },
};

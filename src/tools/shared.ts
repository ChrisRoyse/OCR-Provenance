/**
 * Shared Tool Utilities
 *
 * Common types, formatters, and error handlers used across all tool modules.
 * Eliminates duplication of formatResponse, handleError, and type definitions.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/shared
 */

import { z } from 'zod';
import { MCPError, formatErrorResponse } from '../server/errors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** MCP tool response format */
export type ToolResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Tool handler function signature */
type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/** Tool definition with description, schema, and handler */
export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format tool result as MCP content response
 */
export function formatResponse(result: unknown): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Handle errors uniformly - FAIL FAST
 */
export function handleError(error: unknown): ToolResponse {
  const mcpError = MCPError.fromUnknown(error);
  console.error(`[ERROR] ${mcpError.category}: ${mcpError.message}`);
  return {
    content: [{ type: 'text', text: JSON.stringify(formatErrorResponse(mcpError), null, 2) }],
    isError: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED QUERY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch provenance chain for a given provenance ID and attach to response object.
 * Returns the chain array on success. If provenanceId is null/undefined, returns undefined.
 *
 * FAIL FAST: If the provenance query fails, the error propagates up to the
 * tool handler's catch block where handleError() will produce a proper error
 * response. We do NOT silently swallow errors -- if include_provenance was
 * requested and the query fails, the tool should fail.
 *
 * Shared by clustering, comparison, file-management, and form-fill tools.
 */
export function fetchProvenanceChain(
  db: { getProvenanceChain: (id: string) => unknown[] },
  provenanceId: string | null | undefined,
  _logPrefix: string
): unknown[] | undefined {
  if (!provenanceId) return undefined;
  return db.getProvenanceChain(provenanceId);
}


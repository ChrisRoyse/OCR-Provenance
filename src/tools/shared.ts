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

/** Max response size in bytes before truncation (700KB). Prevents Claude Code
 *  from spilling multi-MB tool results to disk as .txt files. */
const MAX_RESPONSE_BYTES = 700 * 1024;

/**
 * Format tool result as MCP content response.
 * If the serialized JSON exceeds MAX_RESPONSE_BYTES, arrays are progressively
 * truncated and a `_response_truncated` warning is injected so the AI knows
 * to paginate.
 */
export function formatResponse(result: unknown): ToolResponse {
  const json = JSON.stringify(result, null, 2);
  if (json.length <= MAX_RESPONSE_BYTES) {
    return { content: [{ type: 'text', text: json }] };
  }

  // Truncate: find arrays in the result and cap them
  const truncated = truncateResult(result as Record<string, unknown>, MAX_RESPONSE_BYTES);
  const truncatedJson = JSON.stringify(truncated, null, 2);
  return { content: [{ type: 'text', text: truncatedJson }] };
}

/**
 * Recursively truncate arrays in a result object until it fits within maxBytes.
 * Adds `_response_truncated` metadata so the AI knows to use pagination.
 */
function truncateResult(obj: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  // Find all arrays and their sizes
  const arrays: { path: string[]; arr: unknown[]; size: number }[] = [];
  findArrays(obj, [], arrays);

  // Sort by size descending — truncate largest arrays first
  arrays.sort((a, b) => b.size - a.size);

  const copy = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  let currentSize = JSON.stringify(copy, null, 2).length;

  const truncatedFields: string[] = [];

  for (const { path, arr } of arrays) {
    if (currentSize <= maxBytes) break;
    if (arr.length <= 5) continue; // Don't truncate tiny arrays

    // Cap to at most 50 items or fewer
    const cap = Math.min(50, Math.max(5, Math.floor(arr.length * 0.1)));
    setNestedValue(copy, path, arr.slice(0, cap));

    // Add count metadata next to the array
    const countPath = [...path.slice(0, -1), `_${path[path.length - 1]}_total`];
    setNestedValue(copy, countPath, arr.length);

    truncatedFields.push(`${path.join('.')} (${arr.length} → ${cap})`);
    currentSize = JSON.stringify(copy, null, 2).length;
  }

  if (truncatedFields.length > 0) {
    copy._response_truncated = {
      reason: `Response exceeded ${Math.round(maxBytes / 1024)}KB limit`,
      truncated_fields: truncatedFields,
      suggestion: 'Use limit/offset parameters or more specific filters to reduce response size',
    };
  }

  // If still too large after array truncation, return a minimal fallback response
  if (currentSize > maxBytes) {
    const finalJson = JSON.stringify(copy, null, 2);
    if (finalJson.length > maxBytes) {
      return {
        _response_truncated: {
          reason: `Response exceeded ${Math.round(maxBytes / 1024)}KB limit and could not be reduced by array truncation`,
          original_size_bytes: JSON.stringify(obj, null, 2).length,
          suggestion: 'Use limit/offset parameters or more specific filters to reduce response size',
        },
      };
    }
  }

  return copy;
}

function findArrays(
  obj: unknown,
  path: string[],
  result: { path: string[]; arr: unknown[]; size: number }[]
): void {
  if (Array.isArray(obj)) {
    result.push({ path: [...path], arr: obj, size: JSON.stringify(obj).length });
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      findArrays(value, [...path, key], result);
    }
  }
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = current[path[i]];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      return; // Path doesn't exist in copy
    }
  }
  current[path[path.length - 1]] = value;
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

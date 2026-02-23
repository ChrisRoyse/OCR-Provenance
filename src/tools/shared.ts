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
// GEMINI RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Robustly parse JSON from Gemini AI responses.
 *
 * Gemini sometimes returns JSON wrapped in markdown code fences, with
 * reasoning preamble, or with trailing garbage. This 4-step parser handles
 * all common Gemini output formats:
 *   1. Strip markdown code fences
 *   2. Try full-text parse
 *   3. Extract outermost { ... } block
 *   4. Fail with diagnostics
 *
 * Used by all tools that call gemini.fast() and parse the response.
 */
export function parseGeminiJson<T = Record<string, unknown>>(text: string, label: string): T {
  if (!text || text.trim().length === 0) {
    throw new Error(`Gemini returned empty response for ${label}`);
  }

  // Step 1: Strip markdown code fences
  const clean = text.replace(/```json\n?|\n?```/g, '').trim();

  // Step 2: Try parsing the full cleaned text
  try {
    return JSON.parse(clean) as T;
  } catch (error) {
    console.error(`[shared] Failed to parse full cleaned text as JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Step 3: Extract JSON object from mixed text (reasoning preamble + JSON)
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = clean.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonCandidate) as T;
    } catch (error) {
      console.error(`[shared] Failed to parse extracted JSON substring for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Step 4: All extraction attempts failed - throw with diagnostics
  throw new Error(
    `Gemini ${label} JSON parse failed: could not extract valid JSON from response. ` +
      `Raw response (first 500 chars): ${text.slice(0, 500)}`
  );
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


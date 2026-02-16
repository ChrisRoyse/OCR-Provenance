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
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** MCP tool response format */
export type ToolResponse = { content: Array<{ type: 'text'; text: string }> };

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
  return formatResponse(formatErrorResponse(mcpError));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED QUERY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Entity row shape returned by queryEntitiesForDocuments */
export interface DocumentEntityRow {
  id: string;
  text: string;
  type: string;
  normalized_text: string;
  confidence: number;
}

/**
 * Query entities for a set of document IDs.
 * Shared by clustering, comparison, and file-management tools.
 */
export function queryEntitiesForDocuments(
  conn: import('better-sqlite3').Database,
  documentIds: string[]
): DocumentEntityRow[] {
  if (documentIds.length === 0) return [];
  const placeholders = documentIds.map(() => '?').join(',');
  return conn
    .prepare(
      `SELECT id, raw_text as text, entity_type as type, normalized_text, confidence
     FROM entities WHERE document_id IN (${placeholders})
     ORDER BY entity_type, confidence DESC`
    )
    .all(...documentIds) as DocumentEntityRow[];
}

/**
 * Fetch provenance chain for a given provenance ID and attach to response object.
 * Returns the chain array on success, or undefined on failure (with error logged).
 *
 * Shared by clustering, comparison, file-management, and form-fill tools.
 */
export function fetchProvenanceChain(
  db: { getProvenanceChain: (id: string) => unknown[] },
  provenanceId: string | null | undefined,
  logPrefix: string
): unknown[] | undefined {
  if (!provenanceId) return undefined;
  try {
    return db.getProvenanceChain(provenanceId);
  } catch (err) {
    console.error(
      `[${logPrefix}] Provenance query failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Build a cluster reassignment hint for a document whose content has changed.
 * Returns an object with hint text and current cluster info, or undefined if
 * the document has no cluster memberships.
 *
 * Shared by vlm, extraction-structured, and other tools that modify document content.
 */
export function buildClusterReassignmentHint(
  conn: import('better-sqlite3').Database,
  documentId: string,
  logPrefix: string
):
  | {
      cluster_reassignment_hint: string;
      current_clusters: Array<{ cluster_id: string; label: string | null }>;
    }
  | undefined {
  try {
    const clusterSummaries = getClusterSummariesForDocument(conn, documentId);
    if (clusterSummaries.length > 0) {
      return {
        cluster_reassignment_hint:
          'Document content changed. Run ocr_cluster_documents to update cluster assignments.',
        current_clusters: clusterSummaries.map((s) => ({ cluster_id: s.id, label: s.label })),
      };
    }
  } catch (clusterErr) {
    console.error(
      `[${logPrefix}] Cluster check failed: ${clusterErr instanceof Error ? clusterErr.message : String(clusterErr)}`
    );
  }
  return undefined;
}

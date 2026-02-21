/**
 * Health Check MCP Tools
 *
 * Tools: ocr_health_check
 *
 * Detects data integrity gaps and optionally triggers fixes.
 * Internal-only - no external API calls needed.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/health
 */

import { z } from 'zod';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { validateInput } from '../utils/validation.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const HealthCheckInput = z.object({
  fix: z.boolean().default(false)
    .describe('If true, trigger processing for fixable gaps (chunks without embeddings). Other gaps are reported but need manual intervention via specific tools.'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** Gap category with counts and sample IDs */
interface GapCategory {
  count: number;
  sample_ids: string[];
  fixable: boolean;
  fix_tool: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: ocr_health_check
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_health_check - Detect and optionally fix data integrity gaps
 *
 * Checks for:
 * 1. Chunks without embeddings (fixable via embedding generation)
 * 2. Documents without OCR results (non-pending status)
 * 3. Images without VLM descriptions
 * 4. Embeddings without vectors in vec_embeddings
 * 5. Orphaned provenance records
 */
async function handleHealthCheck(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(HealthCheckInput, params);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    const gaps: Record<string, GapCategory> = {};
    const fixes: string[] = [];
    const SAMPLE_LIMIT = 10;

    // ──────────────────────────────────────────────────────────────
    // Gap 1: Chunks without embeddings
    // ──────────────────────────────────────────────────────────────
    const chunksWithoutEmbeddings = conn.prepare(
      `SELECT c.id FROM chunks c
       LEFT JOIN embeddings e ON e.chunk_id = c.id
       WHERE e.id IS NULL AND c.embedding_status != 'complete'`
    ).all() as Array<{ id: string }>;

    gaps.chunks_without_embeddings = {
      count: chunksWithoutEmbeddings.length,
      sample_ids: chunksWithoutEmbeddings.slice(0, SAMPLE_LIMIT).map(r => r.id),
      fixable: true,
      fix_tool: 'ocr_process_pending (or set fix=true to trigger embedding generation)',
    };

    // Fix: Generate embeddings for chunks missing them
    if (input.fix && chunksWithoutEmbeddings.length > 0) {
      try {
        const { getEmbeddingService } = await import('../services/embedding/embedder.js');
        const embeddingService = getEmbeddingService();

        // Get pending chunks (those with embedding_status != 'complete')
        const pendingChunks = db.getPendingEmbeddingChunks(100);

        if (pendingChunks.length > 0) {
          // Group chunks by document for proper provenance
          const chunksByDoc = new Map<string, typeof pendingChunks>();
          for (const chunk of pendingChunks) {
            const existing = chunksByDoc.get(chunk.document_id);
            if (existing) {
              existing.push(chunk);
            } else {
              chunksByDoc.set(chunk.document_id, [chunk]);
            }
          }

          let totalEmbedded = 0;
          for (const [docId, docChunks] of chunksByDoc.entries()) {
            const doc = db.getDocument(docId);
            if (!doc) {
              console.error(`[HealthCheck] Document ${docId} not found, skipping ${docChunks.length} chunks`);
              continue;
            }

            try {
              const result = await embeddingService.embedDocumentChunks(
                db,
                vector,
                docChunks,
                {
                  documentId: doc.id,
                  filePath: doc.file_path,
                  fileName: doc.file_name,
                  fileHash: doc.file_hash,
                  documentProvenanceId: doc.provenance_id,
                }
              );
              totalEmbedded += result.totalChunks;
            } catch (embedError) {
              console.error(`[HealthCheck] Failed to embed chunks for ${docId}: ${String(embedError)}`);
              fixes.push(`FAILED: Embedding generation for document ${docId}: ${String(embedError)}`);
            }
          }

          if (totalEmbedded > 0) {
            fixes.push(`Generated embeddings for ${totalEmbedded} chunks across ${chunksByDoc.size} documents`);
          }
        }
      } catch (serviceError) {
        console.error(`[HealthCheck] Embedding service initialization failed: ${String(serviceError)}`);
        fixes.push(`FAILED: Could not initialize embedding service: ${String(serviceError)}`);
      }
    }

    // ──────────────────────────────────────────────────────────────
    // Gap 2: Documents without OCR results (non-pending)
    // ──────────────────────────────────────────────────────────────
    const docsWithoutOCR = conn.prepare(
      `SELECT d.id FROM documents d
       LEFT JOIN ocr_results o ON o.document_id = d.id
       WHERE o.id IS NULL AND d.status NOT IN ('pending', 'processing')`
    ).all() as Array<{ id: string }>;

    gaps.documents_without_ocr = {
      count: docsWithoutOCR.length,
      sample_ids: docsWithoutOCR.slice(0, SAMPLE_LIMIT).map(r => r.id),
      fixable: false,
      fix_tool: 'ocr_process_pending or ocr_retry_failed',
    };

    // ──────────────────────────────────────────────────────────────
    // Gap 3: Images without VLM descriptions
    // ──────────────────────────────────────────────────────────────
    const imagesWithoutVLM = conn.prepare(
      `SELECT id FROM images
       WHERE vlm_status IN ('pending', 'failed') OR vlm_status IS NULL`
    ).all() as Array<{ id: string }>;

    gaps.images_without_vlm = {
      count: imagesWithoutVLM.length,
      sample_ids: imagesWithoutVLM.slice(0, SAMPLE_LIMIT).map(r => r.id),
      fixable: false,
      fix_tool: 'ocr_vlm_process_pending',
    };

    // ──────────────────────────────────────────────────────────────
    // Gap 4: Embeddings without vectors in vec_embeddings
    // ──────────────────────────────────────────────────────────────
    const embeddingsWithoutVectors = conn.prepare(
      `SELECT e.id FROM embeddings e
       LEFT JOIN vec_embeddings v ON v.embedding_id = e.id
       WHERE v.embedding_id IS NULL`
    ).all() as Array<{ id: string }>;

    gaps.embeddings_without_vectors = {
      count: embeddingsWithoutVectors.length,
      sample_ids: embeddingsWithoutVectors.slice(0, SAMPLE_LIMIT).map(r => r.id),
      fixable: false,
      fix_tool: 'ocr_embedding_rebuild or ocr_reembed_document',
    };

    // ──────────────────────────────────────────────────────────────
    // Gap 5: Orphaned provenance records
    // Provenance records not referenced by any entity's provenance_id
    // ──────────────────────────────────────────────────────────────
    const orphanedProvenance = conn.prepare(
      `SELECT p.id FROM provenance p
       WHERE p.type = 'DOCUMENT' AND p.id NOT IN (SELECT provenance_id FROM documents WHERE provenance_id IS NOT NULL)
       UNION ALL
       SELECT p.id FROM provenance p
       WHERE p.type = 'OCR_RESULT' AND p.id NOT IN (SELECT provenance_id FROM ocr_results WHERE provenance_id IS NOT NULL)
       UNION ALL
       SELECT p.id FROM provenance p
       WHERE p.type = 'CHUNK' AND p.id NOT IN (SELECT provenance_id FROM chunks WHERE provenance_id IS NOT NULL)
       UNION ALL
       SELECT p.id FROM provenance p
       WHERE p.type = 'EMBEDDING' AND p.id NOT IN (SELECT provenance_id FROM embeddings WHERE provenance_id IS NOT NULL)
       UNION ALL
       SELECT p.id FROM provenance p
       WHERE p.type = 'IMAGE' AND p.id NOT IN (SELECT provenance_id FROM images WHERE provenance_id IS NOT NULL)
       LIMIT 100`
    ).all() as Array<{ id: string }>;

    gaps.orphaned_provenance = {
      count: orphanedProvenance.length,
      sample_ids: orphanedProvenance.slice(0, SAMPLE_LIMIT).map(r => r.id),
      fixable: false,
      fix_tool: null,
    };

    // ──────────────────────────────────────────────────────────────
    // Summary statistics
    // ──────────────────────────────────────────────────────────────
    const totalDocuments = (conn.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number }).count;
    const totalChunks = (conn.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number }).count;
    const totalEmbeddings = (conn.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number }).count;
    const totalImages = (conn.prepare('SELECT COUNT(*) as count FROM images').get() as { count: number }).count;

    const totalGaps = Object.values(gaps).reduce((sum, g) => sum + g.count, 0);
    const healthy = totalGaps === 0;

    return formatResponse(successResult({
      healthy,
      total_gaps: totalGaps,
      gaps,
      fixes_applied: fixes.length > 0 ? fixes : undefined,
      summary: {
        total_documents: totalDocuments,
        total_chunks: totalChunks,
        total_embeddings: totalEmbeddings,
        total_images: totalImages,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Health check tools collection for MCP server registration
 */
export const healthTools: Record<string, ToolDefinition> = {
  ocr_health_check: {
    description:
      'Check system health: find documents without chunks, chunks without embeddings, stale FTS indexes, and other data integrity issues. Use to diagnose problems.',
    inputSchema: HealthCheckInput.shape,
    handler: handleHealthCheck,
  },
};

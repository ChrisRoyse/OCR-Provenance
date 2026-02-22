/**
 * Document Comparison Tools
 *
 * MCP tools for comparing two OCR-processed documents.
 * Provides text diff and structural diff.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module tools/comparison
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  formatResponse,
  handleError,
  fetchProvenanceChain,
  type ToolDefinition,
  type ToolResponse,
} from './shared.js';
import { successResult } from '../server/types.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { computeHash } from '../utils/hash.js';
import { MCPError } from '../server/errors.js';
import {
  compareText,
  compareStructure,
  generateSummary,
} from '../services/comparison/diff-service.js';
import {
  insertComparison,
  getComparison,
  listComparisons,
} from '../services/storage/database/comparison-operations.js';
import {
  getCluster,
  getClusterDocuments,
} from '../services/storage/database/cluster-operations.js';
import {
  computeDocumentEmbeddings,
  cosineSimilarity,
} from '../services/clustering/clustering-service.js';
import { getProvenanceTracker } from '../services/provenance/index.js';
import { ProvenanceType } from '../models/provenance.js';
import type { SourceType } from '../models/provenance.js';
import type { Comparison } from '../models/comparison.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const DocumentCompareInput = z.object({
  document_id_1: z.string().min(1).describe('First document ID'),
  document_id_2: z.string().min(1).describe('Second document ID'),
  include_text_diff: z.boolean().default(true).describe('Include text-level diff operations'),
  max_diff_operations: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(1000)
    .describe('Maximum diff operations to return'),
  include_provenance: z
    .boolean()
    .default(false)
    .describe('Include provenance chain for the comparison'),
});

const ComparisonListInput = z.object({
  document_id: z
    .string()
    .optional()
    .describe('Filter by document ID (matches either doc1 or doc2)'),
  limit: z.number().int().min(1).max(100).default(50).describe('Maximum results'),
  offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
});

const ComparisonGetInput = z.object({
  comparison_id: z.string().min(1).describe('Comparison ID'),
});

const ComparisonDiscoverInput = z.object({
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe('Minimum cosine similarity threshold (0-1)'),
  document_filter: z
    .array(z.string())
    .optional()
    .describe('Only consider these document IDs'),
  exclude_existing: z
    .boolean()
    .default(true)
    .describe('Exclude document pairs that already have comparisons'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum pairs to return'),
});

const ComparisonBatchInput = z.object({
  pairs: z
    .array(
      z.object({
        doc1: z.string().min(1).describe('First document ID'),
        doc2: z.string().min(1).describe('Second document ID'),
      })
    )
    .optional()
    .describe('Explicit document pairs to compare'),
  cluster_id: z
    .string()
    .optional()
    .describe('Compare all documents within this cluster'),
  include_text_diff: z
    .boolean()
    .default(true)
    .describe('Include text-level diff operations in each comparison'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;

function countChunks(conn: import('better-sqlite3').Database, docId: string): number {
  return (
    conn.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE document_id = ?').get(docId) as {
      cnt: number;
    }
  ).cnt;
}

/**
 * Parse stored JSON with descriptive error on malformed data.
 * Throws MCPError instead of returning undefined.
 */
function parseStoredJSON(field: string, fieldName: string, comparisonId: string): unknown {
  try {
    return JSON.parse(field);
  } catch (e) {
    throw new MCPError(
      'INTERNAL_ERROR',
      `Failed to parse ${fieldName} for comparison '${comparisonId}': stored JSON is malformed. Error: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

function fetchCompleteDocument(
  conn: import('better-sqlite3').Database,
  docId: string
): { doc: Row; ocr: Row } {
  const doc = conn.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as Row | undefined;
  if (!doc) {
    throw new MCPError('DOCUMENT_NOT_FOUND', `Document '${docId}' not found`);
  }
  if (doc.status !== 'complete') {
    throw new MCPError(
      'VALIDATION_ERROR',
      `Document '${docId}' has status '${String(doc.status)}', expected 'complete'. Run ocr_process_pending first.`
    );
  }
  const ocr = conn.prepare('SELECT * FROM ocr_results WHERE document_id = ?').get(docId) as
    | Row
    | undefined;
  if (!ocr) {
    throw new MCPError(
      'INTERNAL_ERROR',
      `No OCR result found for document '${docId}'. Document may need reprocessing.`
    );
  }
  return { doc, ocr };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-SIGNAL SIMILARITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute embedding centroid similarity between two documents.
 * Fetches all chunk embedding vectors for each document, computes centroids,
 * and returns cosine similarity between them.
 *
 * @returns Cosine similarity (0-1) or null if either document has no embeddings
 */
function computeEmbeddingCentroidSimilarity(
  conn: import('better-sqlite3').Database,
  docId1: string,
  docId2: string
): number | null {
  try {
    const docEmbeddings = computeDocumentEmbeddings(conn, [docId1, docId2]);
    const emb1 = docEmbeddings.find((d) => d.document_id === docId1);
    const emb2 = docEmbeddings.find((d) => d.document_id === docId2);

    if (!emb1 || !emb2) return null;

    return cosineSimilarity(emb1.embedding, Array.from(emb2.embedding));
  } catch (error) {
    console.error(
      '[comparison] Failed to compute embedding centroid similarity:',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Compute structural similarity between two documents based on block type distributions.
 * Uses block_type_stats from extras_json of OCR results (added in Phase 4).
 * Computes cosine similarity of block type distribution vectors.
 *
 * @returns Similarity score (0-1), or 0 if stats unavailable
 */
function computeStructuralSimilarity(
  conn: import('better-sqlite3').Database,
  docId1: string,
  docId2: string
): number {
  try {
    const stats1 = getBlockTypeStats(conn, docId1);
    const stats2 = getBlockTypeStats(conn, docId2);

    if (!stats1 || !stats2) return 0;

    // Build unified set of block types
    const allTypes = new Set([...Object.keys(stats1), ...Object.keys(stats2)]);
    if (allTypes.size === 0) return 0;

    // Build distribution vectors
    const vec1: number[] = [];
    const vec2: number[] = [];
    for (const type of allTypes) {
      vec1.push(stats1[type] ?? 0);
      vec2.push(stats2[type] ?? 0);
    }

    // Compute cosine similarity
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  } catch (error) {
    console.error(
      '[comparison] Failed to compute structural similarity:',
      error instanceof Error ? error.message : String(error)
    );
    return 0;
  }
}

/**
 * Extract block_type_stats from extras_json of a document's OCR result.
 * Returns a map of block_type -> count, or null if not available.
 */
function getBlockTypeStats(
  conn: import('better-sqlite3').Database,
  docId: string
): Record<string, number> | null {
  const row = conn
    .prepare('SELECT extras_json FROM ocr_results WHERE document_id = ? ORDER BY processing_completed_at DESC LIMIT 1')
    .get(docId) as { extras_json: string | null } | undefined;

  if (!row?.extras_json) return null;

  try {
    const extras = JSON.parse(row.extras_json) as Record<string, unknown>;
    const blockTypeStats = extras.block_type_stats as Record<string, number> | undefined;
    if (!blockTypeStats || typeof blockTypeStats !== 'object') return null;
    return blockTypeStats;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDocumentCompare(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const startTime = Date.now();
    const input = validateInput(DocumentCompareInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    if (input.document_id_1 === input.document_id_2) {
      throw new MCPError(
        'VALIDATION_ERROR',
        'Cannot compare document with itself. Provide two different document IDs.'
      );
    }

    const { doc: doc1, ocr: ocr1 } = fetchCompleteDocument(conn, input.document_id_1);
    const { doc: doc2, ocr: ocr2 } = fetchCompleteDocument(conn, input.document_id_2);

    // Duplicate comparison detection
    const existingComparison = conn
      .prepare(
        `SELECT c.id, c.created_at, c.similarity_ratio
       FROM comparisons c
       WHERE (c.document_id_1 = ? AND c.document_id_2 = ?)
          OR (c.document_id_1 = ? AND c.document_id_2 = ?)
       ORDER BY c.created_at DESC LIMIT 1`
      )
      .get(input.document_id_1, input.document_id_2, input.document_id_2, input.document_id_1) as
      | { id: string; created_at: string; similarity_ratio: number }
      | undefined;

    if (existingComparison) {
      // Check if underlying OCR data has changed since last comparison
      const currentInputHash = computeHash(
        String(ocr1.content_hash) + ':' + String(ocr2.content_hash)
      );
      const prevInputHash = conn
        .prepare(
          'SELECT input_hash FROM provenance WHERE id = (SELECT provenance_id FROM comparisons WHERE id = ?)'
        )
        .get(existingComparison.id) as { input_hash: string } | undefined;

      if (prevInputHash && prevInputHash.input_hash === currentInputHash) {
        throw new MCPError(
          'VALIDATION_ERROR',
          `These documents were already compared with identical OCR content. ` +
            `Existing comparison: ${existingComparison.id} (created ${existingComparison.created_at}, similarity ${(existingComparison.similarity_ratio * 100).toFixed(1)}%). ` +
            `To re-compare, first reprocess one of the documents with ocr_reprocess.`
        );
      }
      // If input hashes differ, the OCR content has changed, allow re-comparison
    }

    const chunks1Count = countChunks(conn, input.document_id_1);
    const chunks2Count = countChunks(conn, input.document_id_2);

    // Text diff
    const textDiff = input.include_text_diff
      ? compareText(
          String(ocr1.extracted_text),
          String(ocr2.extracted_text),
          input.max_diff_operations
        )
      : null;

    // Structural diff
    const structuralDiff = compareStructure(
      {
        page_count: doc1.page_count as number | null,
        text_length: Number(ocr1.text_length),
        quality_score: ocr1.parse_quality_score as number | null,
        ocr_mode: String(ocr1.datalab_mode),
        chunk_count: chunks1Count,
      },
      {
        page_count: doc2.page_count as number | null,
        text_length: Number(ocr2.text_length),
        quality_score: ocr2.parse_quality_score as number | null,
        ocr_mode: String(ocr2.datalab_mode),
        chunk_count: chunks2Count,
      }
    );

    // Generate summary
    const summary = generateSummary(
      textDiff,
      structuralDiff,
      String(doc1.file_name),
      String(doc2.file_name)
    );

    // Compute similarity from text diff or default to structural comparison
    const similarityRatio = textDiff ? textDiff.similarity_ratio : 0;

    // Multi-signal similarity computation (ME-6)
    const embeddingSimilarity = computeEmbeddingCentroidSimilarity(
      conn,
      input.document_id_1,
      input.document_id_2
    );
    const structSimilarity = computeStructuralSimilarity(
      conn,
      input.document_id_1,
      input.document_id_2
    );

    // Quality alignment: how close are the OCR quality scores
    const q1 = (ocr1.parse_quality_score as number | null) ?? 0;
    const q2 = (ocr2.parse_quality_score as number | null) ?? 0;
    const qualityAlignment = q1 > 0 && q2 > 0
      ? 1 - Math.abs(q1 - q2) / Math.max(q1, q2)
      : 0;

    // Composite similarity: weighted blend of all signals
    const compositeSimilarity =
      0.4 * similarityRatio +
      0.3 * (embeddingSimilarity ?? similarityRatio) +
      0.2 * structSimilarity +
      0.1 * qualityAlignment;

    // Compute content hash
    const diffContent = JSON.stringify({
      text_diff: textDiff,
      structural_diff: structuralDiff,
    });
    const contentHash = computeHash(diffContent);

    // Create provenance record
    const comparisonId = uuidv4();
    const now = new Date().toISOString();
    const inputHash = computeHash(String(ocr1.content_hash) + ':' + String(ocr2.content_hash));

    const tracker = getProvenanceTracker(db);
    const provId = tracker.createProvenance({
      type: ProvenanceType.COMPARISON,
      source_type: 'COMPARISON' as SourceType,
      source_id: String(ocr1.provenance_id),
      root_document_id: String(doc1.provenance_id),
      content_hash: contentHash,
      input_hash: inputHash,
      file_hash: String(doc1.file_hash),
      source_path: `${String(doc1.file_path)} <-> ${String(doc2.file_path)}`,
      processor: 'document-comparison',
      processor_version: '1.0.0',
      processing_params: { document_id_1: input.document_id_1, document_id_2: input.document_id_2 },
    });

    const processingDurationMs = Date.now() - startTime;

    // Update provenance with actual duration (not known at creation time)
    conn
      .prepare('UPDATE provenance SET processing_duration_ms = ? WHERE id = ?')
      .run(processingDurationMs, provId);

    // Insert comparison record
    const comparison: Comparison = {
      id: comparisonId,
      document_id_1: input.document_id_1,
      document_id_2: input.document_id_2,
      similarity_ratio: similarityRatio,
      text_diff_json: JSON.stringify(textDiff ?? {}),
      structural_diff_json: JSON.stringify(structuralDiff),
      summary,
      content_hash: contentHash,
      provenance_id: provId,
      created_at: now,
      processing_duration_ms: processingDurationMs,
    };

    // F-INTEG-10: Delete stale comparisons for this document pair before inserting
    // (handles re-OCR creating new comparisons alongside outdated ones)
    conn
      .prepare(
        `DELETE FROM comparisons WHERE
        (document_id_1 = ? AND document_id_2 = ?) OR
        (document_id_1 = ? AND document_id_2 = ?)`
      )
      .run(input.document_id_1, input.document_id_2, input.document_id_2, input.document_id_1);

    insertComparison(conn, comparison);

    const comparisonResponse: Record<string, unknown> = {
      comparison_id: comparisonId,
      document_1: { id: input.document_id_1, file_name: doc1.file_name },
      document_2: { id: input.document_id_2, file_name: doc2.file_name },
      similarity_ratio: similarityRatio,
      composite_similarity: Math.round(compositeSimilarity * 10000) / 10000,
      similarity_signals: {
        text_similarity: similarityRatio,
        embedding_centroid_similarity: embeddingSimilarity !== null
          ? Math.round(embeddingSimilarity * 10000) / 10000
          : null,
        structural_similarity: Math.round(structSimilarity * 10000) / 10000,
        quality_alignment: Math.round(qualityAlignment * 10000) / 10000,
        weights: { text: 0.4, embedding: 0.3, structural: 0.2, quality: 0.1 },
      },
      summary,
      text_diff: textDiff,
      structural_diff: structuralDiff,
      provenance_id: provId,
      processing_duration_ms: processingDurationMs,
    };

    if (input.include_provenance) {
      comparisonResponse.provenance_chain = fetchProvenanceChain(db, provId, 'comparison');
    }

    comparisonResponse.next_steps = [
      { tool: 'ocr_comparison_list', description: 'View all comparisons in the database' },
    ];

    return formatResponse(successResult(comparisonResponse));
  } catch (error) {
    return handleError(error);
  }
}

async function handleComparisonList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComparisonListInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const comparisons = listComparisons(conn, input);

    // Return summaries without large JSON fields
    const results = comparisons.map((c) => ({
      id: c.id,
      document_id_1: c.document_id_1,
      document_id_2: c.document_id_2,
      similarity_ratio: c.similarity_ratio,
      summary: c.summary,
      created_at: c.created_at,
      processing_duration_ms: c.processing_duration_ms,
    }));

    return formatResponse(
      successResult({
        comparisons: results,
        count: results.length,
        offset: input.offset,
        limit: input.limit,
        next_steps: [{ tool: 'ocr_comparison_get', description: 'View full diff data for a comparison' }, { tool: 'ocr_document_compare', description: 'Compare two new documents' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

async function handleComparisonGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComparisonGetInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const comparison = getComparison(conn, input.comparison_id);
    if (!comparison) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Comparison '${input.comparison_id}' not found`);
    }

    // Parse stored JSON fields with error handling
    return formatResponse(
      successResult({
        ...comparison,
        text_diff_json: parseStoredJSON(
          comparison.text_diff_json,
          'text_diff_json',
          input.comparison_id
        ),
        structural_diff_json: parseStoredJSON(
          comparison.structural_diff_json,
          'structural_diff_json',
          input.comparison_id
        ),
        next_steps: [{ tool: 'ocr_document_get', description: 'View one of the compared documents' }, { tool: 'ocr_comparison_list', description: 'Browse other comparisons' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVER & BATCH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover document pairs likely similar based on embedding proximity.
 * Computes document centroid embeddings (average chunk embeddings),
 * then pairwise cosine similarity.
 */
async function handleComparisonDiscover(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComparisonDiscoverInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const minSimilarity = input.min_similarity ?? 0.7;
    const excludeExisting = input.exclude_existing ?? true;
    const limit = input.limit ?? 20;

    // Compute document centroid embeddings
    const docEmbeddings = computeDocumentEmbeddings(
      conn,
      input.document_filter
    );

    if (docEmbeddings.length < 2) {
      return formatResponse(
        successResult({
          pairs: [],
          total_pairs: 0,
          documents_analyzed: docEmbeddings.length,
          message:
            docEmbeddings.length === 0
              ? 'No documents with embeddings found'
              : 'At least 2 documents with embeddings required for comparison discovery',
          next_steps: [{ tool: 'ocr_process_pending', description: 'Process more documents to enable comparison' }],
        })
      );
    }

    // Build set of existing comparison pairs for exclusion
    const existingPairs = new Set<string>();
    if (excludeExisting) {
      const existing = conn
        .prepare('SELECT document_id_1, document_id_2 FROM comparisons')
        .all() as Array<{ document_id_1: string; document_id_2: string }>;
      for (const row of existing) {
        // Store both orderings
        existingPairs.add(`${row.document_id_1}:${row.document_id_2}`);
        existingPairs.add(`${row.document_id_2}:${row.document_id_1}`);
      }
    }

    // Compute pairwise cosine similarity
    const pairs: Array<{
      document_id_1: string;
      document_id_2: string;
      similarity: number;
      file_name_1: string;
      file_name_2: string;
    }> = [];

    // Get file names for all documents
    const fileNameMap = new Map<string, string>();
    for (const de of docEmbeddings) {
      const doc = db.getDocument(de.document_id);
      fileNameMap.set(de.document_id, doc?.file_name ?? 'unknown');
    }

    for (let i = 0; i < docEmbeddings.length; i++) {
      for (let j = i + 1; j < docEmbeddings.length; j++) {
        const docA = docEmbeddings[i];
        const docB = docEmbeddings[j];

        // Skip if already compared
        if (excludeExisting && existingPairs.has(`${docA.document_id}:${docB.document_id}`)) {
          continue;
        }

        const similarity = cosineSimilarity(docA.embedding, Array.from(docB.embedding));
        if (similarity >= minSimilarity) {
          pairs.push({
            document_id_1: docA.document_id,
            document_id_2: docB.document_id,
            similarity: Math.round(similarity * 10000) / 10000,
            file_name_1: fileNameMap.get(docA.document_id) ?? 'unknown',
            file_name_2: fileNameMap.get(docB.document_id) ?? 'unknown',
          });
        }
      }
    }

    // Sort by similarity descending, then limit
    pairs.sort((a, b) => b.similarity - a.similarity);
    const limitedPairs = pairs.slice(0, limit);

    return formatResponse(
      successResult({
        pairs: limitedPairs,
        total_pairs: pairs.length,
        returned_pairs: limitedPairs.length,
        documents_analyzed: docEmbeddings.length,
        min_similarity: minSimilarity,
        exclude_existing: excludeExisting,
        next_steps: [{ tool: 'ocr_document_compare', description: 'Compare a discovered similar pair' }, { tool: 'ocr_comparison_batch', description: 'Compare all discovered pairs at once' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Compare multiple document pairs in one batch operation.
 * Can specify explicit pairs or compare all documents in a cluster.
 */
async function handleComparisonBatch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComparisonBatchInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Build list of pairs to compare
    let pairsToCompare: Array<{ doc1: string; doc2: string }> = [];

    if (input.cluster_id) {
      // Get all documents in cluster and generate all pairs
      const cluster = getCluster(conn, input.cluster_id);
      if (!cluster) {
        throw new MCPError('DOCUMENT_NOT_FOUND', `Cluster "${input.cluster_id}" not found`);
      }

      const members = getClusterDocuments(conn, input.cluster_id);
      if (members.length < 2) {
        return formatResponse(
          successResult({
            results: [],
            total_compared: 0,
            message: `Cluster has ${members.length} document(s), need at least 2 for comparison`,
            next_steps: [{ tool: 'ocr_cluster_list', description: 'Find a cluster with more documents' }],
          })
        );
      }

      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          pairsToCompare.push({
            doc1: members[i].document_id,
            doc2: members[j].document_id,
          });
        }
      }
    } else if (input.pairs && input.pairs.length > 0) {
      pairsToCompare = input.pairs;
    } else {
      throw new MCPError(
        'VALIDATION_ERROR',
        'Either pairs or cluster_id must be provided'
      );
    }

    if (pairsToCompare.length === 0) {
      return formatResponse(
        successResult({
          results: [],
          total_compared: 0,
          message: 'No pairs to compare',
          next_steps: [{ tool: 'ocr_comparison_list', description: 'View existing comparisons' }],
        })
      );
    }

    // Compare each pair by calling the existing compare handler
    const results: Array<Record<string, unknown>> = [];
    const errors: Array<{ doc1: string; doc2: string; error: string }> = [];

    for (const pair of pairsToCompare) {
      try {
        const compareResult = await handleDocumentCompare({
          document_id_1: pair.doc1,
          document_id_2: pair.doc2,
          include_text_diff: input.include_text_diff ?? true,
          max_diff_operations: 100, // Use smaller limit for batch
          include_provenance: false,
        });

        const parsed = JSON.parse(compareResult.content[0].text) as {
          success: boolean;
          data?: Record<string, unknown>;
          error?: { message: string };
        };

        if (parsed.success && parsed.data) {
          results.push({
            document_id_1: pair.doc1,
            document_id_2: pair.doc2,
            comparison_id: parsed.data.comparison_id,
            similarity_ratio: parsed.data.similarity_ratio,
            summary: parsed.data.summary,
          });
        } else {
          errors.push({
            doc1: pair.doc1,
            doc2: pair.doc2,
            error: parsed.error?.message ?? 'Unknown error',
          });
        }
      } catch (e) {
        errors.push({
          doc1: pair.doc1,
          doc2: pair.doc2,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return formatResponse(
      successResult({
        results,
        errors: errors.length > 0 ? errors : undefined,
        total_compared: results.length,
        total_errors: errors.length,
        total_pairs_requested: pairsToCompare.length,
        next_steps: [{ tool: 'ocr_comparison_list', description: 'List all comparison results' }, { tool: 'ocr_comparison_get', description: 'View details for a specific comparison' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON MATRIX HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const ComparisonMatrixInput = z.object({
  document_ids: z.array(z.string()).optional()
    .describe('Document IDs to include (default: all documents with embeddings)'),
  max_documents: z.number().int().min(2).max(100).default(50)
    .describe('Maximum documents in matrix'),
});

/**
 * Handle ocr_comparison_matrix - Compute pairwise similarity matrix for documents
 */
async function handleComparisonMatrix(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComparisonMatrixInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Compute document centroid embeddings
    const docEmbeddings = computeDocumentEmbeddings(conn, input.document_ids);

    if (docEmbeddings.length < 2) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Need at least 2 documents with embeddings for a similarity matrix. Found: ${docEmbeddings.length}`
      );
    }

    // Limit to max_documents (default 50 from schema)
    const limited = docEmbeddings.slice(0, input.max_documents);

    // Get file names for all documents
    const documentIds: string[] = [];
    const fileNames: string[] = [];
    for (const de of limited) {
      documentIds.push(de.document_id);
      const doc = db.getDocument(de.document_id);
      fileNames.push(doc?.file_name ?? 'unknown');
    }

    // Compute NxN similarity matrix
    const n = limited.length;
    const matrix: number[][] = [];
    let mostSimilarPair = { doc1_index: 0, doc2_index: 1, similarity: -1 };
    let leastSimilarPair = { doc1_index: 0, doc2_index: 1, similarity: 2 };
    let totalSimilarity = 0;
    let pairCount = 0;

    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) {
          row.push(1.0);
        } else {
          const sim = cosineSimilarity(limited[i].embedding, Array.from(limited[j].embedding));
          const rounded = Math.round(sim * 10000) / 10000;
          row.push(rounded);

          // Only track for upper triangle to avoid double-counting
          if (j > i) {
            totalSimilarity += rounded;
            pairCount++;
            if (rounded > mostSimilarPair.similarity) {
              mostSimilarPair = { doc1_index: i, doc2_index: j, similarity: rounded };
            }
            if (rounded < leastSimilarPair.similarity) {
              leastSimilarPair = { doc1_index: i, doc2_index: j, similarity: rounded };
            }
          }
        }
      }
      matrix.push(row);
    }

    const averageSimilarity = pairCount > 0
      ? Math.round((totalSimilarity / pairCount) * 10000) / 10000
      : 0;

    return formatResponse(
      successResult({
        document_ids: documentIds,
        file_names: fileNames,
        matrix,
        most_similar_pair: mostSimilarPair,
        least_similar_pair: leastSimilarPair,
        average_similarity: averageSimilarity,
        documents_analyzed: n,
        next_steps: [{ tool: 'ocr_document_compare', description: 'Compare the most similar pair in detail' }, { tool: 'ocr_cluster_documents', description: 'Cluster documents by similarity' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const comparisonTools: Record<string, ToolDefinition> = {
  ocr_document_compare: {
    description:
      '[ANALYSIS] Use to compare two OCR-processed documents for text and structural differences. Returns similarity ratio, composite similarity, text diff, and structural diff. Both documents must have status "complete".',
    inputSchema: DocumentCompareInput.shape,
    handler: handleDocumentCompare,
  },
  ocr_comparison_list: {
    description:
      '[ANALYSIS] Use to list past document comparisons with optional filtering by document ID. Returns comparison summaries with similarity ratios. Use ocr_comparison_get for full diff data.',
    inputSchema: ComparisonListInput.shape,
    handler: handleComparisonList,
  },
  ocr_comparison_get: {
    description:
      '[ANALYSIS] Use to retrieve full diff data for a specific comparison by ID. Returns text diff operations and structural differences. Use after ocr_comparison_list.',
    inputSchema: ComparisonGetInput.shape,
    handler: handleComparisonGet,
  },
  ocr_comparison_discover: {
    description:
      '[ANALYSIS] Use to find document pairs that are likely similar before comparing them. Returns pairs ranked by embedding cosine similarity. Follow with ocr_document_compare or ocr_comparison_batch.',
    inputSchema: ComparisonDiscoverInput.shape,
    handler: handleComparisonDiscover,
  },
  ocr_comparison_batch: {
    description:
      '[ANALYSIS] Use to compare multiple document pairs in one operation. Provide explicit pairs or a cluster_id to compare all documents within a cluster. Returns summaries for each pair.',
    inputSchema: ComparisonBatchInput.shape,
    handler: handleComparisonBatch,
  },
  ocr_comparison_matrix: {
    description:
      '[ANALYSIS] Use to compute an NxN pairwise similarity matrix across documents. Returns cosine similarity scores, most/least similar pairs, and average similarity. Requires documents with embeddings.',
    inputSchema: ComparisonMatrixInput.shape,
    handler: handleComparisonMatrix,
  },
};

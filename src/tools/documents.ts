/**
 * Document Management MCP Tools
 *
 * Extracted from src/index.ts Task 22.
 * Tools: ocr_document_list, ocr_document_get, ocr_document_delete,
 *        ocr_document_find_similar
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/documents
 */

import { z } from 'zod';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { requireDatabase, getDefaultStoragePath } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  sanitizePath,
  DocumentListInput,
  DocumentGetInput,
  DocumentDeleteInput,
} from '../utils/validation.js';
import { documentNotFoundError, MCPError } from '../server/errors.js';
import { formatResponse, handleError, fetchProvenanceChain, type ToolResponse, type ToolDefinition } from './shared.js';
import { getComparisonSummariesByDocument } from '../services/storage/database/comparison-operations.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getImagesByDocument } from '../services/storage/database/image-operations.js';
import { extractTableStructures } from '../services/chunking/json-block-analyzer.js';
import type { DatabaseService } from '../services/storage/database/index.js';
import type { Document } from '../models/document.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT STRUCTURE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface OutlineEntry {
  level: number;
  text: string;
  page: number | null;
}

interface TableEntry {
  page: number | null;
  caption?: string;
}

interface FigureEntry {
  page: number | null;
  caption?: string;
}

interface CodeBlockEntry {
  page: number | null;
  language?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_list - List documents in the current database
 */
export async function handleDocumentList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentListInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Build dynamic SQL with conditional WHERE clauses for new filters
    const conditions: string[] = [];
    const queryParams: (string | number)[] = [];

    if (input.status_filter) {
      conditions.push('status = ?');
      queryParams.push(input.status_filter);
    }
    if (input.created_after) {
      conditions.push('created_at > ?');
      queryParams.push(input.created_after);
    }
    if (input.created_before) {
      conditions.push('created_at < ?');
      queryParams.push(input.created_before);
    }
    if (input.file_type) {
      conditions.push('file_type = ?');
      queryParams.push(input.file_type);
    }

    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    // Get total count with same filters
    const countRow = conn
      .prepare(`SELECT COUNT(*) as total FROM documents${whereClause}`)
      .get(...queryParams) as { total: number };
    const total = countRow.total;

    // Get paginated results
    const dataQuery = `SELECT * FROM documents${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const dataParams = [...queryParams, input.limit, input.offset];
    const rows = conn.prepare(dataQuery).all(...dataParams) as Array<Record<string, unknown>>;

    // Phase 2: Prepared statement for structural summary from extras_json
    const extrasStmt = conn.prepare('SELECT extras_json FROM ocr_results WHERE document_id = ? LIMIT 1');

    return formatResponse(
      successResult({
        documents: rows.map((d) => ({
          id: d.id,
          file_name: d.file_name,
          file_path: d.file_path,
          file_size: d.file_size,
          file_type: d.file_type,
          status: d.status,
          page_count: d.page_count,
          doc_title: d.doc_title ?? null,
          doc_author: d.doc_author ?? null,
          doc_subject: d.doc_subject ?? null,
          created_at: d.created_at,
          structural_summary: (() => {
            try {
              const ocrRow = extrasStmt.get(d.id as string) as { extras_json: string | null } | undefined;
              if (!ocrRow?.extras_json) return null;
              const extras = JSON.parse(ocrRow.extras_json) as Record<string, unknown>;
              const fp = extras.structural_fingerprint as Record<string, unknown> | undefined;
              if (!fp) return null;
              const headingDepths = fp.heading_depths as Record<string, number> | undefined;
              return {
                table_count: fp.table_count ?? 0,
                figure_count: fp.figure_count ?? 0,
                heading_count: headingDepths ? Object.values(headingDepths).reduce((a: number, b: number) => a + b, 0) : 0,
                content_types: fp.content_type_distribution ?? null,
              };
            } catch { return null; }
          })(),
        })),
        total,
        limit: input.limit,
        offset: input.offset,
        next_steps: [
          { tool: 'ocr_document_get', description: 'Get details for a specific document by ID' },
          { tool: 'ocr_search', description: 'Search within the corpus' },
          { tool: 'ocr_document_structure', description: 'View a document outline (headings, tables)' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_document_get - Get detailed information about a specific document
 */
export async function handleDocumentGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentGetInput, params);
    const { db } = requireDatabase();

    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Always fetch OCR result for metadata (lightweight - excludes extracted_text in response unless include_text)
    const ocrResult = db.getOCRResultByDocumentId(doc.id);

    const result: Record<string, unknown> = {
      id: doc.id,
      file_name: doc.file_name,
      file_path: doc.file_path,
      file_hash: doc.file_hash,
      file_size: doc.file_size,
      file_type: doc.file_type,
      status: doc.status,
      page_count: doc.page_count,
      doc_title: doc.doc_title ?? null,
      doc_author: doc.doc_author ?? null,
      doc_subject: doc.doc_subject ?? null,
      created_at: doc.created_at,
      provenance_id: doc.provenance_id,
      ocr_info: ocrResult
        ? {
            ocr_result_id: ocrResult.id,
            datalab_request_id: ocrResult.datalab_request_id,
            datalab_mode: ocrResult.datalab_mode,
            parse_quality_score: ocrResult.parse_quality_score,
            cost_cents: ocrResult.cost_cents,
            page_count: ocrResult.page_count,
            text_length: ocrResult.text_length,
            processing_duration_ms: ocrResult.processing_duration_ms,
            content_hash: ocrResult.content_hash,
          }
        : null,
    };

    // Surface enrichment data from extras_json (Tasks 4.1, 4.2, 4.4)
    if (ocrResult?.extras_json) {
      try {
        const extras = JSON.parse(ocrResult.extras_json) as Record<string, unknown>;
        if (extras.block_type_stats) {
          result.block_type_stats = extras.block_type_stats;
        }
        if (extras.link_count !== undefined) {
          result.link_count = extras.link_count;
          result.structured_links = extras.structured_links ?? [];
        }
        if (extras.structural_fingerprint) {
          result.structural_fingerprint = extras.structural_fingerprint;
        }
      } catch (parseErr) {
        console.error(
          `[DocumentGet] Failed to parse extras_json for enrichment fields: ${String(parseErr)}`
        );
      }
    }

    // Compute document_profile from block_type_stats (no additional DB queries)
    const stats = result.block_type_stats as {
      total_blocks: number;
      text_blocks: number;
      table_blocks: number;
      figure_blocks: number;
      code_blocks: number;
      list_blocks: number;
      tables_per_page: number;
      figures_per_page: number;
      text_density: number;
    } | undefined;
    if (stats) {
      const richBlockCount = stats.table_blocks + stats.figure_blocks + stats.code_blocks;
      let contentComplexity: 'high' | 'medium' | 'low';
      if (richBlockCount > 5) {
        contentComplexity = 'high';
      } else if (stats.table_blocks + stats.figure_blocks > 0) {
        contentComplexity = 'medium';
      } else {
        contentComplexity = 'low';
      }

      result.document_profile = {
        has_tables: stats.table_blocks > 0,
        has_figures: stats.figure_blocks > 0,
        has_code: stats.code_blocks > 0,
        has_lists: stats.list_blocks > 0,
        content_complexity: contentComplexity,
        tables_per_page: stats.tables_per_page ?? null,
        figures_per_page: stats.figures_per_page ?? null,
        text_density: stats.text_density ?? null,
      };
    } else {
      result.document_profile = null;
    }

    if (input.include_text) {
      result.ocr_text = ocrResult?.extracted_text ?? null;
    }

    if (input.include_chunks) {
      const chunks = db.getChunksByDocumentId(doc.id);
      result.chunks = chunks.map((c) => ({
        id: c.id,
        chunk_index: c.chunk_index,
        text_length: c.text.length,
        page_number: c.page_number,
        character_start: c.character_start,
        character_end: c.character_end,
        embedding_status: c.embedding_status,
        heading_context: c.heading_context ?? null,
        heading_level: c.heading_level ?? null,
        section_path: c.section_path ?? null,
        content_types: c.content_types ?? null,
        is_atomic: c.is_atomic ?? 0,
        chunking_strategy: c.chunking_strategy ?? null,
      }));
    }

    if (input.include_blocks && ocrResult) {
      result.json_blocks = ocrResult.json_blocks ? JSON.parse(ocrResult.json_blocks) : null;
      result.extras = ocrResult.extras_json ? JSON.parse(ocrResult.extras_json) : null;
    }

    if (input.include_full_provenance) {
      const chain = db.getProvenanceChain(doc.provenance_id);
      result.provenance_chain = chain.map((p) => ({
        id: p.id,
        type: p.type,
        chain_depth: p.chain_depth,
        processor: p.processor,
        processor_version: p.processor_version,
        content_hash: p.content_hash,
        created_at: p.created_at,
      }));
    }

    // Comparison context: show all comparisons referencing this document
    const comparisons = getComparisonSummariesByDocument(db.getConnection(), doc.id);
    result.comparisons = {
      total: comparisons.length,
      items: comparisons.map((c) => ({
        comparison_id: c.id,
        compared_with: c.document_id_1 === doc.id ? c.document_id_2 : c.document_id_1,
        similarity_ratio: c.similarity_ratio,
        summary: c.summary,
        created_at: c.created_at,
      })),
    };

    // Cluster memberships: show all clusters this document belongs to
    const clusterMemberships = getClusterSummariesForDocument(db.getConnection(), doc.id);
    if (clusterMemberships.length > 0) {
      result.clusters = clusterMemberships.map((c) => ({
        cluster_id: c.id,
        run_id: c.run_id,
        cluster_index: c.cluster_index,
        label: c.label,
        classification_tag: c.classification_tag,
        coherence_score: c.coherence_score,
      }));
    }

    result.next_steps = [
      { tool: 'ocr_document_page', description: 'Read a specific page of this document' },
      { tool: 'ocr_document_structure', description: 'View document outline and layout' },
      { tool: 'ocr_search', description: 'Search within this document (use document_id filter)' },
      { tool: 'ocr_chunk_list', description: 'List all chunks with section/heading filtering' },
    ];

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_document_delete - Delete a document and all its derived data
 */
export async function handleDocumentDelete(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentDeleteInput, params);
    const { db, vector } = requireDatabase();

    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Count items before deletion for reporting
    const chunks = db.getChunksByDocumentId(doc.id);
    const embeddings = db.getEmbeddingsByDocumentId(doc.id);
    const provenance = db.getProvenanceByRootDocument(doc.provenance_id);

    // Delete vectors first
    const vectorsDeleted = vector.deleteVectorsByDocumentId(doc.id);

    // Delete document (cascades to chunks, embeddings, provenance)
    db.deleteDocument(doc.id);

    // Clean up extracted image files on disk
    let imagesCleanedUp = false;
    const imageDir = resolve(getDefaultStoragePath(), 'images', doc.id);
    if (existsSync(imageDir)) {
      rmSync(imageDir, { recursive: true, force: true });
      imagesCleanedUp = true;
    }

    return formatResponse(
      successResult({
        document_id: doc.id,
        deleted: true,
        chunks_deleted: chunks.length,
        embeddings_deleted: embeddings.length,
        vectors_deleted: vectorsDeleted,
        provenance_deleted: provenance.length,
        images_directory_cleaned: imagesCleanedUp,
        next_steps: [{ tool: 'ocr_document_list', description: 'Browse remaining documents' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS FOR NEW TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

const DocumentStructureInput = z.object({
  document_id: z.string().min(1).describe('Document ID'),
  format: z.enum(['structure', 'tree', 'outline']).default('structure')
    .describe('Output format: "structure" (headings/tables/figures/code), "tree" (hierarchical section tree with chunks), "outline" (flat numbered section list)'),
  include_chunk_ids: z.boolean().default(true)
    .describe('Include chunk IDs in each section node (tree/outline formats only)'),
  include_page_numbers: z.boolean().default(true)
    .describe('Include page numbers in each section node (tree/outline formats only)'),
});

const FindSimilarInput = z.object({
  document_id: z.string().min(1).describe('Source document ID'),
  limit: z.number().int().min(1).max(50).default(10),
  min_similarity: z.number().min(0).max(1).default(0.5)
    .describe('Minimum similarity threshold (0-1)'),
});

const UpdateMetadataInput = z.object({
  document_ids: z.array(z.string().min(1)).min(1)
    .describe('Document IDs to update'),
  doc_title: z.string().optional(),
  doc_author: z.string().optional(),
  doc_subject: z.string().optional(),
});

const DuplicateDetectionInput = z.object({
  mode: z.enum(['exact', 'near']).default('near')
    .describe('exact: same file_hash; near: high text similarity'),
  similarity_threshold: z.number().min(0.5).max(1).default(0.9)
    .describe('Minimum similarity for near-duplicate detection'),
  limit: z.number().int().min(1).max(100).default(20),
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-DOCUMENT SIMILARITY HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_find_similar - Find documents similar to a given document
 * using averaged chunk embeddings as document centroid for vector search.
 */
export async function handleFindSimilar(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(FindSimilarInput, params);
    const { db, vector } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Get all chunk embeddings for source document
    const embeddingRows = db.getConnection()
      .prepare('SELECT id FROM embeddings WHERE document_id = ? AND chunk_id IS NOT NULL')
      .all(input.document_id) as Array<{ id: string }>;

    if (embeddingRows.length === 0) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Document "${input.document_id}" has no chunk embeddings. Process the document first.`
      );
    }

    // Collect vectors and compute centroid
    const vectors: Float32Array[] = [];
    for (const row of embeddingRows) {
      const vec = vector.getVector(row.id);
      if (vec) {
        vectors.push(vec);
      }
    }

    if (vectors.length === 0) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Document "${input.document_id}" has embedding records but no vectors in vec_embeddings.`
      );
    }

    // Average vectors to create 768-dim document centroid
    const dims = 768;
    const centroid = new Float32Array(dims);
    for (const vec of vectors) {
      for (let i = 0; i < dims; i++) {
        centroid[i] += vec[i];
      }
    }
    for (let i = 0; i < dims; i++) {
      centroid[i] /= vectors.length;
    }

    // Search for similar embeddings (fetch extra to allow aggregation)
    const resultLimit = input.limit ?? 10;
    const minSim = input.min_similarity ?? 0.5;
    const searchResults = vector.searchSimilar(centroid, {
      limit: resultLimit * 10,
      threshold: minSim,
    });

    // Aggregate by document: average similarity across matching chunks, excluding source doc
    const docSimilarityMap = new Map<string, { totalSim: number; count: number }>();
    for (const r of searchResults) {
      if (r.document_id === input.document_id) continue;
      const entry = docSimilarityMap.get(r.document_id);
      if (entry) {
        entry.totalSim += r.similarity_score;
        entry.count += 1;
      } else {
        docSimilarityMap.set(r.document_id, { totalSim: r.similarity_score, count: 1 });
      }
    }

    // Rank by average similarity, filter by min_similarity, slice to limit
    const ranked = Array.from(docSimilarityMap.entries())
      .map(([docId, { totalSim, count }]) => ({
        document_id: docId,
        avg_similarity: Math.round((totalSim / count) * 1000000) / 1000000,
        matching_chunks: count,
      }))
      .filter((r) => r.avg_similarity >= minSim)
      .sort((a, b) => b.avg_similarity - a.avg_similarity)
      .slice(0, resultLimit);

    // Enrich with document metadata and structural fingerprint
    const conn = db.getConnection();
    const similarDocuments = ranked.map((r) => {
      const simDoc = db.getDocument(r.document_id);

      // Try to include structural fingerprint from extras_json
      let structuralFingerprint: unknown = null;
      try {
        const ocrRow = conn
          .prepare('SELECT extras_json FROM ocr_results WHERE document_id = ?')
          .get(r.document_id) as { extras_json: string | null } | undefined;
        if (ocrRow?.extras_json) {
          const extras = JSON.parse(ocrRow.extras_json) as Record<string, unknown>;
          if (extras.structural_fingerprint) {
            structuralFingerprint = extras.structural_fingerprint;
          }
        }
      } catch {
        // Non-fatal: skip fingerprint enrichment
      }

      return {
        document_id: r.document_id,
        file_name: simDoc?.file_name ?? null,
        file_type: simDoc?.file_type ?? null,
        status: simDoc?.status ?? null,
        avg_similarity: r.avg_similarity,
        matching_chunks: r.matching_chunks,
        structural_fingerprint: structuralFingerprint,
      };
    });

    return formatResponse(
      successResult({
        source_document_id: input.document_id,
        source_chunk_count: vectors.length,
        similar_documents: similarDocuments,
        total: similarDocuments.length,
        next_steps: [{ tool: 'ocr_document_get', description: 'Get details for a similar document' }, { tool: 'ocr_document_compare', description: 'Compare two similar documents' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH METADATA UPDATE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_update_metadata - Batch update metadata for multiple documents
 */
export async function handleUpdateMetadata(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(UpdateMetadataInput, params);

    // Verify at least one metadata field is provided (before requiring database)
    if (
      input.doc_title === undefined &&
      input.doc_author === undefined &&
      input.doc_subject === undefined
    ) {
      throw new MCPError(
        'VALIDATION_ERROR',
        'At least one metadata field (doc_title, doc_author, doc_subject) must be provided.'
      );
    }

    const { db } = requireDatabase();

    let updatedCount = 0;
    const notFoundIds: string[] = [];

    for (const docId of input.document_ids) {
      try {
        const doc = db.getDocument(docId);
        if (!doc) {
          notFoundIds.push(docId);
          continue;
        }

        db.updateDocumentMetadata(docId, {
          docTitle: input.doc_title,
          docAuthor: input.doc_author,
          docSubject: input.doc_subject,
        });
        updatedCount++;
      } catch (docError) {
        const errMsg = docError instanceof Error ? docError.message : String(docError);
        console.error(`[WARN] Failed to update metadata for document ${docId}: ${errMsg}`);
        notFoundIds.push(docId);
      }
    }

    return formatResponse(
      successResult({
        updated_count: updatedCount,
        not_found_ids: notFoundIds,
        total_requested: input.document_ids.length,
        next_steps: [{ tool: 'ocr_document_get', description: 'Verify the updated metadata' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE DOCUMENT DETECTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_duplicates - Detect duplicate documents
 */
export async function handleDuplicateDetection(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DuplicateDetectionInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    if (input.mode === 'exact') {
      // Find documents with same file_hash
      const groups = conn
        .prepare(
          `
          SELECT file_hash, GROUP_CONCAT(id) as doc_ids, GROUP_CONCAT(file_name) as file_names,
                 COUNT(*) as count
          FROM documents
          GROUP BY file_hash
          HAVING COUNT(*) > 1
          ORDER BY count DESC
          LIMIT ?
        `
        )
        .all(input.limit) as Array<{
        file_hash: string;
        doc_ids: string;
        file_names: string;
        count: number;
      }>;

      const duplicateGroups = groups.map((g) => ({
        file_hash: g.file_hash,
        document_ids: g.doc_ids.split(','),
        file_names: g.file_names.split(','),
        count: g.count,
      }));

      return formatResponse(
        successResult({
          mode: 'exact',
          total_groups: duplicateGroups.length,
          total_duplicate_documents: duplicateGroups.reduce((sum, g) => sum + g.count, 0),
          groups: duplicateGroups,
          next_steps: [{ tool: 'ocr_document_compare', description: 'Compare a duplicate pair in detail' }, { tool: 'ocr_document_delete', description: 'Delete a confirmed duplicate' }],
        })
      );
    } else {
      // Near-duplicate mode: query comparisons table
      const comparisons = conn
        .prepare(
          `
          SELECT c.id as comparison_id, c.document_id_1, c.document_id_2,
                 c.similarity_ratio, c.summary,
                 d1.file_name as file_name_1, d2.file_name as file_name_2
          FROM comparisons c
          JOIN documents d1 ON d1.id = c.document_id_1
          JOIN documents d2 ON d2.id = c.document_id_2
          WHERE c.similarity_ratio >= ?
          ORDER BY c.similarity_ratio DESC
          LIMIT ?
        `
        )
        .all(input.similarity_threshold, input.limit) as Array<{
        comparison_id: string;
        document_id_1: string;
        document_id_2: string;
        similarity_ratio: number;
        summary: string | null;
        file_name_1: string;
        file_name_2: string;
      }>;

      return formatResponse(
        successResult({
          mode: 'near',
          similarity_threshold: input.similarity_threshold,
          total_pairs: comparisons.length,
          pairs: comparisons.map((c) => ({
            comparison_id: c.comparison_id,
            document_id_1: c.document_id_1,
            file_name_1: c.file_name_1,
            document_id_2: c.document_id_2,
            file_name_2: c.file_name_2,
            similarity_ratio: c.similarity_ratio,
            summary: c.summary,
          })),
          next_steps: [{ tool: 'ocr_document_compare', description: 'Compare a duplicate pair in detail' }, { tool: 'ocr_document_delete', description: 'Delete a confirmed duplicate' }],
        })
      );
    }
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT STRUCTURE ANALYSIS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an outline from chunks that have heading metadata.
 * Deduplicates headings by tracking seen heading_context values.
 */
function buildOutlineFromChunks(
  chunks: Array<{
    heading_context: string | null;
    heading_level: number | null;
    page_number: number | null;
  }>
): OutlineEntry[] {
  const seen = new Set<string>();
  const outline: OutlineEntry[] = [];

  for (const chunk of chunks) {
    if (chunk.heading_context && !seen.has(chunk.heading_context)) {
      seen.add(chunk.heading_context);
      outline.push({
        level: chunk.heading_level ?? 1,
        text: chunk.heading_context,
        page: chunk.page_number,
      });
    }
  }

  return outline;
}

/**
 * Walk a block tree from json_blocks, extracting structural elements.
 */
function walkBlocks(
  blocks: Array<Record<string, unknown>>,
  outline: OutlineEntry[],
  tables: TableEntry[],
  figures: FigureEntry[],
  codeBlocks: CodeBlockEntry[]
): void {
  for (const block of blocks) {
    const blockType = block.block_type as string | undefined;
    const page = (block.page as number) ?? (block.page_idx as number) ?? null;

    if (blockType === 'SectionHeader' || blockType === 'Title') {
      const text = (block.text as string) ?? (block.html as string) ?? '';
      const level = (block.level as number) ?? (blockType === 'Title' ? 1 : 2);
      if (text) {
        outline.push({ level, text, page });
      }
    } else if (blockType === 'Table') {
      const caption = (block.caption as string) ?? undefined;
      tables.push({ page, caption });
    } else if (blockType === 'Figure' || blockType === 'Picture') {
      const caption = (block.caption as string) ?? undefined;
      figures.push({ page, caption });
    } else if (blockType === 'Code') {
      const language = (block.language as string) ?? undefined;
      codeBlocks.push({ page, language });
    }

    // Recursively walk children if present
    if (Array.isArray(block.children)) {
      walkBlocks(
        block.children as Array<Record<string, unknown>>,
        outline,
        tables,
        figures,
        codeBlocks
      );
    }
  }
}

/**
 * Handle ocr_document_structure - Analyze document structure
 *
 * Supports three formats:
 * - 'structure' (default): headings, tables, figures, code blocks from json_blocks or chunks
 * - 'tree': hierarchical section tree with chunk_ids, page_numbers (merged from ocr_document_sections)
 * - 'outline': flat numbered outline with chunk counts (merged from ocr_document_sections)
 */
export async function handleDocumentStructure(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentStructureInput, params);
    const { db } = requireDatabase();

    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Delegate to sections logic for tree/outline formats
    if (input.format === 'tree' || input.format === 'outline') {
      return handleDocumentSectionsInternal(db, doc, input);
    }

    // Default 'structure' format: headings, tables, figures, code blocks
    const conn = db.getConnection();
    const outline: OutlineEntry[] = [];
    const tables: TableEntry[] = [];
    const figures: FigureEntry[] = [];
    const codeBlocks: CodeBlockEntry[] = [];
    let source: 'json_blocks' | 'chunks' = 'chunks';
    let documentMap: Record<string, unknown> | null = null;

    // Try json_blocks first (richer structure)
    const ocrRow = conn
      .prepare('SELECT json_blocks FROM ocr_results WHERE document_id = ?')
      .get(input.document_id) as { json_blocks: string | null } | undefined;

    if (ocrRow?.json_blocks) {
      try {
        const parsed = JSON.parse(ocrRow.json_blocks) as Record<string, unknown> | Array<Record<string, unknown>>;
        // Handle both formats: array of blocks or {children: [...]} object
        const blocks = Array.isArray(parsed) ? parsed
          : (Array.isArray((parsed as Record<string, unknown>).children) ? (parsed as Record<string, unknown>).children as Array<Record<string, unknown>> : null);
        if (blocks && blocks.length > 0) {
          walkBlocks(blocks, outline, tables, figures, codeBlocks);
          source = 'json_blocks';

          // Build document map with table column details
          try {
            const ocrTextRow = conn.prepare('SELECT extracted_text FROM ocr_results WHERE document_id = ?')
              .get(input.document_id) as { extracted_text: string | null } | undefined;

            if (ocrTextRow?.extracted_text) {
              // Pass the original parsed object (or wrap array in {children:...})
              const jsonBlocksRoot = Array.isArray(parsed)
                ? { children: parsed } as Record<string, unknown>
                : parsed as Record<string, unknown>;
              const tableStructures = extractTableStructures(
                jsonBlocksRoot,
                ocrTextRow.extracted_text,
                [] // pageOffsets not needed for structure extraction
              );

              documentMap = {
                sections: outline.map(o => ({
                  heading: o.text,
                  level: o.level,
                  page: o.page,
                })),
                tables: tableStructures.map(ts => ({
                  page: ts.pageNumber,
                  columns: ts.columnHeaders,
                  row_count: ts.rowCount,
                  column_count: ts.columnCount,
                })),
                figures: figures.map(f => ({
                  page: f.page,
                  caption: f.caption ?? null,
                })),
                code_blocks: codeBlocks.map(cb => ({
                  page: cb.page,
                  language: cb.language ?? null,
                })),
              };
            }
          } catch (mapErr) {
            console.error(`[DocumentStructure] Failed to build document_map: ${String(mapErr)}`);
          }
        }
      } catch (parseErr) {
        console.error(`[DocumentStructure] Failed to parse json_blocks for ${input.document_id}: ${String(parseErr)}`);
        // Fall through to chunk-based analysis
      }
    }

    // Fallback to chunks if no json_blocks or parsing failed
    if (source === 'chunks') {
      const chunks = db.getChunksByDocumentId(input.document_id);
      const chunkData = chunks.map((c) => ({
        heading_context: c.heading_context ?? null,
        heading_level: c.heading_level ?? null,
        page_number: c.page_number,
      }));
      const chunkOutline = buildOutlineFromChunks(chunkData);
      outline.push(...chunkOutline);
    }

    const responseData: Record<string, unknown> = {
      document_id: doc.id,
      file_name: doc.file_name,
      page_count: doc.page_count,
      format: 'structure',
      source,
      outline,
      tables: { count: tables.length, items: tables },
      figures: { count: figures.length, items: figures },
      code_blocks: { count: codeBlocks.length, items: codeBlocks },
      total_structural_elements: outline.length + tables.length + figures.length + codeBlocks.length,
      next_steps: [{ tool: 'ocr_document_page', description: 'Read a specific page from the document' }, { tool: 'ocr_search', description: 'Search within the document' }, { tool: 'ocr_document_tables', description: 'Extract table data from the document' }],
    };
    if (documentMap) {
      responseData.document_map = documentMap;
    }

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT SECTIONS TREE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/** Section tree node */
interface SectionNode {
  name: string;
  chunk_count: number;
  heading_level: number | null;
  first_chunk_index: number | null;
  last_chunk_index: number | null;
  chunk_ids?: string[];
  page_numbers?: number[];
  page_range?: string | null;
  children: SectionNode[];
}

/**
 * Flatten a section tree into a numbered outline format.
 * Example: "1. Introduction (pages 1-3) [5 chunks]"
 */
function flattenToOutline(nodes: SectionNode[], prefix = ''): string[] {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const num = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    const node = nodes[i];
    const pageInfo = node.page_range ? ` (pages ${node.page_range})` : '';
    lines.push(`${num}. ${node.name}${pageInfo} [${node.chunk_count} chunks]`);
    if (node.children && node.children.length > 0) {
      lines.push(...flattenToOutline(node.children, num));
    }
  }
  return lines;
}

/**
 * Internal handler for section tree/outline format (merged from ocr_document_sections).
 * Called by handleDocumentStructure when format='tree' or format='outline'.
 */
async function handleDocumentSectionsInternal(
  db: DatabaseService,
  doc: Document,
  input: { document_id: string; format?: string; include_chunk_ids?: boolean; include_page_numbers?: boolean }
): Promise<ToolResponse> {
  try {
    const chunks = db.getChunksByDocumentId(input.document_id);

    // Build tree from section_path strings
    const root: SectionNode = {
      name: '(root)',
      chunk_count: 0,
      heading_level: null,
      first_chunk_index: null,
      last_chunk_index: null,
      chunk_ids: input.include_chunk_ids ? [] : undefined,
      page_numbers: input.include_page_numbers ? [] : undefined,
      children: [],
    };

    let chunksWithSections = 0;
    let chunksWithoutSections = 0;

    /** Helper to update chunk index range on a node */
    const updateChunkIndexRange = (node: SectionNode, chunkIndex: number | null | undefined): void => {
      if (chunkIndex == null) return;
      if (node.first_chunk_index === null || chunkIndex < node.first_chunk_index) {
        node.first_chunk_index = chunkIndex;
      }
      if (node.last_chunk_index === null || chunkIndex > node.last_chunk_index) {
        node.last_chunk_index = chunkIndex;
      }
    };

    for (const chunk of chunks) {
      if (!chunk.section_path) {
        // Chunks without section_path go to root
        chunksWithoutSections++;
        root.chunk_count++;
        updateChunkIndexRange(root, chunk.chunk_index);
        if (input.include_chunk_ids && root.chunk_ids) {
          root.chunk_ids.push(chunk.id);
        }
        if (input.include_page_numbers && root.page_numbers && chunk.page_number !== null) {
          if (!root.page_numbers.includes(chunk.page_number)) {
            root.page_numbers.push(chunk.page_number);
          }
        }
        continue;
      }

      chunksWithSections++;

      // Parse section_path: "Heading 1 > Heading 2 > Heading 3"
      const parts = chunk.section_path.split(' > ').map((s) => s.trim()).filter((s) => s.length > 0);

      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const partName = parts[i];
        let child = current.children.find((c) => c.name === partName);
        if (!child) {
          child = {
            name: partName,
            chunk_count: 0,
            heading_level: null,
            first_chunk_index: null,
            last_chunk_index: null,
            chunk_ids: input.include_chunk_ids ? [] : undefined,
            page_numbers: input.include_page_numbers ? [] : undefined,
            children: [],
          };
          current.children.push(child);
        }

        // Only add chunk to the deepest (leaf) level
        if (i === parts.length - 1) {
          child.chunk_count++;
          updateChunkIndexRange(child, chunk.chunk_index);
          // Set heading_level from the chunk (first non-null wins)
          if (child.heading_level === null && chunk.heading_level != null) {
            child.heading_level = chunk.heading_level;
          }
          if (input.include_chunk_ids && child.chunk_ids) {
            child.chunk_ids.push(chunk.id);
          }
          if (input.include_page_numbers && child.page_numbers && chunk.page_number !== null) {
            if (!child.page_numbers.includes(chunk.page_number)) {
              child.page_numbers.push(chunk.page_number);
            }
          }
        }

        current = child;
      }
    }

    // Post-process: compute page_range for nodes with page_numbers
    const computePageRange = (node: SectionNode): void => {
      if (node.page_numbers && node.page_numbers.length > 0) {
        node.page_numbers.sort((a, b) => a - b);
        const min = node.page_numbers[0];
        const max = node.page_numbers[node.page_numbers.length - 1];
        node.page_range = min === max ? String(min) : `${min}-${max}`;
      } else {
        node.page_range = null;
      }
      for (const child of node.children) {
        computePageRange(child);
      }
    };

    if (input.include_page_numbers) {
      computePageRange(root);
    }

    // Count total sections in the tree
    const countSections = (nodes: SectionNode[]): number => {
      let count = nodes.length;
      for (const node of nodes) {
        count += countSections(node.children);
      }
      return count;
    };
    const totalSections = countSections(root.children);

    if (input.format === 'outline') {
      // Flat numbered outline format
      const outline = flattenToOutline(root.children);
      return formatResponse(
        successResult({
          document_id: doc.id,
          file_name: doc.file_name,
          format: 'outline',
          total_chunks: chunks.length,
          chunks_with_sections: chunksWithSections,
          chunks_without_sections: chunksWithoutSections,
          total_sections: totalSections,
          root_chunks: root.chunk_count,
          outline,
          next_steps: [{ tool: 'ocr_document_page', description: 'Read a specific page from the document' }, { tool: 'ocr_search', description: 'Search within the document' }, { tool: 'ocr_document_tables', description: 'Extract table data from the document' }],
        })
      );
    }

    // Default: tree format
    return formatResponse(
      successResult({
        document_id: doc.id,
        file_name: doc.file_name,
        format: 'tree',
        total_chunks: chunks.length,
        chunks_with_sections: chunksWithSections,
        chunks_without_sections: chunksWithoutSections,
        total_sections: totalSections,
        sections: root.children,
        root_chunks: root.chunk_count,
        next_steps: [{ tool: 'ocr_document_page', description: 'Read a specific page from the document' }, { tool: 'ocr_search', description: 'Search within the document' }, { tool: 'ocr_document_tables', description: 'Extract table data from the document' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK EXPORT INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const DocumentExportInput = z.object({
  document_id: z.string().min(1).describe('Document ID'),
  format: z.enum(['json', 'markdown']).default('json')
    .describe('Export format: json or markdown'),
  output_path: z.string().min(1).describe('Path to save exported file'),
  include_images: z.boolean().default(true)
    .describe('Include image data in export'),
  include_extractions: z.boolean().default(true)
    .describe('Include structured extractions in export'),
  include_provenance: z.boolean().default(false)
    .describe('Include provenance chain in export'),
});

const CorpusExportInput = z.object({
  output_path: z.string().min(1).describe('Path to save exported file'),
  format: z.enum(['json', 'csv']).default('json')
    .describe('Export format: json or csv'),
  include_chunks: z.boolean().default(false)
    .describe('Include chunk list per document'),
  include_images: z.boolean().default(false)
    .describe('Include image list per document'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT EXPORT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_export - Export all data for a document to JSON or markdown
 */
export async function handleDocumentExport(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentExportInput, params);
    const { db } = requireDatabase();

    // Get document record
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Get OCR results
    const ocrResult = db.getOCRResultByDocumentId(doc.id);

    // Get all chunks
    const chunks = db.getChunksByDocumentId(doc.id);

    // Get images if requested
    let images: Array<Record<string, unknown>> = [];
    if (input.include_images) {
      const conn = db.getConnection();
      const imgRows = getImagesByDocument(conn, doc.id);
      images = imgRows.map((img) => ({
        id: img.id,
        page_number: img.page_number,
        image_index: img.image_index,
        block_type: img.block_type,
        extracted_path: img.extracted_path,
        width: img.dimensions?.width ?? null,
        height: img.dimensions?.height ?? null,
        vlm_status: img.vlm_status,
        vlm_description: img.vlm_description ?? null,
        vlm_image_type: img.vlm_structured_data?.imageType ?? null,
        created_at: img.created_at,
      }));
    }

    // Get extractions if requested
    let extractions: Array<Record<string, unknown>> = [];
    if (input.include_extractions) {
      const extRows = db.getExtractionsByDocument(doc.id);
      extractions = extRows.map((ext) => ({
        id: ext.id,
        schema_json: ext.schema_json,
        extraction_json: ext.extraction_json,
        content_hash: ext.content_hash,
        created_at: ext.created_at,
      }));
    }

    // Get provenance if requested
    let provenance: unknown[] | undefined;
    if (input.include_provenance) {
      provenance = fetchProvenanceChain(db, doc.provenance_id, 'DocumentExport');
    }

    // Sanitize output path
    const safePath = sanitizePath(input.output_path);

    // Create output directory if needed
    const dir = dirname(safePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (input.format === 'json') {
      // Build JSON export
      const exportData: Record<string, unknown> = {
        document: {
          id: doc.id,
          file_name: doc.file_name,
          file_path: doc.file_path,
          file_hash: doc.file_hash,
          file_size: doc.file_size,
          file_type: doc.file_type,
          status: doc.status,
          page_count: doc.page_count,
          doc_title: doc.doc_title ?? null,
          doc_author: doc.doc_author ?? null,
          doc_subject: doc.doc_subject ?? null,
          created_at: doc.created_at,
        },
        ocr_results: ocrResult
          ? {
              id: ocrResult.id,
              datalab_mode: ocrResult.datalab_mode,
              parse_quality_score: ocrResult.parse_quality_score,
              page_count: ocrResult.page_count,
              text_length: ocrResult.text_length,
              extracted_text: ocrResult.extracted_text,
              cost_cents: ocrResult.cost_cents,
              processing_duration_ms: ocrResult.processing_duration_ms,
            }
          : null,
        chunks: chunks.map((c) => ({
          id: c.id,
          chunk_index: c.chunk_index,
          text: c.text,
          page_number: c.page_number,
          character_start: c.character_start,
          character_end: c.character_end,
          heading_context: c.heading_context ?? null,
          section_path: c.section_path ?? null,
          content_types: c.content_types ?? null,
        })),
      };

      if (input.include_images) {
        exportData.images = images;
      }
      if (input.include_extractions) {
        exportData.extractions = extractions;
      }
      if (input.include_provenance && provenance) {
        exportData.provenance = provenance;
      }

      writeFileSync(safePath, JSON.stringify(exportData, null, 2), 'utf-8');
    } else {
      // Build Markdown export
      const lines: string[] = [];

      lines.push(`# Document Export: ${doc.file_name}`);
      lines.push('');
      lines.push('## Metadata');
      lines.push(`- **File:** ${doc.file_path}`);
      lines.push(`- **Status:** ${doc.status}`);
      lines.push(`- **Pages:** ${doc.page_count ?? 'N/A'}`);
      lines.push(`- **Created:** ${doc.created_at}`);
      lines.push(`- **File Type:** ${doc.file_type}`);
      lines.push(`- **File Size:** ${doc.file_size} bytes`);
      if (doc.doc_title) lines.push(`- **Title:** ${doc.doc_title}`);
      if (doc.doc_author) lines.push(`- **Author:** ${doc.doc_author}`);
      lines.push('');

      if (ocrResult) {
        lines.push('## OCR Info');
        lines.push(`- **Mode:** ${ocrResult.datalab_mode}`);
        lines.push(`- **Quality Score:** ${ocrResult.parse_quality_score}`);
        lines.push(`- **Text Length:** ${ocrResult.text_length}`);
        lines.push(`- **Processing Time:** ${ocrResult.processing_duration_ms}ms`);
        lines.push('');
      }

      if (chunks.length > 0) {
        lines.push('## Content');
        lines.push('');
        for (const chunk of chunks) {
          const pageInfo = chunk.page_number !== null ? ` (Page ${chunk.page_number})` : '';
          const heading = chunk.heading_context ? ` - ${chunk.heading_context}` : '';
          lines.push(`### Chunk ${chunk.chunk_index}${pageInfo}${heading}`);
          lines.push('');
          lines.push(chunk.text);
          lines.push('');
        }
      }

      if (input.include_images && images.length > 0) {
        lines.push('## Images');
        lines.push('');
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const pageInfo = img.page_number !== null ? ` (Page ${img.page_number})` : '';
          lines.push(`### Image ${i + 1}${pageInfo}`);
          lines.push(`- **Path:** ${img.extracted_path ?? 'N/A'}`);
          lines.push(`- **Type:** ${img.block_type ?? 'unknown'}`);
          lines.push(`- **Size:** ${img.width ?? '?'}x${img.height ?? '?'}`);
          if (img.vlm_description) {
            lines.push(`- **Description:** ${img.vlm_description}`);
          }
          lines.push('');
        }
      }

      if (input.include_extractions && extractions.length > 0) {
        lines.push('## Extractions');
        lines.push('');
        for (let i = 0; i < extractions.length; i++) {
          const ext = extractions[i];
          lines.push(`### Extraction ${i + 1}`);
          lines.push('');
          lines.push('**Schema:**');
          lines.push('```json');
          lines.push(String(ext.schema_json));
          lines.push('```');
          lines.push('');
          lines.push('**Data:**');
          lines.push('```json');
          lines.push(String(ext.extraction_json));
          lines.push('```');
          lines.push('');
        }
      }

      if (input.include_provenance && provenance && provenance.length > 0) {
        lines.push('## Provenance');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(provenance, null, 2));
        lines.push('```');
        lines.push('');
      }

      writeFileSync(safePath, lines.join('\n'), 'utf-8');
    }

    return formatResponse(
      successResult({
        output_path: safePath,
        format: input.format,
        document_id: doc.id,
        stats: {
          chunk_count: chunks.length,
          image_count: images.length,
          extraction_count: extractions.length,
        },
        next_steps: [{ tool: 'ocr_document_list', description: 'Export another document' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORPUS EXPORT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_corpus_export - Export entire corpus metadata and statistics
 */
export async function handleCorpusExport(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(CorpusExportInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Get all documents
    const documents = db.listDocuments();

    // Sanitize output path
    const safePath = sanitizePath(input.output_path);

    // Create output directory if needed
    const dir = dirname(safePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let totalChunks = 0;
    let totalImages = 0;

    if (input.format === 'json') {
      // Build JSON export: array of document objects
      const exportDocs: Array<Record<string, unknown>> = [];

      for (const doc of documents) {
        const chunkRows = db.getChunksByDocumentId(doc.id);
        const chunkCount = chunkRows.length;
        totalChunks += chunkCount;

        const imageCountRow = conn
          .prepare('SELECT COUNT(*) as count FROM images WHERE document_id = ?')
          .get(doc.id) as { count: number } | undefined;
        const imageCount = imageCountRow?.count ?? 0;
        totalImages += imageCount;

        const docEntry: Record<string, unknown> = {
          id: doc.id,
          file_path: doc.file_path,
          file_name: doc.file_name,
          file_type: doc.file_type,
          file_size: doc.file_size,
          status: doc.status,
          page_count: doc.page_count,
          doc_title: doc.doc_title ?? null,
          doc_author: doc.doc_author ?? null,
          doc_subject: doc.doc_subject ?? null,
          chunk_count: chunkCount,
          image_count: imageCount,
          created_at: doc.created_at,
        };

        if (input.include_chunks) {
          docEntry.chunks = chunkRows.map((c) => ({
            id: c.id,
            chunk_index: c.chunk_index,
            text: c.text,
            page_number: c.page_number,
            heading_context: c.heading_context ?? null,
            section_path: c.section_path ?? null,
            content_types: c.content_types ?? null,
          }));
        }

        if (input.include_images) {
          const imgRows = getImagesByDocument(conn, doc.id);
          totalImages = totalImages - imageCount + imgRows.length; // Correct count
          docEntry.images = imgRows.map((img) => ({
            id: img.id,
            page_number: img.page_number,
            block_type: img.block_type,
            extracted_path: img.extracted_path,
            width: img.dimensions?.width ?? null,
            height: img.dimensions?.height ?? null,
            vlm_status: img.vlm_status,
            vlm_description: img.vlm_description ?? null,
          }));
        }

        exportDocs.push(docEntry);
      }

      writeFileSync(safePath, JSON.stringify(exportDocs, null, 2), 'utf-8');
    } else {
      // CSV format: one row per document
      const csvQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

      const headers = ['id', 'file_path', 'file_name', 'file_type', 'status', 'page_count', 'chunk_count', 'image_count', 'created_at'];
      const csvLines: string[] = [headers.map(csvQuote).join(',')];

      for (const doc of documents) {
        const chunkCount = db.getChunksByDocumentId(doc.id).length;
        totalChunks += chunkCount;

        const imageCountRow = conn
          .prepare('SELECT COUNT(*) as count FROM images WHERE document_id = ?')
          .get(doc.id) as { count: number } | undefined;
        const imageCount = imageCountRow?.count ?? 0;
        totalImages += imageCount;

        csvLines.push([
          csvQuote(doc.id),
          csvQuote(doc.file_path),
          csvQuote(doc.file_name),
          csvQuote(doc.file_type),
          csvQuote(doc.status),
          csvQuote(String(doc.page_count ?? '')),
          csvQuote(String(chunkCount)),
          csvQuote(String(imageCount)),
          csvQuote(doc.created_at),
        ].join(','));
      }

      writeFileSync(safePath, csvLines.join('\n'), 'utf-8');
    }

    return formatResponse(
      successResult({
        output_path: safePath,
        format: input.format,
        document_count: documents.length,
        total_chunks: totalChunks,
        total_images: totalImages,
        next_steps: [{ tool: 'ocr_report_overview', description: 'Get quality and corpus analytics' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT VERSIONS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const DocumentVersionsInput = z.object({
  document_id: z.string().min(1).describe('Document ID to find versions of'),
});

/**
 * Handle ocr_document_versions - Find all versions of a document by file_path
 */
async function handleDocumentVersions(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentVersionsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Query ALL documents with the same file_path, ordered by created_at DESC
    const versions = conn
      .prepare(
        `SELECT id, file_hash, file_size, status, created_at, ocr_completed_at
         FROM documents
         WHERE file_path = ?
         ORDER BY created_at DESC`
      )
      .all(doc.file_path) as Array<{
      id: string;
      file_hash: string;
      file_size: number;
      status: string;
      created_at: string;
      ocr_completed_at: string | null;
    }>;

    return formatResponse(
      successResult({
        document_id: input.document_id,
        file_path: doc.file_path,
        versions: versions.map((v) => ({
          id: v.id,
          file_hash: v.file_hash,
          file_size: v.file_size,
          status: v.status,
          created_at: v.created_at,
          ocr_completed_at: v.ocr_completed_at,
        })),
        total_versions: versions.length,
        next_steps: [{ tool: 'ocr_document_get', description: 'Get details for a specific version' }, { tool: 'ocr_document_compare', description: 'Compare two versions' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT WORKFLOW HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const WORKFLOW_PREFIX = 'workflow:';
const WORKFLOW_COLORS: Record<string, string> = {
  draft: '#6B7280',
  review: '#F59E0B',
  approved: '#10B981',
  rejected: '#EF4444',
  archived: '#6366F1',
};

const DocumentWorkflowInput = z.object({
  document_id: z.string().min(1).describe('Document ID'),
  action: z.enum(['get', 'set', 'history']).describe('Action: get current state, set new state, or view history'),
  state: z.enum(['draft', 'review', 'approved', 'rejected', 'archived']).optional()
    .describe('New workflow state (required for action=set)'),
  note: z.string().max(500).optional().describe('Optional note for state transition'),
});

/**
 * Get the current workflow state for a document from its most recent workflow tag.
 */
function getCurrentWorkflowState(
  conn: import('better-sqlite3').Database,
  documentId: string
): string {
  const tag = conn
    .prepare(
      `SELECT t.name FROM tags t
       JOIN entity_tags et ON et.tag_id = t.id
       WHERE et.entity_type = 'document' AND et.entity_id = ?
         AND t.name LIKE 'workflow:%'
       ORDER BY et.created_at DESC LIMIT 1`
    )
    .get(documentId) as { name: string } | undefined;

  return tag ? tag.name.replace(WORKFLOW_PREFIX, '') : 'none';
}

/**
 * Handle ocr_document_workflow - Manage document workflow states via tags
 */
async function handleDocumentWorkflow(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentWorkflowInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    if (input.action === 'get') {
      return formatResponse(
        successResult({
          document_id: input.document_id,
          current_state: getCurrentWorkflowState(conn, input.document_id),
          next_steps: [{ tool: 'ocr_document_get', description: 'View document details after workflow change' }, { tool: 'ocr_tag_search', description: 'Find other documents in the same workflow state' }],
        })
      );
    }

    if (input.action === 'set') {
      if (!input.state) {
        throw new MCPError('VALIDATION_ERROR', 'state is required when action is "set"');
      }

      const previousState = getCurrentWorkflowState(conn, input.document_id);

      // Don't delete old workflow tags - preserve history for the 'history' action.
      // The 'get' action uses ORDER BY created_at DESC LIMIT 1 to get current state.

      // Create tag if it doesn't exist
      const tagName = WORKFLOW_PREFIX + input.state;
      const now = new Date().toISOString();
      const { v4: uuidv4 } = await import('uuid');

      conn
        .prepare(
          `INSERT OR IGNORE INTO tags (id, name, description, color, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          uuidv4(),
          tagName,
          `Workflow state: ${input.state}${input.note ? ' - ' + input.note : ''}`,
          WORKFLOW_COLORS[input.state] ?? '#6B7280',
          now
        );

      // Get the tag ID (may have been pre-existing)
      const tag = conn
        .prepare('SELECT id FROM tags WHERE name = ?')
        .get(tagName) as { id: string };

      // Apply tag to document
      conn
        .prepare(
          `INSERT INTO entity_tags (id, entity_type, entity_id, tag_id, created_at)
           VALUES (?, 'document', ?, ?, ?)`
        )
        .run(uuidv4(), input.document_id, tag.id, now);

      return formatResponse(
        successResult({
          document_id: input.document_id,
          previous_state: previousState,
          new_state: input.state,
          transitioned_at: now,
          note: input.note ?? null,
          next_steps: [{ tool: 'ocr_document_get', description: 'View document details after workflow change' }, { tool: 'ocr_tag_search', description: 'Find other documents in the same workflow state' }],
        })
      );
    }

    // action === 'history'
    const historyRows = conn
      .prepare(
        `SELECT t.name, et.created_at
         FROM entity_tags et
         JOIN tags t ON t.id = et.tag_id
         WHERE et.entity_type = 'document' AND et.entity_id = ?
           AND t.name LIKE 'workflow:%'
         ORDER BY et.created_at ASC`
      )
      .all(input.document_id) as Array<{ name: string; created_at: string }>;

    // Get current state (last entry)
    const currentState = historyRows.length > 0
      ? historyRows[historyRows.length - 1].name.replace(WORKFLOW_PREFIX, '')
      : 'none';

    return formatResponse(
      successResult({
        document_id: input.document_id,
        current_state: currentState,
        history: historyRows.map((r) => ({
          state: r.name.replace(WORKFLOW_PREFIX, ''),
          applied_at: r.created_at,
        })),
        next_steps: [{ tool: 'ocr_document_get', description: 'View document details after workflow change' }, { tool: 'ocr_tag_search', description: 'Find other documents in the same workflow state' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Document tools collection for MCP server registration
 */
export const documentTools: Record<string, ToolDefinition> = {
  ocr_document_list: {
    description:
      '[ESSENTIAL] Use to browse documents in the current database. Returns metadata with structural summaries. Filter by status, date, or file type. Start here after ocr_db_select.',
    inputSchema: {
      status_filter: z
        .enum(['pending', 'processing', 'complete', 'failed'])
        .optional()
        .describe('Filter by status'),
      limit: z.number().int().min(1).max(1000).default(50).describe('Maximum results'),
      offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
      created_after: z.string().datetime().optional()
        .describe('Filter documents created after this ISO 8601 timestamp'),
      created_before: z.string().datetime().optional()
        .describe('Filter documents created before this ISO 8601 timestamp'),
      file_type: z.string().optional()
        .describe('Filter by file type (e.g., "pdf", "docx")'),
    },
    handler: handleDocumentList,
  },
  ocr_document_get: {
    description:
      '[ESSENTIAL] Use to get full details for a single document. Returns OCR metadata, structure, quality, and memberships. Use ocr_document_page to read specific pages.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_text: z.boolean().default(false).describe('Include OCR extracted text'),
      include_chunks: z.boolean().default(false).describe('Include chunk information'),
      include_blocks: z
        .boolean()
        .default(false)
        .describe('Include JSON blocks and extras metadata'),
      include_full_provenance: z.boolean().default(false).describe('Include full provenance chain'),
    },
    handler: handleDocumentGet,
  },
  ocr_document_delete: {
    description:
      '[DESTRUCTIVE] Use to permanently delete a document and all derived data (chunks, embeddings, images, provenance). Requires confirm=true.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleDocumentDelete,
  },
  ocr_document_find_similar: {
    description:
      '[ANALYSIS] Use to find documents similar to a given document by content. Returns ranked list with similarity scores. Requires completed embeddings.',
    inputSchema: FindSimilarInput.shape,
    handler: handleFindSimilar,
  },
  ocr_document_structure: {
    description:
      '[ESSENTIAL] Use to get document structure. Default format="structure" returns headings, tables, figures, code blocks. Use format="tree" for hierarchical section tree with chunk IDs, or format="outline" for flat numbered list.',
    inputSchema: DocumentStructureInput.shape,
    handler: handleDocumentStructure,
  },
  ocr_document_update_metadata: {
    description:
      '[MANAGE] Use to update title, author, or subject metadata on one or more documents. Returns updated document IDs.',
    inputSchema: UpdateMetadataInput.shape,
    handler: handleUpdateMetadata,
  },
  ocr_document_duplicates: {
    description:
      '[ANALYSIS] Use to find duplicate documents. Exact mode matches file hashes; near mode uses similarity scores from comparisons. Returns duplicate pairs.',
    inputSchema: DuplicateDetectionInput.shape,
    handler: handleDuplicateDetection,
  },
  ocr_document_export: {
    description:
      '[STATUS] Use to export all data for a document to JSON or markdown file. Returns complete document data including chunks, images, and extractions.',
    inputSchema: DocumentExportInput.shape,
    handler: handleDocumentExport,
  },
  ocr_corpus_export: {
    description:
      '[STATUS] Use to export entire corpus metadata to JSON or CSV. Returns all document summaries with statistics. Use for backup or external analysis.',
    inputSchema: CorpusExportInput.shape,
    handler: handleCorpusExport,
  },
  ocr_document_versions: {
    description:
      '[ANALYSIS] Use to find all versions of a re-ingested document. Returns documents sharing the same file path, newest first.',
    inputSchema: DocumentVersionsInput.shape,
    handler: handleDocumentVersions,
  },
  ocr_document_workflow: {
    description:
      '[MANAGE] Use to track document review progress. action="get" shows current state, action="set" changes state (draft/review/approved/rejected/archived), action="history" shows all state transitions. States are stored as tags.',
    inputSchema: DocumentWorkflowInput.shape,
    handler: handleDocumentWorkflow,
  },
};

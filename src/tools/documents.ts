/**
 * Document Management MCP Tools
 *
 * Extracted from src/index.ts Task 22.
 * Tools: ocr_document_list, ocr_document_get, ocr_document_delete,
 *        ocr_document_find_similar, ocr_document_classify
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/documents
 */

import { z } from 'zod';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { requireDatabase, getDefaultStoragePath } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  DocumentListInput,
  DocumentGetInput,
  DocumentDeleteInput,
} from '../utils/validation.js';
import { documentNotFoundError, MCPError } from '../server/errors.js';
import { formatResponse, handleError, parseGeminiJson, type ToolResponse, type ToolDefinition } from './shared.js';
import { getComparisonSummariesByDocument } from '../services/storage/database/comparison-operations.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';

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
        })),
        total,
        limit: input.limit,
        offset: input.offset,
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

const DEFAULT_CATEGORIES = [
  'contract', 'invoice', 'report', 'letter', 'legal_filing',
  'medical_record', 'academic_paper', 'form', 'memo',
  'presentation', 'spreadsheet', 'other',
];

const ClassifyDocumentInput = z.object({
  document_id: z.string().min(1).describe('Document ID to classify'),
  custom_categories: z.array(z.string()).optional()
    .describe('Custom category list (default: contract, invoice, report, letter, legal_filing, medical_record, academic_paper, form, memo, presentation, spreadsheet, other)'),
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

    // Enrich with document metadata
    const similarDocuments = ranked.map((r) => {
      const simDoc = db.getDocument(r.document_id);
      return {
        document_id: r.document_id,
        file_name: simDoc?.file_name ?? null,
        file_type: simDoc?.file_type ?? null,
        status: simDoc?.status ?? null,
        avg_similarity: r.avg_similarity,
        matching_chunks: r.matching_chunks,
      };
    });

    return formatResponse(
      successResult({
        source_document_id: input.document_id,
        source_chunk_count: vectors.length,
        similar_documents: similarDocuments,
        total: similarDocuments.length,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT CLASSIFICATION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_classify - Classify a document using Gemini AI
 */
export async function handleClassifyDocument(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ClassifyDocumentInput, params);
    const { db } = requireDatabase();

    // Get document and verify status
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    if (doc.status !== 'complete') {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Document "${input.document_id}" has status "${doc.status}". Only "complete" documents can be classified.`
      );
    }

    // Get OCR result and sample text
    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult?.extracted_text) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Document "${input.document_id}" has no extracted text. Process OCR first.`
      );
    }

    const sampleText = ocrResult.extracted_text.substring(0, 2000);
    const categories = input.custom_categories ?? DEFAULT_CATEGORIES;

    // Use Gemini for classification
    const { getSharedClient } = await import('../services/gemini/index.js');
    const gemini = getSharedClient();

    const prompt = `Classify the following document text into one of these categories: ${categories.join(', ')}

Analyze the content and determine:
1. The document type (must be one of the categories listed)
2. Your confidence (0-1)
3. Brief reasoning for your classification
4. The primary language of the document
5. Key topics covered (up to 5)

Document text (first 2000 chars):
---
${sampleText}
---

Respond with valid JSON matching the schema.`;

    const schema = {
      type: 'object' as const,
      properties: {
        document_type: { type: 'string' as const, enum: categories },
        confidence: { type: 'number' as const },
        reasoning: { type: 'string' as const },
        language: { type: 'string' as const },
        key_topics: { type: 'array' as const, items: { type: 'string' as const } },
      },
      required: ['document_type', 'confidence', 'reasoning'],
    };

    const result = await gemini.fast(prompt, schema);
    const classification = parseGeminiJson<{
      document_type: string;
      confidence: number;
      reasoning: string;
      language?: string;
      key_topics?: string[];
    }>(result.text, 'document_classify');

    // Store classification in doc_subject field
    db.getConnection()
      .prepare('UPDATE documents SET doc_subject = ? WHERE id = ?')
      .run(JSON.stringify(classification), doc.id);

    return formatResponse(
      successResult({
        document_id: doc.id,
        file_name: doc.file_name,
        document_type: classification.document_type,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        language: classification.language ?? null,
        key_topics: classification.key_topics ?? [],
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
 * Handle ocr_document_structure - Analyze document structure (headings, tables, figures, code)
 */
export async function handleDocumentStructure(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentStructureInput, params);
    const { db } = requireDatabase();

    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    const outline: OutlineEntry[] = [];
    const tables: TableEntry[] = [];
    const figures: FigureEntry[] = [];
    const codeBlocks: CodeBlockEntry[] = [];
    let source: 'json_blocks' | 'chunks' = 'chunks';

    // Try json_blocks first (richer structure)
    const ocrRow = db.getConnection()
      .prepare('SELECT json_blocks FROM ocr_results WHERE document_id = ?')
      .get(input.document_id) as { json_blocks: string | null } | undefined;

    if (ocrRow?.json_blocks) {
      try {
        const blocks = JSON.parse(ocrRow.json_blocks) as Array<Record<string, unknown>>;
        if (Array.isArray(blocks) && blocks.length > 0) {
          walkBlocks(blocks, outline, tables, figures, codeBlocks);
          source = 'json_blocks';
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

    return formatResponse(
      successResult({
        document_id: doc.id,
        file_name: doc.file_name,
        page_count: doc.page_count,
        source,
        outline,
        tables: { count: tables.length, items: tables },
        figures: { count: figures.length, items: figures },
        code_blocks: { count: codeBlocks.length, items: codeBlocks },
        total_structural_elements: outline.length + tables.length + figures.length + codeBlocks.length,
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
      'List documents in the current database. Supports status filtering.',
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
      'Get detailed information about a specific document including OCR results, chunks, and provenance.',
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
      'Delete a document and all its derived data (chunks, embeddings, vectors, provenance)',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleDocumentDelete,
  },
  ocr_document_find_similar: {
    description:
      'Find documents similar to a given document using averaged chunk embeddings as document centroid for vector similarity search.',
    inputSchema: FindSimilarInput.shape,
    handler: handleFindSimilar,
  },
  ocr_document_classify: {
    description:
      'Classify a document into a category (contract, invoice, report, etc.) using Gemini AI analysis of OCR text.',
    inputSchema: ClassifyDocumentInput.shape,
    handler: handleClassifyDocument,
  },
  ocr_document_structure: {
    description:
      'Analyze document structure including headings outline, tables, figures, and code blocks. Uses json_blocks when available, falls back to chunk metadata.',
    inputSchema: DocumentStructureInput.shape,
    handler: handleDocumentStructure,
  },
  ocr_document_update_metadata: {
    description:
      'Batch update metadata (title, author, subject) for one or more documents.',
    inputSchema: UpdateMetadataInput.shape,
    handler: handleUpdateMetadata,
  },
  ocr_document_duplicates: {
    description:
      'Detect duplicate documents. Exact mode finds documents with identical file hashes. Near mode finds high-similarity document pairs from the comparisons table.',
    inputSchema: DuplicateDetectionInput.shape,
    handler: handleDuplicateDetection,
  },
};

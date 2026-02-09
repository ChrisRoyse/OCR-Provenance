/**
 * Document Comparison Tools
 *
 * MCP tools for comparing two OCR-processed documents.
 * Provides text diff, structural diff, and entity diff.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module tools/comparison
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse, handleError, type ToolDefinition, type ToolResponse } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { computeHash } from '../utils/hash.js';
import { MCPError } from '../server/errors.js';
import { compareText, compareStructure, compareEntities, generateSummary } from '../services/comparison/diff-service.js';
import { insertComparison, getComparison, listComparisons } from '../services/storage/database/comparison-operations.js';
import { getEntitiesByDocument } from '../services/storage/database/entity-operations.js';
import type { Comparison } from '../models/comparison.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const DocumentCompareInput = z.object({
  document_id_1: z.string().min(1).describe('First document ID'),
  document_id_2: z.string().min(1).describe('Second document ID'),
  include_text_diff: z.boolean().default(true).describe('Include text-level diff operations'),
  include_entity_diff: z.boolean().default(true).describe('Include entity comparison'),
  max_diff_operations: z.number().int().min(1).max(10000).default(1000).describe('Maximum diff operations to return'),
});

const ComparisonListInput = z.object({
  document_id: z.string().optional().describe('Filter by document ID (matches either doc1 or doc2)'),
  limit: z.number().int().min(1).max(100).default(50).describe('Maximum results'),
  offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
});

const ComparisonGetInput = z.object({
  comparison_id: z.string().min(1).describe('Comparison ID'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleDocumentCompare(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const startTime = Date.now();
    const input = validateInput(DocumentCompareInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Validate: different documents
    if (input.document_id_1 === input.document_id_2) {
      throw new MCPError('VALIDATION_ERROR', 'Cannot compare document with itself. Provide two different document IDs.');
    }

    // Fetch documents - FAIL FAST if not found
    const doc1 = conn.prepare('SELECT * FROM documents WHERE id = ?').get(input.document_id_1) as Record<string, unknown> | undefined;
    if (!doc1) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document '${input.document_id_1}' not found`);
    }
    const doc2 = conn.prepare('SELECT * FROM documents WHERE id = ?').get(input.document_id_2) as Record<string, unknown> | undefined;
    if (!doc2) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document '${input.document_id_2}' not found`);
    }

    // Verify documents are OCR processed
    if (doc1.status !== 'complete') {
      throw new MCPError('VALIDATION_ERROR', `Document '${input.document_id_1}' has status '${String(doc1.status)}', expected 'complete'. Run ocr_process_pending first.`);
    }
    if (doc2.status !== 'complete') {
      throw new MCPError('VALIDATION_ERROR', `Document '${input.document_id_2}' has status '${String(doc2.status)}', expected 'complete'. Run ocr_process_pending first.`);
    }

    // Fetch OCR results
    const ocr1 = conn.prepare('SELECT * FROM ocr_results WHERE document_id = ?').get(input.document_id_1) as Record<string, unknown> | undefined;
    if (!ocr1) {
      throw new MCPError('INTERNAL_ERROR', `No OCR result found for document '${input.document_id_1}'. Document may need reprocessing.`);
    }
    const ocr2 = conn.prepare('SELECT * FROM ocr_results WHERE document_id = ?').get(input.document_id_2) as Record<string, unknown> | undefined;
    if (!ocr2) {
      throw new MCPError('INTERNAL_ERROR', `No OCR result found for document '${input.document_id_2}'. Document may need reprocessing.`);
    }

    // Fetch chunks for structural comparison
    const chunks1Count = (conn.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE document_id = ?').get(input.document_id_1) as { cnt: number }).cnt;
    const chunks2Count = (conn.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE document_id = ?').get(input.document_id_2) as { cnt: number }).cnt;

    // Text diff
    const textDiff = input.include_text_diff
      ? compareText(String(ocr1.extracted_text), String(ocr2.extracted_text), input.max_diff_operations)
      : null;

    // Structural diff
    const structuralDiff = compareStructure(
      doc1.page_count as number | null,
      doc2.page_count as number | null,
      chunks1Count,
      chunks2Count,
      Number(ocr1.text_length),
      Number(ocr2.text_length),
      ocr1.parse_quality_score as number | null,
      ocr2.parse_quality_score as number | null,
      String(ocr1.datalab_mode),
      String(ocr2.datalab_mode)
    );

    // Entity diff
    let entityDiff = null;
    if (input.include_entity_diff) {
      try {
        const entities1 = getEntitiesByDocument(conn, input.document_id_1);
        const entities2 = getEntitiesByDocument(conn, input.document_id_2);
        entityDiff = compareEntities(entities1, entities2);
      } catch (e: unknown) {
        // If entities table doesn't exist (no entities extracted yet), return empty
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('no such table')) {
          entityDiff = { doc1_total_entities: 0, doc2_total_entities: 0, by_type: {} };
        } else {
          throw e;
        }
      }
    }

    // Generate summary
    const summary = generateSummary(
      textDiff,
      structuralDiff,
      entityDiff,
      String(doc1.file_name),
      String(doc2.file_name)
    );

    // Compute similarity from text diff or default to structural comparison
    const similarityRatio = textDiff ? textDiff.similarity_ratio : 0;

    // Compute content hash
    const diffContent = JSON.stringify({
      text_diff: textDiff,
      structural_diff: structuralDiff,
      entity_diff: entityDiff,
    });
    const contentHash = computeHash(diffContent);

    // Create provenance record
    const provId = uuidv4();
    const comparisonId = uuidv4();
    const now = new Date().toISOString();
    const inputHash = computeHash(String(ocr1.content_hash) + ':' + String(ocr2.content_hash));

    conn.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_file_created_at, source_file_modified_at,
        source_type, source_path, source_id, root_document_id, location, content_hash, input_hash, file_hash,
        processor, processor_version, processing_params, processing_duration_ms, processing_quality_score,
        parent_id, parent_ids, chain_depth, chain_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provId,
      'COMPARISON',
      now,
      now,
      null,
      null,
      'COMPARISON',
      `${String(doc1.file_path)} <-> ${String(doc2.file_path)}`,
      String(ocr1.provenance_id),
      String(doc1.provenance_id),
      null,
      contentHash,
      inputHash,
      String(doc1.file_hash),
      'document-comparison',
      '1.0.0',
      JSON.stringify({ document_id_1: input.document_id_1, document_id_2: input.document_id_2 }),
      null,
      null,
      String(ocr1.provenance_id),
      JSON.stringify([String(doc1.provenance_id), String(ocr1.provenance_id)]),
      2,
      JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'COMPARISON'])
    );

    const processingDurationMs = Date.now() - startTime;

    // Update provenance with actual duration
    conn.prepare('UPDATE provenance SET processing_duration_ms = ? WHERE id = ?').run(processingDurationMs, provId);

    // Insert comparison record
    const comparison: Comparison = {
      id: comparisonId,
      document_id_1: input.document_id_1,
      document_id_2: input.document_id_2,
      similarity_ratio: similarityRatio,
      text_diff_json: JSON.stringify(textDiff ?? {}),
      structural_diff_json: JSON.stringify(structuralDiff),
      entity_diff_json: JSON.stringify(entityDiff ?? {}),
      summary,
      content_hash: contentHash,
      provenance_id: provId,
      created_at: now,
      processing_duration_ms: processingDurationMs,
    };

    insertComparison(conn, comparison);

    return formatResponse({
      comparison_id: comparisonId,
      document_1: { id: input.document_id_1, file_name: doc1.file_name },
      document_2: { id: input.document_id_2, file_name: doc2.file_name },
      similarity_ratio: similarityRatio,
      summary,
      text_diff: textDiff,
      structural_diff: structuralDiff,
      entity_diff: entityDiff,
      provenance_id: provId,
      processing_duration_ms: processingDurationMs,
    });
  } catch (error) {
    return handleError(error);
  }
}

async function handleComparisonList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ComparisonListInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const comparisons = listComparisons(conn, {
      document_id: input.document_id,
      limit: input.limit,
      offset: input.offset,
    });

    // Return summaries without large JSON fields
    const results = comparisons.map(c => ({
      id: c.id,
      document_id_1: c.document_id_1,
      document_id_2: c.document_id_2,
      similarity_ratio: c.similarity_ratio,
      summary: c.summary,
      created_at: c.created_at,
      processing_duration_ms: c.processing_duration_ms,
    }));

    return formatResponse({
      comparisons: results,
      count: results.length,
      offset: input.offset,
      limit: input.limit,
    });
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

    // Parse stored JSON fields
    return formatResponse({
      ...comparison,
      text_diff_json: JSON.parse(comparison.text_diff_json),
      structural_diff_json: JSON.parse(comparison.structural_diff_json),
      entity_diff_json: JSON.parse(comparison.entity_diff_json),
    });
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const comparisonTools: Record<string, ToolDefinition> = {
  'ocr_document_compare': {
    description: 'Compare two OCR-processed documents to find differences in text, structure, and entities. Returns similarity ratio, text diff operations, structural metadata comparison, and entity differences.',
    inputSchema: DocumentCompareInput.shape,
    handler: handleDocumentCompare,
  },
  'ocr_comparison_list': {
    description: 'List document comparisons with optional filtering by document ID. Returns comparison summaries without large diff data.',
    inputSchema: ComparisonListInput.shape,
    handler: handleComparisonList,
  },
  'ocr_comparison_get': {
    description: 'Get a specific comparison by ID with full diff data including text operations, structural differences, and entity differences.',
    inputSchema: ComparisonGetInput.shape,
    handler: handleComparisonGet,
  },
};

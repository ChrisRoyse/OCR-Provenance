/**
 * Document Management MCP Tools
 *
 * Extracted from src/index.ts Task 22.
 * Tools: ocr_document_list, ocr_document_get, ocr_document_delete
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
import { documentNotFoundError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { getComparisonSummariesByDocument } from '../services/storage/database/comparison-operations.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getKnowledgeNodeSummariesByDocument } from '../services/storage/database/knowledge-graph-operations.js';
import { archiveKGSubgraphForDocument } from '../services/storage/database/document-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_list - List documents in the current database
 */
export async function handleDocumentList(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentListInput, params);
    const { db } = requireDatabase();

    const documents = db.listDocuments({
      status: input.status_filter,
      limit: input.limit,
      offset: input.offset,
    });

    // When a status filter is active, total must reflect the filtered count,
    // not the global total_documents from stats.
    const stats = db.getStats();
    const total = input.status_filter
      ? stats.documents_by_status[input.status_filter as keyof typeof stats.documents_by_status] ?? 0
      : stats.total_documents;

    return formatResponse(successResult({
      documents: documents.map(d => ({
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
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_document_get - Get detailed information about a specific document
 */
export async function handleDocumentGet(
  params: Record<string, unknown>
): Promise<ToolResponse> {
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
      ocr_info: ocrResult ? {
        ocr_result_id: ocrResult.id,
        datalab_request_id: ocrResult.datalab_request_id,
        datalab_mode: ocrResult.datalab_mode,
        parse_quality_score: ocrResult.parse_quality_score,
        cost_cents: ocrResult.cost_cents,
        page_count: ocrResult.page_count,
        text_length: ocrResult.text_length,
        processing_duration_ms: ocrResult.processing_duration_ms,
        content_hash: ocrResult.content_hash,
      } : null,
    };

    if (input.include_text) {
      result.ocr_text = ocrResult?.extracted_text ?? null;
    }

    if (input.include_chunks) {
      const chunks = db.getChunksByDocumentId(doc.id);
      result.chunks = chunks.map(c => ({
        id: c.id,
        chunk_index: c.chunk_index,
        text_length: c.text.length,
        page_number: c.page_number,
        character_start: c.character_start,
        character_end: c.character_end,
        embedding_status: c.embedding_status,
      }));
    }

    if (input.include_blocks && ocrResult) {
      result.json_blocks = ocrResult.json_blocks ? JSON.parse(ocrResult.json_blocks) : null;
      result.extras = ocrResult.extras_json ? JSON.parse(ocrResult.extras_json) : null;
    }

    if (input.include_full_provenance) {
      const chain = db.getProvenanceChain(doc.provenance_id);
      result.provenance_chain = chain.map(p => ({
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
      items: comparisons.map(c => ({
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
      result.clusters = clusterMemberships.map(c => ({
        cluster_id: c.id,
        run_id: c.run_id,
        cluster_index: c.cluster_index,
        label: c.label,
        classification_tag: c.classification_tag,
        coherence_score: c.coherence_score,
      }));
    }

    // Knowledge graph membership
    const knowledgeNodes = getKnowledgeNodeSummariesByDocument(db.getConnection(), doc.id);
    if (knowledgeNodes.length > 0) {
      result.knowledge_graph = {
        nodes: knowledgeNodes,
        cross_document_relationships: knowledgeNodes.filter(n => n.document_count > 1).length,
      };
    }

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_document_delete - Delete a document and all its derived data
 */
export async function handleDocumentDelete(
  params: Record<string, unknown>
): Promise<ToolResponse> {
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

    // Archive KG subgraph BEFORE any deletions (data must still exist)
    const archiveDir = resolve(getDefaultStoragePath(), 'archives');
    const archiveResult = archiveKGSubgraphForDocument(db.getConnection(), doc.id, archiveDir);

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

    return formatResponse(successResult({
      document_id: doc.id,
      deleted: true,
      chunks_deleted: chunks.length,
      embeddings_deleted: embeddings.length,
      vectors_deleted: vectorsDeleted,
      provenance_deleted: provenance.length,
      images_directory_cleaned: imagesCleanedUp,
      kg_archive: archiveResult,
    }));
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
  'ocr_document_list': {
    description: 'List documents in the current database',
    inputSchema: {
      status_filter: z.enum(['pending', 'processing', 'complete', 'failed']).optional().describe('Filter by status'),
      limit: z.number().int().min(1).max(1000).default(50).describe('Maximum results'),
      offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
    },
    handler: handleDocumentList,
  },
  'ocr_document_get': {
    description: 'Get detailed information about a specific document',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_text: z.boolean().default(false).describe('Include OCR extracted text'),
      include_chunks: z.boolean().default(false).describe('Include chunk information'),
      include_blocks: z.boolean().default(false).describe('Include JSON blocks and extras metadata'),
      include_full_provenance: z.boolean().default(false).describe('Include full provenance chain'),
    },
    handler: handleDocumentGet,
  },
  'ocr_document_delete': {
    description: 'Delete a document and all its derived data (chunks, embeddings, vectors, provenance)',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleDocumentDelete,
  },
};

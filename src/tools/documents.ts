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
  escapeLikePattern,
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

    // Batch query entity counts per document if requested
    let entityCountMap: Map<string, number> | undefined;
    let kgNodeCountMap: Map<string, number> | undefined;
    if (input.include_entity_counts) {
      entityCountMap = new Map();
      kgNodeCountMap = new Map();
      const conn = db.getConnection();
      try {
        const docIds = documents.map(d => d.id);
        if (docIds.length > 0) {
          const placeholders = docIds.map(() => '?').join(',');
          const entityRows = conn.prepare(
            `SELECT document_id, COUNT(*) as cnt FROM entity_mentions WHERE document_id IN (${placeholders}) GROUP BY document_id`
          ).all(...docIds) as Array<{ document_id: string; cnt: number }>;
          for (const r of entityRows) entityCountMap.set(r.document_id, r.cnt);

          const kgRows = conn.prepare(
            `SELECT em.document_id, COUNT(DISTINCT nel.node_id) as cnt
             FROM entity_mentions em
             JOIN entities e ON em.entity_id = e.id
             JOIN node_entity_links nel ON nel.entity_id = e.id
             WHERE em.document_id IN (${placeholders})
             GROUP BY em.document_id`
          ).all(...docIds) as Array<{ document_id: string; cnt: number }>;
          for (const r of kgRows) kgNodeCountMap.set(r.document_id, r.cnt);
        }
      } catch (err) {
        console.error(`[documents] entity/KG count query failed: ${err instanceof Error ? err.message : String(err)}`);
        // Entity/KG tables may not exist
      }
    }

    // Apply entity-based filters if any are provided
    let filteredDocuments = documents;
    const hasEntityFilters = input.entity_type_filter || input.min_entity_count || input.entity_name_filter;
    if (hasEntityFilters) {
      const conn = db.getConnection();
      const docIds = documents.map(d => d.id);
      if (docIds.length > 0) {
        let allowedDocIds: Set<string> | null = null;
        const placeholders = docIds.map(() => '?').join(',');

        try {
          // Filter by entity type
          if (input.entity_type_filter && input.entity_type_filter.length > 0) {
            const typePlaceholders = input.entity_type_filter.map(() => '?').join(',');
            const rows = conn.prepare(
              `SELECT DISTINCT document_id FROM entities WHERE entity_type IN (${typePlaceholders}) AND document_id IN (${placeholders})`
            ).all(...input.entity_type_filter, ...docIds) as Array<{ document_id: string }>;
            const typeSet = new Set(rows.map(r => r.document_id));
            allowedDocIds = allowedDocIds ? new Set([...allowedDocIds].filter(id => typeSet.has(id))) : typeSet;
          }

          // Filter by minimum entity count
          if (input.min_entity_count) {
            const rows = conn.prepare(
              `SELECT document_id, COUNT(*) as cnt FROM entities WHERE document_id IN (${placeholders}) GROUP BY document_id HAVING cnt >= ?`
            ).all(...docIds, input.min_entity_count) as Array<{ document_id: string; cnt: number }>;
            const countSet = new Set(rows.map(r => r.document_id));
            allowedDocIds = allowedDocIds ? new Set([...allowedDocIds].filter(id => countSet.has(id))) : countSet;
          }

          // Filter by entity name substring match
          if (input.entity_name_filter) {
            const likePattern = `%${escapeLikePattern(input.entity_name_filter.toLowerCase())}%`;
            const rows = conn.prepare(
              `SELECT DISTINCT document_id FROM entities WHERE LOWER(normalized_text) LIKE ? ESCAPE '\\' AND document_id IN (${placeholders})`
            ).all(likePattern, ...docIds) as Array<{ document_id: string }>;
            const nameSet = new Set(rows.map(r => r.document_id));
            allowedDocIds = allowedDocIds ? new Set([...allowedDocIds].filter(id => nameSet.has(id))) : nameSet;
          }
        } catch (err) {
          console.error(`[documents] entity filter query failed: ${err instanceof Error ? err.message : String(err)}`);
          // Entity tables may not exist yet — skip filtering
          allowedDocIds = null;
        }

        if (allowedDocIds !== null) {
          filteredDocuments = documents.filter(d => allowedDocIds!.has(d.id));
        }
      }
    }

    return formatResponse(successResult({
      documents: filteredDocuments.map(d => {
        const doc: Record<string, unknown> = {
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
        };
        if (input.include_entity_counts) {
          doc.entity_mention_count = entityCountMap?.get(d.id) ?? 0;
          doc.kg_node_count = kgNodeCountMap?.get(d.id) ?? 0;
        }
        return doc;
      }),
      total: hasEntityFilters ? filteredDocuments.length : total,
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

    // Entity summary when requested
    if (input.include_entity_summary) {
      const conn = db.getConnection();
      try {
        // Per-type entity counts with average confidence
        const typeCounts = conn.prepare(
          `SELECT entity_type, COUNT(*) as count, AVG(confidence) as avg_confidence
           FROM entities WHERE document_id = ? GROUP BY entity_type`
        ).all(doc.id) as Array<{ entity_type: string; count: number; avg_confidence: number }>;

        // Top 10 entities by mention count
        const topEntities = conn.prepare(
          `SELECT e.raw_text, e.entity_type, e.confidence, COUNT(em.id) as mention_count
           FROM entities e LEFT JOIN entity_mentions em ON em.entity_id = e.id
           WHERE e.document_id = ? GROUP BY e.id ORDER BY mention_count DESC LIMIT 10`
        ).all(doc.id) as Array<{ raw_text: string; entity_type: string; confidence: number; mention_count: number }>;

        // Extraction coverage from segments
        let extractionCoverage: { total_segments: number; segments_with_entities: number } | null = null;
        try {
          const coverage = conn.prepare(
            `SELECT COUNT(*) as total_segments, SUM(CASE WHEN entity_count > 0 THEN 1 ELSE 0 END) as segments_with_entities
             FROM entity_extraction_segments WHERE document_id = ?`
          ).get(doc.id) as { total_segments: number; segments_with_entities: number } | undefined;
          if (coverage && coverage.total_segments > 0) {
            extractionCoverage = coverage;
          }
        } catch (err) {
          console.error(`[documents] entity_extraction_segments query failed: ${err instanceof Error ? err.message : String(err)}`);
          // entity_extraction_segments table may not exist
        }

        result.entity_summary = {
          total_entities: typeCounts.reduce((sum, t) => sum + t.count, 0),
          by_type: typeCounts.map(t => ({
            entity_type: t.entity_type,
            count: t.count,
            avg_confidence: Math.round(t.avg_confidence * 1000) / 1000,
          })),
          top_entities: topEntities.map(e => ({
            raw_text: e.raw_text,
            entity_type: e.entity_type,
            confidence: e.confidence,
            mention_count: e.mention_count,
          })),
          extraction_coverage: extractionCoverage,
        };
      } catch (err) {
        console.error(`[documents] entity summary query failed: ${err instanceof Error ? err.message : String(err)}`);
        // Entity tables may not exist yet
        result.entity_summary = null;
      }
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
    description: 'List documents in the current database. Supports entity-based filtering: entity_type_filter, min_entity_count, entity_name_filter. Set include_entity_counts=true to see entity and KG node counts per document.',
    inputSchema: {
      status_filter: z.enum(['pending', 'processing', 'complete', 'failed']).optional().describe('Filter by status'),
      limit: z.number().int().min(1).max(1000).default(50).describe('Maximum results'),
      offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
      include_entity_counts: z.boolean().default(false).describe('Include entity_mention_count and kg_node_count per document'),
      entity_type_filter: z.array(z.enum([
        'person', 'organization', 'date', 'amount', 'case_number',
        'location', 'statute', 'exhibit', 'medication', 'diagnosis',
        'medical_device', 'other',
      ])).optional().describe('Only show documents containing entities of these types'),
      min_entity_count: z.number().int().min(1).optional().describe('Only show documents with at least this many entities'),
      entity_name_filter: z.string().optional().describe('Only show documents mentioning entities matching this text (substring match)'),
    },
    handler: handleDocumentList,
  },
  'ocr_document_get': {
    description: 'Get detailed information about a specific document. Set include_entity_summary=true for per-type entity counts, top entities, and extraction coverage.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_text: z.boolean().default(false).describe('Include OCR extracted text'),
      include_chunks: z.boolean().default(false).describe('Include chunk information'),
      include_blocks: z.boolean().default(false).describe('Include JSON blocks and extras metadata'),
      include_full_provenance: z.boolean().default(false).describe('Include full provenance chain'),
      include_entity_summary: z.boolean().default(false).describe('Include per-type entity counts, top entities by mention count, and extraction coverage'),
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

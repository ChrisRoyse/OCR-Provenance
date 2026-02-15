/**
 * Evaluation Report MCP Tools
 *
 * Tools for generating evaluation reports on OCR and VLM processing results.
 * Produces markdown reports with statistics, metrics, and quality analysis.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/reports
 */

import { z } from 'zod';
import * as fs from 'fs';
import { dirname } from 'path';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput, sanitizePath } from '../utils/validation.js';
import {
  getImageStats,
  getImagesByDocument,
} from '../services/storage/database/image-operations.js';
import { getComparisonSummariesByDocument } from '../services/storage/database/comparison-operations.js';
import { getClusteringStats, getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getKnowledgeNodeSummariesByDocument } from '../services/storage/database/knowledge-graph-operations.js';
import type Database from 'better-sqlite3';
import {
  getEntityCount,
  getEntityTypeDistribution,
  getPagesWithEntities,
  getSegmentStats,
  getKGLinkedEntityCount,
} from '../services/storage/database/entity-operations.js';


// ===============================================================================
// KNOWLEDGE GRAPH QUALITY METRICS
// ===============================================================================

interface KGQualityMetrics {
  total_nodes: number;
  total_edges: number;
  avg_document_count: number | null;
  max_document_count: number | null;
  avg_edge_count: number | null;
  max_edge_count: number | null;
  orphaned_nodes: number;
  entity_extraction_coverage: {
    docs_with_entities: number;
    total_complete_docs: number;
    coverage_pct: number;
  };
  resolution_method_distribution: Array<{ method: string; count: number }>;
  relationship_type_distribution: Array<{ type: string; count: number }>;
  entity_type_distribution: Array<{ type: string; count: number }>;
}

/**
 * Gather detailed KG health metrics from the database.
 * Queries knowledge_nodes, knowledge_edges, entities, and documents tables.
 */
function getKnowledgeGraphQualityMetrics(conn: Database.Database): KGQualityMetrics {
  const nodeTotals = conn.prepare(`
    SELECT
      COUNT(*) as total_nodes,
      AVG(document_count) as avg_doc_count,
      MAX(document_count) as max_doc_count,
      AVG(edge_count) as avg_edge_count,
      MAX(edge_count) as max_edge_count,
      SUM(CASE WHEN edge_count = 0 THEN 1 ELSE 0 END) as orphaned_nodes
    FROM knowledge_nodes
  `).get() as {
    total_nodes: number;
    avg_doc_count: number | null;
    max_doc_count: number | null;
    avg_edge_count: number | null;
    max_edge_count: number | null;
    orphaned_nodes: number;
  };

  const totalEdges = (conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;

  const coverage = conn.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT document_id) FROM entities) as docs_with_entities,
      (SELECT COUNT(*) FROM documents WHERE status = 'complete') as total_complete
  `).get() as { docs_with_entities: number; total_complete: number };

  const resolutionDist = conn.prepare(
    "SELECT COALESCE(resolution_method, 'unknown') as method, COUNT(*) as count FROM node_entity_links GROUP BY resolution_method ORDER BY count DESC"
  ).all() as Array<{ method: string; count: number }>;

  const relTypeDist = conn.prepare(
    'SELECT relationship_type as type, COUNT(*) as count FROM knowledge_edges GROUP BY relationship_type ORDER BY count DESC'
  ).all() as Array<{ type: string; count: number }>;

  const entityTypeDist = conn.prepare(
    'SELECT entity_type as type, COUNT(*) as count FROM knowledge_nodes GROUP BY entity_type ORDER BY count DESC'
  ).all() as Array<{ type: string; count: number }>;

  const coveragePct = coverage.total_complete > 0
    ? (coverage.docs_with_entities / coverage.total_complete) * 100
    : 0;

  return {
    total_nodes: nodeTotals.total_nodes,
    total_edges: totalEdges,
    avg_document_count: nodeTotals.total_nodes > 0 ? nodeTotals.avg_doc_count : null,
    max_document_count: nodeTotals.total_nodes > 0 ? nodeTotals.max_doc_count : null,
    avg_edge_count: nodeTotals.total_nodes > 0 ? nodeTotals.avg_edge_count : null,
    max_edge_count: nodeTotals.total_nodes > 0 ? nodeTotals.max_edge_count : null,
    orphaned_nodes: nodeTotals.orphaned_nodes,
    entity_extraction_coverage: {
      docs_with_entities: coverage.docs_with_entities,
      total_complete_docs: coverage.total_complete,
      coverage_pct: coveragePct,
    },
    resolution_method_distribution: resolutionDist,
    relationship_type_distribution: relTypeDist,
    entity_type_distribution: entityTypeDist,
  };
}

// ===============================================================================
// ENTITY QUALITY METRICS
// ===============================================================================

interface DocumentEntityQuality {
  entity_count: number;
  entity_density_per_page: number;
  type_distribution: Array<{ entity_type: string; count: number }>;
  pages_with_entities: number;
  total_pages: number;
  extraction_coverage_pct: number;
  kg_linked_entities: number;
  kg_link_coverage_pct: number;
  segment_stats: {
    total_segments: number;
    complete: number;
    failed: number;
    total_entities_extracted: number;
  } | null;
}

/**
 * Get entity quality metrics for a single document.
 * Returns zeros if entity tables do not exist.
 * Uses shared helpers from entity-operations.ts.
 */
function getDocumentEntityQualityMetrics(
  conn: Database.Database,
  documentId: string,
  pageCount: number | null,
): DocumentEntityQuality {
  const entityCount = getEntityCount(conn, documentId);
  const typeDist = getEntityTypeDistribution(conn, documentId);
  const pagesWithEntities = getPagesWithEntities(conn, documentId);
  const kgLinked = getKGLinkedEntityCount(conn, documentId);
  const segmentStats = getSegmentStats(conn, documentId);
  const totalPages = pageCount ?? 0;

  return {
    entity_count: entityCount,
    entity_density_per_page: totalPages > 0 ? entityCount / totalPages : 0,
    type_distribution: typeDist,
    pages_with_entities: pagesWithEntities,
    total_pages: totalPages,
    extraction_coverage_pct: totalPages > 0 ? (pagesWithEntities / totalPages) * 100 : 0,
    kg_linked_entities: kgLinked,
    kg_link_coverage_pct: entityCount > 0 ? (kgLinked / entityCount) * 100 : 0,
    segment_stats: segmentStats,
  };
}

/**
 * Get aggregate entity quality metrics across all documents.
 * Returns zeros if entity tables do not exist.
 */
function getAggregateEntityQualityMetrics(conn: Database.Database): Record<string, unknown> {
  const defaults = {
    total_entities: 0,
    docs_with_entities: 0,
    total_complete_docs: 0,
    entity_extraction_coverage_pct: 0,
    avg_entities_per_doc: 0,
    total_entity_mentions: 0,
    type_distribution: [] as Array<{ entity_type: string; count: number }>,
    kg_linked_entities: 0,
    kg_link_coverage_pct: 0,
    low_coverage_documents: [] as Array<{ document_id: string; file_name: string; entity_count: number; page_count: number; density: number }>,
  };

  try {
    const totalEntities = (conn.prepare(
      'SELECT COUNT(*) as cnt FROM entities'
    ).get() as { cnt: number }).cnt;

    const docsWithEntities = (conn.prepare(
      'SELECT COUNT(DISTINCT document_id) as cnt FROM entities'
    ).get() as { cnt: number }).cnt;

    const totalCompleteDocs = (conn.prepare(
      "SELECT COUNT(*) as cnt FROM documents WHERE status = 'complete'"
    ).get() as { cnt: number }).cnt;

    const avgEntitiesPerDoc = totalCompleteDocs > 0 ? totalEntities / totalCompleteDocs : 0;

    let totalMentions = 0;
    try {
      totalMentions = (conn.prepare(
        'SELECT COUNT(*) as cnt FROM entity_mentions'
      ).get() as { cnt: number }).cnt;
    } catch (err) {
      console.error(`[reports] entity_mentions count query failed: ${err instanceof Error ? err.message : String(err)}`);
      // entity_mentions may not exist
    }

    const typeDist = conn.prepare(
      'SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type ORDER BY count DESC'
    ).all() as Array<{ entity_type: string; count: number }>;

    let kgLinked = 0;
    try {
      kgLinked = (conn.prepare(
        'SELECT COUNT(DISTINCT entity_id) as cnt FROM node_entity_links'
      ).get() as { cnt: number }).cnt;
    } catch (err) {
      console.error(`[reports] node_entity_links count query failed: ${err instanceof Error ? err.message : String(err)}`);
      // node_entity_links may not exist
    }

    // Documents with low entity coverage (< 1 entity per page)
    const lowCoverageDocs = conn.prepare(`
      SELECT e.document_id, d.file_name, COUNT(*) as entity_count, COALESCE(d.page_count, 1) as page_count,
             CAST(COUNT(*) AS REAL) / MAX(1, COALESCE(d.page_count, 1)) as density
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE d.status = 'complete' AND d.page_count > 0
      GROUP BY e.document_id
      HAVING density < 1.0
      ORDER BY density ASC
      LIMIT 10
    `).all() as Array<{ document_id: string; file_name: string; entity_count: number; page_count: number; density: number }>;

    // Also find complete docs with zero entities
    const zeroEntityDocs = conn.prepare(`
      SELECT d.id as document_id, d.file_name, 0 as entity_count, COALESCE(d.page_count, 0) as page_count, 0.0 as density
      FROM documents d
      WHERE d.status = 'complete'
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.document_id = d.id)
      ORDER BY d.file_name
      LIMIT 10
    `).all() as Array<{ document_id: string; file_name: string; entity_count: number; page_count: number; density: number }>;

    const coveragePct = totalCompleteDocs > 0 ? (docsWithEntities / totalCompleteDocs) * 100 : 0;

    return {
      total_entities: totalEntities,
      docs_with_entities: docsWithEntities,
      total_complete_docs: totalCompleteDocs,
      entity_extraction_coverage_pct: coveragePct,
      avg_entities_per_doc: avgEntitiesPerDoc,
      total_entity_mentions: totalMentions,
      type_distribution: typeDist,
      kg_linked_entities: kgLinked,
      kg_link_coverage_pct: totalEntities > 0 ? (kgLinked / totalEntities) * 100 : 0,
      low_coverage_documents: [...zeroEntityDocs, ...lowCoverageDocs].slice(0, 10),
    };
  } catch (err) {
    console.error(`[reports] aggregate entity quality metrics failed: ${err instanceof Error ? err.message : String(err)}`);
    return defaults;
  }
}

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const EvaluationReportInput = z.object({
  output_path: z.string().optional(),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
});

const DocumentReportInput = z.object({
  document_id: z.string().min(1),
});

const QualitySummaryInput = z.object({});

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

interface DocumentImageStats {
  document_id: string;
  file_name: string;
  page_count: number | null;
  ocr_text_length: number;
  image_count: number;
  vlm_complete: number;
  vlm_pending: number;
  vlm_failed: number;
  avg_confidence: number;
  min_confidence: number;
  max_confidence: number;
  image_types: Record<string, number>;
}

interface LowConfidenceImage {
  image_id: string;
  document_id: string;
  file_name: string;
  page: number;
  confidence: number;
  image_type: string;
  path: string;
}

/**
 * Handle ocr_evaluation_report - Generate comprehensive evaluation report
 */
export async function handleEvaluationReport(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(EvaluationReportInput, params);
    const outputPath = input.output_path;
    const confidenceThreshold = input.confidence_threshold ?? 0.7;

    const { db } = requireDatabase();

    // Get overall stats
    const imageStats = getImageStats(db.getConnection());
    const dbStats = db.getStats();

    // Get per-document stats
    const documents = db.listDocuments({ limit: 1000 });
    const docStats: DocumentImageStats[] = [];
    const imageTypeDistribution: Record<string, number> = {};

    let totalConfidence = 0;
    let confidenceCount = 0;

    // M-10: Prepare per-document image status count query (reuse statement)
    const docImageCountStmt = db.getConnection().prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN vlm_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN vlm_status = 'failed' THEN 1 END) as failed
      FROM images WHERE document_id = ?
    `);

    for (const doc of documents) {
      // M-10: Use vlmStatus filter to only load complete images from SQL
      const completeImages = getImagesByDocument(db.getConnection(), doc.id, { vlmStatus: 'complete' });
      const ocrResult = db.getOCRResultByDocumentId(doc.id);
      const docImageCounts = docImageCountStmt.get(doc.id) as { total: number; pending: number; failed: number };

      const confidences = completeImages
        .filter(i => i.vlm_confidence !== null)
        .map(i => i.vlm_confidence as number);

      // Track image types
      const docImageTypes: Record<string, number> = {};
      for (const img of completeImages) {
        if (img.vlm_structured_data) {
          const imageType = (img.vlm_structured_data as { imageType?: string }).imageType || 'other';
          docImageTypes[imageType] = (docImageTypes[imageType] || 0) + 1;
          imageTypeDistribution[imageType] = (imageTypeDistribution[imageType] || 0) + 1;
        }
      }

      // Calculate stats
      const avgConfidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0;

      totalConfidence += confidences.reduce((a, b) => a + b, 0);
      confidenceCount += confidences.length;

      docStats.push({
        document_id: doc.id,
        file_name: doc.file_name,
        page_count: doc.page_count,
        ocr_text_length: ocrResult?.text_length || 0,
        image_count: docImageCounts.total,
        vlm_complete: completeImages.length,
        vlm_pending: docImageCounts.pending,
        vlm_failed: docImageCounts.failed,
        avg_confidence: avgConfidence,
        min_confidence: confidences.length > 0 ? Math.min(...confidences) : 0,
        max_confidence: confidences.length > 0 ? Math.max(...confidences) : 0,
        image_types: docImageTypes,
      });
    }

    // M-10: Direct SQL for low confidence images instead of tracking in per-document loop
    const lowConfidenceImages = db.getConnection().prepare(`
      SELECT i.id as image_id, i.document_id, d.file_name, i.page_number as page,
             i.vlm_confidence as confidence,
             COALESCE(json_extract(i.vlm_structured_data, '$.imageType'), 'unknown') as image_type,
             COALESCE(i.extracted_path, 'unknown') as path
      FROM images i
      JOIN documents d ON d.id = i.document_id
      WHERE i.vlm_status = 'complete'
        AND i.vlm_confidence IS NOT NULL
        AND i.vlm_confidence < ?
      ORDER BY i.vlm_confidence ASC
      LIMIT 50
    `).all(confidenceThreshold) as LowConfidenceImage[];

    // Calculate overall average confidence
    const overallAvgConfidence = confidenceCount > 0
      ? totalConfidence / confidenceCount
      : 0;

    // Comparison statistics
    const comparisonSummary = db.getConnection().prepare(`
      SELECT COUNT(*) as count, AVG(similarity_ratio) as avg_similarity
      FROM comparisons
    `).get() as { count: number; avg_similarity: number | null };
    const comparisonCount = comparisonSummary.count;
    const avgComparisonSimilarity = comparisonSummary.avg_similarity;

    // Clustering statistics
    const clusteringStats = getClusteringStats(db.getConnection());

    // Knowledge graph quality metrics
    const kgMetrics = getKnowledgeGraphQualityMetrics(db.getConnection());

    // Generate markdown report
    const report = generateMarkdownReport({
      dbStats,
      imageStats,
      docStats,
      lowConfidenceImages, // Already limited to 50 by SQL query
      imageTypeDistribution,
      overallAvgConfidence,
      confidenceThreshold,
      comparisonStats: { total: comparisonCount, avg_similarity: avgComparisonSimilarity },
      clusteringStats,
      kgMetrics,
    });

    // Save to file if path provided
    if (outputPath) {
      const safeOutputPath = sanitizePath(outputPath);
      const dir = dirname(safeOutputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(safeOutputPath, report);
      console.error(`[INFO] Report saved to: ${safeOutputPath}`);
    }

    return formatResponse(successResult({
      summary: {
        total_documents: documents.length,
        total_pages: documents.reduce((sum, d) => sum + (d.page_count || 0), 0),
        total_images: imageStats.total,
        vlm_processed: imageStats.processed,
        vlm_pending: imageStats.pending,
        vlm_failed: imageStats.failed,
        overall_avg_confidence: overallAvgConfidence,
        low_confidence_count: lowConfidenceImages.length,
        total_comparisons: comparisonCount,
        avg_comparison_similarity: avgComparisonSimilarity,
        total_clusters: clusteringStats.total_clusters,
        total_cluster_runs: clusteringStats.total_runs,
        avg_coherence: clusteringStats.avg_coherence,
        knowledge_graph: {
          total_nodes: kgMetrics.total_nodes,
          total_edges: kgMetrics.total_edges,
          avg_document_count: kgMetrics.avg_document_count,
          max_document_count: kgMetrics.max_document_count,
          avg_edge_count: kgMetrics.avg_edge_count,
          max_edge_count: kgMetrics.max_edge_count,
          orphaned_nodes: kgMetrics.orphaned_nodes,
          entity_extraction_coverage_pct: kgMetrics.entity_extraction_coverage.coverage_pct,
          resolution_method_distribution: kgMetrics.resolution_method_distribution,
          relationship_type_distribution: kgMetrics.relationship_type_distribution,
          entity_type_distribution: kgMetrics.entity_type_distribution,
        },
      },
      image_type_distribution: imageTypeDistribution,
      output_path: outputPath || null,
      report: outputPath ? null : report, // Only include report in response if not saved to file
    }));

  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_document_report - Generate report for a single document
 */
export async function handleDocumentReport(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentReportInput, params);
    const documentId = input.document_id;

    const { db } = requireDatabase();

    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError(
        'DOCUMENT_NOT_FOUND',
        `Document not found: ${documentId}`,
        { document_id: documentId }
      );
    }

    const ocrResult = db.getOCRResultByDocumentId(documentId);
    const images = getImagesByDocument(db.getConnection(), documentId);
    const chunks = db.getChunksByDocumentId(documentId);
    const extractions = db.getExtractionsByDocument(documentId);

    // Calculate image stats
    const completeImages = images.filter(i => i.vlm_status === 'complete');
    const confidences = completeImages
      .filter(i => i.vlm_confidence !== null)
      .map(i => i.vlm_confidence as number);

    const imageTypes: Record<string, number> = {};
    for (const img of completeImages) {
      if (img.vlm_structured_data) {
        const imageType = (img.vlm_structured_data as { imageType?: string }).imageType || 'other';
        imageTypes[imageType] = (imageTypes[imageType] || 0) + 1;
      }
    }

    // Build image details
    const imageDetails = images.map(img => ({
      id: img.id,
      page: img.page_number,
      index: img.image_index,
      format: img.format,
      dimensions: img.dimensions,
      vlm_status: img.vlm_status,
      confidence: img.vlm_confidence,
      image_type: (img.vlm_structured_data as { imageType?: string })?.imageType || null,
      primary_subject: (img.vlm_structured_data as { primarySubject?: string })?.primarySubject || null,
      description_length: img.vlm_description?.length || 0,
      has_embedding: !!img.vlm_embedding_id,
      error: img.error_message,
    }));

    const docComparisons = getComparisonSummariesByDocument(db.getConnection(), documentId);
    const docClusterMemberships = getClusterSummariesForDocument(db.getConnection(), documentId);

    return formatResponse(successResult({
      document: {
        id: doc.id,
        file_name: doc.file_name,
        file_path: doc.file_path,
        file_type: doc.file_type,
        file_size: doc.file_size,
        status: doc.status,
        page_count: doc.page_count,
        doc_title: doc.doc_title ?? null,
        doc_author: doc.doc_author ?? null,
        doc_subject: doc.doc_subject ?? null,
      },
      ocr: ocrResult ? {
        text_length: ocrResult.text_length,
        quality_score: ocrResult.parse_quality_score,
        processing_duration_ms: ocrResult.processing_duration_ms,
        mode: ocrResult.datalab_mode,
        cost_cents: ocrResult.cost_cents,
        datalab_request_id: ocrResult.datalab_request_id,
        content_hash: ocrResult.content_hash,
      } : null,
      chunks: {
        total: chunks.length,
      },
      images: {
        total: images.length,
        complete: completeImages.length,
        pending: images.filter(i => i.vlm_status === 'pending').length,
        failed: images.filter(i => i.vlm_status === 'failed').length,
        avg_confidence: confidences.length > 0
          ? confidences.reduce((a, b) => a + b, 0) / confidences.length
          : null,
        min_confidence: confidences.length > 0 ? Math.min(...confidences) : null,
        max_confidence: confidences.length > 0 ? Math.max(...confidences) : null,
        type_distribution: imageTypes,
        details: imageDetails,
      },
      extractions: {
        total: extractions.length,
        items: extractions.map(e => ({
          id: e.id,
          schema: e.schema_json ? JSON.parse(e.schema_json) : null,
          result: e.extraction_json ? JSON.parse(e.extraction_json) : null,
          created_at: e.created_at,
          provenance_id: e.provenance_id,
        })),
      },
      comparisons: {
        total: docComparisons.length,
        items: docComparisons.map(c => ({
          id: c.id,
          compared_with: c.document_id_1 === documentId ? c.document_id_2 : c.document_id_1,
          similarity_ratio: c.similarity_ratio,
          summary: c.summary,
          created_at: c.created_at,
          processing_duration_ms: c.processing_duration_ms,
        })),
      },
      clusters: {
        total: docClusterMemberships.length,
        items: docClusterMemberships.map(c => ({
          cluster_id: c.id,
          run_id: c.run_id,
          cluster_index: c.cluster_index,
          label: c.label,
          classification_tag: c.classification_tag,
          coherence_score: c.coherence_score,
        })),
      },
      knowledge_graph: (() => {
        const kgNodes = getKnowledgeNodeSummariesByDocument(db.getConnection(), documentId);
        if (kgNodes.length === 0) return { total_nodes: 0, cross_document_nodes: 0, total_edges: 0, nodes: [] };
        return {
          total_nodes: kgNodes.length,
          cross_document_nodes: kgNodes.filter(n => n.document_count > 1).length,
          total_edges: kgNodes.reduce((sum, n) => sum + n.edge_count, 0),
          nodes: kgNodes,
        };
      })(),
      entity_quality: getDocumentEntityQualityMetrics(db.getConnection(), documentId, doc.page_count),
    }));

  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_quality_summary - Get quick quality summary
 */
export async function handleQualitySummary(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    validateInput(QualitySummaryInput, params);

    const { db } = requireDatabase();

    const imageStats = getImageStats(db.getConnection());
    const dbStats = db.getStats();

    // M-10: SQL aggregation instead of loading all images per document
    const confStats = db.getConnection().prepare(`
      SELECT
        COUNT(*) as cnt,
        AVG(vlm_confidence) as avg_conf,
        MIN(vlm_confidence) as min_conf,
        MAX(vlm_confidence) as max_conf,
        SUM(CASE WHEN vlm_confidence >= 0.9 THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN vlm_confidence >= 0.7 AND vlm_confidence < 0.9 THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN vlm_confidence >= 0.5 AND vlm_confidence < 0.7 THEN 1 ELSE 0 END) as low,
        SUM(CASE WHEN vlm_confidence < 0.5 THEN 1 ELSE 0 END) as very_low
      FROM images
      WHERE vlm_status = 'complete' AND vlm_confidence IS NOT NULL
    `).get() as {
      cnt: number; avg_conf: number | null; min_conf: number | null; max_conf: number | null;
      high: number; medium: number; low: number; very_low: number;
    };

    // OCR quality distribution
    const ocrQualityStats = db.getConnection().prepare(`
      SELECT
        COUNT(parse_quality_score) as scored_count,
        AVG(parse_quality_score) as avg_quality,
        MIN(parse_quality_score) as min_quality,
        MAX(parse_quality_score) as max_quality,
        SUM(CASE WHEN parse_quality_score >= 4 THEN 1 ELSE 0 END) as excellent,
        SUM(CASE WHEN parse_quality_score >= 3 AND parse_quality_score < 4 THEN 1 ELSE 0 END) as good,
        SUM(CASE WHEN parse_quality_score >= 2 AND parse_quality_score < 3 THEN 1 ELSE 0 END) as fair,
        SUM(CASE WHEN parse_quality_score < 2 THEN 1 ELSE 0 END) as poor,
        COALESCE(SUM(cost_cents), 0) as total_ocr_cost
      FROM ocr_results
    `).get() as {
      scored_count: number; avg_quality: number | null; min_quality: number | null; max_quality: number | null;
      excellent: number; good: number; fair: number; poor: number; total_ocr_cost: number;
    };

    const formFillCost = (db.getConnection().prepare(
      'SELECT COALESCE(SUM(cost_cents), 0) as total FROM form_fills'
    ).get() as { total: number }).total;

    const comparisonStats = db.getConnection().prepare(`
      SELECT
        COUNT(*) as total,
        AVG(similarity_ratio) as avg_similarity,
        MIN(similarity_ratio) as min_similarity,
        MAX(similarity_ratio) as max_similarity
      FROM comparisons
    `).get() as {
      total: number; avg_similarity: number | null; min_similarity: number | null;
      max_similarity: number | null;
    };

    const qualityClusteringStats = getClusteringStats(db.getConnection());

    return formatResponse(successResult({
      documents: {
        total: dbStats.total_documents,
        complete: dbStats.documents_by_status.complete,
        failed: dbStats.documents_by_status.failed,
        pending: dbStats.documents_by_status.pending,
      },
      ocr: {
        total_chunks: dbStats.total_chunks,
        total_embeddings: dbStats.total_embeddings,
      },
      ocr_quality: {
        average: ocrQualityStats.scored_count > 0 ? ocrQualityStats.avg_quality : null,
        min: ocrQualityStats.scored_count > 0 ? ocrQualityStats.min_quality : null,
        max: ocrQualityStats.scored_count > 0 ? ocrQualityStats.max_quality : null,
        scored_count: ocrQualityStats.scored_count,
        distribution: {
          excellent_gte4: ocrQualityStats.excellent || 0,
          good_3to4: ocrQualityStats.good || 0,
          fair_2to3: ocrQualityStats.fair || 0,
          poor_lt2: ocrQualityStats.poor || 0,
        },
      },
      costs: {
        total_ocr_cost_cents: ocrQualityStats.total_ocr_cost,
        total_form_fill_cost_cents: formFillCost,
        total_cost_cents: ocrQualityStats.total_ocr_cost + formFillCost,
      },
      images: {
        total: imageStats.total,
        processed: imageStats.processed,
        pending: imageStats.pending,
        failed: imageStats.failed,
        processing_rate: imageStats.total > 0
          ? `${((imageStats.processed / imageStats.total) * 100).toFixed(1)}%`
          : '0%',
      },
      vlm_confidence: {
        average: confStats.cnt > 0 ? confStats.avg_conf : null,
        min: confStats.cnt > 0 ? confStats.min_conf : null,
        max: confStats.cnt > 0 ? confStats.max_conf : null,
        distribution: {
          high: confStats.high || 0,
          medium: confStats.medium || 0,
          low: confStats.low || 0,
          very_low: confStats.very_low || 0,
        },
      },
      extractions: {
        total: dbStats.total_extractions,
        extraction_rate: dbStats.total_documents > 0
          ? `${((dbStats.total_extractions / dbStats.total_documents) * 100).toFixed(1)}%`
          : '0%',
      },
      form_fills: {
        total: dbStats.total_form_fills,
      },
      comparisons: {
        total: comparisonStats.total,
        avg_similarity: comparisonStats.total > 0 ? comparisonStats.avg_similarity : null,
        min_similarity: comparisonStats.total > 0 ? comparisonStats.min_similarity : null,
        max_similarity: comparisonStats.total > 0 ? comparisonStats.max_similarity : null,
      },
      clustering: {
        total_clusters: qualityClusteringStats.total_clusters,
        total_runs: qualityClusteringStats.total_runs,
        avg_coherence: qualityClusteringStats.total_clusters > 0 ? qualityClusteringStats.avg_coherence : null,
      },
      knowledge_graph: (() => {
        const conn = db.getConnection();
        const totalEntities = (conn.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
        const linkedEntities = (conn.prepare('SELECT COUNT(*) as cnt FROM node_entity_links').get() as { cnt: number }).cnt;
        const kgMetrics = getKnowledgeGraphQualityMetrics(conn);
        return {
          entities_resolved: linkedEntities,
          total_entities: totalEntities,
          resolution_coverage: totalEntities > 0 ? linkedEntities / totalEntities : 0,
          total_nodes: kgMetrics.total_nodes,
          total_edges: kgMetrics.total_edges,
          avg_document_count: kgMetrics.avg_document_count,
          max_document_count: kgMetrics.max_document_count,
          avg_edge_count: kgMetrics.avg_edge_count,
          max_edge_count: kgMetrics.max_edge_count,
          orphaned_nodes: kgMetrics.orphaned_nodes,
          entity_extraction_coverage: kgMetrics.entity_extraction_coverage,
          resolution_method_distribution: kgMetrics.resolution_method_distribution,
          relationship_type_distribution: kgMetrics.relationship_type_distribution,
          entity_type_distribution: kgMetrics.entity_type_distribution,
        };
      })(),
      entity_quality: getAggregateEntityQualityMetrics(db.getConnection()),
    }));

  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COST ANALYTICS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_cost_summary - Get cost analytics for OCR and form fill operations
 */
async function handleCostSummary(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(z.object({
      group_by: z.enum(['document', 'mode', 'month', 'total']).default('total'),
    }), params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const totals = conn.prepare(`
      SELECT
        (SELECT COALESCE(SUM(cost_cents), 0) FROM ocr_results) as ocr_cost,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM form_fills) as form_fill_cost,
        (SELECT COUNT(*) FROM ocr_results WHERE cost_cents > 0) as ocr_count,
        (SELECT COUNT(*) FROM form_fills WHERE cost_cents > 0) as form_fill_count
    `).get() as { ocr_cost: number; form_fill_cost: number; ocr_count: number; form_fill_count: number };

    const result: Record<string, unknown> = {
      total_cost_cents: totals.ocr_cost + totals.form_fill_cost,
      total_cost_dollars: ((totals.ocr_cost + totals.form_fill_cost) / 100).toFixed(2),
      ocr: { total_cents: totals.ocr_cost, document_count: totals.ocr_count },
      form_fill: { total_cents: totals.form_fill_cost, fill_count: totals.form_fill_count },
    };

    if (input.group_by === 'mode') {
      result.by_mode = conn.prepare(`
        SELECT datalab_mode as mode, COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cents
        FROM ocr_results WHERE cost_cents > 0 GROUP BY datalab_mode
      `).all();
    } else if (input.group_by === 'document') {
      result.by_document = conn.prepare(`
        SELECT d.file_name, o.datalab_mode as mode, o.cost_cents, o.page_count
        FROM ocr_results o JOIN documents d ON d.id = o.document_id
        WHERE o.cost_cents > 0 ORDER BY o.cost_cents DESC LIMIT 50
      `).all();
    } else if (input.group_by === 'month') {
      result.by_month = conn.prepare(`
        SELECT strftime('%Y-%m', processing_completed_at) as month,
               COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cents
        FROM ocr_results WHERE cost_cents > 0
        GROUP BY strftime('%Y-%m', processing_completed_at) ORDER BY month DESC
      `).all();
    }

    // Comparison processing durations (compute-only, no API cost)
    const compDurations = conn.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(processing_duration_ms), 0) as total_ms,
             AVG(processing_duration_ms) as avg_ms
      FROM comparisons
    `).get() as { count: number; total_ms: number; avg_ms: number | null };

    result.comparison_compute = {
      total_comparisons: compDurations.count,
      total_duration_ms: compDurations.total_ms,
      avg_duration_ms: compDurations.avg_ms,
    };

    // Clustering processing durations (compute-only, no API cost)
    const clusterDurations = conn.prepare(`
      SELECT COUNT(*) as count,
             COUNT(DISTINCT run_id) as runs,
             COALESCE(SUM(processing_duration_ms), 0) as total_ms,
             AVG(processing_duration_ms) as avg_ms
      FROM clusters
    `).get() as { count: number; runs: number; total_ms: number; avg_ms: number | null };

    result.clustering_compute = {
      total_clusters: clusterDurations.count,
      total_runs: clusterDurations.runs,
      total_duration_ms: clusterDurations.total_ms,
      avg_duration_ms: clusterDurations.avg_ms,
    };

    // Knowledge graph build costs (Gemini calls for AI resolution + relationship classification)
    const kgProvenance = conn.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(processing_duration_ms), 0) as total_ms FROM provenance WHERE type = 'KNOWLEDGE_GRAPH'"
    ).get() as { cnt: number; total_ms: number };

    result.knowledge_graph_build = {
      total_builds: kgProvenance.cnt,
      total_duration_ms: kgProvenance.total_ms,
    };

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

interface ReportParams {
  dbStats: ReturnType<ReturnType<typeof requireDatabase>['db']['getStats']>;
  imageStats: ReturnType<typeof getImageStats>;
  docStats: DocumentImageStats[];
  lowConfidenceImages: LowConfidenceImage[];
  imageTypeDistribution: Record<string, number>;
  overallAvgConfidence: number;
  confidenceThreshold: number;
  comparisonStats: { total: number; avg_similarity: number | null };
  clusteringStats: { total_clusters: number; total_runs: number; avg_coherence: number | null };
  kgMetrics: KGQualityMetrics;
}

function generateMarkdownReport(params: ReportParams): string {
  const now = new Date().toISOString();
  const {
    dbStats,
    imageStats,
    docStats,
    lowConfidenceImages,
    imageTypeDistribution,
    overallAvgConfidence,
    confidenceThreshold,
  } = params;

  let report = `# Gemini VLM Evaluation Report

Generated: ${now}

## Executive Summary

| Metric | Value |
|--------|-------|
| Total Documents | ${dbStats.total_documents} |
| Total Pages | ${docStats.reduce((sum, d) => sum + (d.page_count || 0), 0)} |
| Total Images Extracted | ${imageStats.total} |
| VLM Processed | ${imageStats.processed} |
| VLM Pending | ${imageStats.pending} |
| VLM Failed | ${imageStats.failed} |
| **Overall Avg Confidence** | **${(overallAvgConfidence * 100).toFixed(1)}%** |
| Low Confidence (< ${(confidenceThreshold * 100).toFixed(0)}%) | ${lowConfidenceImages.length} |

---

## Image Type Distribution

| Type | Count | Percentage |
|------|-------|------------|
`;

  const totalImages = Object.values(imageTypeDistribution).reduce((a, b) => a + b, 0);
  const sortedTypes = Object.entries(imageTypeDistribution)
    .sort(([, a], [, b]) => b - a);

  for (const [type, count] of sortedTypes) {
    const pct = totalImages > 0 ? ((count / totalImages) * 100).toFixed(1) : '0.0';
    report += `| ${type} | ${count} | ${pct}% |\n`;
  }

  report += `
---

## Per-Document Summary

| Document | Pages | Images | Complete | Avg Conf | Min Conf |
|----------|-------|--------|----------|----------|----------|
`;

  // Sort by number of images descending
  const sortedDocs = [...docStats].sort((a, b) => b.image_count - a.image_count);

  for (const doc of sortedDocs.slice(0, 20)) { // Top 20 documents
    const fileName = doc.file_name.length > 40
      ? doc.file_name.slice(0, 37) + '...'
      : doc.file_name;
    report += `| ${fileName} | ${doc.page_count || 'N/A'} | ${doc.image_count} | ${doc.vlm_complete} | ${(doc.avg_confidence * 100).toFixed(1)}% | ${(doc.min_confidence * 100).toFixed(1)}% |\n`;
  }

  if (sortedDocs.length > 20) {
    report += `| ... and ${sortedDocs.length - 20} more | | | | | |\n`;
  }

  if (lowConfidenceImages.length > 0) {
    report += `
---

## Low Confidence Images (< ${(confidenceThreshold * 100).toFixed(0)}%)

These images may need manual review or reprocessing.

| Document | Page | Confidence | Type | Path |
|----------|------|------------|------|------|
`;

    for (const img of lowConfidenceImages.slice(0, 30)) {
      const fileName = img.file_name.length > 30
        ? img.file_name.slice(0, 27) + '...'
        : img.file_name;
      const shortPath = img.path.split('/').slice(-2).join('/');
      report += `| ${fileName} | ${img.page} | ${(img.confidence * 100).toFixed(1)}% | ${img.image_type} | ${shortPath} |\n`;
    }

    if (lowConfidenceImages.length > 30) {
      report += `| ... and ${lowConfidenceImages.length - 30} more | | | | |\n`;
    }
  }

  report += `
---

## Processing Statistics

- **OCR Results**: ${dbStats.total_documents} documents processed
- **Text Chunks**: ${dbStats.total_chunks} chunks created
- **Text Embeddings**: ${dbStats.total_embeddings} embeddings stored
- **Structured Extractions**: ${dbStats.total_extractions} extractions
- **Form Fills**: ${dbStats.total_form_fills} form fills
- **Comparisons**: ${params.comparisonStats.total} document comparisons
- **Clusters**: ${params.clusteringStats.total_clusters} clusters across ${params.clusteringStats.total_runs} runs${params.clusteringStats.avg_coherence !== null ? ` (avg coherence: ${(params.clusteringStats.avg_coherence * 100).toFixed(1)}%)` : ''}
- **Knowledge Graph**: ${params.kgMetrics.total_nodes} nodes, ${params.kgMetrics.total_edges} edges

### VLM Processing Rate

\`\`\`
${imageStats.total > 0 ? `Processed: ${'█'.repeat(Math.round((imageStats.processed / imageStats.total) * 40))}${'░'.repeat(40 - Math.round((imageStats.processed / imageStats.total) * 40))} ${((imageStats.processed / imageStats.total) * 100).toFixed(1)}%` : 'No images to process.'}
\`\`\`

---

## Knowledge Graph Health

| Metric | Value |
|--------|-------|
| Total Nodes | ${params.kgMetrics.total_nodes} |
| Total Edges | ${params.kgMetrics.total_edges} |
| Avg Document Count per Node | ${params.kgMetrics.avg_document_count !== null ? params.kgMetrics.avg_document_count.toFixed(2) : 'N/A'} |
| Max Document Count | ${params.kgMetrics.max_document_count ?? 'N/A'} |
| Avg Edge Count per Node | ${params.kgMetrics.avg_edge_count !== null ? params.kgMetrics.avg_edge_count.toFixed(2) : 'N/A'} |
| Max Edge Count | ${params.kgMetrics.max_edge_count ?? 'N/A'} |
| Orphaned Nodes (no edges) | ${params.kgMetrics.orphaned_nodes} |
| Entity Extraction Coverage | ${params.kgMetrics.entity_extraction_coverage.coverage_pct.toFixed(1)}% (${params.kgMetrics.entity_extraction_coverage.docs_with_entities}/${params.kgMetrics.entity_extraction_coverage.total_complete_docs} docs) |

### Resolution Method Distribution

| Method | Count |
|--------|-------|
${params.kgMetrics.resolution_method_distribution.length > 0
  ? params.kgMetrics.resolution_method_distribution.map(r => `| ${r.method} | ${r.count} |`).join('\n')
  : '| (none) | 0 |'}

### Entity Type Distribution

| Type | Count |
|------|-------|
${params.kgMetrics.entity_type_distribution.length > 0
  ? params.kgMetrics.entity_type_distribution.map(r => `| ${r.type} | ${r.count} |`).join('\n')
  : '| (none) | 0 |'}

### Relationship Type Distribution

| Type | Count |
|------|-------|
${params.kgMetrics.relationship_type_distribution.length > 0
  ? params.kgMetrics.relationship_type_distribution.map(r => `| ${r.type} | ${r.count} |`).join('\n')
  : '| (none) | 0 |'}

---

*Report generated by OCR Provenance MCP System*
`;

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Report tools collection for MCP server registration
 */
export const reportTools: Record<string, ToolDefinition> = {
  'ocr_evaluation_report': {
    description: 'Generate comprehensive evaluation report with OCR and VLM metrics, saves as markdown file',
    inputSchema: {
      output_path: z.string().optional().describe('Path to save markdown report (optional)'),
      confidence_threshold: z.number().min(0).max(1).default(0.7).describe('Threshold for low confidence flagging'),
    },
    handler: handleEvaluationReport,
  },

  'ocr_document_report': {
    description: 'Get detailed report for a single document including image analysis, entity quality metrics (density, type distribution, KG coverage), and knowledge graph details',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
    },
    handler: handleDocumentReport,
  },

  'ocr_quality_summary': {
    description: 'Get quick quality summary across all documents and images, including aggregate entity quality metrics and low-coverage document flagging',
    inputSchema: {},
    handler: handleQualitySummary,
  },

  'ocr_cost_summary': {
    description: 'Get cost analytics for OCR and form fill operations',
    inputSchema: {
      group_by: z.enum(['document', 'mode', 'month', 'total']).default('total')
        .describe('How to group cost data'),
    },
    handler: handleCostSummary,
  },
};

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
import {
  getClusteringStats,
  getClusterSummariesForDocument,
} from '../services/storage/database/cluster-operations.js';

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

const ReportOverviewInput = z.object({
  section: z.enum(['quality', 'corpus', 'all']).default('all'),
  include_section_frequency: z.boolean().default(true),
  include_content_type_distribution: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(20),
});

const ReportPerformanceInput = z.object({
  section: z.enum(['pipeline', 'throughput', 'bottlenecks', 'all']).default('all'),
  group_by: z.enum(['total', 'document', 'mode', 'file_type']).default('total'),
  limit: z.number().int().min(1).max(100).default(20),
  processor_filter: z.string().optional(),
  bucket: z.enum(['hourly', 'daily', 'weekly', 'monthly']).default('daily'),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
});

const ErrorAnalyticsInput = z.object({
  include_error_messages: z.boolean().default(true),
  limit: z.number().int().min(1).max(50).default(10),
});

// MERGE-C: Unified trends schema (ocr_quality_trends + ocr_timeline_analytics → ocr_trends)
const TrendsInput = z.object({
  metric: z.enum(['quality', 'volume']).describe('Trend type: quality (OCR scores over time) or volume (processing counts over time)'),
  bucket: z.enum(['hourly', 'daily', 'weekly', 'monthly']).default('daily'),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  // quality-specific
  group_by: z.enum(['none', 'ocr_mode', 'processor']).default('none')
    .describe('(quality only) Group by OCR mode or processor'),
  // volume-specific
  volume_metric: z.enum(['documents', 'pages', 'chunks', 'embeddings', 'images', 'cost']).default('documents')
    .describe('(volume only) Which metric to track over time'),
});


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
      const completeImages = getImagesByDocument(db.getConnection(), doc.id, {
        vlmStatus: 'complete',
      });
      const ocrResult = db.getOCRResultByDocumentId(doc.id);
      const docImageCounts = docImageCountStmt.get(doc.id) as {
        total: number;
        pending: number;
        failed: number;
      };

      const confidences = completeImages
        .filter((i) => i.vlm_confidence !== null)
        .map((i) => i.vlm_confidence as number);

      // Track image types
      const docImageTypes: Record<string, number> = {};
      for (const img of completeImages) {
        if (img.vlm_structured_data) {
          const imageType =
            (img.vlm_structured_data as { imageType?: string }).imageType || 'other';
          docImageTypes[imageType] = (docImageTypes[imageType] || 0) + 1;
          imageTypeDistribution[imageType] = (imageTypeDistribution[imageType] || 0) + 1;
        }
      }

      // Calculate stats
      const avgConfidence =
        confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

      totalConfidence += confidences.reduce((a, b) => a + b, 0);
      confidenceCount += confidences.length;

      docStats.push({
        document_id: doc.id,
        file_name: doc.file_name,
        page_count: doc.page_count,
        ocr_text_length: ocrResult?.text_length ?? 0,
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
    const lowConfidenceImages = db
      .getConnection()
      .prepare(
        `
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
    `
      )
      .all(confidenceThreshold) as LowConfidenceImage[];

    // Calculate overall average confidence
    const overallAvgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;

    // Comparison statistics
    const comparisonSummary = db
      .getConnection()
      .prepare(
        `
      SELECT COUNT(*) as count, AVG(similarity_ratio) as avg_similarity
      FROM comparisons
    `
      )
      .get() as { count: number; avg_similarity: number | null };
    const comparisonCount = comparisonSummary.count;
    const avgComparisonSimilarity = comparisonSummary.avg_similarity;

    // Clustering statistics
    const clusteringStats = getClusteringStats(db.getConnection());

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

    return formatResponse(
      successResult({
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
        },
        image_type_distribution: imageTypeDistribution,
        output_path: outputPath ?? null,
        report: outputPath ? null : report, // Only include report in response if not saved to file
        next_steps: [
          { tool: 'ocr_report_overview', description: 'Get quality and corpus overview' },
          { tool: 'ocr_evaluate', description: 'Evaluate more images' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_document_report - Generate report for a single document
 */
export async function handleDocumentReport(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentReportInput, params);
    const documentId = input.document_id;

    const { db } = requireDatabase();

    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
        document_id: documentId,
      });
    }

    const ocrResult = db.getOCRResultByDocumentId(documentId);
    const images = getImagesByDocument(db.getConnection(), documentId);
    const chunks = db.getChunksByDocumentId(documentId);
    const extractions = db.getExtractionsByDocument(documentId);

    // Calculate image stats
    const completeImages = images.filter((i) => i.vlm_status === 'complete');
    const confidences = completeImages
      .filter((i) => i.vlm_confidence !== null)
      .map((i) => i.vlm_confidence as number);

    const imageTypes: Record<string, number> = {};
    for (const img of completeImages) {
      if (img.vlm_structured_data) {
        const imageType = (img.vlm_structured_data as { imageType?: string }).imageType || 'other';
        imageTypes[imageType] = (imageTypes[imageType] || 0) + 1;
      }
    }

    // Build image details
    const imageDetails = images.map((img) => ({
      id: img.id,
      page: img.page_number,
      index: img.image_index,
      format: img.format,
      dimensions: img.dimensions,
      vlm_status: img.vlm_status,
      confidence: img.vlm_confidence,
      image_type: (img.vlm_structured_data as { imageType?: string })?.imageType || null,
      primary_subject:
        (img.vlm_structured_data as { primarySubject?: string })?.primarySubject || null,
      description_length: img.vlm_description?.length ?? 0,
      has_embedding: !!img.vlm_embedding_id,
      error: img.error_message,
    }));

    const docComparisons = getComparisonSummariesByDocument(db.getConnection(), documentId);
    const docClusterMemberships = getClusterSummariesForDocument(db.getConnection(), documentId);

    return formatResponse(
      successResult({
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
        ocr: ocrResult
          ? {
              text_length: ocrResult.text_length,
              quality_score: ocrResult.parse_quality_score,
              processing_duration_ms: ocrResult.processing_duration_ms,
              mode: ocrResult.datalab_mode,
              cost_cents: ocrResult.cost_cents,
              datalab_request_id: ocrResult.datalab_request_id,
              content_hash: ocrResult.content_hash,
            }
          : null,
        chunks: {
          total: chunks.length,
        },
        images: {
          total: images.length,
          complete: completeImages.length,
          pending: images.filter((i) => i.vlm_status === 'pending').length,
          failed: images.filter((i) => i.vlm_status === 'failed').length,
          avg_confidence:
            confidences.length > 0
              ? confidences.reduce((a, b) => a + b, 0) / confidences.length
              : null,
          min_confidence: confidences.length > 0 ? Math.min(...confidences) : null,
          max_confidence: confidences.length > 0 ? Math.max(...confidences) : null,
          type_distribution: imageTypes,
          details: imageDetails,
        },
        extractions: {
          total: extractions.length,
          items: extractions.map((e) => ({
            id: e.id,
            schema: e.schema_json ? JSON.parse(e.schema_json) : null,
            result: e.extraction_json ? JSON.parse(e.extraction_json) : null,
            created_at: e.created_at,
            provenance_id: e.provenance_id,
          })),
        },
        comparisons: {
          total: docComparisons.length,
          items: docComparisons.map((c) => ({
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
          items: docClusterMemberships.map((c) => ({
            cluster_id: c.id,
            run_id: c.run_id,
            cluster_index: c.cluster_index,
            label: c.label,
            classification_tag: c.classification_tag,
            coherence_score: c.coherence_score,
          })),
        },
        next_steps: [
          { tool: 'ocr_document_get', description: 'Get document metadata' },
          { tool: 'ocr_search', description: 'Search within this document' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_report_overview - Consolidated quality + corpus overview
 * Merges former ocr_quality_summary and ocr_corpus_profile.
 * section='quality' | 'corpus' | 'all' (default: 'all')
 */
export async function handleReportOverview(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ReportOverviewInput, params);
    const section = input.section ?? 'all';

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const result: Record<string, unknown> = { section };

    // ---- Quality section (former ocr_quality_summary) ----
    if (section === 'quality' || section === 'all') {
      const imageStats = getImageStats(conn);
      const dbStats = db.getStats();

      const confStats = conn
        .prepare(
          `
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
      `
        )
        .get() as {
        cnt: number;
        avg_conf: number | null;
        min_conf: number | null;
        max_conf: number | null;
        high: number;
        medium: number;
        low: number;
        very_low: number;
      };

      const ocrQualityStats = conn
        .prepare(
          `
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
      `
        )
        .get() as {
        scored_count: number;
        avg_quality: number | null;
        min_quality: number | null;
        max_quality: number | null;
        excellent: number;
        good: number;
        fair: number;
        poor: number;
        total_ocr_cost: number;
      };

      const formFillCost = (
        conn
          .prepare('SELECT COALESCE(SUM(cost_cents), 0) as total FROM form_fills')
          .get() as { total: number }
      ).total;

      const comparisonStats = conn
        .prepare(
          `
        SELECT
          COUNT(*) as total,
          AVG(similarity_ratio) as avg_similarity,
          MIN(similarity_ratio) as min_similarity,
          MAX(similarity_ratio) as max_similarity
        FROM comparisons
      `
        )
        .get() as {
        total: number;
        avg_similarity: number | null;
        min_similarity: number | null;
        max_similarity: number | null;
      };

      const qualityClusteringStats = getClusteringStats(conn);

      result.quality = {
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
          processing_rate:
            imageStats.total > 0
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
          extraction_rate:
            dbStats.total_documents > 0
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
          avg_coherence:
            qualityClusteringStats.total_clusters > 0 ? qualityClusteringStats.avg_coherence : null,
        },
      };
    }

    // ---- Corpus section (former ocr_corpus_profile) ----
    if (section === 'corpus' || section === 'all') {
      // Document size distribution
      const docSizeStats = conn
        .prepare(
          `
        SELECT
          COALESCE(AVG(page_count), 0) as avg_page_count,
          COALESCE(MIN(page_count), 0) as min_page_count,
          COALESCE(MAX(page_count), 0) as max_page_count,
          COALESCE(AVG(file_size), 0) as avg_file_size,
          COALESCE(SUM(file_size), 0) as total_file_size,
          COUNT(*) as total_documents
        FROM documents
        WHERE status = 'complete'
      `
        )
        .get() as {
        avg_page_count: number;
        min_page_count: number;
        max_page_count: number;
        avg_file_size: number;
        total_file_size: number;
        total_documents: number;
      };

      const fileTypeDistribution = conn
        .prepare(
          `
        SELECT file_type, COUNT(*) as count
        FROM documents
        GROUP BY file_type
        ORDER BY count DESC
      `
        )
        .all() as Array<{ file_type: string; count: number }>;

      const chunkStats = conn
        .prepare(
          `
        SELECT
          COALESCE(COUNT(*), 0) as total_chunks,
          COALESCE(AVG(LENGTH(text)), 0) as avg_text_length,
          COALESCE(MIN(LENGTH(text)), 0) as min_text_length,
          COALESCE(MAX(LENGTH(text)), 0) as max_text_length,
          COALESCE(SUM(CASE WHEN is_atomic = 1 THEN 1 ELSE 0 END), 0) as atomic_chunks,
          COALESCE(SUM(CASE WHEN heading_context IS NOT NULL AND heading_context != '' THEN 1 ELSE 0 END), 0) as chunks_with_headings
        FROM chunks
      `
        )
        .get() as {
        total_chunks: number;
        avg_text_length: number;
        min_text_length: number;
        max_text_length: number;
        atomic_chunks: number;
        chunks_with_headings: number;
      };

      const chunksPerDoc = conn
        .prepare(
          `
        SELECT
          COALESCE(AVG(cnt), 0) as avg_chunks,
          COALESCE(MIN(cnt), 0) as min_chunks,
          COALESCE(MAX(cnt), 0) as max_chunks
        FROM (SELECT COUNT(*) as cnt FROM chunks GROUP BY document_id)
      `
        )
        .get() as { avg_chunks: number; min_chunks: number; max_chunks: number };

      const avgContentTypes = conn
        .prepare(
          `
        SELECT COALESCE(AVG(
          CASE
            WHEN content_types IS NOT NULL AND content_types != '[]' AND content_types != ''
            THEN json_array_length(content_types)
            ELSE 0
          END
        ), 0) as avg_content_types
        FROM chunks
      `
        )
        .get() as { avg_content_types: number };

      const corpusData: Record<string, unknown> = {
        documents: {
          total_complete: docSizeStats.total_documents,
          avg_page_count: docSizeStats.avg_page_count,
          min_page_count: docSizeStats.min_page_count,
          max_page_count: docSizeStats.max_page_count,
          avg_file_size: docSizeStats.avg_file_size,
          total_file_size: docSizeStats.total_file_size,
        },
        file_types: fileTypeDistribution,
        chunks: {
          total_chunks: chunkStats.total_chunks,
          avg_text_length: chunkStats.avg_text_length,
          min_text_length: chunkStats.min_text_length,
          max_text_length: chunkStats.max_text_length,
          avg_content_types_per_chunk: avgContentTypes.avg_content_types,
          atomic_chunks: chunkStats.atomic_chunks,
          chunks_with_headings: chunkStats.chunks_with_headings,
          per_document: {
            avg: chunksPerDoc.avg_chunks,
            min: chunksPerDoc.min_chunks,
            max: chunksPerDoc.max_chunks,
          },
        },
      };

      if (input.include_content_type_distribution) {
        corpusData.content_type_distribution = conn
          .prepare(
            `
          SELECT
            j.value as content_type,
            COUNT(*) as count
          FROM chunks, json_each(COALESCE(content_types, '[]')) j
          GROUP BY j.value
          ORDER BY count DESC
          LIMIT ?
        `
          )
          .all(input.limit) as Array<{ content_type: string; count: number }>;
      }

      if (input.include_section_frequency) {
        corpusData.section_frequency = conn
          .prepare(
            `
          SELECT
            heading_context,
            COUNT(*) as occurrence_count,
            COUNT(DISTINCT document_id) as document_count
          FROM chunks
          WHERE heading_context IS NOT NULL AND heading_context != ''
          GROUP BY heading_context
          ORDER BY occurrence_count DESC
          LIMIT ?
        `
          )
          .all(input.limit) as Array<{
          heading_context: string;
          occurrence_count: number;
          document_count: number;
        }>;
      }

      corpusData.image_type_distribution = conn
        .prepare(
          `
        SELECT
          COALESCE(json_extract(vlm_structured_data, '$.imageType'), 'unknown') as image_type,
          COUNT(*) as count
        FROM images
        WHERE vlm_status = 'complete' AND vlm_structured_data IS NOT NULL
        GROUP BY image_type
        ORDER BY count DESC
      `
        )
        .all() as Array<{ image_type: string; count: number }>;

      result.corpus = corpusData;
    }

    result.next_steps = [
      { tool: 'ocr_report_performance', description: 'Get pipeline performance analytics' },
      { tool: 'ocr_error_analytics', description: 'Analyze errors and failures' },
      { tool: 'ocr_trends', description: 'View quality/volume trends over time' },
    ];

    return formatResponse(successResult(result));
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
    const input = validateInput(
      z.object({
        group_by: z.enum(['document', 'mode', 'month', 'total']).default('total'),
      }),
      params
    );
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const totals = conn
      .prepare(
        `
      SELECT
        (SELECT COALESCE(SUM(cost_cents), 0) FROM ocr_results) as ocr_cost,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM form_fills) as form_fill_cost,
        (SELECT COUNT(*) FROM ocr_results WHERE cost_cents > 0) as ocr_count,
        (SELECT COUNT(*) FROM form_fills WHERE cost_cents > 0) as form_fill_count
    `
      )
      .get() as {
      ocr_cost: number;
      form_fill_cost: number;
      ocr_count: number;
      form_fill_count: number;
    };

    const result: Record<string, unknown> = {
      total_cost_cents: totals.ocr_cost + totals.form_fill_cost,
      total_cost_dollars: ((totals.ocr_cost + totals.form_fill_cost) / 100).toFixed(2),
      ocr: { total_cents: totals.ocr_cost, document_count: totals.ocr_count },
      form_fill: { total_cents: totals.form_fill_cost, fill_count: totals.form_fill_count },
    };

    if (input.group_by === 'mode') {
      result.by_mode = conn
        .prepare(
          `
        SELECT datalab_mode as mode, COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cents
        FROM ocr_results WHERE cost_cents > 0 GROUP BY datalab_mode
      `
        )
        .all();
    } else if (input.group_by === 'document') {
      result.by_document = conn
        .prepare(
          `
        SELECT d.file_name, o.datalab_mode as mode, o.cost_cents, o.page_count
        FROM ocr_results o JOIN documents d ON d.id = o.document_id
        WHERE o.cost_cents > 0 ORDER BY o.cost_cents DESC LIMIT 50
      `
        )
        .all();
    } else if (input.group_by === 'month') {
      result.by_month = conn
        .prepare(
          `
        SELECT strftime('%Y-%m', processing_completed_at) as month,
               COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cents
        FROM ocr_results WHERE cost_cents > 0
        GROUP BY strftime('%Y-%m', processing_completed_at) ORDER BY month DESC
      `
        )
        .all();
    }

    // Comparison processing durations (compute-only, no API cost)
    const compDurations = conn
      .prepare(
        `
      SELECT COUNT(*) as count,
             COALESCE(SUM(processing_duration_ms), 0) as total_ms,
             AVG(processing_duration_ms) as avg_ms
      FROM comparisons
    `
      )
      .get() as { count: number; total_ms: number; avg_ms: number | null };

    result.comparison_compute = {
      total_comparisons: compDurations.count,
      total_duration_ms: compDurations.total_ms,
      avg_duration_ms: compDurations.avg_ms,
    };

    // Clustering processing durations (compute-only, no API cost)
    const clusterDurations = conn
      .prepare(
        `
      SELECT COUNT(*) as count,
             COUNT(DISTINCT run_id) as runs,
             COALESCE(SUM(processing_duration_ms), 0) as total_ms,
             AVG(processing_duration_ms) as avg_ms
      FROM clusters
    `
      )
      .get() as { count: number; runs: number; total_ms: number; avg_ms: number | null };

    result.clustering_compute = {
      total_clusters: clusterDurations.count,
      total_runs: clusterDurations.runs,
      total_duration_ms: clusterDurations.total_ms,
      avg_duration_ms: clusterDurations.avg_ms,
    };

    result.next_steps = [
      { tool: 'ocr_report_performance', description: 'Get pipeline performance analytics' },
      { tool: 'ocr_db_stats', description: 'Get database overview statistics' },
    ];

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED PERFORMANCE REPORT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_report_performance - Consolidated pipeline + throughput + bottlenecks
 * Merges former ocr_pipeline_analytics, ocr_throughput_analytics, and ocr_provenance_bottlenecks.
 * section='pipeline' | 'throughput' | 'bottlenecks' | 'all' (default: 'all')
 */
export async function handleReportPerformance(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ReportPerformanceInput, params);
    const section = input.section ?? 'all';

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const result: Record<string, unknown> = { section };

    // ---- Pipeline section (former ocr_pipeline_analytics) ----
    if (section === 'pipeline' || section === 'all') {
      const ocrStats = conn
        .prepare(
          `
        SELECT
          COALESCE(COUNT(*), 0) as total_docs,
          COALESCE(SUM(page_count), 0) as total_pages,
          COALESCE(AVG(processing_duration_ms), 0) as avg_duration_ms,
          COALESCE(MIN(processing_duration_ms), 0) as min_duration_ms,
          COALESCE(MAX(processing_duration_ms), 0) as max_duration_ms,
          COALESCE(SUM(processing_duration_ms), 0) as total_duration_ms,
          COALESCE(AVG(parse_quality_score), 0) as avg_quality
        FROM ocr_results
      `
        )
        .get() as {
        total_docs: number;
        total_pages: number;
        avg_duration_ms: number;
        min_duration_ms: number;
        max_duration_ms: number;
        total_duration_ms: number;
        avg_quality: number;
      };

      const avgMsPerPage =
        ocrStats.total_pages > 0 ? ocrStats.total_duration_ms / ocrStats.total_pages : 0;

      const embeddingStats = conn
        .prepare(
          `
        SELECT
          COALESCE(COUNT(*), 0) as total_embeddings,
          COALESCE(AVG(generation_duration_ms), 0) as avg_duration_ms,
          COALESCE(MIN(generation_duration_ms), 0) as min_duration_ms,
          COALESCE(MAX(generation_duration_ms), 0) as max_duration_ms,
          COALESCE(SUM(generation_duration_ms), 0) as total_duration_ms,
          COUNT(DISTINCT gpu_device) as device_count
        FROM embeddings
      `
        )
        .get() as {
        total_embeddings: number;
        avg_duration_ms: number;
        min_duration_ms: number;
        max_duration_ms: number;
        total_duration_ms: number;
        device_count: number;
      };

      const vlmStats = conn
        .prepare(
          `
        SELECT
          COALESCE(COUNT(*), 0) as total_images,
          COALESCE(SUM(CASE WHEN vlm_status = 'complete' THEN 1 ELSE 0 END), 0) as completed,
          COALESCE(SUM(CASE WHEN vlm_status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
          COALESCE(AVG(CASE WHEN vlm_status = 'complete' THEN vlm_tokens_used END), 0) as avg_tokens,
          COALESCE(SUM(CASE WHEN vlm_status = 'complete' THEN vlm_tokens_used ELSE 0 END), 0) as total_tokens,
          COALESCE(AVG(CASE WHEN vlm_status = 'complete' THEN vlm_confidence END), 0) as avg_confidence
        FROM images
      `
        )
        .get() as {
        total_images: number;
        completed: number;
        failed: number;
        avg_tokens: number;
        total_tokens: number;
        avg_confidence: number;
      };

      const compStats = conn
        .prepare(
          `
        SELECT
          COALESCE(COUNT(*), 0) as total,
          COALESCE(AVG(processing_duration_ms), 0) as avg_duration_ms,
          COALESCE(SUM(processing_duration_ms), 0) as total_duration_ms
        FROM comparisons
      `
        )
        .get() as { total: number; avg_duration_ms: number; total_duration_ms: number };

      const clusterStats = conn
        .prepare(
          `
        SELECT
          COALESCE(COUNT(*), 0) as total_clusters,
          COUNT(DISTINCT run_id) as total_runs,
          COALESCE(AVG(processing_duration_ms), 0) as avg_duration_ms,
          COALESCE(SUM(processing_duration_ms), 0) as total_duration_ms
        FROM clusters
      `
        )
        .get() as {
        total_clusters: number;
        total_runs: number;
        avg_duration_ms: number;
        total_duration_ms: number;
      };

      const pagesPerMinute =
        ocrStats.total_duration_ms > 0
          ? (ocrStats.total_pages / ocrStats.total_duration_ms) * 60000
          : 0;
      const embeddingsPerSecond =
        embeddingStats.total_duration_ms > 0
          ? (embeddingStats.total_embeddings / embeddingStats.total_duration_ms) * 1000
          : 0;

      const pipelineData: Record<string, unknown> = {
        ocr: {
          total_docs: ocrStats.total_docs,
          total_pages: ocrStats.total_pages,
          avg_duration_ms: ocrStats.avg_duration_ms,
          min_duration_ms: ocrStats.min_duration_ms,
          max_duration_ms: ocrStats.max_duration_ms,
          total_duration_ms: ocrStats.total_duration_ms,
          avg_ms_per_page: avgMsPerPage,
          avg_quality: ocrStats.avg_quality,
        },
        embeddings: {
          total_embeddings: embeddingStats.total_embeddings,
          avg_duration_ms: embeddingStats.avg_duration_ms,
          min_duration_ms: embeddingStats.min_duration_ms,
          max_duration_ms: embeddingStats.max_duration_ms,
          total_duration_ms: embeddingStats.total_duration_ms,
          device_count: embeddingStats.device_count,
        },
        vlm: {
          total_images: vlmStats.total_images,
          completed: vlmStats.completed,
          failed: vlmStats.failed,
          avg_tokens: vlmStats.avg_tokens,
          total_tokens: vlmStats.total_tokens,
          avg_confidence: vlmStats.avg_confidence,
        },
        comparisons: {
          total: compStats.total,
          avg_duration_ms: compStats.avg_duration_ms,
          total_duration_ms: compStats.total_duration_ms,
        },
        clustering: {
          total_clusters: clusterStats.total_clusters,
          total_runs: clusterStats.total_runs,
          avg_duration_ms: clusterStats.avg_duration_ms,
          total_duration_ms: clusterStats.total_duration_ms,
        },
        throughput: {
          pages_per_minute: pagesPerMinute,
          embeddings_per_second: embeddingsPerSecond,
        },
      };

      // Group-by breakdown
      if (input.group_by === 'mode') {
        pipelineData.by_mode = conn
          .prepare(
            `
          SELECT
            datalab_mode as mode,
            COUNT(*) as count,
            COALESCE(AVG(processing_duration_ms), 0) as avg_ms,
            COALESCE(AVG(parse_quality_score), 0) as avg_quality,
            COALESCE(AVG(cost_cents), 0) as avg_cost
          FROM ocr_results
          GROUP BY datalab_mode
        `
          )
          .all();
      } else if (input.group_by === 'file_type') {
        pipelineData.by_file_type = conn
          .prepare(
            `
          SELECT
            d.file_type,
            COUNT(*) as count,
            COALESCE(AVG(o.processing_duration_ms), 0) as avg_ms,
            COALESCE(AVG(o.parse_quality_score), 0) as avg_quality
          FROM ocr_results o
          JOIN documents d ON d.id = o.document_id
          GROUP BY d.file_type
          LIMIT ?
        `
          )
          .all(input.limit);
      } else if (input.group_by === 'document') {
        pipelineData.by_document = conn
          .prepare(
            `
          SELECT
            d.id as document_id,
            d.file_name,
            o.processing_duration_ms,
            o.page_count,
            o.parse_quality_score as quality,
            o.datalab_mode as mode,
            (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) as chunk_count,
            (SELECT COUNT(*) FROM images i WHERE i.document_id = d.id) as image_count
          FROM ocr_results o
          JOIN documents d ON d.id = o.document_id
          ORDER BY o.processing_duration_ms DESC
          LIMIT ?
        `
          )
          .all(input.limit);
      }

      result.pipeline = pipelineData;
    }

    // ---- Throughput section (former ocr_throughput_analytics from timeline.ts) ----
    if (section === 'throughput' || section === 'all') {
      const bucket = input.bucket ?? 'daily';

      const data = db.getThroughputAnalytics({
        bucket,
        created_after: input.created_after,
        created_before: input.created_before,
      });

      const totalPages = data.reduce((sum, d) => sum + d.pages_processed, 0);
      const totalEmbeddings = data.reduce((sum, d) => sum + d.embeddings_generated, 0);
      const totalImages = data.reduce((sum, d) => sum + d.images_processed, 0);
      const totalOcrMs = data.reduce((sum, d) => sum + d.total_ocr_duration_ms, 0);
      const totalEmbMs = data.reduce((sum, d) => sum + d.total_embedding_duration_ms, 0);

      result.throughput = {
        bucket,
        total_periods: data.length,
        filters: {
          created_after: input.created_after ?? null,
          created_before: input.created_before ?? null,
        },
        summary: {
          total_pages_processed: totalPages,
          total_embeddings_generated: totalEmbeddings,
          total_images_processed: totalImages,
          total_ocr_duration_ms: totalOcrMs,
          total_embedding_duration_ms: totalEmbMs,
          overall_avg_ms_per_page: totalPages > 0
            ? Math.round((totalOcrMs / totalPages) * 100) / 100
            : 0,
          overall_avg_ms_per_embedding: totalEmbeddings > 0
            ? Math.round((totalEmbMs / totalEmbeddings) * 100) / 100
            : 0,
        },
        data,
      };
    }

    // ---- Bottlenecks section (former ocr_provenance_bottlenecks) ----
    if (section === 'bottlenecks' || section === 'all') {
      const byProcessor = conn
        .prepare(
          `
          SELECT
            processor,
            type,
            COUNT(*) as count,
            COALESCE(AVG(processing_duration_ms), 0) as avg_duration_ms,
            COALESCE(MIN(processing_duration_ms), 0) as min_duration_ms,
            COALESCE(MAX(processing_duration_ms), 0) as max_duration_ms,
            COALESCE(SUM(processing_duration_ms), 0) as total_duration_ms
          FROM provenance
          WHERE processing_duration_ms IS NOT NULL AND processing_duration_ms > 0
          GROUP BY processor, type
          ORDER BY total_duration_ms DESC
        `
        )
        .all() as Array<{
        processor: string;
        type: string;
        count: number;
        avg_duration_ms: number;
        min_duration_ms: number;
        max_duration_ms: number;
        total_duration_ms: number;
      }>;

      const byChainDepth = conn
        .prepare(
          `
          SELECT
            chain_depth,
            type,
            COUNT(*) as count,
            COALESCE(AVG(processing_duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(processing_duration_ms), 0) as total_duration_ms
          FROM provenance
          WHERE processing_duration_ms IS NOT NULL AND processing_duration_ms > 0
          GROUP BY chain_depth, type
          ORDER BY chain_depth ASC, total_duration_ms DESC
        `
        )
        .all() as Array<{
        chain_depth: number;
        type: string;
        count: number;
        avg_duration_ms: number;
        total_duration_ms: number;
      }>;

      const slowestOps = conn
        .prepare(
          `
          SELECT
            p.id as provenance_id,
            p.type,
            p.processor,
            p.processing_duration_ms,
            p.chain_depth,
            p.source_path,
            d.file_name as document_name
          FROM provenance p
          LEFT JOIN documents d ON d.provenance_id = p.root_document_id
          WHERE p.processing_duration_ms IS NOT NULL AND p.processing_duration_ms > 0
          ORDER BY p.processing_duration_ms DESC
          LIMIT 10
        `
        )
        .all() as Array<{
        provenance_id: string;
        type: string;
        processor: string;
        processing_duration_ms: number;
        chain_depth: number;
        source_path: string | null;
        document_name: string | null;
      }>;

      const grandTotal = byProcessor.reduce((sum, p) => sum + p.total_duration_ms, 0);

      result.bottlenecks = {
        grand_total_duration_ms: grandTotal,
        by_processor: byProcessor.map((p) => ({
          processor: p.processor,
          type: p.type,
          count: p.count,
          avg_duration_ms: p.avg_duration_ms,
          min_duration_ms: p.min_duration_ms,
          max_duration_ms: p.max_duration_ms,
          total_duration_ms: p.total_duration_ms,
          pct_of_total: grandTotal > 0
            ? Math.round((p.total_duration_ms / grandTotal) * 10000) / 100
            : 0,
        })),
        by_chain_depth: byChainDepth.map((d) => ({
          chain_depth: d.chain_depth,
          type: d.type,
          count: d.count,
          avg_duration_ms: d.avg_duration_ms,
          total_duration_ms: d.total_duration_ms,
        })),
        slowest_operations: slowestOps.map((o) => ({
          provenance_id: o.provenance_id,
          type: o.type,
          processor: o.processor,
          processing_duration_ms: o.processing_duration_ms,
          chain_depth: o.chain_depth,
          document_name: o.document_name,
          source_path: o.source_path,
        })),
      };
    }

    result.next_steps = [
      { tool: 'ocr_report_overview', description: 'Get quality and corpus overview' },
      { tool: 'ocr_error_analytics', description: 'Analyze error patterns' },
    ];

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR & RECOVERY ANALYTICS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_error_analytics - Get error and recovery analytics
 */
export async function handleErrorAnalytics(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ErrorAnalyticsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // 1. Document failure rates
    const docFailures = conn
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) as complete,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing
      FROM documents
    `
      )
      .get() as {
      total: number;
      failed: number;
      complete: number;
      pending: number;
      processing: number;
    };

    const docFailureRate = docFailures.total > 0 ? (docFailures.failed / docFailures.total) * 100 : 0;

    // 2. Failure by file type
    const failureByFileType = conn
      .prepare(
        `
      SELECT
        file_type,
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        ROUND(
          CASE WHEN COUNT(*) > 0
            THEN CAST(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100
            ELSE 0
          END,
        1) as failure_rate_pct
      FROM documents
      GROUP BY file_type
      ORDER BY failed DESC
    `
      )
      .all() as Array<{
      file_type: string;
      total: number;
      failed: number;
      failure_rate_pct: number;
    }>;

    // 4. VLM failure stats
    const vlmFailures = conn
      .prepare(
        `
      SELECT
        COUNT(*) as total_images,
        COALESCE(SUM(CASE WHEN vlm_status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN vlm_status = 'complete' THEN 1 ELSE 0 END), 0) as complete,
        COALESCE(SUM(CASE WHEN vlm_status = 'pending' THEN 1 ELSE 0 END), 0) as pending
      FROM images
    `
      )
      .get() as {
      total_images: number;
      failed: number;
      complete: number;
      pending: number;
    };

    const vlmFailureRate =
      vlmFailures.total_images > 0
        ? (vlmFailures.failed / vlmFailures.total_images) * 100
        : 0;

    // 6. Embedding failure stats (from chunks embedding_status)
    const embeddingFailures = conn
      .prepare(
        `
      SELECT
        COUNT(*) as total_chunks,
        COALESCE(SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN embedding_status = 'complete' THEN 1 ELSE 0 END), 0) as complete,
        COALESCE(SUM(CASE WHEN embedding_status = 'pending' THEN 1 ELSE 0 END), 0) as pending
      FROM chunks
    `
      )
      .get() as {
      total_chunks: number;
      failed: number;
      complete: number;
      pending: number;
    };

    const result: Record<string, unknown> = {
      documents: {
        total: docFailures.total,
        failed: docFailures.failed,
        complete: docFailures.complete,
        pending: docFailures.pending,
        processing: docFailures.processing,
        failure_rate_pct: docFailureRate,
      },
      failure_by_file_type: failureByFileType,
      vlm: {
        total_images: vlmFailures.total_images,
        failed: vlmFailures.failed,
        complete: vlmFailures.complete,
        pending: vlmFailures.pending,
        failure_rate_pct: vlmFailureRate,
      },
      embeddings: {
        total_chunks: embeddingFailures.total_chunks,
        failed: embeddingFailures.failed,
        complete: embeddingFailures.complete,
        pending: embeddingFailures.pending,
      },
    };

    // 3. Common document errors (optional)
    if (input.include_error_messages) {
      result.common_document_errors = conn
        .prepare(
          `
        SELECT
          error_message,
          COUNT(*) as count
        FROM documents
        WHERE error_message IS NOT NULL
        GROUP BY error_message
        ORDER BY count DESC
        LIMIT ?
      `
        )
        .all(input.limit) as Array<{ error_message: string; count: number }>;

      // 5. VLM common errors
      result.common_vlm_errors = conn
        .prepare(
          `
        SELECT
          error_message,
          COUNT(*) as count
        FROM images
        WHERE vlm_status = 'failed' AND error_message IS NOT NULL
        GROUP BY error_message
        ORDER BY count DESC
        LIMIT ?
      `
        )
        .all(input.limit) as Array<{ error_message: string; count: number }>;
    }

    result.next_steps = [
      { tool: 'ocr_retry_failed', description: 'Retry failed documents' },
      { tool: 'ocr_image_reset_failed', description: 'Reset failed VLM images' },
      { tool: 'ocr_health_check', description: 'Run a full health check' },
    ];

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED TRENDS HANDLER (MERGE-C)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_trends - Unified time-series trends
 * metric='quality': OCR quality scores over time (delegates to getQualityTrends)
 * metric='volume': Processing volume counts over time (delegates to getTimelineStats)
 */
async function handleTrends(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(TrendsInput, params);
    const { db } = requireDatabase();

    const bucket = input.bucket ?? 'daily';

    if (input.metric === 'quality') {
      const groupBy = input.group_by ?? 'none';

      const data = db.getQualityTrends({
        bucket,
        group_by: groupBy,
        created_after: input.created_after,
        created_before: input.created_before,
      });

      return formatResponse(
        successResult({
          metric: 'quality',
          bucket,
          group_by: groupBy,
          total_periods: data.length,
          filters: {
            created_after: input.created_after ?? null,
            created_before: input.created_before ?? null,
          },
          data,
          next_steps: [
            { tool: 'ocr_report_overview', description: 'Get aggregate quality summary' },
            { tool: 'ocr_trends', description: 'View volume trends (metric=volume)' },
          ],
        })
      );
    }

    // metric === 'volume'
    const volumeMetric = input.volume_metric ?? 'documents';

    const data = db.getTimelineStats({
      bucket,
      metric: volumeMetric,
      created_after: input.created_after,
      created_before: input.created_before,
    });

    return formatResponse(
      successResult({
        metric: 'volume',
        bucket,
        volume_metric: volumeMetric,
        total_periods: data.length,
        total_count: data.reduce((sum, d) => sum + d.count, 0),
        filters: {
          created_after: input.created_after ?? null,
          created_before: input.created_before ?? null,
        },
        data,
        next_steps: [
          { tool: 'ocr_report_performance', description: 'Get detailed pipeline performance' },
          { tool: 'ocr_trends', description: 'View quality trends (metric=quality)' },
        ],
      })
    );
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
  const sortedTypes = Object.entries(imageTypeDistribution).sort(([, a], [, b]) => b - a);

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

  for (const doc of sortedDocs.slice(0, 20)) {
    // Top 20 documents
    const fileName = doc.file_name.length > 40 ? doc.file_name.slice(0, 37) + '...' : doc.file_name;
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
      const fileName =
        img.file_name.length > 30 ? img.file_name.slice(0, 27) + '...' : img.file_name;
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

### VLM Processing Rate

\`\`\`
${imageStats.total > 0 ? `Processed: ${'█'.repeat(Math.round((imageStats.processed / imageStats.total) * 40))}${'░'.repeat(40 - Math.round((imageStats.processed / imageStats.total) * 40))} ${((imageStats.processed / imageStats.total) * 100).toFixed(1)}%` : 'No images to process.'}
\`\`\`

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
  ocr_evaluation_report: {
    description:
      '[STATUS] Use to generate a comprehensive evaluation report with OCR and VLM metrics. Saves as markdown file. Returns report path and summary.',
    inputSchema: {
      output_path: z.string().optional().describe('Path to save markdown report (optional)'),
      confidence_threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe('Threshold for low confidence flagging'),
    },
    handler: handleEvaluationReport,
  },

  ocr_document_report: {
    description:
      '[STATUS] Use to get a detailed report for a single document (images, extractions, comparisons, clusters). Returns comprehensive document analysis.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
    },
    handler: handleDocumentReport,
  },

  ocr_report_overview: {
    description:
      '[STATUS] Quality and corpus overview. section="quality"|"corpus"|"all" (default). Aggregate scores, content type stats.',
    inputSchema: {
      section: z
        .enum(['quality', 'corpus', 'all'])
        .default('all')
        .describe('Which section to return: quality, corpus, or all'),
      include_section_frequency: z
        .boolean()
        .default(true)
        .describe('(corpus) Include most common section headings across documents'),
      include_content_type_distribution: z
        .boolean()
        .default(true)
        .describe('(corpus) Include content type distribution (tables, code, etc.)'),
      limit: z.number().int().min(1).max(100).default(20).describe('(corpus) Max items per list'),
    },
    handler: handleReportOverview,
  },

  ocr_cost_summary: {
    description: '[STATUS] Use to get cost analytics for OCR and form fill operations. Returns costs grouped by document, mode, month, or total.',
    inputSchema: {
      group_by: z
        .enum(['document', 'mode', 'month', 'total'])
        .default('total')
        .describe('How to group cost data'),
    },
    handler: handleCostSummary,
  },

  ocr_report_performance: {
    description:
      '[STATUS] Pipeline performance analytics. section="pipeline"|"throughput"|"bottlenecks"|"all" (default).',
    inputSchema: {
      section: z
        .enum(['pipeline', 'throughput', 'bottlenecks', 'all'])
        .default('all')
        .describe('Which section to return'),
      group_by: z
        .enum(['total', 'document', 'mode', 'file_type'])
        .default('total')
        .describe('(pipeline) How to group performance data'),
      limit: z.number().int().min(1).max(100).default(20).describe('(pipeline) Max items per group'),
      bucket: z
        .enum(['hourly', 'daily', 'weekly', 'monthly'])
        .default('daily')
        .describe('(throughput) Time bucket granularity'),
      created_after: z
        .string()
        .optional()
        .describe('(throughput) Filter data created after this ISO 8601 timestamp'),
      created_before: z
        .string()
        .optional()
        .describe('(throughput) Filter data created before this ISO 8601 timestamp'),
    },
    handler: handleReportPerformance,
  },

  ocr_error_analytics: {
    description:
      '[STATUS] Use to get error and recovery analytics (failure rates, common error messages). Returns error breakdown for documents, VLM, and embeddings.',
    inputSchema: {
      include_error_messages: z
        .boolean()
        .default(true)
        .describe('Include most common error messages'),
      limit: z.number().int().min(1).max(50).default(10),
    },
    handler: handleErrorAnalytics,
  },

  ocr_trends: {
    description:
      '[STATUS] Time-series trends. metric="quality" for OCR scores, "volume" for processing counts. Bucketed by time period.',
    inputSchema: TrendsInput.shape,
    handler: handleTrends,
  },
};

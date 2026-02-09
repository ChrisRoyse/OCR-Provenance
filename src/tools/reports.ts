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
import { resolve } from 'path';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import {
  getImageStats,
  getImagesByDocument,
} from '../services/storage/database/image-operations.js';
import { getComparisonSummariesByDocument } from '../services/storage/database/comparison-operations.js';


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
    });

    // Save to file if path provided
    if (outputPath) {
      const dir = resolve(outputPath).replace(/[^/\\]+$/, '');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outputPath, report);
      console.error(`[INFO] Report saved to: ${outputPath}`);
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
      comparisons: (() => {
        const comps = getComparisonSummariesByDocument(db.getConnection(), documentId);
        return {
          total: comps.length,
          items: comps.map(c => ({
            id: c.id,
            compared_with: c.document_id_1 === documentId ? c.document_id_2 : c.document_id_1,
            similarity_ratio: c.similarity_ratio,
            summary: c.summary,
            created_at: c.created_at,
            processing_duration_ms: c.processing_duration_ms,
          })),
        };
      })(),
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
  'ocr_evaluation_report': {
    description: 'Generate comprehensive evaluation report with OCR and VLM metrics, saves as markdown file',
    inputSchema: {
      output_path: z.string().optional().describe('Path to save markdown report (optional)'),
      confidence_threshold: z.number().min(0).max(1).default(0.7).describe('Threshold for low confidence flagging'),
    },
    handler: handleEvaluationReport,
  },

  'ocr_document_report': {
    description: 'Get detailed report for a single document including all image analysis results',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
    },
    handler: handleDocumentReport,
  },

  'ocr_quality_summary': {
    description: 'Get quick quality summary across all documents and images',
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

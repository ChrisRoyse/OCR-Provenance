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
import {
  getImageStats,
  getImagesByDocument,
} from '../services/storage/database/image-operations.js';

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
    const outputPath = params.output_path as string | undefined;
    const confidenceThreshold = (params.confidence_threshold as number) || 0.7;
    const includeDetails = params.include_details as boolean ?? true;

    const { db } = requireDatabase();

    // Get overall stats
    const imageStats = getImageStats(db.getConnection());
    const dbStats = db.getStats();

    // Get per-document stats
    const documents = db.listDocuments({ limit: 1000 });
    const docStats: DocumentImageStats[] = [];
    const lowConfidenceImages: LowConfidenceImage[] = [];
    const imageTypeDistribution: Record<string, number> = {};

    let totalConfidence = 0;
    let confidenceCount = 0;

    for (const doc of documents) {
      const images = getImagesByDocument(db.getConnection(), doc.id);
      const ocrResult = db.getOCRResultByDocumentId(doc.id);

      const completeImages = images.filter(i => i.vlm_status === 'complete');
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

      // Track low confidence images
      for (const img of completeImages) {
        if (img.vlm_confidence !== null && img.vlm_confidence < confidenceThreshold) {
          lowConfidenceImages.push({
            image_id: img.id,
            document_id: doc.id,
            file_name: doc.file_name,
            page: img.page_number,
            confidence: img.vlm_confidence,
            image_type: (img.vlm_structured_data as { imageType?: string })?.imageType || 'unknown',
            path: img.extracted_path || 'unknown',
          });
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
        image_count: images.length,
        vlm_complete: completeImages.length,
        vlm_pending: images.filter(i => i.vlm_status === 'pending').length,
        vlm_failed: images.filter(i => i.vlm_status === 'failed').length,
        avg_confidence: avgConfidence,
        min_confidence: confidences.length > 0 ? Math.min(...confidences) : 0,
        max_confidence: confidences.length > 0 ? Math.max(...confidences) : 0,
        image_types: docImageTypes,
      });
    }

    // Sort low confidence images by confidence
    lowConfidenceImages.sort((a, b) => a.confidence - b.confidence);

    // Calculate overall average confidence
    const overallAvgConfidence = confidenceCount > 0
      ? totalConfidence / confidenceCount
      : 0;

    // Generate markdown report
    const report = generateMarkdownReport({
      dbStats,
      imageStats,
      docStats,
      lowConfidenceImages: lowConfidenceImages.slice(0, 50), // Top 50 lowest
      imageTypeDistribution,
      overallAvgConfidence,
      confidenceThreshold,
      includeDetails,
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
    const documentId = params.document_id as string;

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
      },
      ocr: ocrResult ? {
        text_length: ocrResult.text_length,
        quality_score: ocrResult.parse_quality_score,
        processing_duration_ms: ocrResult.processing_duration_ms,
        mode: ocrResult.datalab_mode,
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
    }));

  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_quality_summary - Get quick quality summary
 */
export async function handleQualitySummary(
  _params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const { db } = requireDatabase();

    const imageStats = getImageStats(db.getConnection());
    const dbStats = db.getStats();
    const documents = db.listDocuments({ limit: 1000 });

    // Calculate confidence stats across all images
    let totalConfidence = 0;
    let minConfidence = 1;
    let maxConfidence = 0;
    let confidenceCount = 0;

    const confidenceBuckets = {
      high: 0,      // >= 0.9
      medium: 0,    // >= 0.7 < 0.9
      low: 0,       // >= 0.5 < 0.7
      very_low: 0,  // < 0.5
    };

    for (const doc of documents) {
      const images = getImagesByDocument(db.getConnection(), doc.id);
      for (const img of images) {
        if (img.vlm_status === 'complete' && img.vlm_confidence !== null) {
          const conf = img.vlm_confidence;
          totalConfidence += conf;
          confidenceCount++;
          minConfidence = Math.min(minConfidence, conf);
          maxConfidence = Math.max(maxConfidence, conf);

          if (conf >= 0.9) confidenceBuckets.high++;
          else if (conf >= 0.7) confidenceBuckets.medium++;
          else if (conf >= 0.5) confidenceBuckets.low++;
          else confidenceBuckets.very_low++;
        }
      }
    }

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
        average: confidenceCount > 0 ? totalConfidence / confidenceCount : null,
        min: confidenceCount > 0 ? minConfidence : null,
        max: confidenceCount > 0 ? maxConfidence : null,
        distribution: confidenceBuckets,
      },
    }));

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
  includeDetails: boolean;
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
    includeDetails: _includeDetails, // Reserved for detailed per-image sections
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

### VLM Processing Rate

\`\`\`
Processed: ${'█'.repeat(Math.round((imageStats.processed / imageStats.total) * 40))}${'░'.repeat(40 - Math.round((imageStats.processed / imageStats.total) * 40))} ${((imageStats.processed / imageStats.total) * 100).toFixed(1)}%
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
      include_details: z.boolean().default(true).describe('Include per-document details'),
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
};

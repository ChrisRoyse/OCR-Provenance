/**
 * Image Extraction and Management MCP Tools
 *
 * Tools for extracting images from PDFs and managing image records in the database.
 * Uses PyMuPDF for extraction and integrates with VLM pipeline.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/images
 */

import { z } from 'zod';
import * as fs from 'fs';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { validateInput, escapeLikePattern } from '../utils/validation.js';
import { ImageExtractor } from '../services/images/extractor.js';
import {
  getImage,
  getImagesByDocument,
  getPendingImages,
  getImageStats,
  deleteImageCascade,
  deleteImagesByDocumentCascade,
  resetFailedImages,
  resetProcessingImages,
  insertImageBatch,
  updateImageProvenance,
} from '../services/storage/database/image-operations.js';
import { getProvenanceTracker } from '../services/provenance/index.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash, computeFileHashSync } from '../utils/hash.js';
import type { CreateImageReference } from '../models/image.js';

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const ImageExtractInput = z.object({
  pdf_path: z.string().min(1),
  output_dir: z.string().min(1),
  document_id: z.string().min(1),
  ocr_result_id: z.string().min(1),
  min_size: z.number().int().min(1).default(50),
  max_images: z.number().int().min(1).max(1000).default(100),
});

const ImageListInput = z.object({
  document_id: z.string().min(1),
  include_descriptions: z.boolean().default(false),
  vlm_status: z.enum(['pending', 'processing', 'complete', 'failed']).optional(),
  entity_filter: z.string().optional(),
});

const ImageGetInput = z.object({
  image_id: z.string().min(1),
  include_page_entities: z.boolean().default(false),
});

const ImageStatsInput = z.object({});

const ImageDeleteInput = z.object({
  image_id: z.string().min(1),
  delete_file: z.boolean().default(false),
});

const ImageDeleteByDocumentInput = z.object({
  document_id: z.string().min(1),
  delete_files: z.boolean().default(false),
});

const ImageResetFailedInput = z.object({
  document_id: z.string().optional(),
});

const ImagePendingInput = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_image_extract - Extract images from a PDF document
 */
export async function handleImageExtract(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageExtractInput, params);
    const pdfPath = input.pdf_path;
    const outputDir = input.output_dir;
    const documentId = input.document_id;
    const ocrResultId = input.ocr_result_id;
    const minSize = input.min_size ?? 50;
    const maxImages = input.max_images ?? 100;

    // Validate PDF path exists
    if (!fs.existsSync(pdfPath)) {
      throw new MCPError(
        'PATH_NOT_FOUND',
        `PDF file not found: ${pdfPath}`,
        { pdf_path: pdfPath }
      );
    }

    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError(
        'DOCUMENT_NOT_FOUND',
        `Document not found: ${documentId}`,
        { document_id: documentId }
      );
    }

    // Create output directory if needed
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Extract images using PyMuPDF
    const extractor = new ImageExtractor();
    const extracted = await extractor.extractFromPDF(pdfPath, {
      outputDir,
      minSize,
      maxImages,
    });

    // Store image references in database
    const imageRefs: CreateImageReference[] = extracted.map(img => ({
      document_id: documentId,
      ocr_result_id: ocrResultId,
      page_number: img.page,
      bounding_box: img.bbox,
      image_index: img.index,
      format: img.format,
      dimensions: { width: img.width, height: img.height },
      extracted_path: img.path,
      file_size: img.size,
      context_text: null,
      provenance_id: null,
      block_type: null,
      is_header_footer: false,
      content_hash: img.path && fs.existsSync(img.path)
        ? computeFileHashSync(img.path)
        : null,
    }));

    const stored = insertImageBatch(db.getConnection(), imageRefs);

    // Create IMAGE provenance records
    const ocrResult = db.getOCRResultByDocumentId(documentId);
    if (ocrResult && doc.provenance_id) {
      const tracker = getProvenanceTracker(db);
      for (const img of stored) {
        try {
          const provenanceId = tracker.createProvenance({
            type: ProvenanceType.IMAGE,
            source_type: 'IMAGE_EXTRACTION',
            source_id: ocrResult.provenance_id,
            root_document_id: doc.provenance_id,
            content_hash: img.content_hash ?? (img.extracted_path && fs.existsSync(img.extracted_path) ? computeFileHashSync(img.extracted_path) : computeHash(img.id)),
            source_path: img.extracted_path ?? undefined,
            processor: 'pdf-image-extraction',
            processor_version: '1.0.0',
            processing_params: {
              page_number: img.page_number,
              image_index: img.image_index,
              format: img.format,
            },
            location: {
              page_number: img.page_number,
            },
          });
          updateImageProvenance(db.getConnection(), img.id, provenanceId);
          img.provenance_id = provenanceId;
        } catch (error) {
          console.error(`[WARN] Failed to create IMAGE provenance for ${img.id}: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      }
    }

    return formatResponse(successResult({
      document_id: documentId,
      pdf_path: pdfPath,
      output_dir: outputDir,
      extracted: extracted.length,
      stored: stored.length,
      images: stored.map(img => ({
        id: img.id,
        page: img.page_number,
        index: img.image_index,
        format: img.format,
        dimensions: img.dimensions,
        path: img.extracted_path,
      })),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_list - List all images in a document
 */
export async function handleImageList(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageListInput, params);
    const documentId = input.document_id;
    const includeDescriptions = input.include_descriptions ?? false;
    const vlmStatusFilter = input.vlm_status;
    const entityFilter = input.entity_filter;

    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError(
        'DOCUMENT_NOT_FOUND',
        `Document not found: ${documentId}`,
        { document_id: documentId }
      );
    }

    let images = getImagesByDocument(
      db.getConnection(),
      documentId,
      vlmStatusFilter ? { vlmStatus: vlmStatusFilter } : undefined
    );

    // Filter images by entity co-located on the same page
    if (entityFilter && images.length > 0) {
      try {
        const conn = db.getConnection();
        const escapedPattern = `%${escapeLikePattern(entityFilter)}%`;
        const matchingPages = conn.prepare(`
          SELECT DISTINCT i.page_number
          FROM images i
          JOIN entity_mentions em ON em.document_id = i.document_id AND em.page_number = i.page_number
          JOIN entities e ON em.entity_id = e.id
          WHERE i.document_id = ? AND LOWER(e.normalized_text) LIKE LOWER(?) ESCAPE '\\'
        `).all(documentId, escapedPattern) as Array<{ page_number: number }>;
        const pageSet = new Set(matchingPages.map(r => r.page_number));
        images = images.filter(img => pageSet.has(img.page_number));
      } catch {
        // Entity tables may not exist yet - skip filtering
      }
    }

    return formatResponse(successResult({
      document_id: documentId,
      count: images.length,
      entity_filter: entityFilter || undefined,
      images: images.map(img => ({
        id: img.id,
        page: img.page_number,
        index: img.image_index,
        format: img.format,
        dimensions: img.dimensions,
        vlm_status: img.vlm_status,
        has_vlm: img.vlm_status === 'complete',
        confidence: img.vlm_confidence,
        ...(includeDescriptions && img.vlm_description && {
          description: img.vlm_description,
        }),
      })),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_get - Get details of a specific image
 */
export async function handleImageGet(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageGetInput, params);
    const imageId = input.image_id;
    const includePageEntities = input.include_page_entities ?? false;

    const { db } = requireDatabase();

    const img = getImage(db.getConnection(), imageId);
    if (!img) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Image not found: ${imageId}`,
        { image_id: imageId }
      );
    }

    const responseData: Record<string, unknown> = {
      image: {
        id: img.id,
        document_id: img.document_id,
        ocr_result_id: img.ocr_result_id,
        page: img.page_number,
        index: img.image_index,
        format: img.format,
        dimensions: img.dimensions,
        bounding_box: img.bounding_box,
        path: img.extracted_path,
        file_size: img.file_size,
        vlm_status: img.vlm_status,
        vlm: img.vlm_status === 'complete' ? {
          description: img.vlm_description,
          structured_data: img.vlm_structured_data,
          model: img.vlm_model,
          confidence: img.vlm_confidence,
          tokens_used: img.vlm_tokens_used,
          processed_at: img.vlm_processed_at,
          embedding_id: img.vlm_embedding_id,
        } : null,
        error_message: img.error_message,
        created_at: img.created_at,
      },
    };

    // Include entities co-located on the same page as the image
    if (includePageEntities) {
      try {
        const conn = db.getConnection();
        const pageEntities = conn.prepare(`
          SELECT DISTINCT e.raw_text, e.entity_type, e.confidence
          FROM entity_mentions em
          JOIN entities e ON em.entity_id = e.id
          WHERE em.document_id = ? AND em.page_number = ?
          ORDER BY e.confidence DESC
          LIMIT 20
        `).all(img.document_id, img.page_number) as Array<{ raw_text: string; entity_type: string; confidence: number }>;
        responseData.page_entities = pageEntities;
      } catch {
        // Entity tables may not exist yet
        responseData.page_entities = [];
      }
    }

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_stats - Get image processing statistics
 */
export async function handleImageStats(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    validateInput(ImageStatsInput, params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const stats = getImageStats(conn);

    const responseData: Record<string, unknown> = {
      stats: {
        total: stats.total,
        processed: stats.processed,
        pending: stats.pending,
        processing: stats.processing,
        failed: stats.failed,
        processing_rate: stats.total > 0
          ? ((stats.processed / stats.total) * 100).toFixed(1) + '%'
          : '0%',
      },
    };

    // Add entity coverage metrics for image pages
    try {
      const totalImagePages = conn.prepare(
        'SELECT COUNT(DISTINCT document_id || \':\' || page_number) as cnt FROM images'
      ).get() as { cnt: number };

      const pagesWithEntities = conn.prepare(`
        SELECT COUNT(DISTINCT i.document_id || ':' || i.page_number) as cnt
        FROM images i
        JOIN entity_mentions em ON em.document_id = i.document_id AND em.page_number = i.page_number
      `).get() as { cnt: number };

      const avgEntities = conn.prepare(`
        SELECT COALESCE(AVG(entity_count), 0) as avg_count FROM (
          SELECT i.document_id, i.page_number, COUNT(DISTINCT em.entity_id) as entity_count
          FROM images i
          JOIN entity_mentions em ON em.document_id = i.document_id AND em.page_number = i.page_number
          GROUP BY i.document_id, i.page_number
        )
      `).get() as { avg_count: number };

      responseData.entity_coverage = {
        total_image_pages: totalImagePages.cnt,
        pages_with_entities: pagesWithEntities.cnt,
        coverage_rate: totalImagePages.cnt > 0
          ? ((pagesWithEntities.cnt / totalImagePages.cnt) * 100).toFixed(1) + '%'
          : '0%',
        avg_entities_per_image_page: Number(avgEntities.avg_count.toFixed(1)),
      };
    } catch {
      // Entity tables may not exist yet
    }

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_delete - Delete a specific image
 */
export async function handleImageDelete(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageDeleteInput, params);
    const imageId = input.image_id;
    const deleteFile = input.delete_file ?? false;

    const { db } = requireDatabase();

    const img = getImage(db.getConnection(), imageId);
    if (!img) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Image not found: ${imageId}`,
        { image_id: imageId }
      );
    }

    // Delete the file if requested
    if (deleteFile && img.extracted_path && fs.existsSync(img.extracted_path)) {
      fs.unlinkSync(img.extracted_path);
    }

    // Delete from database with full cascade (embeddings, vectors, provenance)
    deleteImageCascade(db.getConnection(), imageId);

    return formatResponse(successResult({
      image_id: imageId,
      deleted: true,
      file_deleted: !!(deleteFile && img.extracted_path),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_delete_by_document - Delete all images for a document
 */
export async function handleImageDeleteByDocument(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageDeleteByDocumentInput, params);
    const documentId = input.document_id;
    const deleteFiles = input.delete_files ?? false;

    const { db } = requireDatabase();

    // Get images first if we need to delete files
    let filesDeleted = 0;
    if (deleteFiles) {
      const images = getImagesByDocument(db.getConnection(), documentId);
      for (const img of images) {
        if (img.extracted_path && fs.existsSync(img.extracted_path)) {
          fs.unlinkSync(img.extracted_path);
          filesDeleted++;
        }
      }
    }

    // Delete from database with full cascade (embeddings, vectors, provenance)
    const count = deleteImagesByDocumentCascade(db.getConnection(), documentId);

    return formatResponse(successResult({
      document_id: documentId,
      images_deleted: count,
      files_deleted: filesDeleted,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_reset_failed - Reset failed and stuck processing images to pending status
 */
export async function handleImageResetFailed(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageResetFailedInput, params);
    const documentId = input.document_id;

    const { db } = requireDatabase();

    const failedCount = resetFailedImages(db.getConnection(), documentId);
    const processingCount = resetProcessingImages(db.getConnection(), documentId);

    return formatResponse(successResult({
      document_id: documentId || 'all',
      images_reset: failedCount + processingCount,
      failed_reset: failedCount,
      processing_reset: processingCount,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_pending - Get images pending VLM processing
 */
export async function handleImagePending(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ImagePendingInput, params);
    const limit = input.limit ?? 100;

    const { db } = requireDatabase();

    const images = getPendingImages(db.getConnection(), limit);

    return formatResponse(successResult({
      count: images.length,
      limit,
      images: images.map(img => ({
        id: img.id,
        document_id: img.document_id,
        page: img.page_number,
        index: img.image_index,
        format: img.format,
        path: img.extracted_path,
        created_at: img.created_at,
      })),
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Image tools collection for MCP server registration
 */
export const imageTools: Record<string, ToolDefinition> = {
  'ocr_image_extract': {
    description: 'Extract images from a PDF document and store references in database',
    inputSchema: {
      pdf_path: z.string().min(1).describe('Path to PDF file'),
      output_dir: z.string().min(1).describe('Directory to save extracted images'),
      document_id: z.string().min(1).describe('Document ID'),
      ocr_result_id: z.string().min(1).describe('OCR result ID'),
      min_size: z.number().int().min(1).default(50).describe('Minimum image dimension in pixels'),
      max_images: z.number().int().min(1).max(1000).default(100).describe('Maximum images to extract'),
    },
    handler: handleImageExtract,
  },

  'ocr_image_list': {
    description: 'List all images extracted from a document, with optional entity-based filtering',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_descriptions: z.boolean().default(false).describe('Include VLM descriptions'),
      vlm_status: z.enum(['pending', 'processing', 'complete', 'failed']).optional().describe('Filter by VLM status'),
      entity_filter: z.string().optional().describe('Filter images to pages containing entities matching this text (substring match)'),
    },
    handler: handleImageList,
  },

  'ocr_image_get': {
    description: 'Get detailed information about a specific image, optionally including co-located page entities',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID'),
      include_page_entities: z.boolean().default(false).describe('Include entities found on the same page as this image'),
    },
    handler: handleImageGet,
  },

  'ocr_image_stats': {
    description: 'Get image processing statistics including entity coverage metrics',
    inputSchema: {},
    handler: handleImageStats,
  },

  'ocr_image_delete': {
    description: 'Delete a specific image record and optionally the file',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID'),
      delete_file: z.boolean().default(false).describe('Also delete the extracted image file'),
    },
    handler: handleImageDelete,
  },

  'ocr_image_delete_by_document': {
    description: 'Delete all images for a document',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      delete_files: z.boolean().default(false).describe('Also delete the extracted image files'),
    },
    handler: handleImageDeleteByDocument,
  },

  'ocr_image_reset_failed': {
    description: 'Reset failed images to pending status for reprocessing',
    inputSchema: {
      document_id: z.string().optional().describe('Document ID (omit for all documents)'),
    },
    handler: handleImageResetFailed,
  },

  'ocr_image_pending': {
    description: 'Get images pending VLM processing',
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum images to return'),
    },
    handler: handleImagePending,
  },
};

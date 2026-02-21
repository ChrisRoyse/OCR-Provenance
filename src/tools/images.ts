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
import { validateInput } from '../utils/validation.js';
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
});

const ImageGetInput = z.object({
  image_id: z.string().min(1),
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

const ImageSearchInput = z.object({
  image_type: z.string().optional(),
  block_type: z.string().optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  document_id: z.string().optional(),
  exclude_headers_footers: z.boolean().default(false),
  page_number: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_image_extract - Extract images from a PDF document
 */
export async function handleImageExtract(params: Record<string, unknown>): Promise<ToolResponse> {
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
      throw new MCPError('PATH_NOT_FOUND', `PDF file not found: ${pdfPath}`, { pdf_path: pdfPath });
    }

    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
        document_id: documentId,
      });
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
    const imageRefs: CreateImageReference[] = extracted.map((img) => ({
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
      content_hash: img.path && fs.existsSync(img.path) ? computeFileHashSync(img.path) : null,
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
            content_hash:
              img.content_hash ??
              (img.extracted_path && fs.existsSync(img.extracted_path)
                ? computeFileHashSync(img.extracted_path)
                : computeHash(img.id)),
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
          console.error(
            `[WARN] Failed to create IMAGE provenance for ${img.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          throw error;
        }
      }
    }

    return formatResponse(
      successResult({
        document_id: documentId,
        pdf_path: pdfPath,
        output_dir: outputDir,
        extracted: extracted.length,
        stored: stored.length,
        images: stored.map((img) => ({
          id: img.id,
          page: img.page_number,
          index: img.image_index,
          format: img.format,
          dimensions: img.dimensions,
          path: img.extracted_path,
        })),
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_list - List all images in a document
 */
export async function handleImageList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageListInput, params);
    const documentId = input.document_id;
    const includeDescriptions = input.include_descriptions ?? false;
    const vlmStatusFilter = input.vlm_status;

    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
        document_id: documentId,
      });
    }

    const images = getImagesByDocument(
      db.getConnection(),
      documentId,
      vlmStatusFilter ? { vlmStatus: vlmStatusFilter } : undefined
    );

    return formatResponse(
      successResult({
        document_id: documentId,
        count: images.length,
        images: images.map((img) => ({
          id: img.id,
          page: img.page_number,
          index: img.image_index,
          format: img.format,
          dimensions: img.dimensions,
          vlm_status: img.vlm_status,
          has_vlm: img.vlm_status === 'complete',
          confidence: img.vlm_confidence,
          ...(includeDescriptions &&
            img.vlm_description && {
              description: img.vlm_description,
            }),
        })),
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_get - Get details of a specific image
 */
export async function handleImageGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageGetInput, params);
    const imageId = input.image_id;

    const { db } = requireDatabase();

    const img = getImage(db.getConnection(), imageId);
    if (!img) {
      throw new MCPError('VALIDATION_ERROR', `Image not found: ${imageId}`, { image_id: imageId });
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
        vlm:
          img.vlm_status === 'complete'
            ? {
                description: img.vlm_description,
                structured_data: img.vlm_structured_data,
                model: img.vlm_model,
                confidence: img.vlm_confidence,
                tokens_used: img.vlm_tokens_used,
                processed_at: img.vlm_processed_at,
                embedding_id: img.vlm_embedding_id,
              }
            : null,
        error_message: img.error_message,
        created_at: img.created_at,
      },
    };

    return formatResponse(successResult(responseData));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_stats - Get image processing statistics
 */
export async function handleImageStats(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    validateInput(ImageStatsInput, params);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    const stats = getImageStats(conn);

    return formatResponse(
      successResult({
        stats: {
          total: stats.total,
          processed: stats.processed,
          pending: stats.pending,
          processing: stats.processing,
          failed: stats.failed,
          processing_rate:
            stats.total > 0 ? ((stats.processed / stats.total) * 100).toFixed(1) + '%' : '0%',
        },
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_delete - Delete a specific image
 */
export async function handleImageDelete(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageDeleteInput, params);
    const imageId = input.image_id;
    const deleteFile = input.delete_file ?? false;

    const { db } = requireDatabase();

    const img = getImage(db.getConnection(), imageId);
    if (!img) {
      throw new MCPError('VALIDATION_ERROR', `Image not found: ${imageId}`, { image_id: imageId });
    }

    // Delete the file if requested
    if (deleteFile && img.extracted_path && fs.existsSync(img.extracted_path)) {
      fs.unlinkSync(img.extracted_path);
    }

    // Delete from database with full cascade (embeddings, vectors, provenance)
    deleteImageCascade(db.getConnection(), imageId);

    return formatResponse(
      successResult({
        image_id: imageId,
        deleted: true,
        file_deleted: !!(deleteFile && img.extracted_path),
      })
    );
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

    return formatResponse(
      successResult({
        document_id: documentId,
        images_deleted: count,
        files_deleted: filesDeleted,
      })
    );
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

    return formatResponse(
      successResult({
        document_id: documentId || 'all',
        images_reset: failedCount + processingCount,
        failed_reset: failedCount,
        processing_reset: processingCount,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_search - Search images by VLM classification type, block type, and other filters
 */
export async function handleImageSearch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImageSearchInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    let sql = `SELECT id, document_id, page_number, image_index, format, width, height,
      vlm_confidence, vlm_description, vlm_structured_data, block_type,
      is_header_footer, extracted_path, file_size
      FROM images WHERE vlm_status = 'complete'`;
    const sqlParams: unknown[] = [];

    if (input.image_type) {
      sql += ` AND json_extract(vlm_structured_data, '$.imageType') = ?`;
      sqlParams.push(input.image_type);
    }
    if (input.block_type) {
      sql += ` AND block_type = ?`;
      sqlParams.push(input.block_type);
    }
    if (input.min_confidence !== undefined) {
      sql += ` AND vlm_confidence >= ?`;
      sqlParams.push(input.min_confidence);
    }
    if (input.document_id) {
      sql += ` AND document_id = ?`;
      sqlParams.push(input.document_id);
    }
    if (input.exclude_headers_footers) {
      sql += ` AND is_header_footer = 0`;
    }
    if (input.page_number !== undefined) {
      sql += ` AND page_number = ?`;
      sqlParams.push(input.page_number);
    }

    sql += ` ORDER BY document_id, page_number, image_index LIMIT ?`;
    sqlParams.push(input.limit);

    const rows = conn.prepare(sql).all(...sqlParams) as Record<string, unknown>[];

    const results = rows.map(r => ({
      id: r.id,
      document_id: r.document_id,
      page_number: r.page_number,
      image_index: r.image_index,
      format: r.format,
      dimensions: { width: r.width, height: r.height },
      vlm_confidence: r.vlm_confidence,
      vlm_description: r.vlm_description,
      vlm_structured_data: r.vlm_structured_data ? JSON.parse(r.vlm_structured_data as string) : null,
      block_type: r.block_type,
      is_header_footer: r.is_header_footer === 1,
      extracted_path: r.extracted_path,
      file_size: r.file_size,
    }));

    // Aggregate type counts
    const typeCounts: Record<string, number> = {};
    for (const r of results) {
      const type = (r.vlm_structured_data?.imageType as string) || 'unknown';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    return formatResponse(
      successResult({
        images: results,
        total: results.length,
        type_distribution: typeCounts,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_pending - Get images pending VLM processing
 */
export async function handleImagePending(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ImagePendingInput, params);
    const limit = input.limit ?? 100;

    const { db } = requireDatabase();

    const images = getPendingImages(db.getConnection(), limit);

    return formatResponse(
      successResult({
        count: images.length,
        limit,
        images: images.map((img) => ({
          id: img.id,
          document_id: img.document_id,
          page: img.page_number,
          index: img.image_index,
          format: img.format,
          path: img.extracted_path,
          created_at: img.created_at,
        })),
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
 * Image tools collection for MCP server registration
 */
export const imageTools: Record<string, ToolDefinition> = {
  ocr_image_extract: {
    description: 'Extract images from a PDF document and store references in database',
    inputSchema: {
      pdf_path: z.string().min(1).describe('Path to PDF file'),
      output_dir: z.string().min(1).describe('Directory to save extracted images'),
      document_id: z.string().min(1).describe('Document ID'),
      ocr_result_id: z.string().min(1).describe('OCR result ID'),
      min_size: z.number().int().min(1).default(50).describe('Minimum image dimension in pixels'),
      max_images: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe('Maximum images to extract'),
    },
    handler: handleImageExtract,
  },

  ocr_image_list: {
    description: 'List all images extracted from a document',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_descriptions: z.boolean().default(false).describe('Include VLM descriptions'),
      vlm_status: z
        .enum(['pending', 'processing', 'complete', 'failed'])
        .optional()
        .describe('Filter by VLM status'),
    },
    handler: handleImageList,
  },

  ocr_image_get: {
    description: 'Get detailed information about a specific image',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID'),
    },
    handler: handleImageGet,
  },

  ocr_image_stats: {
    description: 'Get image processing statistics',
    inputSchema: {},
    handler: handleImageStats,
  },

  ocr_image_delete: {
    description: 'Delete a specific image record and optionally the file',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID'),
      delete_file: z.boolean().default(false).describe('Also delete the extracted image file'),
    },
    handler: handleImageDelete,
  },

  ocr_image_delete_by_document: {
    description: 'Delete all images for a document',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      delete_files: z.boolean().default(false).describe('Also delete the extracted image files'),
    },
    handler: handleImageDeleteByDocument,
  },

  ocr_image_reset_failed: {
    description: 'Reset failed images to pending status for reprocessing',
    inputSchema: {
      document_id: z.string().optional().describe('Document ID (omit for all documents)'),
    },
    handler: handleImageResetFailed,
  },

  ocr_image_pending: {
    description: 'Get images pending VLM processing',
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum images to return'),
    },
    handler: handleImagePending,
  },

  ocr_image_search: {
    description: 'Search images by VLM classification type, block type, confidence, and other filters',
    inputSchema: {
      image_type: z.string().optional()
        .describe('Filter by VLM image type (e.g., "chart", "diagram", "photograph", "table", "signature")'),
      block_type: z.string().optional()
        .describe('Filter by Datalab block type (e.g., "Figure", "Picture", "PageHeader")'),
      min_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum VLM confidence score'),
      document_id: z.string().optional()
        .describe('Filter to specific document'),
      exclude_headers_footers: z.boolean().default(false)
        .describe('Exclude header/footer images'),
      page_number: z.number().int().min(1).optional()
        .describe('Filter to specific page'),
      limit: z.number().int().min(1).max(100).default(50).describe('Maximum results'),
    },
    handler: handleImageSearch,
  },
};

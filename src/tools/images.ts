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
import { ImageExtractor } from '../services/images/extractor.js';
import {
  getImage,
  getImagesByDocument,
  getPendingImages,
  getImageStats,
  deleteImage,
  deleteImagesByDocument,
  resetFailedImages,
  insertImageBatch,
} from '../services/storage/database/image-operations.js';
import type { CreateImageReference } from '../models/image.js';

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
    const pdfPath = params.pdf_path as string;
    const outputDir = params.output_dir as string;
    const documentId = params.document_id as string;
    const ocrResultId = params.ocr_result_id as string;
    const minSize = (params.min_size as number) || 50;
    const maxImages = (params.max_images as number) || 100;

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
    }));

    const stored = insertImageBatch(db.getConnection(), imageRefs);

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
    const documentId = params.document_id as string;
    const includeDescriptions = params.include_descriptions as boolean || false;
    const vlmStatusFilter = params.vlm_status as string | undefined;

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

    let images = getImagesByDocument(db.getConnection(), documentId);

    // Filter by VLM status if specified
    if (vlmStatusFilter) {
      images = images.filter(img => img.vlm_status === vlmStatusFilter);
    }

    return formatResponse(successResult({
      document_id: documentId,
      count: images.length,
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
    const imageId = params.image_id as string;

    const { db } = requireDatabase();

    const img = getImage(db.getConnection(), imageId);
    if (!img) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Image not found: ${imageId}`,
        { image_id: imageId }
      );
    }

    return formatResponse(successResult({
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
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_image_stats - Get image processing statistics
 */
export async function handleImageStats(
  _params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const { db } = requireDatabase();

    const stats = getImageStats(db.getConnection());

    return formatResponse(successResult({
      stats: {
        total: stats.total,
        processed: stats.processed,
        pending: stats.pending,
        failed: stats.failed,
        processing_rate: stats.total > 0
          ? ((stats.processed / stats.total) * 100).toFixed(1) + '%'
          : '0%',
      },
    }));
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
    const imageId = params.image_id as string;
    const deleteFile = params.delete_file as boolean || false;

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

    // Delete from database
    deleteImage(db.getConnection(), imageId);

    return formatResponse(successResult({
      image_id: imageId,
      deleted: true,
      file_deleted: deleteFile && img.extracted_path ? true : false,
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
    const documentId = params.document_id as string;
    const deleteFiles = params.delete_files as boolean || false;

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

    // Delete from database
    const count = deleteImagesByDocument(db.getConnection(), documentId);

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
 * Handle ocr_image_reset_failed - Reset failed images to pending status
 */
export async function handleImageResetFailed(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const documentId = params.document_id as string | undefined;

    const { db } = requireDatabase();

    const count = resetFailedImages(db.getConnection(), documentId);

    return formatResponse(successResult({
      document_id: documentId || 'all',
      images_reset: count,
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
    const limit = (params.limit as number) || 100;

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
    description: 'List all images extracted from a document',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID'),
      include_descriptions: z.boolean().default(false).describe('Include VLM descriptions'),
      vlm_status: z.enum(['pending', 'processing', 'complete', 'failed']).optional().describe('Filter by VLM status'),
    },
    handler: handleImageList,
  },

  'ocr_image_get': {
    description: 'Get detailed information about a specific image',
    inputSchema: {
      image_id: z.string().min(1).describe('Image ID'),
    },
    handler: handleImageGet,
  },

  'ocr_image_stats': {
    description: 'Get image processing statistics for the current database',
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

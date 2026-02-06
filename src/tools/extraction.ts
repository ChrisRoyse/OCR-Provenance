/**
 * Image Extraction MCP Tools
 *
 * Tools for extracting images directly from PDFs using PyMuPDF.
 * Independent of Datalab - gives full control over image extraction.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/extraction
 */

import { z } from 'zod';
import * as fs from 'fs';
import { resolve } from 'path';
import { requireDatabase, state } from '../server/state.js';
import { successResult } from '../server/types.js';
import { MCPError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { ImageExtractor } from '../services/images/extractor.js';
import { insertImageBatch, getImagesByDocument } from '../services/storage/database/image-operations.js';
import type { CreateImageReference } from '../models/image.js';

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_extract_images - Extract images from a PDF using PyMuPDF
 *
 * This tool extracts images directly from PDF files without relying on
 * Datalab. It provides better quality images and precise bounding boxes.
 */
export async function handleExtractImages(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const documentId = params.document_id as string;
    const minSize = (params.min_size as number) || 100;
    const maxImages = (params.max_images as number) || 500;
    const outputDir = params.output_dir as string | undefined;

    const { db } = requireDatabase();

    // Get document
    const doc = db.getDocument(documentId);
    if (!doc) {
      throw new MCPError(
        'DOCUMENT_NOT_FOUND',
        `Document not found: ${documentId}`,
        { document_id: documentId }
      );
    }

    // Validate file exists and is a PDF
    if (!fs.existsSync(doc.file_path)) {
      throw new MCPError(
        'PATH_NOT_FOUND',
        `Document file not found: ${doc.file_path}`,
        { file_path: doc.file_path }
      );
    }

    const fileType = doc.file_type.toLowerCase();
    if (!ImageExtractor.isSupported(doc.file_path)) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Image extraction not supported for file type: ${fileType}. Supported: pdf, docx`,
        { file_type: fileType, document_id: documentId }
      );
    }

    // Get OCR result for foreign key
    const ocrResult = db.getOCRResultByDocumentId(documentId);
    if (!ocrResult) {
      throw new MCPError(
        'VALIDATION_ERROR',
        `Document has not been OCR processed. Run ocr_process_pending first.`,
        { document_id: documentId }
      );
    }

    // Determine output directory
    const imageOutputDir = outputDir || resolve(
      state.config.defaultStoragePath,
      'images',
      documentId
    );

    console.error(`[INFO] Extracting images from: ${doc.file_path}`);
    console.error(`[INFO] Output directory: ${imageOutputDir}`);

    // Extract images using appropriate extractor (PDF or DOCX)
    const extractor = new ImageExtractor();
    const extractedImages = await extractor.extractImages(doc.file_path, {
      outputDir: imageOutputDir,
      minSize,
      maxImages,
    });

    console.error(`[INFO] Extracted ${extractedImages.length} images`);

    // Convert to CreateImageReference format
    const imageRefs: CreateImageReference[] = extractedImages.map(img => ({
      document_id: documentId,
      ocr_result_id: ocrResult.id,
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
      content_hash: null,
    }));

    // Store in database
    const storedImages = insertImageBatch(db.getConnection(), imageRefs);

    console.error(`[INFO] Stored ${storedImages.length} image records in database`);

    return formatResponse(successResult({
      document_id: documentId,
      file_name: doc.file_name,
      output_dir: imageOutputDir,
      extracted: extractedImages.length,
      stored: storedImages.length,
      min_size_filter: minSize,
      max_images_limit: maxImages,
      images: storedImages.map(img => ({
        id: img.id,
        page: img.page_number,
        index: img.image_index,
        format: img.format,
        dimensions: img.dimensions,
        path: img.extracted_path,
        file_size: img.file_size,
        vlm_status: img.vlm_status,
      })),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_extract_images_batch - Extract images from all documents
 *
 * Extracts images from all documents that haven't had images extracted yet.
 */
export async function handleExtractImagesBatch(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const minSize = (params.min_size as number) || 100;
    const maxImagesPerDoc = (params.max_images_per_doc as number) || 200;
    const limit = (params.limit as number) || 50;
    const statusFilter = params.status as string | undefined;

    const { db } = requireDatabase();

    // Get documents that are complete (OCR done) and have supported file types
    const documents = db.listDocuments({
      status: statusFilter === 'all' ? undefined : (statusFilter as 'pending' | 'processing' | 'complete' | 'failed' | undefined) || 'complete',
      limit,
    }).filter(d => ImageExtractor.isSupported(d.file_path));

    if (documents.length === 0) {
      return formatResponse(successResult({
        processed: 0,
        total_images: 0,
        message: 'No documents with supported image extraction types found (supported: pdf, docx)',
      }));
    }

    const extractor = new ImageExtractor();
    const results: Array<{
      document_id: string;
      file_name: string;
      images_extracted: number;
      error?: string;
    }> = [];

    let totalImages = 0;

    for (const doc of documents) {
      try {
        // Check if document already has images extracted
        const existingImages = getImagesByDocument(db.getConnection(), doc.id);
        if (existingImages.length > 0) {
          results.push({
            document_id: doc.id,
            file_name: doc.file_name,
            images_extracted: 0,
            error: `Already has ${existingImages.length} images`,
          });
          continue;
        }

        // Get OCR result
        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        if (!ocrResult) {
          results.push({
            document_id: doc.id,
            file_name: doc.file_name,
            images_extracted: 0,
            error: 'No OCR result',
          });
          continue;
        }

        // Validate file exists
        if (!fs.existsSync(doc.file_path)) {
          results.push({
            document_id: doc.id,
            file_name: doc.file_name,
            images_extracted: 0,
            error: 'File not found',
          });
          continue;
        }

        const imageOutputDir = resolve(
          state.config.defaultStoragePath,
          'images',
          doc.id
        );

        console.error(`[INFO] Extracting from: ${doc.file_name}`);

        const extractedImages = await extractor.extractImages(doc.file_path, {
          outputDir: imageOutputDir,
          minSize,
          maxImages: maxImagesPerDoc,
        });

        // Store in database
        const imageRefs: CreateImageReference[] = extractedImages.map(img => ({
          document_id: doc.id,
          ocr_result_id: ocrResult.id,
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
          content_hash: null,
        }));

        if (imageRefs.length > 0) {
          insertImageBatch(db.getConnection(), imageRefs);
        }

        totalImages += extractedImages.length;
        results.push({
          document_id: doc.id,
          file_name: doc.file_name,
          images_extracted: extractedImages.length,
        });

        console.error(`[INFO] ${doc.file_name}: ${extractedImages.length} images`);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          document_id: doc.id,
          file_name: doc.file_name,
          images_extracted: 0,
          error: errorMsg,
        });
        console.error(`[ERROR] ${doc.file_name}: ${errorMsg}`);
      }
    }

    const successful = results.filter(r => !r.error && r.images_extracted > 0).length;
    const skipped = results.filter(r => r.error?.includes('Already has')).length;
    const failed = results.filter(r => r.error && !r.error.includes('Already has')).length;

    return formatResponse(successResult({
      processed: documents.length,
      successful,
      skipped,
      failed,
      total_images: totalImages,
      results,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_extraction_check - Check Python environment for image extraction
 */
export async function handleExtractionCheck(
  _params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const extractor = new ImageExtractor();
    const envCheck = await extractor.checkEnvironment();

    return formatResponse(successResult({
      available: envCheck.available,
      python_version: envCheck.pythonVersion,
      missing_dependencies: envCheck.missingDependencies,
      recommendations: envCheck.missingDependencies.length > 0
        ? envCheck.missingDependencies.map(dep => `pip install ${dep}`)
        : [],
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extraction tools collection for MCP server registration
 */
export const extractionTools: Record<string, ToolDefinition> = {
  'ocr_extract_images': {
    description: 'Extract images from a document (PDF or DOCX). Saves images to disk and creates database records for VLM processing.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID (must be OCR processed first)'),
      min_size: z.number().int().min(10).max(1000).default(100).describe('Minimum image dimension in pixels'),
      max_images: z.number().int().min(1).max(1000).default(500).describe('Maximum images to extract'),
      output_dir: z.string().optional().describe('Custom output directory (default: storage_path/images/{document_id}/)'),
    },
    handler: handleExtractImages,
  },

  'ocr_extract_images_batch': {
    description: 'Extract images from all documents (PDF, DOCX) that have been OCR processed',
    inputSchema: {
      min_size: z.number().int().min(10).max(1000).default(100).describe('Minimum image dimension in pixels'),
      max_images_per_doc: z.number().int().min(1).max(1000).default(200).describe('Maximum images per document'),
      limit: z.number().int().min(1).max(100).default(50).describe('Maximum documents to process'),
      status: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('complete').describe('Filter by document status'),
    },
    handler: handleExtractImagesBatch,
  },

  'ocr_extraction_check': {
    description: 'Check if Python environment is configured for image extraction (PyMuPDF, Pillow)',
    inputSchema: {},
    handler: handleExtractionCheck,
  },
};

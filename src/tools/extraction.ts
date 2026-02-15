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
import { validateInput } from '../utils/validation.js';
import { ImageExtractor } from '../services/images/extractor.js';
import { insertImageBatch, getImagesByDocument, updateImageProvenance } from '../services/storage/database/image-operations.js';
import { getProvenanceTracker } from '../services/provenance/index.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash, computeFileHashSync } from '../utils/hash.js';
import type { CreateImageReference } from '../models/image.js';


// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const ExtractImagesInput = z.object({
  document_id: z.string().min(1),
  min_size: z.number().int().min(10).max(1000).default(100),
  max_images: z.number().int().min(1).max(1000).default(500),
  output_dir: z.string().optional(),
});

const ExtractImagesBatchInput = z.object({
  min_size: z.number().int().min(10).max(1000).default(100),
  max_images_per_doc: z.number().int().min(1).max(1000).default(200),
  limit: z.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('complete'),
});

const ExtractionCheckInput = z.object({});

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
    const input = validateInput(ExtractImagesInput, params);
    const documentId = input.document_id;
    const minSize = input.min_size ?? 100;
    const maxImages = input.max_images ?? 500;
    const outputDir = input.output_dir;

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
      content_hash: img.path && fs.existsSync(img.path)
        ? computeFileHashSync(img.path)
        : null,
    }));

    // Store in database
    const storedImages = insertImageBatch(db.getConnection(), imageRefs);

    // Create IMAGE provenance records
    const tracker = getProvenanceTracker(db);
    for (const img of storedImages) {
      try {
        const provenanceId = tracker.createProvenance({
          type: ProvenanceType.IMAGE,
          source_type: 'IMAGE_EXTRACTION',
          source_id: ocrResult.provenance_id,
          root_document_id: doc.provenance_id,
          content_hash: img.content_hash ?? computeHash(img.id),
          source_path: img.extracted_path ?? undefined,
          processor: `${fileType}-file-extraction`,
          processor_version: '1.0.0',
          processing_params: {
            page_number: img.page_number,
            image_index: img.image_index,
            format: img.format,
            block_type: img.block_type,
            is_header_footer: img.is_header_footer,
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
    const input = validateInput(ExtractImagesBatchInput, params);
    const minSize = input.min_size ?? 100;
    const maxImagesPerDoc = input.max_images_per_doc ?? 200;
    const limit = input.limit ?? 50;
    const statusFilter = input.status;

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
          content_hash: img.path && fs.existsSync(img.path)
            ? computeFileHashSync(img.path)
            : null,
        }));

        if (imageRefs.length > 0) {
          const batchImages = insertImageBatch(db.getConnection(), imageRefs);

          // Create IMAGE provenance records
          const ocrProv = ocrResult.provenance_id;
          const docProv = doc.provenance_id;
          if (ocrProv && docProv) {
            const batchTracker = getProvenanceTracker(db);
            for (const img of batchImages) {
              try {
                const provenanceId = batchTracker.createProvenance({
                  type: ProvenanceType.IMAGE,
                  source_type: 'IMAGE_EXTRACTION',
                  source_id: ocrProv,
                  root_document_id: docProv,
                  content_hash: img.content_hash ?? computeHash(img.id),
                  source_path: img.extracted_path ?? undefined,
                  processor: `${doc.file_type}-file-extraction`,
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
              } catch (provError) {
                console.error(`[WARN] Failed to create IMAGE provenance for ${img.id}: ${provError instanceof Error ? provError.message : String(provError)}`);
                throw provError;
              }
            }
          } else {
            console.error(`[WARN] Skipping provenance creation for document ${doc.id}: missing ocrProv=${!!ocrProv} docProv=${!!docProv}`);
          }
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

    // Entity density context for extracted images
    let entityContext: Record<string, unknown> | undefined;
    try {
      const dbConn = db.getConnection();
      const docIdsWithImages = results
        .filter(r => r.images_extracted > 0)
        .map(r => r.document_id);

      if (docIdsWithImages.length > 0) {
        let pagesWithEntities = 0;
        let totalEntityCount = 0;
        let totalPages = 0;
        let highDensityPages = 0;

        for (const docId of docIdsWithImages) {
          const pageEntityRows = dbConn.prepare(
            `SELECT i.page_number, COUNT(DISTINCT em.entity_id) as entity_count
             FROM images i
             LEFT JOIN entity_mentions em ON em.document_id = i.document_id AND em.page_number = i.page_number
             WHERE i.document_id = ?
             GROUP BY i.page_number`
          ).all(docId) as Array<{ page_number: number; entity_count: number }>;

          for (const row of pageEntityRows) {
            totalPages++;
            if (row.entity_count > 0) {
              pagesWithEntities++;
              totalEntityCount += row.entity_count;
            }
            if (row.entity_count > 5) {
              highDensityPages++;
            }
          }
        }

        entityContext = {
          pages_with_entities: pagesWithEntities,
          avg_entities_per_page: totalPages > 0 ? Math.round((totalEntityCount / totalPages) * 100) / 100 : 0,
          high_density_pages: highDensityPages,
          total_image_pages: totalPages,
        };
      }
    } catch (err) {
      console.error(`[extraction] entity_context batch query failed: ${err instanceof Error ? err.message : String(err)}`);
      // Graceful degradation if entity tables don't exist
    }

    return formatResponse(successResult({
      processed: documents.length,
      successful,
      skipped,
      failed,
      total_images: totalImages,
      results,
      ...(entityContext ? { entity_context: entityContext } : {}),
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_extraction_check - Check Python environment for image extraction
 */
export async function handleExtractionCheck(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    validateInput(ExtractionCheckInput, params);

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
    description: 'Extract images from all documents (PDF, DOCX) that have been OCR processed. Includes entity_context with per-page entity density metrics',
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

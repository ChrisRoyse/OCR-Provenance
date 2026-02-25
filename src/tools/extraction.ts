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
import { validateInput, sanitizePath } from '../utils/validation.js';
import { ImageExtractor } from '../services/images/extractor.js';
import {
  insertImageBatch,
  getImagesByDocument,
  updateImageProvenance,
} from '../services/storage/database/image-operations.js';
import { handleVLMProcess } from './vlm.js';
import { getProvenanceTracker } from '../services/provenance/index.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash, computeFileHashSync } from '../utils/hash.js';
import type { CreateImageReference } from '../models/image.js';

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const ExtractImagesInput = z.object({
  document_id: z.string().optional(),
  min_size: z.number().int().min(10).max(1000).default(100),
  max_images: z.number().int().min(1).max(1000).default(500),
  output_dir: z.string().optional(),
  auto_vlm_process: z
    .boolean()
    .default(false)
    .describe('Automatically run VLM processing on extracted images'),
  include_provenance: z
    .boolean()
    .default(false)
    .describe('Include provenance chain for extracted images'),
  limit: z.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('complete'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_extract_images - Extract images from PDF/DOCX files
 *
 * If document_id is provided, extracts images from that single document.
 * If document_id is omitted, batch-extracts images from all OCR-processed documents.
 */
export async function handleExtractImages(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ExtractImagesInput, params);
    const documentId = input.document_id;
    const minSize = input.min_size ?? 100;
    const maxImages = input.max_images ?? 500;

    const { db } = requireDatabase();

    if (documentId) {
      // ── Single document mode ──
      const outputDir = input.output_dir ? sanitizePath(input.output_dir) : undefined;

      const doc = db.getDocument(documentId);
      if (!doc) {
        throw new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`, {
          document_id: documentId,
        });
      }

      if (!fs.existsSync(doc.file_path)) {
        throw new MCPError('PATH_NOT_FOUND', `Document file not found: ${doc.file_path}`, {
          file_path: doc.file_path,
        });
      }

      const fileType = doc.file_type.toLowerCase();
      if (!ImageExtractor.isSupported(doc.file_path)) {
        throw new MCPError(
          'VALIDATION_ERROR',
          `Image extraction not supported for file type: ${fileType}. Supported: pdf, docx`,
          { file_type: fileType, document_id: documentId }
        );
      }

      const ocrResult = db.getOCRResultByDocumentId(documentId);
      if (!ocrResult) {
        throw new MCPError(
          'VALIDATION_ERROR',
          `Document has not been OCR processed. Run ocr_process_pending first.`,
          { document_id: documentId }
        );
      }

      const imageOutputDir =
        outputDir || resolve(state.config.defaultStoragePath, 'images', documentId);

      console.error(`[INFO] Extracting images from: ${doc.file_path}`);
      console.error(`[INFO] Output directory: ${imageOutputDir}`);

      const extractor = new ImageExtractor();
      const extractedImages = await extractor.extractImages(doc.file_path, {
        outputDir: imageOutputDir,
        minSize,
        maxImages,
      });

      console.error(`[INFO] Extracted ${extractedImages.length} images`);

      const imageRefs: CreateImageReference[] = extractedImages.map((img) => ({
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
        content_hash: img.path && fs.existsSync(img.path) ? computeFileHashSync(img.path) : null,
      }));

      const storedImages = insertImageBatch(db.getConnection(), imageRefs);

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
          console.error(
            `[WARN] Failed to create IMAGE provenance for ${img.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          throw error;
        }
      }

      console.error(`[INFO] Stored ${storedImages.length} image records in database`);

      let vlmResult: Record<string, unknown> | undefined;
      if (input.auto_vlm_process && storedImages.length > 0) {
        try {
          const vlmResponse = await handleVLMProcess({ document_id: documentId });
          const vlmText = vlmResponse.content?.[0]?.text;
          if (vlmText) {
            vlmResult = JSON.parse(vlmText).data ?? JSON.parse(vlmText);
          }
        } catch (vlmErr) {
          console.error(
            `[extraction] Auto VLM processing failed: ${vlmErr instanceof Error ? vlmErr.message : String(vlmErr)}`
          );
          vlmResult = {
            error: `VLM processing failed: ${vlmErr instanceof Error ? vlmErr.message : String(vlmErr)}`,
          };
        }
      }

      let provenanceChains: Record<string, unknown> | undefined;
      if (input.include_provenance && storedImages.length > 0) {
        try {
          const chains: Record<string, unknown> = {};
          for (const img of storedImages) {
            if (img.provenance_id) {
              chains[img.id] = db.getProvenanceChain(img.provenance_id);
            }
          }
          if (Object.keys(chains).length > 0) {
            provenanceChains = chains;
          }
        } catch (provErr) {
          console.error(
            `[extraction] Provenance chain query failed: ${provErr instanceof Error ? provErr.message : String(provErr)}`
          );
        }
      }

      return formatResponse(
        successResult({
          mode: 'single',
          document_id: documentId,
          file_name: doc.file_name,
          output_dir: imageOutputDir,
          extracted: extractedImages.length,
          stored: storedImages.length,
          min_size_filter: minSize,
          max_images_limit: maxImages,
          images: storedImages.map((img) => ({
            id: img.id,
            page: img.page_number,
            index: img.image_index,
            format: img.format,
            dimensions: img.dimensions,
            path: img.extracted_path,
            file_size: img.file_size,
            vlm_status: img.vlm_status,
          })),
          ...(vlmResult ? { vlm_processing: vlmResult } : {}),
          ...(provenanceChains ? { provenance_chains: provenanceChains } : {}),
          next_steps: [
            {
              tool: 'ocr_vlm_process',
              description: 'Generate AI descriptions for the extracted images',
            },
          ],
        })
      );
    } else {
      // ── Batch mode (all documents) ──
      const limit = input.limit ?? 50;
      const statusFilter = input.status;

      const documents = db
        .listDocuments({
          status:
            statusFilter === 'all'
              ? undefined
              : (statusFilter as 'pending' | 'processing' | 'complete' | 'failed' | undefined) ||
                'complete',
          limit,
        })
        .filter((d) => ImageExtractor.isSupported(d.file_path));

      if (documents.length === 0) {
        return formatResponse(
          successResult({
            mode: 'batch',
            processed: 0,
            total_images: 0,
            message:
              'No documents with supported image extraction types found (supported: pdf, docx)',
            next_steps: [
              { tool: 'ocr_vlm_process', description: 'Run VLM analysis on extracted images' },
              { tool: 'ocr_image_stats', description: 'Check image extraction statistics' },
            ],
          })
        );
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

          if (!fs.existsSync(doc.file_path)) {
            results.push({
              document_id: doc.id,
              file_name: doc.file_name,
              images_extracted: 0,
              error: 'File not found',
            });
            continue;
          }

          const imageOutputDir = resolve(state.config.defaultStoragePath, 'images', doc.id);

          console.error(`[INFO] Extracting from: ${doc.file_name}`);

          const extractedImages = await extractor.extractImages(doc.file_path, {
            outputDir: imageOutputDir,
            minSize,
            maxImages,
          });

          const imageRefs: CreateImageReference[] = extractedImages.map((img) => ({
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
            content_hash:
              img.path && fs.existsSync(img.path) ? computeFileHashSync(img.path) : null,
          }));

          if (imageRefs.length > 0) {
            const batchImages = insertImageBatch(db.getConnection(), imageRefs);

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
                  console.error(
                    `[WARN] Failed to create IMAGE provenance for ${img.id}: ${provError instanceof Error ? provError.message : String(provError)}`
                  );
                  throw provError;
                }
              }
            } else {
              console.error(
                `[WARN] Skipping provenance creation for document ${doc.id}: missing ocrProv=${!!ocrProv} docProv=${!!docProv}`
              );
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

      const successful = results.filter((r) => !r.error && r.images_extracted > 0).length;
      const skipped = results.filter((r) => r.error?.includes('Already has')).length;
      const failed = results.filter((r) => r.error && !r.error.includes('Already has')).length;

      let batchVlmResults: Array<{ document_id: string; vlm_status: string }> | undefined;
      if (input.auto_vlm_process && totalImages > 0) {
        batchVlmResults = [];
        const docsWithImages = results.filter((r) => r.images_extracted > 0 && !r.error);
        for (const docResult of docsWithImages) {
          try {
            await handleVLMProcess({ document_id: docResult.document_id });
            batchVlmResults.push({ document_id: docResult.document_id, vlm_status: 'complete' });
          } catch (vlmErr) {
            console.error(
              `[extraction] Auto VLM batch failed for ${docResult.document_id}: ${vlmErr instanceof Error ? vlmErr.message : String(vlmErr)}`
            );
            batchVlmResults.push({ document_id: docResult.document_id, vlm_status: 'failed' });
          }
        }
      }

      return formatResponse(
        successResult({
          mode: 'batch',
          processed: documents.length,
          successful,
          skipped,
          failed,
          total_images: totalImages,
          results,
          ...(batchVlmResults ? { vlm_processing: batchVlmResults } : {}),
          next_steps: [
            { tool: 'ocr_vlm_process', description: 'Run VLM analysis on extracted images' },
            { tool: 'ocr_image_stats', description: 'Check image extraction statistics' },
          ],
        })
      );
    }
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
  ocr_extract_images: {
    description:
      '[PROCESSING] Use to extract images from PDF/DOCX files. Pass document_id for single file or omit for batch. Follow with ocr_vlm_process.',
    inputSchema: {
      document_id: z
        .string()
        .optional()
        .describe('Document ID (omit for batch extraction of all documents)'),
      min_size: z
        .number()
        .int()
        .min(10)
        .max(1000)
        .default(100)
        .describe('Minimum image dimension in pixels'),
      max_images: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(500)
        .describe('Maximum images to extract (per document in batch mode)'),
      output_dir: z
        .string()
        .optional()
        .describe('Custom output directory (single document mode only)'),
      auto_vlm_process: z
        .boolean()
        .default(false)
        .describe('Auto-trigger VLM processing after image extraction'),
      include_provenance: z
        .boolean()
        .default(false)
        .describe('Include provenance chain (single document mode only)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Maximum documents to process (batch mode only)'),
      status: z
        .enum(['pending', 'processing', 'complete', 'failed', 'all'])
        .default('complete')
        .describe('Filter by document status (batch mode only)'),
    },
    handler: handleExtractImages,
  },
};

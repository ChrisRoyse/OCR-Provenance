/**
 * Ingestion MCP Tools
 *
 * Extracted from src/index.ts Task 20.
 * Tools: ocr_ingest_directory, ocr_ingest_files, ocr_process_pending, ocr_status
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/ingestion
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, extname, basename } from 'path';

import { DatabaseService } from '../services/storage/database/index.js';
import { OCRProcessor } from '../services/ocr/processor.js';
import { DatalabClient } from '../services/ocr/datalab.js';
import { chunkText, chunkWithPageTracking, chunkTextPageAware, ChunkResult, DEFAULT_CHUNKING_CONFIG } from '../services/chunking/chunker.js';
import type { ChunkingConfig } from '../models/chunk.js';
import { EmbeddingService } from '../services/embedding/embedder.js';
import { ProvenanceTracker } from '../services/provenance/tracker.js';
import { computeHash, hashFile, computeFileHashSync } from '../utils/hash.js';
import {
  state,
  requireDatabase,
} from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  IngestDirectoryInput,
  IngestFilesInput,
  ProcessPendingInput,
  OCRStatusInput,
  RetryFailedInput,
  DEFAULT_FILE_TYPES,
} from '../utils/validation.js';
import {
  pathNotFoundError,
  pathNotDirectoryError,
  documentNotFoundError,
} from '../server/errors.js';
import { formatResponse, handleError, type ToolDefinition } from './shared.js';
import type { Document, OCRResult } from '../models/document.js';
import type { Chunk } from '../models/chunk.js';
import type { CreateImageReference, ImageReference } from '../models/image.js';
import { ProvenanceType } from '../models/provenance.js';
import { insertImageBatch, updateImageProvenance } from '../services/storage/database/image-operations.js';
import { getProvenanceTracker } from '../services/provenance/index.js';
import { createVLMPipeline } from '../services/vlm/pipeline.js';
import { ImageExtractor } from '../services/images/extractor.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingestion item result for tracking status
 */
interface IngestionItem {
  file_path: string;
  file_name: string;
  document_id: string;
  status: string;
  error_message?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Store chunks in database with provenance records
 *
 * Creates CHUNK provenance records (chain_depth=2) and inserts chunk records.
 * Returns array of stored Chunk objects for embedding.
 */
function storeChunks(
  db: DatabaseService,
  doc: Document,
  ocrResult: OCRResult,
  chunkResults: ChunkResult[],
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
): Chunk[] {
  const provenanceTracker = new ProvenanceTracker(db);
  const chunks: Chunk[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < chunkResults.length; i++) {
    const cr = chunkResults[i];
    const chunkId = uuidv4();
    const textHash = computeHash(cr.text);

    // Create chunk provenance (chain_depth=2)
    const chunkProvId = provenanceTracker.createProvenance({
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrResult.provenance_id,
      root_document_id: doc.provenance_id,
      content_hash: textHash,
      input_hash: ocrResult.content_hash,
      file_hash: doc.file_hash,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: {
        chunk_size: config.chunkSize,
        overlap_percent: config.overlapPercent,
        chunk_index: i,
        total_chunks: chunkResults.length,
      },
      location: {
        chunk_index: i,
        character_start: cr.startOffset,
        character_end: cr.endOffset,
        page_number: cr.pageNumber ?? undefined,
        page_range: cr.pageRange ?? undefined,
      },
    });

    db.insertChunk({
      id: chunkId,
      document_id: doc.id,
      ocr_result_id: ocrResult.id,
      text: cr.text,
      text_hash: textHash,
      chunk_index: i,
      character_start: cr.startOffset,
      character_end: cr.endOffset,
      page_number: cr.pageNumber,
      page_range: cr.pageRange,
      overlap_previous: cr.overlapWithPrevious,
      overlap_next: cr.overlapWithNext,
      provenance_id: chunkProvId,
    });

    // L-4 fix: Build Chunk object directly from insert data instead of
    // re-fetching from DB. insertChunk uses 'pending' status, null embedded_at,
    // and a generated created_at -- we mirror those defaults here.
    chunks.push({
      id: chunkId,
      document_id: doc.id,
      ocr_result_id: ocrResult.id,
      text: cr.text,
      text_hash: textHash,
      chunk_index: i,
      character_start: cr.startOffset,
      character_end: cr.endOffset,
      page_number: cr.pageNumber,
      page_range: cr.pageRange,
      overlap_previous: cr.overlapWithPrevious,
      overlap_next: cr.overlapWithNext,
      provenance_id: chunkProvId,
      created_at: now,
      embedding_status: 'pending',
      embedded_at: null,
    });
  }

  return chunks;
}

/**
 * Extract a context text window from OCR text based on estimated page position.
 *
 * Uses a best-effort heuristic: estimates page position as (targetPage - 1) / pageCount * textLength,
 * then takes a ±500 char window around that position, trimmed to word boundaries.
 *
 * @param ocrText - Full OCR extracted text
 * @param pageCount - Total number of pages in the document
 * @param targetPage - The page number to extract context for (1-indexed)
 * @returns Context text window (max ~1000 chars)
 */
function extractContextText(ocrText: string, pageCount: number, targetPage: number): string {
  if (!ocrText || ocrText.length === 0 || pageCount <= 0) {
    return '';
  }

  const textLength = ocrText.length;
  const safePageCount = Math.max(1, pageCount);
  const safePage = Math.max(1, Math.min(targetPage, safePageCount));

  // Estimate position in text for this page
  // Use (safePageCount - 1) as denominator so last page maps to end of text
  const estimatedPosition = Math.floor(((safePage - 1) / Math.max(1, safePageCount - 1)) * textLength);

  // Take ±500 char window
  const windowStart = Math.max(0, estimatedPosition - 500);
  const windowEnd = Math.min(textLength, estimatedPosition + 500);

  let context = ocrText.slice(windowStart, windowEnd);

  // Trim to word boundaries
  if (windowStart > 0) {
    const firstSpace = context.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 50) {
      context = context.slice(firstSpace + 1);
    }
  }
  if (windowEnd < textLength) {
    const lastSpace = context.lastIndexOf(' ');
    if (lastSpace > 0 && lastSpace > context.length - 50) {
      context = context.slice(0, lastSpace);
    }
  }

  return context.trim();
}

/**
 * Parse Datalab block type from image filename.
 * Datalab names images like: _page_0_Picture_21.jpeg, _page_0_Figure_3.jpeg
 * Returns block_type string or null if pattern doesn't match.
 */
export function parseBlockTypeFromFilename(filename: string): string | null {
  const match = filename.match(/_page_\d+_([A-Za-z]+)_\d+\./);
  return match ? match[1] : null;
}

/**
 * Page-level image classification from Datalab JSON block hierarchy.
 */
interface PageImageClassification {
  hasFigure: boolean;
  hasPicture: boolean;
  pictureInHeaderFooter: number;
  pictureInBody: number;
  figureCount: number;
}

/**
 * From Datalab JSON block hierarchy, classify each page's image regions.
 * Returns a map: pageNumber -> PageImageClassification
 *
 * The JSON structure has top-level children (pages), each page has children (blocks).
 * Image blocks have block_type 'Figure', 'Picture', 'FigureGroup', 'PictureGroup'.
 * Layout blocks have block_type 'PageHeader', 'PageFooter'.
 */
export function buildPageBlockClassification(
  jsonBlocks: Record<string, unknown>
): Map<number, PageImageClassification> {
  const pageMap = new Map<number, PageImageClassification>();

  const topChildren = (jsonBlocks as Record<string, unknown[]>).children
    ?? (jsonBlocks as Record<string, unknown[]>).blocks
    ?? [];

  if (!Array.isArray(topChildren)) {
    console.error('[WARN] JSON blocks has no children/blocks array');
    return pageMap;
  }

  let pageNum = 0;
  for (const pageBlock of topChildren) {
    const block = pageBlock as Record<string, unknown>;
    if (block.block_type === 'Page' || !block.block_type) {
      pageNum++;
    } else {
      continue;
    }

    const classification: PageImageClassification = {
      hasFigure: false,
      hasPicture: false,
      pictureInHeaderFooter: 0,
      pictureInBody: 0,
      figureCount: 0,
    };

    const walkChildren = (children: unknown[], inHeaderFooter: boolean) => {
      if (!Array.isArray(children)) return;
      for (const child of children) {
        const c = child as Record<string, unknown>;
        const btype = c.block_type as string | undefined;

        const isHF = inHeaderFooter || btype === 'PageHeader' || btype === 'PageFooter';

        if (btype === 'Figure' || btype === 'FigureGroup') {
          classification.hasFigure = true;
          classification.figureCount++;
        }
        if (btype === 'Picture' || btype === 'PictureGroup') {
          classification.hasPicture = true;
          if (isHF) {
            classification.pictureInHeaderFooter++;
          } else {
            classification.pictureInBody++;
          }
        }

        if (c.children) {
          walkChildren(c.children as unknown[], isHF);
        }
      }
    };

    walkChildren((block.children as unknown[]) ?? [], false);
    pageMap.set(pageNum, classification);
  }

  return pageMap;
}

/**
 * Save images from Datalab to disk and store references in database.
 *
 * Images come from Datalab as {filename: base64_data}.
 * This function:
 * 1. Creates output directory
 * 2. Saves each image to disk
 * 3. Creates image records in database for VLM processing
 *
 * @param db - Database connection
 * @param doc - Document record
 * @param ocrResult - OCR result for provenance chain
 * @param images - Images from Datalab: {filename: base64}
 * @param outputDir - Directory to save images
 * @returns Array of stored ImageReference records
 */
function saveAndStoreImages(
  db: DatabaseService,
  doc: Document,
  ocrResult: OCRResult,
  images: Record<string, string>,
  outputDir: string,
  jsonBlocks?: Record<string, unknown> | null,
): ImageReference[] {
  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Build page-level image classification from JSON blocks
  const pageClassification = jsonBlocks
    ? buildPageBlockClassification(jsonBlocks)
    : new Map<number, PageImageClassification>();

  const imageRefs: CreateImageReference[] = [];
  const pageImageCounts = new Map<number, number>();

  for (const filename of Object.keys(images)) {
    // Decode base64 to buffer
    const buffer = Buffer.from(images[filename], 'base64');

    // H-1 fix: Release base64 string from dict immediately after decoding.
    // The OCR worker returns ALL images as {filename: base64_data} via stdout JSON.
    // Without this delete, the entire dict stays alive throughout processing.
    delete images[filename];

    const filePath = resolve(outputDir, filename);

    // Save to disk - FAIL FAST if write fails
    writeFileSync(filePath, buffer);

    // Parse page number from filename (e.g., "page_1_image_0.png" or "p001_i000.png")
    const pageMatch = filename.match(/page_(\d+)|p(\d+)/i);
    const pageNumber = pageMatch
      ? parseInt(pageMatch[1] || pageMatch[2], 10) + 1
      : 1;

    // Per-page image index (L-2: use per-page counter, not global)
    const currentPageCount = pageImageCounts.get(pageNumber) ?? 0;
    pageImageCounts.set(pageNumber, currentPageCount + 1);
    const imageIndex = currentPageCount;

    // Compute content hash for deduplication
    const contentHash = computeHash(buffer);

    // Parse block type from Datalab filename
    const blockType = parseBlockTypeFromFilename(filename);

    // Determine if image is in header/footer region
    const pageInfo = pageClassification.get(pageNumber);
    const isHeaderFooter = blockType === 'PageHeader' || blockType === 'PageFooter'
      || (pageInfo !== undefined
          && !pageInfo.hasFigure
          && pageInfo.pictureInHeaderFooter > 0
          && pageInfo.pictureInBody === 0);

    // Get image format from extension
    const ext = extname(filename).slice(1).toLowerCase();
    const format = ext || 'png';

    // Extract context text from OCR for this page
    const contextText = extractContextText(
      ocrResult.extracted_text,
      ocrResult.page_count ?? 1,
      pageNumber
    );

    // Create image reference for database
    // Note: dimensions will be estimated - VLM pipeline can update if needed
    imageRefs.push({
      document_id: doc.id,
      ocr_result_id: ocrResult.id,
      page_number: pageNumber,
      bounding_box: { x: 0, y: 0, width: 0, height: 0 }, // Datalab doesn't provide bbox
      image_index: imageIndex,
      format,
      dimensions: { width: 0, height: 0 }, // Datalab does not provide dimensions; filtering pipeline bypasses dimension check when both are 0
      extracted_path: filePath,
      file_size: buffer.length,
      context_text: contextText || null,
      provenance_id: null, // Will be set after insert with provenance record
      block_type: blockType,
      is_header_footer: isHeaderFooter,
      content_hash: contentHash,
    });
  }

  // Batch insert all images
  if (imageRefs.length > 0) {
    const insertedImages = insertImageBatch(db.getConnection(), imageRefs);

    // Create IMAGE provenance records and update image records
    const tracker = getProvenanceTracker(db);
    for (const img of insertedImages) {
      try {
        const provenanceId = tracker.createProvenance({
          type: ProvenanceType.IMAGE,
          source_type: 'IMAGE_EXTRACTION',
          source_id: ocrResult.provenance_id,
          root_document_id: doc.provenance_id,
          content_hash: img.content_hash ?? (img.extracted_path && existsSync(img.extracted_path) ? computeFileHashSync(img.extracted_path) : computeHash(img.id)),
          source_path: img.extracted_path ?? undefined,
          processor: 'datalab-image-extraction',
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

        // Update the image record with the provenance ID
        updateImageProvenance(db.getConnection(), img.id, provenanceId);
        img.provenance_id = provenanceId;
      } catch (error) {
        console.error(`[WARN] Failed to create IMAGE provenance for ${img.id}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }

    return insertedImages;
  }

  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_ingest_directory - Ingest all documents from a directory
 */
export async function handleIngestDirectory(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(IngestDirectoryInput, params);
    const { db } = requireDatabase();

    // Validate directory exists - FAIL FAST
    if (!existsSync(input.directory_path)) {
      throw pathNotFoundError(input.directory_path);
    }

    const dirStats = statSync(input.directory_path);
    if (!dirStats.isDirectory()) {
      throw pathNotDirectoryError(input.directory_path);
    }

    const fileTypes = input.file_types ?? [...DEFAULT_FILE_TYPES];
    const items: IngestionItem[] = [];

    // Collect files recursively
    const collectFiles = (dirPath: string): string[] => {
      const files: string[] = [];
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = resolve(dirPath, entry.name);
        if (entry.isDirectory() && input.recursive) {
          files.push(...collectFiles(fullPath));
        } else if (entry.isFile()) {
          const ext = extname(entry.name).slice(1).toLowerCase();
          if (fileTypes.includes(ext)) {
            files.push(fullPath);
          }
        }
      }

      return files;
    };

    const files = collectFiles(input.directory_path);

    // Ingest each file
    for (const filePath of files) {
      try {
        // Check if already ingested by path
        const existingByPath = db.getDocumentByPath(filePath);

        if (existingByPath) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: existingByPath.id,
            status: 'skipped',
            error_message: 'Already ingested',
          });
          continue;
        }

        const stats = statSync(filePath);
        const fileHash = await hashFile(filePath);

        // Check for duplicate by file hash (same content, different path)
        const existingByHash = db.getDocumentByHash(fileHash);
        if (existingByHash) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: existingByHash.id,
            status: 'skipped',
            error_message: `Duplicate file (same hash as ${existingByHash.file_path})`,
          });
          continue;
        }

        // Create document record
        const documentId = uuidv4();
        const provenanceId = uuidv4();
        const now = new Date().toISOString();
        const ext = extname(filePath).slice(1).toLowerCase();

        // Create document provenance
        db.insertProvenance({
          id: provenanceId,
          type: ProvenanceType.DOCUMENT,
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'FILE',
          source_path: filePath,
          source_id: null,
          root_document_id: provenanceId,
          location: null,
          content_hash: fileHash,
          input_hash: null,
          file_hash: fileHash,
          processor: 'file-scanner',
          processor_version: '1.0.0',
          processing_params: { directory_path: input.directory_path, recursive: input.recursive },
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: null,
          parent_ids: '[]',
          chain_depth: 0,
          chain_path: '["DOCUMENT"]',
        });

        // Insert document
        db.insertDocument({
          id: documentId,
          file_path: filePath,
          file_name: basename(filePath),
          file_hash: fileHash,
          file_size: stats.size,
          file_type: ext,
          status: 'pending',
          page_count: null,
          provenance_id: provenanceId,
          error_message: null,
          modified_at: null,
          ocr_completed_at: null,
          doc_title: null,
          doc_author: null,
          doc_subject: null,
        });

        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: documentId,
          status: 'pending',
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Failed to ingest ${filePath}: ${errorMsg}`);
        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: '',
          status: 'error',
          error_message: errorMsg,
        });
      }
    }

    const result = {
      directory_path: input.directory_path,
      files_found: files.length,
      files_ingested: items.filter(i => i.status === 'pending').length,
      files_skipped: items.filter(i => i.status === 'skipped').length,
      files_errored: items.filter(i => i.status === 'error').length,
      items,
    };

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_ingest_files - Ingest specific files
 */
export async function handleIngestFiles(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(IngestFilesInput, params);
    const { db } = requireDatabase();

    const items: IngestionItem[] = [];

    for (const filePath of input.file_paths) {
      try {
        // Validate file exists - FAIL FAST
        if (!existsSync(filePath)) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: 'File not found',
          });
          continue;
        }

        const stats = statSync(filePath);
        if (!stats.isFile()) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: 'Path is not a file',
          });
          continue;
        }

        // Check if already ingested
        const existingByPath = db.getDocumentByPath(filePath);
        if (existingByPath) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: existingByPath.id,
            status: 'skipped',
            error_message: 'Already ingested',
          });
          continue;
        }

        // Create document record
        const documentId = uuidv4();
        const provenanceId = uuidv4();
        const now = new Date().toISOString();
        const ext = extname(filePath).slice(1).toLowerCase();

        // Validate file type is supported
        if (!DEFAULT_FILE_TYPES.includes(ext)) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: `Unsupported file type: .${ext}. Supported: ${DEFAULT_FILE_TYPES.join(', ')}`,
          });
          continue;
        }

        const fileHash = await hashFile(filePath);

        // Check for duplicate by file hash (same content, different path)
        const existingByHash = db.getDocumentByHash(fileHash);
        if (existingByHash) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: existingByHash.id,
            status: 'skipped',
            error_message: `Duplicate file (same hash as ${existingByHash.file_path})`,
          });
          continue;
        }

        // Create document provenance
        db.insertProvenance({
          id: provenanceId,
          type: ProvenanceType.DOCUMENT,
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'FILE',
          source_path: filePath,
          source_id: null,
          root_document_id: provenanceId,
          location: null,
          content_hash: fileHash,
          input_hash: null,
          file_hash: fileHash,
          processor: 'file-scanner',
          processor_version: '1.0.0',
          processing_params: {},
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: null,
          parent_ids: '[]',
          chain_depth: 0,
          chain_path: '["DOCUMENT"]',
        });

        // Insert document
        db.insertDocument({
          id: documentId,
          file_path: filePath,
          file_name: basename(filePath),
          file_hash: fileHash,
          file_size: stats.size,
          file_type: ext,
          status: 'pending',
          page_count: null,
          provenance_id: provenanceId,
          error_message: null,
          modified_at: null,
          ocr_completed_at: null,
          doc_title: null,
          doc_author: null,
          doc_subject: null,
        });

        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: documentId,
          status: 'pending',
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Failed to ingest ${filePath}: ${errorMsg}`);
        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: '',
          status: 'error',
          error_message: errorMsg,
        });
      }
    }

    return formatResponse(successResult({
      files_ingested: items.filter(i => i.status === 'pending').length,
      files_skipped: items.filter(i => i.status === 'skipped').length,
      files_errored: items.filter(i => i.status === 'error').length,
      items,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_process_pending - Process pending documents through full OCR pipeline
 *
 * Pipeline: OCR -> Extract Images -> Chunk -> Embed -> VLM Process Images -> Complete
 * Provenance chain: DOCUMENT(0) -> OCR_RESULT(1) -> CHUNK(2)/IMAGE(2) -> EMBEDDING(3)/VLM_DESC(3)
 */
export async function handleProcessPending(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(ProcessPendingInput, params);
    const { db, vector } = requireDatabase();

    // Get pending documents - CRITICAL: use 'status' not 'statusFilter'
    const pendingDocs = db.listDocuments({ status: 'pending', limit: input.max_concurrent ?? 3 });

    if (pendingDocs.length === 0) {
      return formatResponse(successResult({
        processed: 0,
        failed: 0,
        remaining: 0,
        message: 'No pending documents to process',
      }));
    }

    const ocrMode = input.ocr_mode ?? state.config.defaultOCRMode;
    const ocrOptions = {
      maxPages: input.max_pages,
      pageRange: input.page_range,
      skipCache: input.skip_cache,
      disableImageExtraction: input.disable_image_extraction,
      extras: input.extras,
      pageSchema: input.page_schema,
      additionalConfig: input.additional_config,
    };
    const results = {
      processed: 0,
      failed: 0,
      errors: [] as Array<{ document_id: string; error: string }>,
    };

    // Default images output directory
    const imagesBaseDir = resolve(state.config.defaultStoragePath, 'images');

    for (const doc of pendingDocs) {
      try {
        console.error(`[INFO] Processing document: ${doc.id} (${doc.file_name})`);

        // Step 1: OCR via Datalab
        // OCRProcessor.processDocument() handles status='processing' internally
        const ocrProcessor = new OCRProcessor(db);
        const processResult = await ocrProcessor.processDocument(doc.id, ocrMode, ocrOptions);

        if (!processResult.success) {
          throw new Error(processResult.error ?? 'OCR processing failed');
        }

        // Get the OCR result
        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        if (!ocrResult) {
          throw new Error('OCR result not found after processing');
        }

        console.error(`[INFO] OCR complete: ${ocrResult.text_length} chars, ${ocrResult.page_count} pages`);

        // Step 1.5: Extract and store images from OCR result (if any)
        let imageCount = 0;
        const imageOutputDir = resolve(imagesBaseDir, doc.id);

        if (processResult.images && Object.keys(processResult.images).length > 0) {
          const imageRefs = saveAndStoreImages(
            db, doc, ocrResult, processResult.images, imageOutputDir,
            processResult.jsonBlocks,
          );
          imageCount = imageRefs.length;
          console.error(`[INFO] Images from Datalab: ${imageCount}`);
        }

        // Step 1.6: File-based image extraction fallback
        // If Datalab didn't return images, extract directly from file (PDF or DOCX)
        if (imageCount === 0 && !ocrOptions.disableImageExtraction && ImageExtractor.isSupported(doc.file_path)) {
          console.error(`[INFO] No images from Datalab for ${doc.file_type} file, running file-based extraction`);
          const extractor = new ImageExtractor();
          const extractedImages = await extractor.extractImages(doc.file_path, {
            outputDir: imageOutputDir,
            minSize: 50,
            maxImages: 500,
          });

          if (extractedImages.length > 0) {
            // Build page classification from JSON blocks for header/footer detection
            const pageClassification = processResult.jsonBlocks
              ? buildPageBlockClassification(processResult.jsonBlocks)
              : new Map<number, PageImageClassification>();

            const imageRefs: CreateImageReference[] = extractedImages.map((img) => {
              // M-5 fix: Use streaming 64KB-chunked hash instead of readFileSync.
              // readFileSync loads the entire image into memory just to hash it.
              const contentHash = computeFileHashSync(img.path);

              const pageInfo = pageClassification.get(img.page);
              const isHeaderFooter = pageInfo !== undefined
                && !pageInfo.hasFigure
                && pageInfo.pictureInHeaderFooter > 0
                && pageInfo.pictureInBody === 0;

              const contextText = extractContextText(
                ocrResult.extracted_text,
                ocrResult.page_count ?? 1,
                img.page
              );
              return {
                document_id: doc.id,
                ocr_result_id: ocrResult.id,
                page_number: img.page,
                bounding_box: img.bbox,
                image_index: img.index,
                format: img.format,
                dimensions: { width: img.width, height: img.height },
                extracted_path: img.path,
                file_size: img.size,
                context_text: contextText || null,
                provenance_id: null,
                block_type: null, // File-based extraction has no block type
                is_header_footer: isHeaderFooter,
                content_hash: contentHash,
              };
            });

            const insertedImages = insertImageBatch(db.getConnection(), imageRefs);

            // Create IMAGE provenance records
            const tracker = getProvenanceTracker(db);
            for (const img of insertedImages) {
              try {
                const provenanceId = tracker.createProvenance({
                  type: ProvenanceType.IMAGE,
                  source_type: 'IMAGE_EXTRACTION',
                  source_id: ocrResult.provenance_id,
                  root_document_id: doc.provenance_id,
                  content_hash: img.content_hash ?? (img.extracted_path && existsSync(img.extracted_path) ? computeFileHashSync(img.extracted_path) : computeHash(img.id)),
                  source_path: img.extracted_path ?? undefined,
                  processor: `${doc.file_type}-image-extraction`,
                  processor_version: '1.0.0',
                  processing_params: {
                    page_number: img.page_number,
                    image_index: img.image_index,
                    format: img.format,
                    extraction_method: 'file-based',
                    is_header_footer: img.is_header_footer,
                  },
                  location: {
                    page_number: img.page_number,
                  },
                });
                updateImageProvenance(db.getConnection(), img.id, provenanceId);
              } catch (provError) {
                console.error(
                  `[ERROR] Failed to create IMAGE provenance for ${img.id}: ` +
                  `${provError instanceof Error ? provError.message : String(provError)}`
                );
                throw provError;
              }
            }

            imageCount = insertedImages.length;
            console.error(`[INFO] File-based extraction: ${imageCount} images`);
          } else {
            console.error(`[INFO] File-based extraction: no images found in document`);
          }
        }

        // Step 2: Chunk the OCR text using config from state
        const chunkConfig: ChunkingConfig = {
          chunkSize: state.config.chunkSize,
          overlapPercent: state.config.chunkOverlapPercent,
        };
        const pageOffsets = processResult.pageOffsets;
        let chunkResults: ChunkResult[];
        if (input.chunking_strategy === 'page_aware' && pageOffsets && pageOffsets.length > 0) {
          // SE-3: Page-boundary-aware chunking -- no chunks span page boundaries
          chunkResults = chunkTextPageAware(ocrResult.extracted_text, pageOffsets, chunkConfig);
        } else if (pageOffsets && pageOffsets.length > 0) {
          chunkResults = chunkWithPageTracking(ocrResult.extracted_text, pageOffsets, chunkConfig);
        } else {
          chunkResults = chunkText(ocrResult.extracted_text, chunkConfig);
        }

        console.error(`[INFO] Chunking complete: ${chunkResults.length} chunks`);

        // Step 3: Store chunks in database with provenance
        const chunks = storeChunks(db, doc, ocrResult, chunkResults, chunkConfig);

        console.error(`[INFO] Chunks stored: ${chunks.length}`);

        // Step 4: Generate embeddings for text chunks
        const embeddingService = new EmbeddingService();
        const documentInfo = {
          documentId: doc.id,
          filePath: doc.file_path,
          fileName: doc.file_name,
          fileHash: doc.file_hash,
          documentProvenanceId: doc.provenance_id,
        };

        const embedResult = await embeddingService.embedDocumentChunks(db, vector, chunks, documentInfo);

        if (!embedResult.success) {
          throw new Error(embedResult.error ?? 'Embedding generation failed');
        }

        console.error(`[INFO] Embeddings complete: ${embedResult.embeddingIds.length} embeddings in ${embedResult.elapsedMs}ms`);

        // Step 5: VLM process images (generate 3+ paragraph descriptions)
        // Only run if document had images extracted
        if (imageCount > 0) {
          const vlmPipeline = createVLMPipeline(db, vector, {
            batchSize: 5,
            concurrency: 3,
            minConfidence: 0.5,
          });

          const vlmResult = await vlmPipeline.processDocument(doc.id);
          console.error(
            `[INFO] VLM complete: ${vlmResult.successful}/${vlmResult.total} images processed, ` +
            `${vlmResult.totalTokens} tokens used`
          );

          if (vlmResult.failed > 0) {
            console.error(
              `[WARN] Document ${doc.id}: ${vlmResult.failed}/${vlmResult.total} VLM image processing failures`
            );
          }
        }

        // Step 5.5: Store structured extraction if present
        if (processResult.extractionJson && input.page_schema) {
          try {
            const extractionContent = JSON.stringify(processResult.extractionJson);
            const extractionHash = computeHash(extractionContent);

            // Create EXTRACTION provenance record
            const extractionProvId = uuidv4();
            const ocrProvId = processResult.provenanceId!;
            const docProvId = doc.provenance_id;
            const now = new Date().toISOString();

            db.insertProvenance({
              id: extractionProvId,
              type: ProvenanceType.EXTRACTION,
              created_at: now,
              processed_at: now,
              source_file_created_at: null,
              source_file_modified_at: null,
              source_type: 'EXTRACTION',
              source_path: doc.file_path,
              source_id: ocrProvId,
              root_document_id: docProvId,
              location: null,
              content_hash: extractionHash,
              input_hash: ocrResult.content_hash,
              file_hash: doc.file_hash,
              processor: 'datalab-extraction',
              processor_version: '1.0.0',
              processing_params: { page_schema: input.page_schema },
              processing_duration_ms: null,
              processing_quality_score: null,
              parent_id: ocrProvId,
              parent_ids: JSON.stringify([docProvId, ocrProvId]),
              chain_depth: 2,
              chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'EXTRACTION']),
            });

            db.insertExtraction({
              id: uuidv4(),
              document_id: doc.id,
              ocr_result_id: ocrResult.id,
              schema_json: input.page_schema,
              extraction_json: extractionContent,
              content_hash: extractionHash,
              provenance_id: extractionProvId,
              created_at: now,
            });

            console.error(`[INFO] Stored structured extraction for document ${doc.id}`);
          } catch (extErr) {
            console.error(`[WARN] Failed to store extraction for ${doc.id}: ${extErr instanceof Error ? extErr.message : String(extErr)}`);
          }
        }

        // Step 5.6: Update document metadata if available
        if (processResult.docTitle || processResult.docAuthor || processResult.docSubject) {
          db.updateDocumentMetadata(doc.id, {
            docTitle: processResult.docTitle ?? null,
            docAuthor: processResult.docAuthor ?? null,
            docSubject: processResult.docSubject ?? null,
          });
        }

        // Step 6: Mark document complete
        db.updateDocumentStatus(doc.id, 'complete');
        results.processed++;

        console.error(`[INFO] Document ${doc.id} processing complete`);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Document ${doc.id} failed: ${errorMsg}`);
        db.updateDocumentStatus(doc.id, 'failed', errorMsg);
        results.failed++;
        results.errors.push({ document_id: doc.id, error: errorMsg });
      }
    }

    // Get remaining count - CRITICAL: use 'status' not 'statusFilter'
    const remaining = db.listDocuments({ status: 'pending' }).length;

    return formatResponse(successResult({
      processed: results.processed,
      failed: results.failed,
      remaining,
      errors: results.errors.length > 0 ? results.errors : undefined,
    }));

  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_status - Get OCR processing status
 */
export async function handleOCRStatus(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(OCRStatusInput, params);
    const { db } = requireDatabase();

    if (input.document_id) {
      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      return formatResponse(successResult({
        documents: [{
          document_id: doc.id,
          file_name: doc.file_name,
          status: doc.status,
          page_count: doc.page_count,
          error_message: doc.error_message ?? undefined,
          created_at: doc.created_at,
        }],
        summary: {
          total: 1,
          pending: doc.status === 'pending' ? 1 : 0,
          processing: doc.status === 'processing' ? 1 : 0,
          complete: doc.status === 'complete' ? 1 : 0,
          failed: doc.status === 'failed' ? 1 : 0,
        },
      }));
    }

    // Map filter values - CRITICAL: use 'status' not 'statusFilter' for listDocuments
    const statusFilter = input.status_filter ?? 'all';
    const filterMap: Record<string, 'pending' | 'processing' | 'complete' | 'failed' | undefined> = {
      pending: 'pending',
      processing: 'processing',
      complete: 'complete',
      failed: 'failed',
      all: undefined,
    };

    const documents = db.listDocuments({
      status: filterMap[statusFilter],
      limit: 1000,
    });

    const stats = db.getStats();

    return formatResponse(successResult({
      documents: documents.map(d => ({
        document_id: d.id,
        file_name: d.file_name,
        status: d.status,
        page_count: d.page_count,
        error_message: d.error_message ?? undefined,
        created_at: d.created_at,
      })),
      summary: {
        total: stats.total_documents,
        pending: stats.documents_by_status.pending,
        processing: stats.documents_by_status.processing,
        complete: stats.documents_by_status.complete,
        failed: stats.documents_by_status.failed,
      },
      supplementary: {
        total_chunks: stats.total_chunks,
        total_embeddings: stats.total_embeddings,
        total_extractions: stats.total_extractions,
        total_form_fills: stats.total_form_fills,
        ocr_quality: stats.ocr_quality,
        costs: stats.costs,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_chunk_complete - Chunk and embed documents that completed OCR but have no chunks
 *
 * Picks up documents with status='complete' that were OCR'd but never chunked/embedded.
 */
export async function handleChunkComplete(
  _params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const { db, vector } = requireDatabase();

    const completeDocs = db.listDocuments({ status: 'complete', limit: 1000 });

    const results = { processed: 0, skipped: 0, failed: 0, errors: [] as Array<{ document_id: string; error: string }> };

    for (const doc of completeDocs) {
      try {
        // M-9 fix: Use existence check instead of loading all chunk rows.
        // getChunksByDocumentId loads every chunk object into memory just to check .length.
        if (db.hasChunksByDocumentId(doc.id)) {
          results.skipped++;
          continue;
        }

        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        if (!ocrResult) {
          results.skipped++;
          continue;
        }

        // Chunk the OCR text
        const chunkResults = chunkText(ocrResult.extracted_text, DEFAULT_CHUNKING_CONFIG);
        console.error(`[INFO] Chunking doc ${doc.id}: ${chunkResults.length} chunks`);

        // Store chunks with provenance
        const chunks = storeChunks(db, doc, ocrResult, chunkResults);

        // Generate embeddings
        const embeddingService = new EmbeddingService();
        const documentInfo = {
          documentId: doc.id,
          filePath: doc.file_path,
          fileName: doc.file_name,
          fileHash: doc.file_hash,
          documentProvenanceId: doc.provenance_id,
        };

        const embedResult = await embeddingService.embedDocumentChunks(db, vector, chunks, documentInfo);
        if (!embedResult.success) {
          throw new Error(embedResult.error ?? 'Embedding generation failed');
        }

        console.error(`[INFO] Doc ${doc.id}: ${chunks.length} chunks, ${embedResult.embeddingIds.length} embeddings`);
        results.processed++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Chunk complete failed for ${doc.id}: ${errorMsg}`);
        results.failed++;
        results.errors.push({ document_id: doc.id, error: errorMsg });
      }
    }

    return formatResponse(successResult({
      processed: results.processed,
      skipped: results.skipped,
      failed: results.failed,
      errors: results.errors.length > 0 ? results.errors : undefined,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_retry_failed - Reset failed documents back to pending for reprocessing
 *
 * Cleans all derived data (OCR results, chunks, embeddings, images, non-root provenance)
 * before resetting status to 'pending' to avoid duplicate data on reprocessing.
 */
export async function handleRetryFailed(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(RetryFailedInput, params);
    const { db } = requireDatabase();

    let resetCount = 0;

    if (input.document_id) {
      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }
      if (doc.status !== 'failed') {
        return formatResponse(successResult({
          reset: 0,
          message: `Document ${input.document_id} is not in failed state (current: ${doc.status})`,
        }));
      }
      // Clean all derived data before resetting to pending
      db.cleanDocumentDerivedData(input.document_id);
      db.updateDocumentStatus(input.document_id, 'pending');
      resetCount = 1;
    } else {
      const failedDocs = db.listDocuments({ status: 'failed', limit: 1000 });
      for (const doc of failedDocs) {
        // Clean all derived data before resetting to pending
        db.cleanDocumentDerivedData(doc.id);
        db.updateDocumentStatus(doc.id, 'pending');
        resetCount++;
      }
    }

    return formatResponse(successResult({
      reset: resetCount,
      message: `Reset ${resetCount} failed document(s) to pending (derived data cleaned)`,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAW CONVERSION HANDLER (AI-4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_convert_raw - Convert a document via OCR and return raw results
 * without storing in database. Quick one-off conversions.
 */
async function handleConvertRaw(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(z.object({
      file_path: z.string().min(1),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
      max_pages: z.number().int().min(1).max(7000).optional(),
      page_range: z.string().optional(),
    }), params);

    // Verify file exists - FAIL FAST
    if (!existsSync(input.file_path)) {
      throw new Error(`File not found: ${input.file_path}`);
    }

    const stats = statSync(input.file_path);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${input.file_path}`);
    }

    // Use DatalabClient directly without DB storage
    const client = new DatalabClient();
    const result = await client.processRaw(input.file_path, input.ocr_mode, {
      maxPages: input.max_pages,
      pageRange: input.page_range,
    });

    return formatResponse(successResult({
      file_path: input.file_path,
      text_length: result.markdown.length,
      page_count: result.pageCount,
      markdown: result.markdown,
      metadata: result.metadata ?? {},
      quality_score: result.qualityScore,
      cost_cents: result.costCents,
      processing_duration_ms: result.durationMs,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPROCESS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_reprocess - Reprocess a document with different OCR settings
 * Cleans all derived data first, then re-runs the pipeline.
 */
async function handleReprocess(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(z.object({
      document_id: z.string().min(1),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional(),
      skip_cache: z.boolean().default(true),
    }), params);
    const { db } = requireDatabase();

    const doc = db.getDocument(input.document_id);
    if (!doc) throw documentNotFoundError(input.document_id);
    if (doc.status !== 'complete' && doc.status !== 'failed') {
      throw new Error(`Document status must be 'complete' or 'failed' to reprocess (current: ${doc.status})`);
    }

    // Save previous quality score for comparison
    const previousOCR = db.getOCRResultByDocumentId(doc.id);
    const previousQuality = previousOCR?.parse_quality_score ?? null;

    // Clean all derived data (chunks, embeddings, images, ocr_results, extractions)
    db.cleanDocumentDerivedData(doc.id);
    db.updateDocumentStatus(doc.id, 'pending');

    // Reprocess through pipeline
    const result = await handleProcessPending({
      max_concurrent: 1,
      ocr_mode: input.ocr_mode,
      skip_cache: input.skip_cache,
    });

    // Get new quality score
    const newOCR = db.getOCRResultByDocumentId(doc.id);

    return formatResponse(successResult({
      document_id: doc.id,
      previous_quality: previousQuality,
      new_quality: newOCR?.parse_quality_score ?? null,
      quality_change: previousQuality !== null && newOCR?.parse_quality_score !== null && newOCR?.parse_quality_score !== undefined
        ? (newOCR.parse_quality_score - previousQuality).toFixed(2)
        : null,
      reprocess_result: result,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingestion tools collection for MCP server registration
 */
export const ingestionTools: Record<string, ToolDefinition> = {
  'ocr_ingest_directory': {
    description: 'Scan and ingest documents from a directory into the current database',
    inputSchema: {
      directory_path: z.string().min(1).describe('Path to directory to scan'),
      recursive: z.boolean().default(true).describe('Scan subdirectories'),
      file_types: z.array(z.string()).optional().describe('File types to include (default: pdf, png, jpg, docx, etc.)'),
    },
    handler: handleIngestDirectory,
  },
  'ocr_ingest_files': {
    description: 'Ingest specific files into the current database. Supports local file paths and optional file URLs for Datalab direct URL processing.',
    inputSchema: {
      file_paths: z.array(z.string().min(1)).min(1).describe('Array of file paths to ingest'),
      file_urls: z.array(z.string().url()).optional().describe('URLs of files to ingest (Datalab supports file_url parameter)'),
    },
    handler: handleIngestFiles,
  },
  'ocr_process_pending': {
    description: 'Process pending documents through OCR pipeline (OCR -> Chunk -> Embed -> Vector)',
    inputSchema: {
      max_concurrent: z.number().int().min(1).max(10).default(3).describe('Maximum concurrent OCR operations'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional().describe('OCR processing mode override'),
      max_pages: z.number().int().min(1).max(7000).optional().describe('Maximum pages to process per document (Datalab limit: 7000)'),
      page_range: z.string().regex(/^[0-9,\-\s]+$/).optional().describe('Specific pages to process, 0-indexed (e.g., "0-5,10")'),
      skip_cache: z.boolean().optional().describe('Force reprocessing, skip Datalab cache'),
      disable_image_extraction: z.boolean().optional().describe('Skip image extraction for text-only processing'),
      extras: z.array(z.enum(['track_changes', 'chart_understanding', 'extract_links', 'table_row_bboxes', 'infographic', 'new_block_types'])).optional().describe('Extra Datalab features to enable'),
      page_schema: z.string().optional().describe('JSON schema string for structured data extraction per page'),
      additional_config: z.record(z.unknown()).optional().describe('Additional Datalab config: keep_pageheader_in_output, keep_pagefooter_in_output, keep_spreadsheet_formatting'),
      chunking_strategy: z.enum(['fixed', 'page_aware']).default('fixed')
        .describe('Chunking strategy: fixed-size or page-boundary-aware (no chunks span pages)'),
    },
    handler: handleProcessPending,
  },
  'ocr_status': {
    description: 'Get OCR processing status for documents',
    inputSchema: {
      document_id: z.string().optional().describe('Specific document ID to check'),
      status_filter: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('all').describe('Filter by status'),
    },
    handler: handleOCRStatus,
  },
  'ocr_chunk_complete': {
    description: 'Chunk and embed documents that completed OCR but have no chunks yet. Fixes documents that were OCR\'d but never chunked/embedded.',
    inputSchema: {},
    handler: handleChunkComplete,
  },
  'ocr_retry_failed': {
    description: 'Reset failed documents back to pending status so they can be reprocessed',
    inputSchema: {
      document_id: z.string().optional().describe('Specific document ID to retry (omit to retry all failed)'),
    },
    handler: handleRetryFailed,
  },
  'ocr_reprocess': {
    description: 'Reprocess a document with different OCR settings (cleans existing data first)',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to reprocess'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional()
        .describe('OCR mode override'),
      skip_cache: z.boolean().default(true)
        .describe('Skip Datalab cache (default: true for reprocessing)'),
    },
    handler: handleReprocess,
  },
  'ocr_convert_raw': {
    description: 'Convert a document via OCR and return raw results without storing in database. Quick one-off conversions.',
    inputSchema: {
      file_path: z.string().min(1).describe('Path to file to convert'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced')
        .describe('OCR processing mode'),
      max_pages: z.number().int().min(1).max(7000).optional()
        .describe('Maximum pages to process'),
      page_range: z.string().optional()
        .describe('Specific pages to process (0-indexed, e.g., "0-5,10")'),
    },
    handler: handleConvertRaw,
  },
};

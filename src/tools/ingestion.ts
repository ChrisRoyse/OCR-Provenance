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
import { existsSync, statSync, lstatSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, extname, basename } from 'path';

import { DatabaseService } from '../services/storage/database/index.js';
import { OCRProcessor } from '../services/ocr/processor.js';
import { DatalabClient } from '../services/ocr/datalab.js';
import {
  chunkHybridSectionAware,
  ChunkResult,
  DEFAULT_CHUNKING_CONFIG,
} from '../services/chunking/chunker.js';
import type { ChunkingConfig } from '../services/chunking/chunker.js';
import { extractPageOffsetsFromText } from '../services/chunking/markdown-parser.js';
import { EmbeddingService } from '../services/embedding/embedder.js';
import { ProvenanceTracker } from '../services/provenance/tracker.js';
import { computeHash, hashFile, computeFileHashSync } from '../utils/hash.js';
import { state, requireDatabase, validateGeneration, getConfig } from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  sanitizePath,
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
import type { Document, OCRResult, PageOffset } from '../models/document.js';
import type { Chunk } from '../models/chunk.js';
import type { CreateImageReference, ImageReference } from '../models/image.js';
import { ProvenanceType } from '../models/provenance.js';
import {
  insertImageBatch,
  updateImageProvenance,
} from '../services/storage/database/image-operations.js';
import { getProvenanceTracker } from '../services/provenance/index.js';
import { createVLMPipeline } from '../services/vlm/pipeline.js';
import { ImageExtractor } from '../services/images/extractor.js';
import { computeBlockTypeStats, detectRepeatedHeadersFooters, isRepeatedHeaderFooter } from '../services/chunking/json-block-analyzer.js';

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
  previous_version_id?: string;
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
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
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
      processor_version: '2.0.0',
      processing_params: {
        strategy: 'hybrid_section',
        max_chunk_size: config.maxChunkSize,
        chunk_size: config.chunkSize,
        overlap_percent: config.overlapPercent,
        chunk_index: i,
        total_chunks: chunkResults.length,
        character_start: cr.startOffset,
        character_end: cr.endOffset,
        heading_context: cr.headingContext ?? null,
        section_path: cr.sectionPath ?? null,
        is_atomic: cr.isAtomic,
        content_types: cr.contentTypes,
        ...(cr.tableMetadata ? {
          table_columns: cr.tableMetadata.columnHeaders,
          table_row_count: cr.tableMetadata.rowCount,
          table_column_count: cr.tableMetadata.columnCount,
        } : {}),
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
      ocr_quality_score: ocrResult.parse_quality_score ?? null,
      heading_context: cr.headingContext ?? null,
      heading_level: cr.headingLevel ?? null,
      section_path: cr.sectionPath ?? null,
      content_types: JSON.stringify(cr.contentTypes),
      is_atomic: cr.isAtomic ? 1 : 0,
      chunking_strategy: 'hybrid_section',
    });

    // Build Chunk object directly from insert data (avoids re-fetching from DB)
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
      ocr_quality_score: ocrResult.parse_quality_score ?? null,
      heading_context: cr.headingContext ?? null,
      heading_level: cr.headingLevel ?? null,
      section_path: cr.sectionPath ?? null,
      content_types: JSON.stringify(cr.contentTypes),
      is_atomic: cr.isAtomic ? 1 : 0,
      chunking_strategy: 'hybrid_section',
    });
  }

  return chunks;
}

/**
 * Extract a context text window from OCR text for a target page.
 *
 * When pageOffsets are provided, uses exact character boundaries from OCR.
 * Falls back to heuristic estimation when pageOffsets are unavailable.
 *
 * @param ocrText - Full OCR extracted text
 * @param pageCount - Total number of pages in the document
 * @param targetPage - The page number to extract context for (1-indexed)
 * @param pageOffsets - Optional exact page offset data from OCR
 * @returns Context text window (max ~1000 chars)
 */
function extractContextText(
  ocrText: string,
  pageCount: number,
  targetPage: number,
  pageOffsets?: PageOffset[]
): string {
  if (!ocrText || ocrText.length === 0 || pageCount <= 0) {
    return '';
  }

  const textLength = ocrText.length;

  // Use exact page boundaries when available
  if (pageOffsets && pageOffsets.length > 0) {
    const pageInfo = pageOffsets.find((p) => p.page === targetPage);
    if (pageInfo) {
      const start = Math.max(0, Math.min(pageInfo.charStart, textLength));
      const end = Math.min(pageInfo.charEnd, textLength);
      // Cap at 1000 chars to match original behavior
      return ocrText.slice(start, Math.min(end, start + 1000)).trim();
    }
  }

  // Fallback: heuristic estimation
  const safePageCount = Math.max(1, pageCount);
  const safePage = Math.max(1, Math.min(targetPage, safePageCount));

  // Estimate position in text for this page
  // Use (safePageCount - 1) as denominator so last page maps to end of text
  const estimatedPosition = Math.floor(
    ((safePage - 1) / Math.max(1, safePageCount - 1)) * textLength
  );

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

  const topChildren =
    (jsonBlocks as Record<string, unknown[]>).children ??
    (jsonBlocks as Record<string, unknown[]>).blocks ??
    [];

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
  pageOffsets?: PageOffset[]
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
    const buffer = Buffer.from(images[filename], 'base64');
    // Release base64 string immediately to reduce peak memory
    delete images[filename];

    const filePath = resolve(outputDir, filename);

    writeFileSync(filePath, buffer);

    // Parse page number from filename (e.g., "page_1_image_0.png" or "p001_i000.png")
    const pageMatch = filename.match(/page_(\d+)|p(\d+)/i);
    const pageNumber = pageMatch ? parseInt(pageMatch[1] || pageMatch[2], 10) + 1 : 1;

    // Per-page image index
    const currentPageCount = pageImageCounts.get(pageNumber) ?? 0;
    pageImageCounts.set(pageNumber, currentPageCount + 1);
    const imageIndex = currentPageCount;

    const contentHash = computeHash(buffer);

    // Parse block type from Datalab filename
    const blockType = parseBlockTypeFromFilename(filename);

    // Determine if image is in header/footer region
    const pageInfo = pageClassification.get(pageNumber);
    const isHeaderFooter =
      blockType === 'PageHeader' ||
      blockType === 'PageFooter' ||
      (pageInfo !== undefined &&
        !pageInfo.hasFigure &&
        pageInfo.pictureInHeaderFooter > 0 &&
        pageInfo.pictureInBody === 0);

    // Get image format from extension
    const ext = extname(filename).slice(1).toLowerCase();
    const format = ext || 'png';

    // Extract context text from OCR for this page (uses exact pageOffsets when available)
    const contextText = extractContextText(
      ocrResult.extracted_text,
      ocrResult.page_count ?? 1,
      pageNumber,
      pageOffsets
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
          content_hash:
            img.content_hash ??
            (img.extracted_path && existsSync(img.extracted_path)
              ? computeFileHashSync(img.extracted_path)
              : computeHash(img.id)),
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
        console.error(
          `[WARN] Failed to create IMAGE provenance for ${img.id}: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
    }

    return insertedImages;
  }

  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE-DOCUMENT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parameters for processing a single document through the OCR pipeline.
 * Extracted from handleProcessPending to allow direct single-document processing
 * (used by handleReprocess to avoid race conditions with batch claiming).
 */
interface ProcessOneDocumentParams {
  db: DatabaseService;
  vector: import('../services/storage/vector.js').VectorService;
  generation: number;
  ocrMode: 'fast' | 'balanced' | 'accurate' | undefined;
  ocrOptions: {
    maxPages?: number;
    pageRange?: string;
    skipCache?: boolean;
    disableImageExtraction?: boolean;
    extras?: string[];
    pageSchema?: string;
    additionalConfig?: Record<string, unknown>;
  };
  pageSchema?: string;
  imagesBaseDir: string;
}

/**
 * Process a single document through the full OCR pipeline.
 *
 * Pipeline: OCR -> Extract Images -> Chunk -> Embed -> VLM -> Structured Extraction -> Complete
 *
 * This function is the core processing unit used by both handleProcessPending (batch)
 * and handleReprocess (single document). Extracting it prevents the race condition
 * where handleReprocess calls handleProcessPending and the target document may not
 * be claimed when other pending documents exist (M-11).
 *
 * @param doc - Document record (must already have status='processing')
 * @param params - Processing parameters
 * @returns void on success, throws on failure
 */
async function processOneDocument(
  doc: Document,
  params: ProcessOneDocumentParams
): Promise<void> {
  const { db, vector, generation, ocrMode, ocrOptions, pageSchema, imagesBaseDir } = params;

  console.error(`[INFO] Processing document: ${doc.id} (${doc.file_name})`);

  // Step 1: OCR via Datalab
  // OCRProcessor.processDocument() throws on failure (FAIL-FAST).
  // It handles status='processing' internally and marks 'failed' before throwing.
  const ocrProcessor = new OCRProcessor(db);
  const processResult = await ocrProcessor.processDocument(doc.id, ocrMode, ocrOptions);

  // Get the OCR result
  const ocrResult = db.getOCRResultByDocumentId(doc.id);
  if (!ocrResult) {
    throw new Error('OCR result not found after processing');
  }

  console.error(
    `[INFO] OCR complete: ${ocrResult.text_length} chars, ${ocrResult.page_count} pages`
  );

  // Step 1.5: Extract and store images from OCR result (if any)
  let imageCount = 0;
  const imageOutputDir = resolve(imagesBaseDir, doc.id);

  if (processResult.images && Object.keys(processResult.images).length > 0) {
    const imageRefs = saveAndStoreImages(
      db,
      doc,
      ocrResult,
      processResult.images,
      imageOutputDir,
      processResult.jsonBlocks,
      processResult.pageOffsets
    );
    imageCount = imageRefs.length;
    console.error(`[INFO] Images from Datalab: ${imageCount}`);
  }

  // Step 1.6: File-based image extraction fallback
  // If Datalab didn't return images, extract directly from file (PDF or DOCX)
  if (
    imageCount === 0 &&
    !ocrOptions.disableImageExtraction &&
    ImageExtractor.isSupported(doc.file_path)
  ) {
    console.error(
      `[INFO] No images from Datalab for ${doc.file_type} file, running file-based extraction`
    );
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
        const contentHash = computeFileHashSync(img.path);

        const pageInfo = pageClassification.get(img.page);
        const isHeaderFooter =
          pageInfo !== undefined &&
          !pageInfo.hasFigure &&
          pageInfo.pictureInHeaderFooter > 0 &&
          pageInfo.pictureInBody === 0;

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
            content_hash:
              img.content_hash ??
              (img.extracted_path && existsSync(img.extracted_path)
                ? computeFileHashSync(img.extracted_path)
                : computeHash(img.id)),
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

  // Step 2: Chunk the OCR text using hybrid section-aware chunker
  const chunkConfig: ChunkingConfig = {
    chunkSize: state.config.chunkSize,
    overlapPercent: state.config.chunkOverlapPercent,
    maxChunkSize: state.config.maxChunkSize,
  };
  let pageOffsets = processResult.pageOffsets ?? [];
  // Fallback: if Python returned a single page offset covering the entire text,
  // re-extract using TypeScript's extractPageOffsetsFromText which handles both
  // HTML comment (<!-- Page N -->) and Datalab ({N}---) separator formats.
  if (pageOffsets.length <= 1 && ocrResult.extracted_text.length > 0) {
    const extracted = extractPageOffsetsFromText(ocrResult.extracted_text);
    if (extracted.length > pageOffsets.length) {
      pageOffsets = extracted;
    }
  }
  const chunkResults = chunkHybridSectionAware(
    ocrResult.extracted_text,
    pageOffsets,
    processResult.jsonBlocks ?? null,
    chunkConfig
  );

  console.error(`[INFO] Chunking complete: ${chunkResults.length} chunks`);

  // Step 3: Store chunks in database with provenance
  const chunks = storeChunks(db, doc, ocrResult, chunkResults, chunkConfig);

  console.error(`[INFO] Chunks stored: ${chunks.length}`);

  // Step 3.4: Detect repeated headers/footers and tag matching chunks (T2.8)
  if (processResult.jsonBlocks) {
    try {
      const headerFooterInfo = detectRepeatedHeadersFooters(processResult.jsonBlocks);
      const allRepeated = [...headerFooterInfo.repeatedHeaders, ...headerFooterInfo.repeatedFooters];

      if (allRepeated.length > 0) {
        const conn = db.getConnection();
        let tagRow = conn.prepare("SELECT id FROM tags WHERE name = ?").get('system:repeated_header_footer') as { id: string } | undefined;
        if (!tagRow) {
          const tagId = uuidv4();
          conn.prepare("INSERT INTO tags (id, name, description, color) VALUES (?, ?, ?, ?)").run(
            tagId, 'system:repeated_header_footer', 'Auto-detected repeated page header or footer content', '#888888'
          );
          tagRow = { id: tagId };
        }

        let taggedCount = 0;
        for (const chunk of chunks) {
          if (isRepeatedHeaderFooter(chunk.text, allRepeated)) {
            const entityTagId = uuidv4();
            conn.prepare(
              "INSERT OR IGNORE INTO entity_tags (id, tag_id, entity_id, entity_type) VALUES (?, ?, ?, 'chunk')"
            ).run(entityTagId, tagRow.id, chunk.id);
            taggedCount++;
          }
        }
        console.error(`[T2.8] Tagged ${taggedCount} chunks as repeated header/footer (${allRepeated.length} patterns detected) for document ${doc.id}`);
      }
    } catch (tagError) {
      // Non-fatal: tagging failure should not block document processing
      console.error(
        `[WARN] Header/footer tagging failed for ${doc.id}: ` +
        `${tagError instanceof Error ? tagError.message : String(tagError)}`
      );
    }
  }

  // Step 3.5: Enrich extras_json with block stats, links, and structural fingerprint
  // (Tasks 4.1, 4.2, 4.4 - Ingestion Pipeline Enrichment)
  try {
    const existingExtras: Record<string, unknown> = ocrResult.extras_json
      ? (JSON.parse(ocrResult.extras_json) as Record<string, unknown>)
      : {};

    // Task 4.1: Block-type statistics from json_blocks
    const blockStats = computeBlockTypeStats(processResult.jsonBlocks ?? null);
    if (blockStats) {
      existingExtras.block_type_stats = blockStats;
    }

    // Task 4.2: Extract structured hyperlinks from Datalab metadata
    const metadataObj = (existingExtras.metadata ?? processResult.metadata ?? null) as Record<string, unknown> | null;
    if (metadataObj) {
      // Datalab stores links under metadata.extras_features.links or metadata.links
      const extrasFeatures = metadataObj.extras_features as Record<string, unknown> | undefined;
      const rawLinks = (extrasFeatures?.links ?? metadataObj.links ?? null) as
        | Array<Record<string, unknown>>
        | null;

      if (Array.isArray(rawLinks) && rawLinks.length > 0) {
        const structuredLinks = rawLinks
          .filter((link) => {
            const url = (link.url ?? link.href ?? '') as string;
            return url.length > 0;
          })
          .map((link) => ({
            url: ((link.url ?? link.href) as string),
            anchor_text: ((link.anchor_text ?? link.text ?? link.title ?? '') as string),
            page_number: ((link.page_number ?? link.page ?? null) as number | null),
          }));

        existingExtras.structured_links = structuredLinks;
        existingExtras.link_count = structuredLinks.length;
      } else {
        existingExtras.link_count = 0;
      }
    }

    // Task 4.4: Structural fingerprint from chunks
    const headingDepths: Record<string, number> = {};
    let totalChunkSize = 0;
    let atomicChunkCount = 0;
    let tableCount = 0;
    let figureCount = 0;
    const contentTypeDist: Record<string, number> = {};

    for (const cr of chunkResults) {
      totalChunkSize += cr.text.length;
      if (cr.isAtomic) atomicChunkCount++;

      // Count heading depths from heading level
      if (cr.headingLevel !== null && cr.headingLevel !== undefined) {
        const key = `h${cr.headingLevel}`;
        headingDepths[key] = (headingDepths[key] ?? 0) + 1;
      }

      // Count content types
      for (const ct of cr.contentTypes) {
        contentTypeDist[ct] = (contentTypeDist[ct] ?? 0) + 1;
        if (ct === 'Table' || ct === 'TableGroup') tableCount++;
        if (ct === 'Figure' || ct === 'FigureGroup') figureCount++;
      }
    }

    existingExtras.structural_fingerprint = {
      page_count: ocrResult.page_count ?? 0,
      chunk_count: chunkResults.length,
      table_count: tableCount,
      figure_count: figureCount,
      heading_depths: headingDepths,
      avg_chunk_size: chunkResults.length > 0
        ? Math.round(totalChunkSize / chunkResults.length)
        : 0,
      atomic_chunk_ratio: chunkResults.length > 0
        ? Math.round((atomicChunkCount / chunkResults.length) * 100) / 100
        : 0,
      content_type_distribution: contentTypeDist,
    };

    // Persist enriched extras_json back to ocr_results
    const updatedExtrasJson = JSON.stringify(existingExtras);
    db.getConnection()
      .prepare('UPDATE ocr_results SET extras_json = ? WHERE id = ?')
      .run(updatedExtrasJson, ocrResult.id);

    console.error(
      `[INFO] Extras enriched: block_stats=${blockStats ? 'yes' : 'no'}, ` +
      `links=${existingExtras.link_count ?? 0}, fingerprint=yes`
    );
  } catch (enrichError) {
    // Non-fatal: enrichment failure should not block document processing
    console.error(
      `[WARN] Extras enrichment failed for ${doc.id}: ` +
      `${enrichError instanceof Error ? enrichError.message : String(enrichError)}`
    );
  }

  // Step 4: Generate embeddings for text chunks
  const embeddingService = new EmbeddingService();
  const documentInfo = {
    documentId: doc.id,
    filePath: doc.file_path,
    fileName: doc.file_name,
    fileHash: doc.file_hash,
    documentProvenanceId: doc.provenance_id,
  };

  const embedResult = await embeddingService.embedDocumentChunks(
    db,
    vector,
    chunks,
    documentInfo
  );

  if (!embedResult.success) {
    throw new Error(embedResult.error ?? 'Embedding generation failed');
  }

  console.error(
    `[INFO] Embeddings complete: ${embedResult.embeddingIds.length} embeddings in ${embedResult.elapsedMs}ms`
  );

  // Step 5: VLM process images (generate 3+ paragraph descriptions)
  // Only run if document had images extracted.
  // VLM failures for individual images are logged as warnings but do NOT fail
  // the document -- OCR, chunking, and embeddings already succeeded. Each image
  // has its own vlm_status ('complete'|'failed'|'skipped') tracked independently.
  if (imageCount > 0) {
    const vlmPipeline = createVLMPipeline(db, vector, {
      batchSize: 5,
      concurrency: 3,
      minConfidence: 0.5,
    });

    const vlmResult = await vlmPipeline.processDocument(doc.id);
    console.error(
      `[INFO] VLM complete: ${vlmResult.successful}/${vlmResult.total} images processed, ` +
        `${vlmResult.skipped} skipped, ${vlmResult.failed} failed, ` +
        `${vlmResult.totalTokens} tokens used`
    );

    if (vlmResult.failed > 0) {
      const failedDetails = vlmResult.results
        .filter((r) => !r.success)
        .map((r) => `${r.imageId}: ${r.error ?? 'unknown error'}`)
        .join('; ');
      console.error(
        `[WARN] VLM processing failed for ${vlmResult.failed}/${vlmResult.total} images ` +
          `in document ${doc.id}. Individual images marked as failed; document will ` +
          `complete normally. Details: ${failedDetails}`
      );
    }
  }

  // Step 5.5: Store structured extraction if present
  // Errors propagate to fail the document (no swallowing)
  if (processResult.extractionJson && pageSchema) {
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
      processing_params: { page_schema: pageSchema },
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
      schema_json: pageSchema,
      extraction_json: extractionContent,
      content_hash: extractionHash,
      provenance_id: extractionProvId,
      created_at: now,
    });

    console.error(`[INFO] Stored structured extraction for document ${doc.id}`);
  }

  // Step 5.6: Update document metadata if available
  if (processResult.docTitle || processResult.docAuthor || processResult.docSubject) {
    db.updateDocumentMetadata(doc.id, {
      docTitle: processResult.docTitle ?? null,
      docAuthor: processResult.docAuthor ?? null,
      docSubject: processResult.docSubject ?? null,
    });
  }

  // Step 6: Validate database wasn't switched during long-running processing
  validateGeneration(generation);

  // Step 7: Mark document complete (OCR + chunks + embeddings succeeded)
  db.updateDocumentStatus(doc.id, 'complete');

  console.error(`[INFO] Document ${doc.id} processing complete`);
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

    const safeDirPath = sanitizePath(input.directory_path);

    // Validate directory exists - FAIL FAST
    if (!existsSync(safeDirPath)) {
      throw pathNotFoundError(safeDirPath);
    }

    const dirStats = statSync(safeDirPath);
    if (!dirStats.isDirectory()) {
      throw pathNotDirectoryError(safeDirPath);
    }

    const fileTypes = input.file_types ?? [...DEFAULT_FILE_TYPES];
    const items: IngestionItem[] = [];

    const collectFiles = (dirPath: string): string[] => {
      const files: string[] = [];
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = resolve(dirPath, entry.name);

        try {
          if (lstatSync(fullPath).isSymbolicLink()) {
            console.error(`[WARN] Skipping symlink during ingestion: ${fullPath}`);
            continue;
          }
        } catch (error) {
          console.error(
            `[WARN] Could not stat entry, skipping: ${fullPath}:`,
            error instanceof Error ? error.message : String(error)
          );
          continue;
        }

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

    const files = collectFiles(safeDirPath);

    // Ingest each file
    for (const filePath of files) {
      try {
        // Check if already ingested by path
        const existingByPath = db.getDocumentByPath(filePath);

        const stats = statSync(filePath);
        const fileHash = await hashFile(filePath);

        if (existingByPath) {
          if (fileHash === existingByPath.file_hash) {
            items.push({
              file_path: filePath,
              file_name: basename(filePath),
              document_id: existingByPath.id,
              status: 'skipped',
              error_message: 'Already ingested, content unchanged',
            });
            continue;
          }
          // Version change detected - continue with normal ingestion flow below
          console.error(`[Ingestion] Version update detected for ${filePath}: ${existingByPath.file_hash} -> ${fileHash}`);
        } else {
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
        }

        // Determine if this is a version update
        const isVersionUpdate = !!existingByPath;

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
          processing_params: {
            directory_path: safeDirPath,
            recursive: input.recursive,
            ...(isVersionUpdate ? { previous_version_id: existingByPath.id } : {}),
          },
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
          datalab_file_id: null,
        });

        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: documentId,
          status: isVersionUpdate ? 'version_updated' : 'pending',
          ...(isVersionUpdate ? { previous_version_id: existingByPath.id } : {}),
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
      directory_path: safeDirPath,
      files_found: files.length,
      files_ingested: items.filter((i) => i.status === 'pending').length,
      files_version_updated: items.filter((i) => i.status === 'version_updated').length,
      files_skipped: items.filter((i) => i.status === 'skipped').length,
      files_errored: items.filter((i) => i.status === 'error').length,
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

    for (const rawFilePath of input.file_paths) {
      const filePath = sanitizePath(rawFilePath);
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

        if (existingByPath) {
          if (fileHash === existingByPath.file_hash) {
            items.push({
              file_path: filePath,
              file_name: basename(filePath),
              document_id: existingByPath.id,
              status: 'skipped',
              error_message: 'Already ingested, content unchanged',
            });
            continue;
          }
          // Version change detected - continue with normal ingestion flow below
          console.error(`[Ingestion] Version update detected for ${filePath}: ${existingByPath.file_hash} -> ${fileHash}`);
        } else {
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
        }

        // Determine if this is a version update
        const isVersionUpdate = !!existingByPath;

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
          processing_params: isVersionUpdate ? { previous_version_id: existingByPath.id } : {},
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
          datalab_file_id: null,
        });

        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: documentId,
          status: isVersionUpdate ? 'version_updated' : 'pending',
          ...(isVersionUpdate ? { previous_version_id: existingByPath.id } : {}),
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

    return formatResponse(
      successResult({
        files_ingested: items.filter((i) => i.status === 'pending').length,
        files_version_updated: items.filter((i) => i.status === 'version_updated').length,
        files_skipped: items.filter((i) => i.status === 'skipped').length,
        files_errored: items.filter((i) => i.status === 'error').length,
        items,
      })
    );
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
    const { db, vector, generation } = requireDatabase();

    if (!process.env.DATALAB_API_KEY) {
      throw new Error('DATALAB_API_KEY environment variable is required for OCR processing');
    }

    // Atomic document claiming: UPDATE then SELECT to prevent concurrent callers
    // from processing the same documents (F-INTEG-3)
    const claimLimit = input.max_concurrent ?? 3;
    const conn = db.getConnection();
    conn
      .prepare(
        `UPDATE documents SET status = 'processing', modified_at = ?
       WHERE id IN (SELECT id FROM documents WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?)`
      )
      .run(new Date().toISOString(), claimLimit);
    const pendingDocs = db.listDocuments({ status: 'processing', limit: claimLimit });

    if (pendingDocs.length === 0) {
      return formatResponse(
        successResult({
          processed: 0,
          failed: 0,
          remaining: 0,
          message: 'No pending documents to process',
        })
      );
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
    const successfulDocIds: string[] = [];

    const batchId = uuidv4();
    const batchStartTime = Date.now();
    console.error(`[INFO] Batch ${batchId}: processing ${pendingDocs.length} documents`);

    // Default images output directory
    const imagesBaseDir = resolve(state.config.defaultStoragePath, 'images');

    // FIX-P1-2: Process documents in parallel batches using max_concurrent
    const maxConcurrent = input.max_concurrent ?? 3;

    // Build shared processing params for the module-level processOneDocument function
    const processingParams: ProcessOneDocumentParams = {
      db,
      vector,
      generation,
      ocrMode,
      ocrOptions,
      pageSchema: input.page_schema,
      imagesBaseDir,
    };

    // Wrapper that handles per-document error tracking and cleanup
    const processDocWithTracking = async (doc: (typeof pendingDocs)[0]) => {
      try {
        await processOneDocument(doc, processingParams);
        results.processed++;
        successfulDocIds.push(doc.id);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Document ${doc.id} failed: ${errorMsg}`);

        // F-INTEG-1: Clean up partial derived data (orphaned chunks, embeddings)
        // before marking as failed, so a retry starts from a clean state.
        try {
          db.cleanDocumentDerivedData(doc.id);
          console.error(`[INFO] Cleaned partial data for failed document ${doc.id}`);
        } catch (cleanupError) {
          const cleanupMsg =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          console.error(`[WARN] Cleanup of partial data failed for ${doc.id}: ${cleanupMsg}`);
        }

        db.updateDocumentStatus(doc.id, 'failed', errorMsg);
        results.failed++;
        results.errors.push({ document_id: doc.id, error: errorMsg });
      }

      if (typeof global.gc === 'function') {
        global.gc();
      }
    };

    // FIX-P1-2: Execute documents in parallel batches
    for (let batchStart = 0; batchStart < pendingDocs.length; batchStart += maxConcurrent) {
      const batch = pendingDocs.slice(batchStart, batchStart + maxConcurrent);
      if (batch.length > 1) {
        console.error(
          `[INFO] Processing document batch ${Math.floor(batchStart / maxConcurrent) + 1}: ` +
            `${batch.length} documents (${batchStart + 1}-${batchStart + batch.length} of ${pendingDocs.length})`
        );
      }
      await Promise.allSettled(batch.map(processDocWithTracking));
    }

    // Get remaining count - CRITICAL: use 'status' not 'statusFilter'
    const remaining = db.listDocuments({ status: 'pending' }).length;

    // Auto-clustering check
    let autoClusterResult: Record<string, unknown> | undefined;
    const config = getConfig();
    if (config.autoClusterEnabled && results.processed > 0) {
      const totalDocs = (conn.prepare('SELECT COUNT(*) as cnt FROM documents WHERE status = ?').get('complete') as { cnt: number }).cnt;
      const threshold = config.autoClusterThreshold ?? 10;

      // Check if we have enough docs and no recent clustering run
      const lastCluster = conn.prepare('SELECT MAX(created_at) as latest FROM clusters').get() as { latest: string | null };
      const lastClusterDate = lastCluster?.latest ? new Date(lastCluster.latest) : null;
      const hoursSinceLastCluster = lastClusterDate ? (Date.now() - lastClusterDate.getTime()) / 3600000 : Infinity;

      if (totalDocs >= threshold && hoursSinceLastCluster > 1) {
        try {
          const { runClustering } = await import('../services/clustering/clustering-service.js');
          const algorithm = config.autoClusterAlgorithm ?? 'hdbscan';
          const clusterResult = await runClustering(db, vector, { algorithm, n_clusters: null, min_cluster_size: 3, distance_threshold: null, linkage: 'average' });
          autoClusterResult = { triggered: true, run_id: clusterResult.run_id, clusters: clusterResult.n_clusters, algorithm };
          console.error(`[Ingestion] Auto-clustering triggered: ${clusterResult.n_clusters} clusters via ${algorithm}`);
        } catch (e) {
          console.error(`[Ingestion] Auto-clustering failed: ${e instanceof Error ? e.message : String(e)}`);
          autoClusterResult = { triggered: true, error: e instanceof Error ? e.message : String(e) };
        }
      }
    }

    // Build response
    const response: Record<string, unknown> = {
      batch_id: batchId,
      batch_duration_ms: Date.now() - batchStartTime,
      processed: results.processed,
      failed: results.failed,
      remaining,
      errors: results.errors.length > 0 ? results.errors : undefined,
    };

    try {
      const totalDocCount = (
        db
          .getConnection()
          .prepare('SELECT COUNT(*) as cnt FROM documents WHERE status = ?')
          .get('complete') as { cnt: number }
      ).cnt;
      if (totalDocCount > 1) {
        response.next_steps = {
          auto_compare_hint:
            'Multiple documents available. Use ocr_document_compare to find differences between documents.',
          document_count: totalDocCount,
        };
      }
    } catch (error) {
      console.error(
        `[Ingestion] Failed to query document count for auto-compare hint: ${String(error)}`
      );
    }

    if (autoClusterResult) {
      response.auto_clustering = autoClusterResult;
    }

    return formatResponse(successResult(response));
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

      return formatResponse(
        successResult({
          documents: [
            {
              document_id: doc.id,
              file_name: doc.file_name,
              status: doc.status,
              page_count: doc.page_count,
              error_message: doc.error_message ?? undefined,
              created_at: doc.created_at,
            },
          ],
          summary: {
            total: 1,
            pending: doc.status === 'pending' ? 1 : 0,
            processing: doc.status === 'processing' ? 1 : 0,
            complete: doc.status === 'complete' ? 1 : 0,
            failed: doc.status === 'failed' ? 1 : 0,
          },
        })
      );
    }

    // Map filter values - CRITICAL: use 'status' not 'statusFilter' for listDocuments
    const statusFilter = input.status_filter ?? 'all';
    const filterMap: Record<string, 'pending' | 'processing' | 'complete' | 'failed' | undefined> =
      {
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

    return formatResponse(
      successResult({
        documents: documents.map((d) => ({
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
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_chunk_complete - Chunk and embed documents that completed OCR but have no chunks
 *
 * Picks up documents with status='complete' that were OCR'd but never chunked/embedded.
 *
 * LM-4 FIX: Now reads chunk_size and chunk_overlap_percent from user config
 * (state.config) instead of always using DEFAULT_CHUNKING_CONFIG. This ensures
 * consistency with handleProcessPending which already respects user config.
 */
export async function handleChunkComplete(
  _params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const { db, vector } = requireDatabase();

    const completeDocs = db.listDocuments({ status: 'complete', limit: 1000 });

    // LM-4 FIX: Use user-configured chunk settings from state, not DEFAULT_CHUNKING_CONFIG
    const chunkConfig: ChunkingConfig = {
      chunkSize: state.config.chunkSize,
      overlapPercent: state.config.chunkOverlapPercent,
      maxChunkSize: state.config.maxChunkSize,
    };

    const results = {
      processed: 0,
      skipped: 0,
      failed: 0,
      errors: [] as Array<{ document_id: string; error: string }>,
    };

    for (const doc of completeDocs) {
      try {
        if (db.hasChunksByDocumentId(doc.id)) {
          results.skipped++;
          continue;
        }

        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        if (!ocrResult) {
          results.skipped++;
          continue;
        }

        // Chunk the OCR text using hybrid section-aware chunker
        const pageOffsets = extractPageOffsetsFromText(ocrResult.extracted_text);
        const jsonBlocks = ocrResult.json_blocks ? JSON.parse(ocrResult.json_blocks) as Record<string, unknown> : null;
        const chunkResults = chunkHybridSectionAware(ocrResult.extracted_text, pageOffsets, jsonBlocks, chunkConfig);
        console.error(`[INFO] Chunking doc ${doc.id}: ${chunkResults.length} chunks`);

        // Store chunks with provenance (pass config for provenance metadata)
        const chunks = storeChunks(db, doc, ocrResult, chunkResults, chunkConfig);

        // Generate embeddings
        const embeddingService = new EmbeddingService();
        const documentInfo = {
          documentId: doc.id,
          filePath: doc.file_path,
          fileName: doc.file_name,
          fileHash: doc.file_hash,
          documentProvenanceId: doc.provenance_id,
        };

        const embedResult = await embeddingService.embedDocumentChunks(
          db,
          vector,
          chunks,
          documentInfo
        );
        if (!embedResult.success) {
          throw new Error(embedResult.error ?? 'Embedding generation failed');
        }

        console.error(
          `[INFO] Doc ${doc.id}: ${chunks.length} chunks, ${embedResult.embeddingIds.length} embeddings`
        );
        results.processed++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Chunk complete failed for ${doc.id}: ${errorMsg}`);
        results.failed++;
        results.errors.push({ document_id: doc.id, error: errorMsg });
      }
    }

    return formatResponse(
      successResult({
        processed: results.processed,
        skipped: results.skipped,
        failed: results.failed,
        errors: results.errors.length > 0 ? results.errors : undefined,
      })
    );
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
        return formatResponse(
          successResult({
            reset: 0,
            message: `Document ${input.document_id} is not in failed state (current: ${doc.status})`,
          })
        );
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

    return formatResponse(
      successResult({
        reset: resetCount,
        message: `Reset ${resetCount} failed document(s) to pending (derived data cleaned)`,
      })
    );
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
    const input = validateInput(
      z.object({
        file_path: z.string().min(1),
        ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
        max_pages: z.number().int().min(1).max(7000).optional(),
        page_range: z.string().optional(),
      }),
      params
    );

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

    return formatResponse(
      successResult({
        file_path: input.file_path,
        text_length: result.markdown.length,
        page_count: result.pageCount,
        markdown: result.markdown,
        metadata: result.metadata ?? {},
        quality_score: result.qualityScore,
        cost_cents: result.costCents,
        processing_duration_ms: result.durationMs,
      })
    );
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
 *
 * M-11 FIX: Previously called handleProcessPending() which uses atomic batch
 * claiming on ALL pending documents. If other documents were already pending,
 * the target document might not be claimed. Now directly claims and processes
 * only the target document via the module-level processOneDocument function.
 */
async function handleReprocess(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1),
        ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional(),
        skip_cache: z.boolean().default(true),
      }),
      params
    );
    const { db, vector, generation } = requireDatabase();

    if (!process.env.DATALAB_API_KEY) {
      throw new Error('DATALAB_API_KEY environment variable is required for OCR processing');
    }

    const doc = db.getDocument(input.document_id);
    if (!doc) throw documentNotFoundError(input.document_id);
    if (doc.status !== 'complete' && doc.status !== 'failed') {
      throw new Error(
        `Document status must be 'complete' or 'failed' to reprocess (current: ${doc.status})`
      );
    }

    // Save previous quality score for comparison
    const previousOCR = db.getOCRResultByDocumentId(doc.id);
    const previousQuality = previousOCR?.parse_quality_score ?? null;

    // Clean all derived data (chunks, embeddings, images, ocr_results, extractions)
    db.cleanDocumentDerivedData(doc.id);

    // M-11 FIX: Directly claim THIS document by setting status to 'processing'.
    // Previously set to 'pending' then called handleProcessPending() which batch-claims
    // from ALL pending documents -- a race condition if other documents are also pending.
    db.updateDocumentStatus(doc.id, 'processing');

    const ocrMode = input.ocr_mode ?? state.config.defaultOCRMode;
    const imagesBaseDir = resolve(state.config.defaultStoragePath, 'images');
    const startTime = Date.now();

    // Process the single document directly -- no batch claiming needed
    try {
      await processOneDocument(doc, {
        db,
        vector,
        generation,
        ocrMode,
        ocrOptions: {
          skipCache: input.skip_cache,
        },
        imagesBaseDir,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] Reprocess failed for document ${doc.id}: ${errorMsg}`);

      // Clean up partial data and mark as failed
      try {
        db.cleanDocumentDerivedData(doc.id);
      } catch (cleanupError) {
        console.error(
          `[WARN] Cleanup of partial data failed for ${doc.id}: ` +
            `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
      db.updateDocumentStatus(doc.id, 'failed', errorMsg);

      throw error;
    }

    // Get new quality score
    const newOCR = db.getOCRResultByDocumentId(doc.id);

    return formatResponse(
      successResult({
        document_id: doc.id,
        previous_quality: previousQuality,
        new_quality: newOCR?.parse_quality_score ?? null,
        quality_change:
          previousQuality !== null &&
          newOCR?.parse_quality_score !== null &&
          newOCR?.parse_quality_score !== undefined
            ? (newOCR.parse_quality_score - previousQuality).toFixed(2)
            : null,
        processing_duration_ms: Date.now() - startTime,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EMBED DOCUMENT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_reembed_document - Re-generate all embeddings for a document
 * without re-running OCR.
 *
 * Steps:
 * 1. Verify document exists and status='complete'
 * 2. Get all chunks for the document
 * 3. Delete existing chunk embeddings (embeddings table + vec_embeddings)
 * 4. Re-generate chunk embeddings via EmbeddingService
 * 5. If include_vlm=true, re-embed VLM descriptions for completed images
 * 6. Return counts
 */
async function handleReembedDocument(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(
      z.object({
        document_id: z.string().min(1).describe('Document ID to re-embed'),
        include_vlm: z
          .boolean()
          .default(true)
          .describe('Also re-embed VLM descriptions for images'),
      }),
      params
    );
    const { db, vector } = requireDatabase();

    // 1. Verify document exists and is complete
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }
    if (doc.status !== 'complete') {
      throw new Error(
        `Document must have status 'complete' to re-embed (current: ${doc.status})`
      );
    }

    const startTime = Date.now();

    // 2. Get all chunks for the document
    const chunks = db.getChunksByDocumentId(input.document_id);
    if (chunks.length === 0) {
      return formatResponse(
        successResult({
          document_id: input.document_id,
          chunks_reembedded: 0,
          vlm_reembedded: 0,
          total_embeddings: 0,
          message: 'No chunks found for this document',
        })
      );
    }

    // 3. Delete existing chunk embeddings from both embeddings table AND vec_embeddings
    // Must delete vec_embeddings FIRST since they reference embedding IDs
    vector.deleteVectorsByDocumentId(input.document_id);
    db.deleteEmbeddingsByDocumentId(input.document_id);

    // Reset chunk embedding status to 'pending'
    for (const chunk of chunks) {
      db.updateChunkEmbeddingStatus(chunk.id, 'pending');
    }

    // 4. Re-generate chunk embeddings via EmbeddingService
    const embeddingService = new EmbeddingService();
    const documentInfo = {
      documentId: doc.id,
      filePath: doc.file_path,
      fileName: doc.file_name,
      fileHash: doc.file_hash,
      documentProvenanceId: doc.provenance_id,
    };

    const embedResult = await embeddingService.embedDocumentChunks(
      db,
      vector,
      chunks,
      documentInfo
    );

    if (!embedResult.success) {
      throw new Error(embedResult.error ?? 'Embedding re-generation failed');
    }

    console.error(
      `[INFO] Re-embedded ${embedResult.embeddingIds.length} chunks for document ${doc.id} in ${embedResult.elapsedMs}ms`
    );

    // 5. Optionally re-embed VLM descriptions
    let vlmReembedded = 0;
    const vlmProvenanceIds: string[] = [];

    if (input.include_vlm) {
      // Import image operations to get images with VLM descriptions
      const conn = db.getConnection();
      const vlmImages = conn
        .prepare(
          `SELECT id, vlm_description, vlm_embedding_id, provenance_id, page_number,
                  extracted_path, format
           FROM images
           WHERE document_id = ? AND vlm_status = 'complete'
             AND vlm_description IS NOT NULL AND vlm_description != '[SKIPPED]'`
        )
        .all(input.document_id) as Array<{
        id: string;
        vlm_description: string;
        vlm_embedding_id: string | null;
        provenance_id: string | null;
        page_number: number;
        extracted_path: string | null;
        format: string | null;
      }>;

      for (const img of vlmImages) {
        try {
          // Delete old VLM embedding if exists
          if (img.vlm_embedding_id) {
            vector.deleteVector(img.vlm_embedding_id);
            conn
              .prepare('DELETE FROM embeddings WHERE id = ?')
              .run(img.vlm_embedding_id);
            // Null out the reference on the image
            conn
              .prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?')
              .run(img.id);
          }

          // Generate new embedding for VLM description
          const vlmEmbedResult = await embeddingService.embedSearchQuery(
            img.vlm_description
          );

          // Create EMBEDDING provenance (depth 4, parent = VLM_DESCRIPTION provenance)
          const embProvId = uuidv4();
          const now = new Date().toISOString();

          // Find VLM description provenance (depth 3) for this image
          const vlmProvRecords = conn
            .prepare(
              `SELECT id, parent_ids FROM provenance
               WHERE root_document_id = ? AND type = 'VLM_DESCRIPTION'
                 AND source_id = ?
               ORDER BY created_at DESC LIMIT 1`
            )
            .all(doc.provenance_id, img.provenance_id) as Array<{
            id: string;
            parent_ids: string;
          }>;

          const vlmProvId =
            vlmProvRecords.length > 0 ? vlmProvRecords[0].id : img.provenance_id;
          const existingParents = vlmProvRecords.length > 0
            ? (JSON.parse(vlmProvRecords[0].parent_ids) as string[])
            : [];
          const parentIds = [...existingParents, vlmProvId];

          db.insertProvenance({
            id: embProvId,
            type: ProvenanceType.EMBEDDING,
            created_at: now,
            processed_at: now,
            source_file_created_at: null,
            source_file_modified_at: null,
            source_type: 'EMBEDDING',
            source_path: null,
            source_id: vlmProvId,
            root_document_id: doc.provenance_id,
            location: { page_number: img.page_number },
            content_hash: computeHash(img.vlm_description),
            input_hash: computeHash(img.vlm_description),
            file_hash: doc.file_hash,
            processor: 'nomic-embed-text-v1.5',
            processor_version: '1.5.0',
            processing_params: {
              task_type: 'search_document',
              inference_mode: 'local',
              source: 'vlm_description_reembed',
            },
            processing_duration_ms: null,
            processing_quality_score: null,
            parent_id: vlmProvId,
            parent_ids: JSON.stringify(parentIds),
            chain_depth: 4,
            chain_path: JSON.stringify([
              'DOCUMENT',
              'OCR_RESULT',
              'IMAGE',
              'VLM_DESCRIPTION',
              'EMBEDDING',
            ]),
          });

          // Insert embedding record (matches VLM pipeline pattern)
          const embId = uuidv4();
          db.insertEmbedding({
            id: embId,
            chunk_id: null,
            image_id: img.id,
            extraction_id: null,
            document_id: doc.id,
            original_text: img.vlm_description,
            original_text_length: img.vlm_description.length,
            source_file_path: img.extracted_path ?? 'unknown',
            source_file_name: img.extracted_path?.split('/').pop() ?? 'vlm_description',
            source_file_hash: 'vlm_generated',
            page_number: img.page_number,
            page_range: null,
            character_start: 0,
            character_end: img.vlm_description.length,
            chunk_index: 0,
            total_chunks: 1,
            model_name: 'nomic-embed-text-v1.5',
            model_version: '1.5.0',
            task_type: 'search_document',
            inference_mode: 'local',
            gpu_device: 'cuda:0',
            provenance_id: embProvId,
            content_hash: computeHash(img.vlm_description),
            generation_duration_ms: null,
          });

          // Store vector
          vector.storeVector(embId, vlmEmbedResult);

          // Update image with new VLM embedding ID
          conn
            .prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?')
            .run(embId, img.id);

          vlmReembedded++;
          vlmProvenanceIds.push(embProvId);
        } catch (vlmError) {
          console.error(
            `[WARN] Failed to re-embed VLM description for image ${img.id}: ${vlmError instanceof Error ? vlmError.message : String(vlmError)}`
          );
          // Non-fatal: continue with remaining images
        }
      }
    }

    const totalEmbeddings = embedResult.embeddingIds.length + vlmReembedded;
    const durationMs = Date.now() - startTime;

    return formatResponse(
      successResult({
        document_id: input.document_id,
        chunks_reembedded: embedResult.embeddingIds.length,
        vlm_reembedded: vlmReembedded,
        total_embeddings: totalEmbeddings,
        provenance_ids: [
          ...embedResult.provenanceIds,
          ...vlmProvenanceIds,
        ],
        processing_duration_ms: durationMs,
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
 * Ingestion tools collection for MCP server registration
 */
export const ingestionTools: Record<string, ToolDefinition> = {
  ocr_ingest_directory: {
    description: 'Scan and ingest documents from a directory into the current database',
    inputSchema: {
      directory_path: z.string().min(1).describe('Path to directory to scan'),
      recursive: z.boolean().default(true).describe('Scan subdirectories'),
      file_types: z
        .array(z.string())
        .optional()
        .describe('File types to include (default: pdf, png, jpg, docx, etc.)'),
    },
    handler: handleIngestDirectory,
  },
  ocr_ingest_files: {
    description:
      'Ingest specific files into the current database. Supports local file paths and optional file URLs for Datalab direct URL processing.',
    inputSchema: {
      file_paths: z.array(z.string().min(1)).min(1).describe('Array of file paths to ingest'),
    },
    handler: handleIngestFiles,
  },
  ocr_process_pending: {
    description:
      'Process pending documents through OCR pipeline (OCR -> Chunk -> Embed -> Vector -> VLM). Optionally reassign to clusters after processing.',
    inputSchema: {
      max_concurrent: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe('Maximum concurrent OCR operations'),
      ocr_mode: z
        .enum(['fast', 'balanced', 'accurate'])
        .optional()
        .describe('OCR processing mode override'),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(7000)
        .optional()
        .describe('Maximum pages to process per document (Datalab limit: 7000)'),
      page_range: z
        .string()
        .regex(/^[0-9,\-\s]+$/)
        .optional()
        .describe('Specific pages to process, 0-indexed (e.g., "0-5,10")'),
      skip_cache: z.boolean().optional().describe('Force reprocessing, skip Datalab cache'),
      disable_image_extraction: z
        .boolean()
        .optional()
        .describe('Skip image extraction for text-only processing'),
      extras: z
        .array(
          z.enum([
            'track_changes',
            'chart_understanding',
            'extract_links',
            'table_row_bboxes',
            'infographic',
            'new_block_types',
          ])
        )
        .optional()
        .describe('Extra Datalab features to enable'),
      page_schema: z
        .string()
        .optional()
        .describe('JSON schema string for structured data extraction per page'),
      additional_config: z
        .record(z.unknown())
        .optional()
        .describe(
          'Additional Datalab config: keep_pageheader_in_output, keep_pagefooter_in_output, keep_spreadsheet_formatting'
        ),
    },
    handler: handleProcessPending,
  },
  ocr_status: {
    description: 'Get OCR processing status for documents',
    inputSchema: {
      document_id: z.string().optional().describe('Specific document ID to check'),
      status_filter: z
        .enum(['pending', 'processing', 'complete', 'failed', 'all'])
        .default('all')
        .describe('Filter by status'),
    },
    handler: handleOCRStatus,
  },
  ocr_chunk_complete: {
    description:
      "Chunk and embed documents that completed OCR but have no chunks yet. Fixes documents that were OCR'd but never chunked/embedded.",
    inputSchema: {},
    handler: handleChunkComplete,
  },
  ocr_retry_failed: {
    description: 'Reset failed documents back to pending status so they can be reprocessed',
    inputSchema: {
      document_id: z
        .string()
        .optional()
        .describe('Specific document ID to retry (omit to retry all failed)'),
    },
    handler: handleRetryFailed,
  },
  ocr_reprocess: {
    description: 'Reprocess a document with different OCR settings (cleans existing data first)',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to reprocess'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional().describe('OCR mode override'),
      skip_cache: z
        .boolean()
        .default(true)
        .describe('Skip Datalab cache (default: true for reprocessing)'),
    },
    handler: handleReprocess,
  },
  ocr_convert_raw: {
    description:
      'Convert a document via OCR and return raw results without storing in database. Quick one-off conversions.',
    inputSchema: {
      file_path: z.string().min(1).describe('Path to file to convert'),
      ocr_mode: z
        .enum(['fast', 'balanced', 'accurate'])
        .default('balanced')
        .describe('OCR processing mode'),
      max_pages: z.number().int().min(1).max(7000).optional().describe('Maximum pages to process'),
      page_range: z
        .string()
        .optional()
        .describe('Specific pages to process (0-indexed, e.g., "0-5,10")'),
    },
    handler: handleConvertRaw,
  },
  ocr_reembed_document: {
    description:
      'Re-generate all embeddings for a document without re-running OCR. Deletes existing embeddings and creates new ones with fresh provenance records.',
    inputSchema: {
      document_id: z.string().min(1).describe('Document ID to re-embed'),
      include_vlm: z
        .boolean()
        .default(true)
        .describe('Also re-embed VLM descriptions for images'),
    },
    handler: handleReembedDocument,
  },
};

/**
 * Batch OCR Processing Script
 *
 * Runs OCR processing directly without MCP timeout constraints.
 * Usage: npx tsx scripts/batch-process.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { DatabaseService } from '../src/services/storage/database/index.js';
import { VectorService } from '../src/services/storage/vector.js';
import { OCRProcessor } from '../src/services/ocr/processor.js';
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '../src/services/chunking/chunker.js';
import { EmbeddingService } from '../src/services/embedding/embedder.js';
import { ProvenanceTracker } from '../src/services/provenance/tracker.js';
import { ProvenanceType } from '../src/models/provenance.js';
import { computeHash } from '../src/utils/hash.js';
import { createVLMPipeline } from '../src/services/vlm/index.js';
import { ImageExtractor } from '../src/services/images/extractor.js';
import { v4 as uuidv4 } from 'uuid';
import { existsSync } from 'fs';
import type { Document, OCRResult } from '../src/models/document.js';
import type { Chunk, ChunkResult } from '../src/models/chunk.js';

const DATABASE_NAME = process.env.OCR_DATABASE || 'default';
const MAX_CONCURRENT = 1; // Process one at a time for stability
const SKIP_VLM = true; // Skip VLM to avoid timeout issues

/**
 * Store chunks in database with provenance records
 * (copied from ingestion.ts storeChunks helper)
 */
function storeChunks(
  db: DatabaseService,
  doc: Document,
  ocrResult: OCRResult,
  chunkResults: ChunkResult[]
): Chunk[] {
  const provenanceTracker = new ProvenanceTracker(db);
  const chunks: Chunk[] = [];

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
        chunk_size: DEFAULT_CHUNKING_CONFIG.chunkSize,
        overlap_percent: DEFAULT_CHUNKING_CONFIG.overlapPercent,
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

    // Retrieve the stored chunk to ensure all fields are populated
    const storedChunk = db.getChunk(chunkId);
    if (!storedChunk) {
      throw new Error(`Failed to retrieve stored chunk: ${chunkId}`);
    }
    chunks.push(storedChunk);
  }

  return chunks;
}

async function processDocument(
  db: DatabaseService,
  vector: VectorService,
  ocrProcessor: OCRProcessor,
  doc: Document,
  ocrMode: 'fast' | 'balanced' | 'accurate'
): Promise<{ success: boolean; error?: string }> {
  const startTime = Date.now();

  try {
    console.log(`[INFO] Processing document: ${doc.id} (${doc.file_name})`);

    // Check file exists
    if (!existsSync(doc.file_path)) {
      throw new Error(`File not found: ${doc.file_path}`);
    }

    // Step 1: OCR using OCRProcessor (handles status, provenance, storage internally)
    const processResult = await ocrProcessor.processDocument(doc.id, ocrMode);

    if (!processResult.success) {
      throw new Error(processResult.error ?? 'OCR processing failed');
    }

    // Get the OCR result for chunking
    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult) {
      throw new Error('OCR result not found after processing');
    }

    console.log(`[INFO] OCR complete: ${ocrResult.text_length} chars, ${ocrResult.page_count} pages`);

    // Step 1.5: Handle images from Datalab
    let imageCount = 0;
    if (processResult.images && Object.keys(processResult.images).length > 0) {
      console.log(`[INFO] Captured ${Object.keys(processResult.images).length} images from Datalab`);
      imageCount = Object.keys(processResult.images).length;
      // TODO: Save and store images if needed
    }

    // Step 1.6: File-based extraction fallback for DOCX
    if (imageCount === 0 && ImageExtractor.isSupported(doc.file_path)) {
      console.log(`[INFO] Running file-based extraction for ${doc.file_type}`);
      const extractor = new ImageExtractor();
      const extractedImages = await extractor.extractImages(doc.file_path, {
        outputDir: `${process.env.HOME || ''}/.ocr-provenance/images/${doc.id}`,
        minSize: 50,
        maxImages: 500,
      });
      if (extractedImages.length > 0) {
        console.log(`[INFO] File-based extraction: ${extractedImages.length} images`);
        imageCount = extractedImages.length;
        // TODO: Insert images into database
      }
    }

    // Step 2: Chunk text
    const chunkResults = chunkText(ocrResult.extracted_text, DEFAULT_CHUNKING_CONFIG);
    console.log(`[INFO] Chunking complete: ${chunkResults.length} chunks`);

    // Step 3: Store chunks with provenance
    const chunks = storeChunks(db, doc, ocrResult, chunkResults);
    console.log(`[INFO] Chunks stored: ${chunks.length}`);

    // Step 4: Generate embeddings
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

    console.log(`[INFO] Embeddings complete: ${embedResult.embeddingIds.length} embeddings in ${embedResult.elapsedMs}ms`);

    // Step 5: VLM processing (if images exist and not skipped)
    if (imageCount > 0 && !SKIP_VLM) {
      try {
        const vlmPipeline = createVLMPipeline(db, vector, {
          batchSize: 5,
          concurrency: 1,
          minConfidence: 0.5,
        });

        const vlmResult = await vlmPipeline.processDocument(doc.id);
        console.log(`[INFO] VLM complete: ${vlmResult.successful}/${vlmResult.total} images, ${vlmResult.totalTokens} tokens`);
      } catch (vlmError) {
        console.error(`[WARN] VLM failed (non-fatal): ${vlmError instanceof Error ? vlmError.message : String(vlmError)}`);
      }
    }

    // Step 6: Mark complete
    db.updateDocumentStatus(doc.id, 'complete');

    const elapsed = Date.now() - startTime;
    console.log(`[INFO] Document ${doc.id} complete in ${elapsed}ms`);

    return { success: true };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] Document ${doc.id} failed: ${errorMsg}`);
    db.updateDocumentStatus(doc.id, 'failed', errorMsg);
    return { success: false, error: errorMsg };
  }
}

async function main() {
  console.log('=== Batch OCR Processing ===');
  console.log(`Database: ${DATABASE_NAME}`);
  console.log(`Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`Skip VLM: ${SKIP_VLM}`);
  console.log('');

  // Initialize services
  const db = DatabaseService.open(DATABASE_NAME);
  const vector = new VectorService(db.getConnection());
  const ocrProcessor = new OCRProcessor(db, { timeout: 900000 }); // 15 min timeout

  // Reset failed documents to pending
  const failedDocs = db.listDocuments({ status: 'failed', limit: 1000 });
  console.log(`Resetting ${failedDocs.length} failed documents to pending...`);
  for (const doc of failedDocs) {
    db.updateDocumentStatus(doc.id, 'pending');
  }

  // Reset processing documents to pending (stale from previous run)
  const processingDocs = db.listDocuments({ status: 'processing', limit: 1000 });
  console.log(`Resetting ${processingDocs.length} processing documents to pending...`);
  for (const doc of processingDocs) {
    db.updateDocumentStatus(doc.id, 'pending');
  }

  // Check pending count
  let pending = db.listDocuments({ status: 'pending', limit: 1000 });
  console.log(`Pending documents: ${pending.length}`);

  let processed = 0;
  let failed = 0;

  while (pending.length > 0) {
    const batch = pending.slice(0, MAX_CONCURRENT);

    for (const doc of batch) {
      const result = await processDocument(db, vector, ocrProcessor, doc, 'balanced');
      if (result.success) {
        processed++;
      } else {
        failed++;
      }
    }

    // Get next batch
    pending = db.listDocuments({ status: 'pending', limit: 1000 });
    console.log(`\n[STATUS] Processed: ${processed}, Failed: ${failed}, Remaining: ${pending.length}\n`);
  }

  console.log('\n=== Processing Complete ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Total failed: ${failed}`);

  db.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

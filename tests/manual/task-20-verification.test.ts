/**
 * Task 20 Manual Verification Tests
 *
 * Tests the complete OCR -> Chunk -> Embed -> Vector pipeline
 * Uses real services, no mocks.
 *
 * Source of Truth Verification:
 * 1. Document status = 'complete'
 * 2. OCR result exists with extracted_text
 * 3. Chunks exist with correct count
 * 4. Embeddings exist with original_text
 * 5. Vectors in vec_embeddings
 * 6. Provenance chain depth 0->1->2->3
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

import { DatabaseService } from '../../src/services/storage/database/index.js';
import { VectorService } from '../../src/services/storage/vector.js';
import { OCRProcessor } from '../../src/services/ocr/processor.js';
import { EmbeddingService } from '../../src/services/embedding/embedder.js';
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '../../src/services/chunking/chunker.js';
import { ProvenanceTracker } from '../../src/services/provenance/tracker.js';
import { computeHash } from '../../src/utils/hash.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { v4 as uuidv4 } from 'uuid';

// Test timeout - processing can take time
const TEST_TIMEOUT = 120000;

describe('Task 20: Full Pipeline Verification', () => {
  let tempDir: string;
  let db: DatabaseService;
  let vector: VectorService;
  let testDocumentId: string;

  beforeAll(() => {
    // Create temp directory
    tempDir = mkdtempSync(resolve(tmpdir(), 'task20-verify-'));
    console.error(`\n[SETUP] Created temp directory: ${tempDir}`);

    // Create database with unique name (timestamp to avoid conflicts)
    db = DatabaseService.create(`task20-verify-${Date.now()}`, tempDir);
    vector = new VectorService(db.getConnection());
    console.error(`[SETUP] Database created: ${db.getPath()}`);
  });

  afterAll(() => {
    // Cleanup
    if (db) {
      db.close();
      console.error('[CLEANUP] Database closed');
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
      console.error('[CLEANUP] Temp directory removed');
    }
  });

  it('SETUP: Ingest test document', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('STEP 1: INGEST TEST DOCUMENT');
    console.error('='.repeat(80));

    // Use the bench test file
    const testFilePath = resolve('./data/bench/doc_0005.pdf');
    console.error(`[INPUT] Test file: ${testFilePath}`);

    // Verify file exists
    expect(existsSync(testFilePath)).toBe(true);

    // Create document record
    testDocumentId = uuidv4();
    const provenanceId = uuidv4();
    const now = new Date().toISOString();

    // Create document provenance (chain_depth=0)
    db.insertProvenance({
      id: provenanceId,
      type: 'DOCUMENT',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: testFilePath,
      source_id: null,
      root_document_id: provenanceId,
      location: null,
      content_hash: `sha256:pending-${testDocumentId}`,
      input_hash: null,
      file_hash: `sha256:pending-${testDocumentId}`,
      processor: 'file-scanner',
      processor_version: '1.0.0',
      processing_params: { test: true },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });

    // Insert document
    db.insertDocument({
      id: testDocumentId,
      file_path: testFilePath,
      file_name: 'doc_0005.pdf',
      file_hash: `sha256:pending-${testDocumentId}`,
      file_size: 1800,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: provenanceId,
      error_message: null,
      ocr_completed_at: null,
    });

    // Verify document created
    const doc = db.getDocument(testDocumentId);
    expect(doc).toBeDefined();
    expect(doc?.status).toBe('pending');

    console.error(`[OUTPUT] Document ID: ${testDocumentId}`);
    console.error(`[OUTPUT] Document status: ${doc?.status}`);
    console.error('STEP 1: PASSED\n');
  }, TEST_TIMEOUT);

  it('STEP 2: OCR Processing', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('STEP 2: OCR PROCESSING');
    console.error('='.repeat(80));

    const processor = new OCRProcessor(db);
    const result = await processor.processDocument(testDocumentId, 'fast');

    console.error(`[OUTPUT] OCR success: ${result.success}`);
    console.error(`[OUTPUT] Page count: ${result.pageCount}`);
    console.error(`[OUTPUT] Text length: ${result.textLength}`);
    console.error(`[OUTPUT] Duration: ${result.durationMs}ms`);

    if (!result.success) {
      console.error(`[ERROR] ${result.error}`);
    }

    expect(result.success).toBe(true);
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.textLength).toBeGreaterThan(0);

    // Verify OCR result in database
    const ocrResult = db.getOCRResultByDocumentId(testDocumentId);
    expect(ocrResult).toBeDefined();
    expect(ocrResult?.extracted_text.length).toBeGreaterThan(0);

    console.error(`[SOURCE OF TRUTH] OCR result ID: ${ocrResult?.id}`);
    console.error(`[SOURCE OF TRUTH] Extracted text length: ${ocrResult?.extracted_text.length}`);
    console.error('STEP 2: PASSED\n');
  }, TEST_TIMEOUT);

  it('STEP 3: Chunking', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('STEP 3: CHUNKING');
    console.error('='.repeat(80));

    const doc = db.getDocument(testDocumentId);
    expect(doc).toBeDefined();

    const ocrResult = db.getOCRResultByDocumentId(testDocumentId);
    expect(ocrResult).toBeDefined();

    // Chunk the text
    const chunkResults = chunkText(ocrResult!.extracted_text, DEFAULT_CHUNKING_CONFIG);
    console.error(`[OUTPUT] Chunks created: ${chunkResults.length}`);

    // Store chunks
    const provenanceTracker = new ProvenanceTracker(db);
    const chunks: Array<{ id: string }> = [];

    for (let i = 0; i < chunkResults.length; i++) {
      const cr = chunkResults[i];
      const chunkId = uuidv4();
      const textHash = computeHash(cr.text);

      // Create chunk provenance (chain_depth=2)
      const chunkProvId = provenanceTracker.createProvenance({
        type: ProvenanceType.CHUNK,
        source_type: 'CHUNKING',
        source_id: ocrResult!.provenance_id,
        root_document_id: doc!.provenance_id,
        content_hash: textHash,
        input_hash: ocrResult!.content_hash,
        file_hash: doc!.file_hash,
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
        },
      });

      db.insertChunk({
        id: chunkId,
        document_id: testDocumentId,
        ocr_result_id: ocrResult!.id,
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
        embedding_status: 'pending',
        embedded_at: null,
      });

      chunks.push({ id: chunkId });
    }

    // Verify chunks in database
    const storedChunks = db.getChunksByDocumentId(testDocumentId);
    console.error(`[SOURCE OF TRUTH] Chunks in database: ${storedChunks.length}`);

    expect(storedChunks.length).toBe(chunkResults.length);
    expect(storedChunks.length).toBeGreaterThan(0);

    // Verify first chunk
    const firstChunk = storedChunks[0];
    console.error(`[SOURCE OF TRUTH] First chunk ID: ${firstChunk.id}`);
    console.error(`[SOURCE OF TRUTH] First chunk text length: ${firstChunk.text.length}`);
    console.error(`[SOURCE OF TRUTH] First chunk status: ${firstChunk.embedding_status}`);

    expect(firstChunk.embedding_status).toBe('pending');
    console.error('STEP 3: PASSED\n');
  }, TEST_TIMEOUT);

  it('STEP 4: Embedding Generation', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('STEP 4: EMBEDDING GENERATION');
    console.error('='.repeat(80));

    const doc = db.getDocument(testDocumentId);
    expect(doc).toBeDefined();

    const chunks = db.getChunksByDocumentId(testDocumentId);
    expect(chunks.length).toBeGreaterThan(0);

    const embeddingService = new EmbeddingService();
    const documentInfo = {
      documentId: testDocumentId,
      filePath: doc!.file_path,
      fileName: doc!.file_name,
      fileHash: doc!.file_hash,
      documentProvenanceId: doc!.provenance_id,
    };

    const result = await embeddingService.embedDocumentChunks(db, vector, chunks, documentInfo);

    console.error(`[OUTPUT] Embedding success: ${result.success}`);
    console.error(`[OUTPUT] Embeddings created: ${result.embeddingIds.length}`);
    console.error(`[OUTPUT] Provenance records: ${result.provenanceIds.length}`);
    console.error(`[OUTPUT] Duration: ${result.elapsedMs}ms`);

    expect(result.success).toBe(true);
    expect(result.embeddingIds.length).toBe(chunks.length);

    // Verify embeddings in database
    const embeddings = db.getEmbeddingsByDocumentId(testDocumentId);
    console.error(`[SOURCE OF TRUTH] Embeddings in database: ${embeddings.length}`);

    expect(embeddings.length).toBe(chunks.length);

    // Verify first embedding has original_text (CP-002)
    const firstEmbedding = embeddings[0];
    console.error(`[SOURCE OF TRUTH] First embedding ID: ${firstEmbedding.id}`);
    console.error(`[SOURCE OF TRUTH] Has original_text: ${firstEmbedding.original_text.length > 0}`);
    console.error(`[SOURCE OF TRUTH] Model: ${firstEmbedding.model_name}`);

    expect(firstEmbedding.original_text.length).toBeGreaterThan(0);
    expect(firstEmbedding.model_name).toBe('nomic-embed-text-v1.5');

    // Verify vectors in vec_embeddings
    const vectorCount = vector.getVectorCount();
    console.error(`[SOURCE OF TRUTH] Vectors in vec_embeddings: ${vectorCount}`);

    expect(vectorCount).toBe(chunks.length);

    // Verify chunk status updated
    const updatedChunks = db.getChunksByDocumentId(testDocumentId);
    const allComplete = updatedChunks.every(c => c.embedding_status === 'complete');
    console.error(`[SOURCE OF TRUTH] All chunks status=complete: ${allComplete}`);

    expect(allComplete).toBe(true);
    console.error('STEP 4: PASSED\n');
  }, TEST_TIMEOUT);

  it('STEP 5: Mark Document Complete', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('STEP 5: MARK DOCUMENT COMPLETE');
    console.error('='.repeat(80));

    db.updateDocumentStatus(testDocumentId, 'complete');

    const doc = db.getDocument(testDocumentId);
    console.error(`[SOURCE OF TRUTH] Document status: ${doc?.status}`);

    expect(doc?.status).toBe('complete');
    console.error('STEP 5: PASSED\n');
  }, TEST_TIMEOUT);

  it('VERIFICATION: Provenance Chain (depth 0->1->2->3)', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('VERIFICATION: PROVENANCE CHAIN');
    console.error('='.repeat(80));

    // Get an embedding and trace its chain
    const embeddings = db.getEmbeddingsByDocumentId(testDocumentId);
    expect(embeddings.length).toBeGreaterThan(0);

    const embedding = embeddings[0];
    const chain = db.getProvenanceChain(embedding.provenance_id);

    console.error(`[CHAIN] Total records in chain: ${chain.length}`);

    for (const record of chain) {
      console.error(`  [depth=${record.chain_depth}] ${record.type} - ${record.id}`);
    }

    // Verify chain structure
    expect(chain.length).toBe(4);

    // Chain should be ordered from current (EMBEDDING) to root (DOCUMENT)
    expect(chain[0].type).toBe('EMBEDDING');
    expect(chain[0].chain_depth).toBe(3);

    expect(chain[1].type).toBe('CHUNK');
    expect(chain[1].chain_depth).toBe(2);

    expect(chain[2].type).toBe('OCR_RESULT');
    expect(chain[2].chain_depth).toBe(1);

    expect(chain[3].type).toBe('DOCUMENT');
    expect(chain[3].chain_depth).toBe(0);

    console.error('[SOURCE OF TRUTH] Provenance chain verified: EMBEDDING(3) -> CHUNK(2) -> OCR_RESULT(1) -> DOCUMENT(0)');
    console.error('VERIFICATION: PASSED\n');
  }, TEST_TIMEOUT);

  it('VERIFICATION: Vector Search Works', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('VERIFICATION: VECTOR SEARCH');
    console.error('='.repeat(80));

    const embeddingService = new EmbeddingService();

    // Search for content
    const queryVector = await embeddingService.embedSearchQuery('test document');
    const results = vector.searchSimilar(queryVector, { limit: 5 });

    console.error(`[OUTPUT] Search results: ${results.length}`);

    expect(results.length).toBeGreaterThan(0);

    // Verify result has original_text (CP-002)
    const firstResult = results[0];
    console.error(`[SOURCE OF TRUTH] First result embedding_id: ${firstResult.embedding_id}`);
    console.error(`[SOURCE OF TRUTH] First result has original_text: ${firstResult.original_text.length > 0}`);
    console.error(`[SOURCE OF TRUTH] First result similarity: ${firstResult.similarity_score.toFixed(4)}`);

    expect(firstResult.original_text.length).toBeGreaterThan(0);
    expect(firstResult.source_file_path).toBeDefined();
    console.error('VERIFICATION: PASSED\n');
  }, TEST_TIMEOUT);

  it('EDGE CASE: No Pending Documents', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('EDGE CASE: NO PENDING DOCUMENTS');
    console.error('='.repeat(80));

    // Verify no pending documents
    const pendingDocs = db.listDocuments({ status: 'pending' });
    console.error(`[SOURCE OF TRUTH] Pending documents: ${pendingDocs.length}`);

    expect(pendingDocs.length).toBe(0);
    console.error('EDGE CASE: PASSED\n');
  }, TEST_TIMEOUT);

  it('SUMMARY: All Source of Truth Verification', async () => {
    console.error('\n' + '='.repeat(80));
    console.error('FINAL SUMMARY');
    console.error('='.repeat(80));

    const doc = db.getDocument(testDocumentId);
    const ocrResult = db.getOCRResultByDocumentId(testDocumentId);
    const chunks = db.getChunksByDocumentId(testDocumentId);
    const embeddings = db.getEmbeddingsByDocumentId(testDocumentId);
    const vectorCount = vector.getVectorCount();
    const stats = db.getStats();

    console.error(`
┌─────────────────────────────────────────────────────────────────┐
│ SOURCE OF TRUTH VERIFICATION                                     │
├─────────────────────────────────────────────────────────────────┤
│ Document ID:     ${testDocumentId}     │
│ Document Status: ${doc?.status}                                            │
│ OCR Text Length: ${ocrResult?.extracted_text.length} chars                                  │
│ Chunk Count:     ${chunks.length}                                              │
│ Embedding Count: ${embeddings.length}                                              │
│ Vector Count:    ${vectorCount}                                              │
├─────────────────────────────────────────────────────────────────┤
│ DATABASE STATS                                                   │
│ Total Documents: ${stats.total_documents}                                              │
│ Total Chunks:    ${stats.total_chunks}                                              │
│ Total Embeddings:${stats.total_embeddings}                                              │
│ Pending:         ${stats.documents_by_status.pending}                                              │
│ Complete:        ${stats.documents_by_status.complete}                                              │
│ Failed:          ${stats.documents_by_status.failed}                                              │
└─────────────────────────────────────────────────────────────────┘
`);

    // Final assertions
    expect(doc?.status).toBe('complete');
    expect(ocrResult).toBeDefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(embeddings.length).toBe(chunks.length);
    expect(vectorCount).toBe(chunks.length);

    console.error('ALL VERIFICATIONS PASSED\n');
  }, TEST_TIMEOUT);
});

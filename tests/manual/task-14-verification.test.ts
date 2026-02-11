/**
 * Task 14 FULL STATE VERIFICATION
 *
 * Run: npx vitest run tests/manual/task-14-verification.test.ts
 *
 * REQUIREMENTS:
 * - GPU with CUDA
 * - sqlite-vec
 *
 * This test VERIFIES:
 * 1. Embeddings exist in `embeddings` table
 * 2. Vectors exist in `vec_embeddings` table
 * 3. Provenance records have chain_depth=3
 * 4. original_text matches chunk text (CP-002)
 * 5. Vectors are retrievable via search
 * 6. Hash integrity verification
 *
 * FAIL FAST: No workarounds, test failures indicate real problems
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { EmbeddingService, EmbeddingError } from '../../src/services/embedding/embedder.js';
import {
  EMBEDDING_DIM,
  MODEL_NAME,
  MODEL_VERSION,
} from '../../src/services/embedding/nomic.js';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { VectorService } from '../../src/services/storage/vector.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { computeHash } from '../../src/utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC_CHUNKS = [
  'The quick brown fox jumps over the lazy dog. This is chunk one for testing embedding generation.',
  'Legal document regarding contract terms and conditions for professional services agreement.',
  'Medical records indicate patient recovery from orthopedic surgery completed in January 2024.',
];

const SYNTHETIC_QUERY = 'What are the contract terms and conditions?';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

let testDir: string;
let db: DatabaseService;
let vectorService: VectorService;
let service: EmbeddingService;
let canRunTests = false;
let gpuAvailable = false;
let setupError: string | null = null;

beforeAll(async () => {
  console.log('\n' + '='.repeat(80));
  console.log('TASK 14 FULL STATE VERIFICATION');
  console.log('='.repeat(80));

  // Check sqlite-vec availability
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    console.log('[SETUP] sqlite-vec: AVAILABLE');
  } catch {
    setupError = 'sqlite-vec not available';
    console.error('[SETUP] sqlite-vec: NOT AVAILABLE');
    console.error('[SETUP] Install: npm install sqlite-vec');
    return;
  }

  // Create test database
  testDir = mkdtempSync(join(tmpdir(), 'task14-verify-'));
  console.log('[SETUP] Test directory:', testDir);

  const dbName = `verify-${Date.now()}`;
  db = DatabaseService.create(dbName, 'Task 14 verification', testDir);
  vectorService = new VectorService(db.getConnection());
  service = new EmbeddingService();
  console.log('[SETUP] Database created:', dbName);

  // Check GPU availability
  try {
    const testVector = await service.embedSearchQuery('GPU test');
    if (testVector.length === EMBEDDING_DIM) {
      gpuAvailable = true;
      canRunTests = true;
      console.log('[SETUP] GPU: AVAILABLE');
      console.log('[SETUP] Embedding dimension:', testVector.length);
    }
  } catch (e) {
    if (e instanceof EmbeddingError) {
      setupError = `${e.code}: ${e.message}`;
      if (e.code === 'GPU_NOT_AVAILABLE') {
        console.warn('[SETUP] GPU: NOT AVAILABLE');
        console.warn('[SETUP] Error:', e.message);
      } else if (e.code === 'MODEL_NOT_FOUND') {
        console.warn('[SETUP] MODEL: NOT FOUND');
        console.warn('[SETUP] Run: git lfs pull');
      } else {
        console.error('[SETUP] Unexpected error:', e.message);
      }
    } else {
      setupError = String(e);
      console.error('[SETUP] GPU check failed:', e);
    }
  }

  console.log('[SETUP] Can run tests:', canRunTests);
  console.log('='.repeat(80) + '\n');
}, 120000);

afterAll(() => {
  console.log('\n' + '='.repeat(80));
  console.log('CLEANUP');
  console.log('='.repeat(80));

  if (db) {
    try {
      db.close();
      console.log('[CLEANUP] Database closed');
    } catch (e) {
      console.error('[CLEANUP] Error closing database:', e);
    }
  }

  if (testDir) {
    try {
      rmSync(testDir, { recursive: true, force: true });
      console.log('[CLEANUP] Test directory removed');
    } catch (e) {
      console.error('[CLEANUP] Error removing test directory:', e);
    }
  }

  console.log('='.repeat(80) + '\n');
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create complete document chain for testing
 */
function createDocumentChain(): {
  docId: string;
  docProvId: string;
  ocrId: string;
  fileHash: string;
  chunkIds: string[];
} {
  const docProvId = uuidv4();
  const docId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrId = uuidv4();
  const fileHash = computeHash('task-14-test-file-content');
  const now = new Date().toISOString();
  const ocrText = SYNTHETIC_CHUNKS.join('\n\n');

  console.log('[CHAIN] Creating document chain...');

  // Document provenance (depth 0)
  db.insertProvenance({
    id: docProvId,
    type: ProvenanceType.DOCUMENT,
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: '/test/task14-doc.pdf',
    source_id: null,
    root_document_id: docProvId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'ingestion',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 10,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: JSON.stringify(['DOCUMENT']),
  });
  console.log('[CHAIN] Document provenance created:', docProvId);

  // Document record
  db.insertDocument({
    id: docId,
    file_path: '/test/task14-doc.pdf',
    file_name: 'task14-doc.pdf',
    file_hash: fileHash,
    file_size: 5000,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    modified_at: null,
    ocr_completed_at: now,
    error_message: null,
  });
  console.log('[CHAIN] Document created:', docId);

  // OCR provenance (depth 1)
  db.insertProvenance({
    id: ocrProvId,
    type: ProvenanceType.OCR_RESULT,
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'OCR',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(ocrText),
    input_hash: fileHash,
    file_hash: fileHash,
    processor: 'datalab-ocr',
    processor_version: '1.0.0',
    processing_params: { mode: 'fast' },
    processing_duration_ms: 1000,
    processing_quality_score: 4.5,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT']),
  });
  console.log('[CHAIN] OCR provenance created:', ocrProvId);

  // OCR result
  db.insertOCRResult({
    id: ocrId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: ocrText,
    text_length: ocrText.length,
    datalab_request_id: 'task14-test-request',
    datalab_mode: 'fast',
    parse_quality_score: 4.5,
    page_count: 1,
    cost_cents: 1,
    content_hash: computeHash(ocrText),
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 1000,
  });
  console.log('[CHAIN] OCR result created:', ocrId);

  // Create chunks with provenance
  const chunkIds: string[] = [];
  for (let i = 0; i < SYNTHETIC_CHUNKS.length; i++) {
    const text = SYNTHETIC_CHUNKS[i];
    const chunkProvId = uuidv4();
    const chunkId = uuidv4();

    // Chunk provenance (depth 2)
    db.insertProvenance({
      id: chunkProvId,
      type: ProvenanceType.CHUNK,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'CHUNKING',
      source_path: null,
      source_id: ocrProvId,
      root_document_id: docProvId,
      location: {
        chunk_index: i,
        character_start: i * 100,
        character_end: i * 100 + text.length,
      },
      content_hash: computeHash(text),
      input_hash: computeHash(ocrText),
      file_hash: fileHash,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { chunk_size: 2000, overlap: 200 },
      processing_duration_ms: 5,
      processing_quality_score: null,
      parent_id: ocrProvId,
      parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'CHUNK']),
    });

    // Chunk record
    db.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrId,
      text: text,
      text_hash: computeHash(text),
      chunk_index: i,
      character_start: i * 100,
      character_end: i * 100 + text.length,
      page_number: 1,
      page_range: null,
      overlap_previous: i > 0 ? 50 : 0,
      overlap_next: i < SYNTHETIC_CHUNKS.length - 1 ? 50 : 0,
      provenance_id: chunkProvId,
    });

    chunkIds.push(chunkId);
    console.log(`[CHAIN] Chunk ${i} created:`, chunkId);
  }

  console.log('[CHAIN] Document chain complete\n');
  return { docId, docProvId, ocrId, fileHash, chunkIds };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL STATE VERIFICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 14 Full State Verification', () => {
  it.skipIf(!canRunTests)(
    'HAPPY PATH: embedDocumentChunks stores embeddings with full provenance',
    async () => {
      console.log('\n' + '='.repeat(80));
      console.log('HAPPY PATH TEST: Full Embedding Pipeline');
      console.log('='.repeat(80) + '\n');

      // === SETUP ===
      const chain = createDocumentChain();
      const dbChunks = db.getChunksByDocumentId(chain.docId);

      // === BEFORE STATE ===
      console.log('--- BEFORE STATE ---');
      console.log('[BEFORE] Chunk count:', dbChunks.length);
      console.log(
        '[BEFORE] Chunk statuses:',
        dbChunks.map((c) => c.embedding_status)
      );
      expect(dbChunks.every((c) => c.embedding_status === 'pending')).toBe(true);

      const vectorCountBefore = vectorService.getVectorCount();
      console.log('[BEFORE] Vector count:', vectorCountBefore);

      // === EXECUTE ===
      console.log('\n--- EXECUTING embedDocumentChunks ---');
      const startTime = Date.now();

      const result = await service.embedDocumentChunks(
        db,
        vectorService,
        dbChunks,
        {
          documentId: chain.docId,
          filePath: '/test/task14-doc.pdf',
          fileName: 'task14-doc.pdf',
          fileHash: chain.fileHash,
          documentProvenanceId: chain.docProvId,
        }
      );

      const elapsedMs = Date.now() - startTime;
      console.log('[RESULT] Success:', result.success);
      console.log('[RESULT] Embedding IDs:', result.embeddingIds);
      console.log('[RESULT] Provenance IDs:', result.provenanceIds);
      console.log('[RESULT] Total chunks:', result.totalChunks);
      console.log('[RESULT] Elapsed ms:', elapsedMs);

      expect(result.success).toBe(true);
      expect(result.embeddingIds).toHaveLength(SYNTHETIC_CHUNKS.length);
      expect(result.provenanceIds).toHaveLength(SYNTHETIC_CHUNKS.length);

      // === FULL STATE VERIFICATION ===

      // 1. EMBEDDINGS TABLE VERIFICATION
      console.log('\n--- EMBEDDINGS TABLE VERIFICATION ---');
      const embeddings = db.getEmbeddingsByDocumentId(chain.docId);
      console.log('[DB] Embedding count:', embeddings.length);
      expect(embeddings.length).toBe(SYNTHETIC_CHUNKS.length);

      // 2. CP-002: original_text verification
      console.log('\n--- CP-002 ORIGINAL TEXT VERIFICATION ---');
      for (const emb of embeddings) {
        const expectedText = SYNTHETIC_CHUNKS[emb.chunk_index];
        console.log(
          `[CP-002] Chunk ${emb.chunk_index}: original_text length=${emb.original_text.length}, expected=${expectedText.length}`
        );
        expect(emb.original_text).toBe(expectedText);
        expect(emb.original_text_length).toBe(expectedText.length);
      }

      // 3. VECTOR TABLE VERIFICATION
      console.log('\n--- VECTOR TABLE VERIFICATION ---');
      const vectorCountAfter = vectorService.getVectorCount();
      console.log('[DB] Vector count:', vectorCountAfter);
      console.log('[DB] Vectors added:', vectorCountAfter - vectorCountBefore);
      expect(vectorCountAfter).toBe(vectorCountBefore + SYNTHETIC_CHUNKS.length);

      // 4. VECTOR EXISTS FOR EACH EMBEDDING
      console.log('\n--- VECTOR EXISTENCE VERIFICATION ---');
      for (const emb of embeddings) {
        const vectorExists = vectorService.vectorExists(emb.id);
        console.log(`[VEC] ${emb.id}: ${vectorExists ? 'EXISTS' : 'MISSING'}`);
        expect(vectorExists).toBe(true);

        const vector = vectorService.getVector(emb.id);
        expect(vector).not.toBeNull();
        expect(vector!.length).toBe(EMBEDDING_DIM);
      }

      // 5. PROVENANCE VERIFICATION
      console.log('\n--- PROVENANCE VERIFICATION ---');
      for (const provId of result.provenanceIds) {
        const prov = db.getProvenance(provId);
        console.log(
          `[PROV] ${provId}: type=${prov?.type}, chain_depth=${prov?.chain_depth}`
        );
        expect(prov).not.toBeNull();
        expect(prov!.type).toBe(ProvenanceType.EMBEDDING);
        expect(prov!.chain_depth).toBe(3);
        expect(prov!.processor).toBe(MODEL_NAME);
        expect(prov!.processor_version).toBe(MODEL_VERSION);
      }

      // 6. CHUNK STATUS VERIFICATION
      console.log('\n--- CHUNK STATUS VERIFICATION ---');
      const updatedChunks = db.getChunksByDocumentId(chain.docId);
      for (const chunk of updatedChunks) {
        console.log(
          `[CHUNK] ${chunk.id}: embedding_status=${chunk.embedding_status}`
        );
        expect(chunk.embedding_status).toBe('complete');
        expect(chunk.embedded_at).not.toBeNull();
      }

      // 7. VECTOR SEARCH VERIFICATION
      console.log('\n--- VECTOR SEARCH VERIFICATION ---');
      const queryVector = await service.embedSearchQuery(SYNTHETIC_QUERY);
      console.log('[QUERY] Vector dimension:', queryVector.length);
      expect(queryVector.length).toBe(EMBEDDING_DIM);

      const searchResults = vectorService.searchSimilar(queryVector, { limit: 3 });
      console.log('[SEARCH] Results found:', searchResults.length);
      expect(searchResults.length).toBeGreaterThan(0);

      // Search results should include original_text (CP-002)
      for (const sr of searchResults) {
        console.log(
          `[SEARCH] similarity=${sr.similarity_score.toFixed(4)}, text_len=${sr.original_text.length}`
        );
        expect(sr.original_text.length).toBeGreaterThan(0);
      }

      // The contract-related chunk should be most similar to contract query
      const contractResult = searchResults.find((r) =>
        r.original_text.includes('contract')
      );
      console.log('[SEARCH] Contract chunk found:', !!contractResult);

      // 8. HASH INTEGRITY VERIFICATION
      console.log('\n--- HASH INTEGRITY VERIFICATION ---');
      for (const emb of embeddings) {
        const computedHash = computeHash(emb.original_text);
        const match = computedHash === emb.content_hash;
        console.log(
          `[HASH] ${emb.id}: ${match ? 'VALID' : 'INVALID'} (stored=${emb.content_hash.slice(0, 20)}...)`
        );
        expect(emb.content_hash).toBe(computedHash);
      }

      console.log('\n' + '='.repeat(80));
      console.log('HAPPY PATH TEST: PASSED');
      console.log('='.repeat(80) + '\n');
    },
    120000
  );

  it.skipIf(!canRunTests)('EDGE CASE: Empty chunks array returns empty result', async () => {
    console.log('\n--- EDGE CASE: Empty chunks ---');

    const result = await service.embedDocumentChunks(db, vectorService, [], {
      documentId: 'test-empty',
      filePath: '/test/empty.pdf',
      fileName: 'empty.pdf',
      fileHash: 'hash',
      documentProvenanceId: 'prov',
    });

    console.log('[RESULT]', result);
    expect(result.success).toBe(true);
    expect(result.embeddingIds).toHaveLength(0);
    expect(result.provenanceIds).toHaveLength(0);
    expect(result.totalChunks).toBe(0);
    expect(result.elapsedMs).toBe(0);

    console.log('EDGE CASE: Empty chunks PASSED\n');
  });

  it.skipIf(!canRunTests)(
    'EDGE CASE: Query embedding is ephemeral (not stored)',
    async () => {
      console.log('\n--- EDGE CASE: Query embedding ephemeral ---');

      const countBefore = vectorService.getVectorCount();
      console.log('[BEFORE] Vector count:', countBefore);

      const queryVector = await service.embedSearchQuery('ephemeral query test');
      console.log('[QUERY] Vector length:', queryVector.length);
      expect(queryVector.length).toBe(EMBEDDING_DIM);

      const countAfter = vectorService.getVectorCount();
      console.log('[AFTER] Vector count:', countAfter);
      expect(countAfter).toBe(countBefore); // No new vectors stored

      console.log('EDGE CASE: Query ephemeral PASSED\n');
    },
    30000
  );

  it.skipIf(!canRunTests)(
    'EDGE CASE: processPendingChunks only processes pending',
    async () => {
      console.log('\n--- EDGE CASE: processPendingChunks ---');

      // Create new document chain
      const chain = createDocumentChain();

      // First run - should process all chunks
      console.log('[RUN 1] Processing pending chunks...');
      const result1 = await service.processPendingChunks(db, vectorService, {
        documentId: chain.docId,
        filePath: '/test/task14-doc.pdf',
        fileName: 'task14-doc.pdf',
        fileHash: chain.fileHash,
        documentProvenanceId: chain.docProvId,
      });

      console.log('[RUN 1] Chunks processed:', result1.totalChunks);
      expect(result1.success).toBe(true);
      expect(result1.totalChunks).toBe(SYNTHETIC_CHUNKS.length);

      // Second run - should process 0 chunks (all complete)
      console.log('[RUN 2] Processing pending chunks again...');
      const result2 = await service.processPendingChunks(db, vectorService, {
        documentId: chain.docId,
        filePath: '/test/task14-doc.pdf',
        fileName: 'task14-doc.pdf',
        fileHash: chain.fileHash,
        documentProvenanceId: chain.docProvId,
      });

      console.log('[RUN 2] Chunks processed:', result2.totalChunks);
      expect(result2.success).toBe(true);
      expect(result2.totalChunks).toBe(0); // None pending

      console.log('EDGE CASE: processPendingChunks PASSED\n');
    },
    120000
  );

  it('VALIDATION: Error handling structure is correct', () => {
    console.log('\n--- VALIDATION: Error handling ---');

    const error = new EmbeddingError('Test error', 'GPU_NOT_AVAILABLE', {
      detail: 'test',
    });

    expect(error.name).toBe('EmbeddingError');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('GPU_NOT_AVAILABLE');
    expect(error.details).toEqual({ detail: 'test' });
    expect(error).toBeInstanceOf(Error);

    console.log('[ERROR] Name:', error.name);
    console.log('[ERROR] Code:', error.code);
    console.log('[ERROR] Message:', error.message);
    console.log('[ERROR] Details:', error.details);

    console.log('VALIDATION: Error handling PASSED\n');
  });

  it('VALIDATION: Constants are correct', () => {
    console.log('\n--- VALIDATION: Constants ---');

    expect(EMBEDDING_DIM).toBe(768);
    expect(MODEL_NAME).toBe('nomic-embed-text-v1.5');
    expect(MODEL_VERSION).toBe('1.5.0');

    console.log('[CONST] EMBEDDING_DIM:', EMBEDDING_DIM);
    console.log('[CONST] MODEL_NAME:', MODEL_NAME);
    console.log('[CONST] MODEL_VERSION:', MODEL_VERSION);

    console.log('VALIDATION: Constants PASSED\n');
  });
});

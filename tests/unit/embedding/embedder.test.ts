/**
 * EmbeddingService Tests
 *
 * Tests for the embedding orchestration service.
 * Uses REAL database and REAL GPU - NO MOCKS. FAIL FAST if unavailable.
 *
 * Tests verify:
 * - Embeddings stored in database with original_text (CP-002)
 * - Vectors stored in vec_embeddings
 * - Provenance records created with chain_depth=3
 * - Chunk status updated to 'complete'
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { EmbeddingService } from '../../../src/services/embedding/embedder.js';
import { EMBEDDING_DIM, MODEL_NAME, MODEL_VERSION } from '../../../src/services/embedding/nomic.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { VectorService } from '../../../src/services/storage/vector.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';

// Require sqlite-vec at module level - fail fast if unavailable
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('sqlite-vec');

let testDir: string;
let db: DatabaseService;
let vectorService: VectorService;
let service: EmbeddingService;

beforeAll(async () => {
  // Create temp directory for test database
  testDir = mkdtempSync(join(tmpdir(), 'emb-test-'));
  const dbName = `embedder-test-${Date.now()}`;
  db = DatabaseService.create(dbName, undefined, testDir);
  vectorService = new VectorService(db.getConnection());
  service = new EmbeddingService();

  // Verify GPU is available - fail fast if not
  const testVector = await service.embedSearchQuery('GPU availability test');
  if (testVector.length !== EMBEDDING_DIM) {
    throw new Error('GPU check failed: unexpected embedding dimensions');
  }
  console.log('[GPU] Available for integration tests');
}, 60000);

afterAll(() => {
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
  }
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a complete document chain for testing
 * Returns all IDs needed for embedding
 */
function createTestDocumentChain(
  db: DatabaseService,
  chunkTexts: string[]
): {
  docId: string;
  docProvId: string;
  ocrId: string;
  ocrProvId: string;
  chunks: Array<{
    id: string;
    provId: string;
    text: string;
  }>;
} {
  const docProvId = uuidv4();
  const docId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrId = uuidv4();
  const fileHash = computeHash('test-file-content-' + Date.now());
  const now = new Date().toISOString();

  // Create document provenance (depth 0)
  db.insertProvenance({
    id: docProvId,
    type: ProvenanceType.DOCUMENT,
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: '/test/doc.pdf',
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

  // Create document
  db.insertDocument({
    id: docId,
    file_path: '/test/doc.pdf',
    file_name: 'doc.pdf',
    file_hash: fileHash,
    file_size: 1000,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    modified_at: null,
    ocr_completed_at: now,
    error_message: null,
  });

  // Create OCR provenance (depth 1)
  const ocrText = chunkTexts.join('\n\n');
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

  // Create OCR result
  db.insertOCRResult({
    id: ocrId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: ocrText,
    text_length: ocrText.length,
    datalab_request_id: 'test-req-' + Date.now(),
    datalab_mode: 'fast',
    parse_quality_score: 4.5,
    page_count: 1,
    cost_cents: 1,
    content_hash: computeHash(ocrText),
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 1000,
  });

  // Create chunks with provenance
  const chunks: Array<{ id: string; provId: string; text: string }> = [];
  for (let i = 0; i < chunkTexts.length; i++) {
    const text = chunkTexts[i];
    const chunkProvId = uuidv4();
    const chunkId = uuidv4();

    // Create chunk provenance (depth 2)
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

    // Insert chunk
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
      overlap_next: i < chunkTexts.length - 1 ? 50 : 0,
      provenance_id: chunkProvId,
    });

    chunks.push({ id: chunkId, provId: chunkProvId, text });
  }

  return {
    docId,
    docProvId,
    ocrId,
    ocrProvId,
    chunks,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('EmbeddingService', () => {
  describe('embedDocumentChunks', () => {
    it('returns empty result for empty chunks', async () => {
      const result = await service.embedDocumentChunks(db, vectorService, [], {
        documentId: 'test',
        filePath: '/test',
        fileName: 'test',
        fileHash: 'hash',
        documentProvenanceId: 'prov',
      });

      expect(result.success).toBe(true);
      expect(result.embeddingIds).toHaveLength(0);
      expect(result.provenanceIds).toHaveLength(0);
      expect(result.totalChunks).toBe(0);
    });

    it('stores embeddings with original_text (CP-002)', async () => {
      const testTexts = [
        'First test chunk for embedding verification.',
        'Second chunk with different content.',
      ];

      const chain = createTestDocumentChain(db, testTexts);

      // Get the full chunk objects from database
      const dbChunks = db.getChunksByDocumentId(chain.docId);

      const result = await service.embedDocumentChunks(db, vectorService, dbChunks, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test-file-content-' + Date.now()),
        documentProvenanceId: chain.docProvId,
      });

      expect(result.success).toBe(true);
      expect(result.embeddingIds).toHaveLength(2);

      // VERIFY: Embeddings exist in database with original_text (CP-002)
      const embeddings = db.getEmbeddingsByDocumentId(chain.docId);
      expect(embeddings).toHaveLength(2);

      for (let i = 0; i < embeddings.length; i++) {
        const emb = embeddings[i];
        const expectedText = testTexts[emb.chunk_index];

        // CP-002: original_text MUST be stored
        expect(emb.original_text).toBe(expectedText);
        expect(emb.original_text_length).toBe(expectedText.length);
        expect(emb.model_name).toBe(MODEL_NAME);
        expect(emb.model_version).toBe(MODEL_VERSION);
        expect(emb.task_type).toBe('search_document');
        expect(emb.inference_mode).toBe('local');
      }
    }, 60000);

    it('stores vectors in vec_embeddings', async () => {
      const testTexts = ['Vector storage verification test chunk.'];
      const chain = createTestDocumentChain(db, testTexts);
      const dbChunks = db.getChunksByDocumentId(chain.docId);

      const countBefore = vectorService.getVectorCount();

      const result = await service.embedDocumentChunks(db, vectorService, dbChunks, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test'),
        documentProvenanceId: chain.docProvId,
      });

      const countAfter = vectorService.getVectorCount();
      expect(countAfter).toBe(countBefore + 1);

      // Verify vector exists and has correct dimensions
      const vector = vectorService.getVector(result.embeddingIds[0]);
      expect(vector).not.toBeNull();
      expect(vector!.length).toBe(EMBEDDING_DIM);
    }, 60000);

    it('creates provenance with chain_depth=3', async () => {
      const testTexts = ['Provenance chain verification chunk.'];
      const chain = createTestDocumentChain(db, testTexts);
      const dbChunks = db.getChunksByDocumentId(chain.docId);

      const result = await service.embedDocumentChunks(db, vectorService, dbChunks, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test'),
        documentProvenanceId: chain.docProvId,
      });

      // Verify provenance record
      const prov = db.getProvenance(result.provenanceIds[0]);
      expect(prov).not.toBeNull();
      expect(prov!.type).toBe(ProvenanceType.EMBEDDING);
      expect(prov!.chain_depth).toBe(3);
      expect(prov!.processor).toBe(MODEL_NAME);
      expect(prov!.processor_version).toBe(MODEL_VERSION);
    }, 60000);

    it('updates chunk status to complete', async () => {
      const testTexts = ['Status update verification chunk.'];
      const chain = createTestDocumentChain(db, testTexts);
      const dbChunks = db.getChunksByDocumentId(chain.docId);

      // Verify initial status is 'pending'
      expect(dbChunks[0].embedding_status).toBe('pending');

      await service.embedDocumentChunks(db, vectorService, dbChunks, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test'),
        documentProvenanceId: chain.docProvId,
      });

      // Verify status updated to 'complete'
      const updatedChunks = db.getChunksByDocumentId(chain.docId);
      expect(updatedChunks[0].embedding_status).toBe('complete');
      expect(updatedChunks[0].embedded_at).not.toBeNull();
    }, 60000);

    it('hash integrity is maintained', async () => {
      const testTexts = ['Hash integrity verification test.'];
      const chain = createTestDocumentChain(db, testTexts);
      const dbChunks = db.getChunksByDocumentId(chain.docId);

      await service.embedDocumentChunks(db, vectorService, dbChunks, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test'),
        documentProvenanceId: chain.docProvId,
      });

      const embeddings = db.getEmbeddingsByDocumentId(chain.docId);
      const emb = embeddings[0];

      // Verify content hash matches original text
      const expectedHash = computeHash(emb.original_text);
      expect(emb.content_hash).toBe(expectedHash);
    }, 60000);
  });

  describe('embedSearchQuery', () => {
    it('returns Float32Array with 768 dimensions', async () => {
      const result = await service.embedSearchQuery('What are the terms?');

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(EMBEDDING_DIM);
    }, 60000);

    it('query embedding is NOT stored (ephemeral)', async () => {
      const countBefore = vectorService.getVectorCount();

      await service.embedSearchQuery('Ephemeral query test');

      const countAfter = vectorService.getVectorCount();
      expect(countAfter).toBe(countBefore); // No new vectors
    }, 30000);
  });

  describe('processPendingChunks', () => {
    it('processes only pending chunks', async () => {
      const testTexts = ['Pending chunk one.', 'Pending chunk two.'];
      const chain = createTestDocumentChain(db, testTexts);

      const result = await service.processPendingChunks(db, vectorService, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test'),
        documentProvenanceId: chain.docProvId,
      });

      expect(result.success).toBe(true);
      expect(result.totalChunks).toBe(2);
      expect(result.embeddingIds).toHaveLength(2);

      // Run again - should process 0 chunks (all complete)
      const secondResult = await service.processPendingChunks(db, vectorService, {
        documentId: chain.docId,
        filePath: '/test/doc.pdf',
        fileName: 'doc.pdf',
        fileHash: computeHash('test'),
        documentProvenanceId: chain.docProvId,
      });

      expect(secondResult.totalChunks).toBe(0);
    }, 60000);
  });
});

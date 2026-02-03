/**
 * Manual Verification Test for VectorService
 *
 * This test performs manual verification of the VectorService implementation.
 * Run with: npm test -- tests/manual/vector-verification.test.ts --run
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../src/services/storage/database.js';
import { VectorService } from '../../src/services/storage/vector.js';
import { ProvenanceType } from '../../src/models/provenance.js';
import { computeHash } from '../../src/utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function log(section: string, message: string): void {
  console.log(`[${section}] ${message}`);
}

function createRandomVector(): Float32Array {
  const vector = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vector[i] = Math.random() * 2 - 1;
  }
  return vector;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('VectorService Manual Verification', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;
  let vectorService: VectorService | undefined;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'vector-manual-'));
    log('SETUP', `Test directory: ${testDir}`);

    if (sqliteVecAvailable) {
      dbService = DatabaseService.create('manual-test', undefined, testDir);
      vectorService = new VectorService(dbService.getConnection());
      log('SETUP', 'Database and VectorService initialized');
    }
  });

  afterAll(() => {
    if (dbService) {
      try {
        dbService.close();
      } catch {
        // Ignore
      }
    }
    rmSync(testDir, { recursive: true, force: true });
    log('CLEANUP', 'Test directory removed');
  });

  it.skipIf(!sqliteVecAvailable)('Full verification: store, search, verify CP-002, delete', () => {
    console.log('\n========================================');
    console.log('  VectorService Manual Verification');
    console.log('========================================\n');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 1: Create full provenance chain and embedding
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('--- Test 1: Create Embedding with Full Provenance Chain ---');

    const now = new Date().toISOString();
    const provId = uuidv4();
    const docId = uuidv4();
    const chunkId = uuidv4();
    const embeddingId = uuidv4();
    const originalText = 'This is the original text that will be stored and must be returned in search results per CP-002.';

    // Insert provenance chain
    dbService!.insertProvenance({
      id: provId,
      type: ProvenanceType.DOCUMENT,
      source_type: 'FILE',
      source_id: null,
      root_document_id: provId,
      content_hash: computeHash('test'),
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      parent_ids: '[]',
      chain_depth: 0,
      created_at: now,
      processed_at: now,
      source_file_created_at: now,
      source_file_modified_at: now,
      source_path: '/test/manual-doc.pdf',
      location: null,
      input_hash: null,
      file_hash: computeHash('file'),
      processing_duration_ms: 0,
      processing_quality_score: null,
      parent_id: null,
      chain_path: null,
    });

    dbService!.insertDocument({
      id: docId,
      file_path: '/test/manual-doc.pdf',
      file_name: 'manual-doc.pdf',
      file_hash: computeHash('file'),
      file_size: 5000,
      file_type: 'pdf',
      status: 'complete',
      provenance_id: provId,
    });

    // OCR provenance
    const ocrProvId = uuidv4();
    dbService!.insertProvenance({
      id: ocrProvId,
      type: ProvenanceType.OCR_RESULT,
      source_type: 'OCR',
      source_id: provId,
      root_document_id: provId,
      content_hash: computeHash('ocr'),
      processor: 'datalab-ocr',
      processor_version: '1.0.0',
      processing_params: { mode: 'accurate' },
      parent_ids: JSON.stringify([provId]),
      parent_id: provId,
      chain_depth: 1,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_path: null,
      location: null,
      input_hash: computeHash('test'),
      file_hash: computeHash('file'),
      processing_duration_ms: 1000,
      processing_quality_score: 0.95,
      chain_path: null,
    });

    const ocrId = uuidv4();
    dbService!.insertOCRResult({
      id: ocrId,
      provenance_id: ocrProvId,
      document_id: docId,
      extracted_text: originalText,
      text_length: originalText.length,
      datalab_request_id: 'req-manual',
      datalab_mode: 'accurate',
      page_count: 1,
      content_hash: computeHash(originalText),
      processing_started_at: now,
      processing_completed_at: now,
      processing_duration_ms: 1000,
    });

    // Chunk provenance
    const chunkProvId = uuidv4();
    dbService!.insertProvenance({
      id: chunkProvId,
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrProvId,
      root_document_id: provId,
      content_hash: computeHash('chunk'),
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: { size: 2000 },
      parent_ids: JSON.stringify([provId, ocrProvId]),
      parent_id: ocrProvId,
      chain_depth: 2,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_path: null,
      location: null,
      input_hash: computeHash('ocr'),
      file_hash: computeHash('file'),
      processing_duration_ms: 10,
      processing_quality_score: null,
      chain_path: null,
    });

    dbService!.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrId,
      text: originalText,
      text_hash: computeHash(originalText),
      chunk_index: 0,
      character_start: 0,
      character_end: originalText.length,
      page_number: 3,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProvId,
    });

    // Embedding provenance
    const embProvId = uuidv4();
    dbService!.insertProvenance({
      id: embProvId,
      type: ProvenanceType.EMBEDDING,
      source_type: 'EMBEDDING',
      source_id: chunkProvId,
      root_document_id: provId,
      content_hash: computeHash('embedding'),
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { dimensions: 768 },
      parent_ids: JSON.stringify([provId, ocrProvId, chunkProvId]),
      parent_id: chunkProvId,
      chain_depth: 3,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_path: null,
      location: null,
      input_hash: computeHash('chunk'),
      file_hash: computeHash('file'),
      processing_duration_ms: 50,
      processing_quality_score: null,
      chain_path: null,
    });

    dbService!.insertEmbedding({
      id: embeddingId,
      chunk_id: chunkId,
      document_id: docId,
      original_text: originalText,
      original_text_length: originalText.length,
      source_file_path: '/test/manual-doc.pdf',
      source_file_name: 'manual-doc.pdf',
      source_file_hash: computeHash('file'),
      page_number: 3,
      page_range: null,
      character_start: 0,
      character_end: originalText.length,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProvId,
      content_hash: computeHash('embedding'),
      generation_duration_ms: 50,
    });

    log('SUCCESS', 'Full provenance chain created');
    log('DATA', `Embedding ID: ${embeddingId}`);
    log('DATA', `Document ID: ${docId}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 2: Store vector
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 2: Store Vector ---');

    const vector = createRandomVector();
    vector[0] = 0.12345;
    vector[767] = -0.98765;

    vectorService!.storeVector(embeddingId, vector);
    log('SUCCESS', 'Vector stored');

    // Physical verification
    const conn = dbService!.getConnection();
    const storedRow = conn
      .prepare('SELECT * FROM vec_embeddings WHERE embedding_id = ?')
      .get(embeddingId) as { embedding_id: string; vector: Buffer } | undefined;

    expect(storedRow).toBeDefined();
    log('PHYSICAL', `Vector stored in database: YES`);
    log('PHYSICAL', `Vector buffer size: ${storedRow!.vector.length} bytes`);
    expect(storedRow!.vector.length).toBe(768 * 4);
    log('SUCCESS', 'Vector size correct');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 3: Search and verify CP-002 compliance
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 3: Search and CP-002 Verification ---');

    const results = vectorService!.searchSimilar(vector, { limit: 5 });

    log('SEARCH', `Results count: ${results.length}`);
    expect(results.length).toBeGreaterThan(0);

    const result = results[0];

    console.log('\n=== SEARCH RESULT FIELDS ===');
    console.log(`  embedding_id: ${result.embedding_id}`);
    console.log(`  document_id: ${result.document_id}`);
    console.log(`  similarity_score: ${result.similarity_score.toFixed(6)}`);
    console.log(`  distance: ${result.distance.toFixed(6)}`);
    console.log(`  original_text: "${result.original_text.substring(0, 50)}..."`);
    console.log(`  original_text_length: ${result.original_text_length}`);
    console.log(`  source_file_path: ${result.source_file_path}`);
    console.log(`  source_file_name: ${result.source_file_name}`);
    console.log(`  page_number: ${result.page_number}`);
    console.log(`  character_start: ${result.character_start}`);
    console.log(`  character_end: ${result.character_end}`);
    console.log(`  chunk_index: ${result.chunk_index}`);
    console.log(`  total_chunks: ${result.total_chunks}`);
    console.log(`  model_name: ${result.model_name}`);
    console.log(`  model_version: ${result.model_version}`);
    console.log(`  provenance_id: ${result.provenance_id}`);

    // CP-002 verification
    console.log('\n=== CP-002 COMPLIANCE CHECK ===');

    expect(result.original_text).toBe(originalText);
    log('SUCCESS', 'original_text matches stored text');

    expect(result.source_file_path).toBe('/test/manual-doc.pdf');
    log('SUCCESS', 'source_file_path correct');

    expect(result.page_number).toBe(3);
    log('SUCCESS', 'page_number correct');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 4: Retrieve vector and verify precision
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 4: Vector Retrieval and Precision ---');

    const retrieved = vectorService!.getVector(embeddingId);

    expect(retrieved).not.toBeNull();
    log('RETRIEVE', `Retrieved vector length: ${retrieved!.length}`);
    log('RETRIEVE', `First value (stored 0.12345): ${retrieved![0]}`);
    log('RETRIEVE', `Last value (stored -0.98765): ${retrieved![767]}`);

    expect(Math.abs(retrieved![0] - 0.12345)).toBeLessThan(0.0001);
    log('SUCCESS', 'Float32 precision maintained');

    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 5: Delete vector
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 5: Delete Vector ---');

    const countBefore = vectorService!.getVectorCount();
    log('DELETE', `Vector count before: ${countBefore}`);

    const deleted = vectorService!.deleteVector(embeddingId);
    log('DELETE', `Delete returned: ${deleted}`);

    const countAfter = vectorService!.getVectorCount();
    log('DELETE', `Vector count after: ${countAfter}`);

    expect(deleted).toBe(true);
    expect(countAfter).toBe(countBefore - 1);
    log('SUCCESS', 'Vector deleted successfully');

    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL RESULT
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n========================================');
    console.log('  ALL VERIFICATIONS PASSED');
    console.log('========================================\n');
  });
});

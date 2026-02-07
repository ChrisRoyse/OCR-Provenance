/**
 * Integration Tests: VLM Image Descriptions Searchable via BM25, Semantic, and Hybrid Search
 *
 * Validates that VLM description embeddings (chunk_id=null, image_id set) are:
 * - Indexed in vlm_fts (FTS5) and searchable via BM25SearchService.searchVLM()
 * - Stored in vec_embeddings and findable via VectorService.searchSimilar()
 * - Correctly fused in RRFFusion without collapsing (keyed by embedding_id, not chunk_id)
 * - Properly represented in schema v6 tables and triggers
 *
 * NO MOCKS. Uses real DatabaseService with temp databases.
 * GPU tests use real EmbeddingService calling python/embedding_worker.py on CUDA GPU.
 *
 * @module tests/unit/services/search/vlm-search-integration
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { DatabaseService } from '../../../../src/services/storage/database/index.js';
import { insertImageBatch } from '../../../../src/services/storage/database/image-operations.js';
import { VectorService } from '../../../../src/services/storage/vector.js';
import { BM25SearchService } from '../../../../src/services/search/bm25.js';
import { RRFFusion, type RankedResult } from '../../../../src/services/search/fusion.js';
import { EmbeddingService, resetEmbeddingService } from '../../../../src/services/embedding/embedder.js';
import { computeHash } from '../../../../src/utils/hash.js';

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
// TEMP DIR TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Insert a full document chain (provenance -> document) and return IDs.
 */
function insertTestDocument(
  db: DatabaseService,
  docId: string,
  fileName: string,
  filePath: string
): { docProvId: string; fileHash: string } {
  const docProvId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(filePath);

  db.insertProvenance({
    id: docProvId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: filePath,
    source_id: null,
    root_document_id: docProvId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  db.insertDocument({
    id: docId,
    file_path: filePath,
    file_name: fileName,
    file_hash: fileHash,
    file_size: 5000,
    file_type: 'pdf',
    status: 'complete',
    page_count: 3,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  return { docProvId, fileHash };
}

/**
 * Insert OCR result and return IDs.
 */
function insertTestOCRResult(
  db: DatabaseService,
  docId: string,
  docProvId: string,
  text: string
): { ocrResultId: string; ocrProvId: string } {
  const ocrResultId = uuidv4();
  const ocrProvId = uuidv4();
  const now = new Date().toISOString();
  const hash = computeHash(text);

  db.insertProvenance({
    id: ocrProvId,
    type: 'OCR_RESULT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'OCR',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: hash,
    input_hash: null,
    file_hash: null,
    processor: 'datalab',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  db.insertOCRResult({
    id: ocrResultId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: text,
    text_length: text.length,
    datalab_request_id: `test-req-${uuidv4()}`,
    datalab_mode: 'balanced',
    parse_quality_score: 4.5,
    page_count: 3,
    cost_cents: 0,
    content_hash: hash,
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 100,
  });

  return { ocrResultId, ocrProvId };
}

/**
 * Insert a chunk with provenance and return IDs.
 */
function insertTestChunk(
  db: DatabaseService,
  chunkId: string,
  docId: string,
  ocrResultId: string,
  ocrProvId: string,
  docProvId: string,
  text: string,
  chunkIndex: number
): string {
  const chunkProvId = uuidv4();
  const now = new Date().toISOString();
  const hash = computeHash(text);

  db.insertProvenance({
    id: chunkProvId,
    type: 'CHUNK',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'CHUNKING',
    source_path: null,
    source_id: ocrProvId,
    root_document_id: docProvId,
    location: JSON.stringify({ chunk_index: chunkIndex }),
    content_hash: hash,
    input_hash: null,
    file_hash: null,
    processor: 'chunker',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: ocrProvId,
    parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
  });

  db.insertChunk({
    id: chunkId,
    document_id: docId,
    ocr_result_id: ocrResultId,
    text: text,
    text_hash: hash,
    chunk_index: chunkIndex,
    character_start: 0,
    character_end: text.length,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: chunkProvId,
    embedding_status: 'pending',
    embedded_at: null,
  });

  return chunkProvId;
}

/**
 * Insert an image via direct SQL (since DatabaseService has no insertImageBatch method).
 * Returns the image ID.
 */
function insertTestImage(
  db: DatabaseService,
  imageId: string,
  docId: string,
  ocrResultId: string,
  ocrProvId: string,
  docProvId: string,
  vlmDescription: string | null
): string {
  const imageProvId = uuidv4();
  const now = new Date().toISOString();

  // IMAGE provenance (depth 2)
  db.insertProvenance({
    id: imageProvId,
    type: 'IMAGE',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'IMAGE_EXTRACTION',
    source_path: null,
    source_id: ocrProvId,
    root_document_id: docProvId,
    location: JSON.stringify({ page_number: 1, bounding_box: { x: 0, y: 0, width: 200, height: 200, page: 1 } }),
    content_hash: computeHash(imageId),
    input_hash: null,
    file_hash: null,
    processor: 'pymupdf',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: ocrProvId,
    parent_ids: JSON.stringify([docProvId, ocrProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "IMAGE"]',
  });

  // Insert image via raw connection using insertImageBatch
  const conn = db.getConnection();
  insertImageBatch(conn, [{
    document_id: docId,
    ocr_result_id: ocrResultId,
    page_number: 1,
    bounding_box: { x: 0, y: 0, width: 200, height: 200 },
    image_index: 0,
    format: 'png',
    dimensions: { width: 200, height: 200 },
    extracted_path: `/tmp/test-images/${imageId}.png`,
    file_size: 1024,
    context_text: 'Surrounding text for the image',
    provenance_id: imageProvId,
    block_type: 'Figure',
    is_header_footer: false,
    content_hash: computeHash(imageId),
  }]);

  // The insertImageBatch auto-generates the id; we need to get it
  const row = conn.prepare(
    'SELECT id FROM images WHERE provenance_id = ?'
  ).get(imageProvId) as { id: string } | undefined;

  const actualImageId = row?.id ?? imageId;

  // If vlmDescription is set, update the image to complete status
  if (vlmDescription) {
    conn.prepare(`
      UPDATE images SET vlm_status = 'complete', vlm_description = ?,
        vlm_model = 'gemini-2.0-flash', vlm_confidence = 0.95,
        vlm_processed_at = ?, vlm_tokens_used = 150
      WHERE id = ?
    `).run(vlmDescription, now, actualImageId);
  }

  return actualImageId;
}

/**
 * Insert a VLM description embedding (chunk_id=null, image_id set).
 * The vlm_fts trigger should auto-fire.
 */
function insertVLMEmbedding(
  db: DatabaseService,
  embeddingId: string,
  imageId: string,
  docId: string,
  imageProvId: string,
  docProvId: string,
  filePath: string,
  fileName: string,
  fileHash: string,
  vlmText: string
): string {
  const vlmDescProvId = uuidv4();
  const embProvId = uuidv4();
  const now = new Date().toISOString();

  // VLM_DESCRIPTION provenance (depth 3)
  db.insertProvenance({
    id: vlmDescProvId,
    type: 'VLM_DESCRIPTION',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'VLM',
    source_path: null,
    source_id: imageProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(vlmText),
    input_hash: null,
    file_hash: null,
    processor: 'gemini-2.0-flash',
    processor_version: '2.0',
    processing_params: { model: 'gemini-2.0-flash' },
    processing_duration_ms: 500,
    processing_quality_score: 0.95,
    parent_id: imageProvId,
    parent_ids: JSON.stringify([docProvId, imageProvId]),
    chain_depth: 3,
    chain_path: '["DOCUMENT", "OCR_RESULT", "IMAGE", "VLM_DESCRIPTION"]',
  });

  // EMBEDDING provenance (depth 4, from VLM_DESCRIPTION)
  db.insertProvenance({
    id: embProvId,
    type: 'EMBEDDING',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'EMBEDDING',
    source_path: null,
    source_id: vlmDescProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(vlmText),
    input_hash: computeHash(vlmText),
    file_hash: fileHash,
    processor: 'nomic-embed-text-v1.5',
    processor_version: '1.5.0',
    processing_params: { dimensions: 768, task_type: 'search_document' },
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: vlmDescProvId,
    parent_ids: JSON.stringify([docProvId, imageProvId, vlmDescProvId]),
    chain_depth: 4,
    chain_path: '["DOCUMENT", "OCR_RESULT", "IMAGE", "VLM_DESCRIPTION", "EMBEDDING"]',
  });

  // Insert the embedding row (chunk_id=null, image_id=set) -- vlm_fts trigger fires
  db.insertEmbedding({
    id: embeddingId,
    chunk_id: null,
    image_id: imageId,
    document_id: docId,
    original_text: vlmText,
    original_text_length: vlmText.length,
    source_file_path: filePath,
    source_file_name: fileName,
    source_file_hash: fileHash,
    page_number: 1,
    page_range: null,
    character_start: 0,
    character_end: vlmText.length,
    chunk_index: 0,
    total_chunks: 1,
    model_name: 'nomic-embed-text-v1.5',
    model_version: '1.5.0',
    task_type: 'search_document',
    inference_mode: 'local',
    gpu_device: 'cuda:0',
    provenance_id: embProvId,
    content_hash: computeHash(vlmText),
    generation_duration_ms: null,
  });

  return embProvId;
}

/**
 * Helper: set up a full VLM test scenario (document -> ocr -> image -> vlm embedding).
 * Returns all IDs needed for further assertions.
 */
function setupVLMTestData(
  db: DatabaseService,
  vlmDescription: string,
  filePath: string,
  fileName: string
): {
  docId: string;
  imageId: string;
  embeddingId: string;
  docProvId: string;
  fileHash: string;
  imageProvId: string;
} {
  const docId = uuidv4();
  const embeddingId = uuidv4();

  const { docProvId, fileHash } = insertTestDocument(db, docId, fileName, filePath);
  const { ocrResultId, ocrProvId } = insertTestOCRResult(db, docId, docProvId, 'Sample OCR text');

  const imageId = insertTestImage(db, uuidv4(), docId, ocrResultId, ocrProvId, docProvId, vlmDescription);

  // Get the image provenance_id
  const conn = db.getConnection();
  const imgRow = conn.prepare('SELECT provenance_id FROM images WHERE id = ?').get(imageId) as { provenance_id: string };
  const imageProvId = imgRow.provenance_id;

  insertVLMEmbedding(
    db, embeddingId, imageId, docId, imageProvId, docProvId,
    filePath, fileName, fileHash, vlmDescription
  );

  return { docId, imageId, embeddingId, docProvId, fileHash, imageProvId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BM25 VLM SEARCH TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('BM25 VLM Search', () => {
  let tempDir: string;
  let db: DatabaseService;

  beforeEach(() => {
    tempDir = createTempDir('vlm-bm25-');
    const dbName = createUniqueName('vlm-bm25');
    db = DatabaseService.create(dbName, undefined, tempDir);
  });

  afterEach(() => {
    db.close();
  });

  it.skipIf(!sqliteVecAvailable)('searchVLM returns results from VLM descriptions', () => {
    const vlmText = 'A detailed photograph showing a mitochondria cross-section with cristae membranes';
    setupVLMTestData(db, vlmText, '/test/biology.pdf', 'biology.pdf');

    const bm25 = new BM25SearchService(db.getConnection());
    const results = bm25.searchVLM({ query: 'mitochondria cristae', limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].result_type).toBe('vlm');
    expect(results[0].chunk_id).toBeNull();
    expect(results[0].image_id).toBeTruthy();
    expect(results[0].embedding_id).toBeTruthy();
    expect(results[0].original_text).toContain('mitochondria');
    expect(results[0].bm25_score).toBeGreaterThan(0);
    expect(results[0].provenance_id).toBeTruthy();
    expect(results[0].content_hash).toMatch(/^sha256:/);
  });

  it.skipIf(!sqliteVecAvailable)('searchVLM returns empty when no VLM embeddings exist', () => {
    // Insert only chunk data, no VLM embeddings
    const docId = uuidv4();
    const chunkId = uuidv4();
    const { docProvId } = insertTestDocument(db, docId, 'test.txt', '/test/test.txt');
    const { ocrResultId, ocrProvId } = insertTestOCRResult(db, docId, docProvId, 'Some chunk text about mitochondria');
    insertTestChunk(db, chunkId, docId, ocrResultId, ocrProvId, docProvId, 'Some chunk text about mitochondria', 0);

    // Insert a chunk-based embedding (chunk_id set, image_id null)
    const embId = uuidv4();
    const embProvId = uuidv4();
    const now = new Date().toISOString();
    db.insertProvenance({
      id: embProvId,
      type: 'EMBEDDING',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EMBEDDING',
      source_path: null,
      source_id: docProvId,
      root_document_id: docProvId,
      location: null,
      content_hash: computeHash('Some chunk text about mitochondria'),
      input_hash: null,
      file_hash: null,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: docProvId,
      parent_ids: JSON.stringify([docProvId]),
      chain_depth: 3,
      chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK", "EMBEDDING"]',
    });

    db.insertEmbedding({
      id: embId,
      chunk_id: chunkId,
      image_id: null,
      document_id: docId,
      original_text: 'Some chunk text about mitochondria',
      original_text_length: 34,
      source_file_path: '/test/test.txt',
      source_file_name: 'test.txt',
      source_file_hash: computeHash('/test/test.txt'),
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: 34,
      chunk_index: 0,
      total_chunks: 1,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProvId,
      content_hash: computeHash('Some chunk text about mitochondria'),
      generation_duration_ms: null,
    });

    const bm25 = new BM25SearchService(db.getConnection());
    const vlmResults = bm25.searchVLM({ query: 'mitochondria', limit: 10 });

    // vlm_fts only indexes embeddings where image_id IS NOT NULL
    // chunk embeddings (image_id=null) should NOT appear in searchVLM
    expect(vlmResults).toHaveLength(0);
  });

  it.skipIf(!sqliteVecAvailable)('searchVLM with no vlm_fts table returns empty gracefully', () => {
    // Drop the vlm_fts table to simulate pre-v6 database
    const conn = db.getConnection();
    conn.exec('DROP TABLE IF EXISTS vlm_fts');

    const bm25 = new BM25SearchService(conn);
    const results = bm25.searchVLM({ query: 'anything', limit: 10 });

    expect(results).toEqual([]);
  });

  it.skipIf(!sqliteVecAvailable)('combined BM25 search returns both chunk and VLM results', () => {
    const docId = uuidv4();
    const chunkId = uuidv4();
    const sharedKeyword = 'photosynthesis';

    const { docProvId, fileHash } = insertTestDocument(db, docId, 'plants.pdf', '/test/plants.pdf');
    const { ocrResultId, ocrProvId } = insertTestOCRResult(db, docId, docProvId, `The process of ${sharedKeyword} in chloroplasts`);

    // Insert a chunk with the shared keyword
    insertTestChunk(
      db, chunkId, docId, ocrResultId, ocrProvId, docProvId,
      `The process of ${sharedKeyword} converts light energy into chemical energy`, 0
    );

    // Insert a VLM embedding with the same keyword
    const imageId = insertTestImage(
      db, uuidv4(), docId, ocrResultId, ocrProvId, docProvId,
      `Diagram showing ${sharedKeyword} in a leaf cell`
    );

    const conn = db.getConnection();
    const imgRow = conn.prepare('SELECT provenance_id FROM images WHERE id = ?').get(imageId) as { provenance_id: string };

    const vlmEmbId = uuidv4();
    insertVLMEmbedding(
      db, vlmEmbId, imageId, docId, imgRow.provenance_id, docProvId,
      '/test/plants.pdf', 'plants.pdf', fileHash,
      `Diagram showing ${sharedKeyword} in a leaf cell`
    );

    const bm25 = new BM25SearchService(db.getConnection());

    // BM25 chunk search
    const chunkResults = bm25.search({ query: sharedKeyword, limit: 10 });
    expect(chunkResults.length).toBeGreaterThanOrEqual(1);
    expect(chunkResults[0].result_type).toBe('chunk');
    expect(chunkResults[0].chunk_id).toBeTruthy();

    // BM25 VLM search
    const vlmResults = bm25.searchVLM({ query: sharedKeyword, limit: 10 });
    expect(vlmResults.length).toBeGreaterThanOrEqual(1);
    expect(vlmResults[0].result_type).toBe('vlm');
    expect(vlmResults[0].image_id).toBeTruthy();
    expect(vlmResults[0].chunk_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RRF FUSION MAP KEY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('RRF Fusion Map Key Tests', () => {
  it('VLM results with different embedding_ids do not collapse in fusion', () => {
    const fusion = new RRFFusion();

    // 3 VLM results with chunk_id=null but different embedding_ids
    const vlmBm25Results: RankedResult[] = [
      {
        chunk_id: null,
        image_id: 'img-1',
        embedding_id: 'emb-vlm-1',
        rank: 1,
        score: 5.0,
        result_type: 'vlm',
        document_id: 'doc-1',
        original_text: 'Description of image 1',
        source_file_path: '/test/doc.pdf',
        source_file_name: 'doc.pdf',
        source_file_hash: 'sha256:aaa',
        page_number: 1,
        character_start: 0,
        character_end: 22,
        chunk_index: 0,
        provenance_id: 'prov-1',
        content_hash: 'sha256:h1',
      },
      {
        chunk_id: null,
        image_id: 'img-2',
        embedding_id: 'emb-vlm-2',
        rank: 2,
        score: 4.0,
        result_type: 'vlm',
        document_id: 'doc-1',
        original_text: 'Description of image 2',
        source_file_path: '/test/doc.pdf',
        source_file_name: 'doc.pdf',
        source_file_hash: 'sha256:aaa',
        page_number: 2,
        character_start: 0,
        character_end: 22,
        chunk_index: 0,
        provenance_id: 'prov-2',
        content_hash: 'sha256:h2',
      },
      {
        chunk_id: null,
        image_id: 'img-3',
        embedding_id: 'emb-vlm-3',
        rank: 3,
        score: 3.0,
        result_type: 'vlm',
        document_id: 'doc-1',
        original_text: 'Description of image 3',
        source_file_path: '/test/doc.pdf',
        source_file_name: 'doc.pdf',
        source_file_hash: 'sha256:aaa',
        page_number: 3,
        character_start: 0,
        character_end: 22,
        chunk_index: 0,
        provenance_id: 'prov-3',
        content_hash: 'sha256:h3',
      },
    ];

    const fused = fusion.fuse(vlmBm25Results, [], 10);

    // All 3 should be present because they have different embedding_ids
    expect(fused).toHaveLength(3);

    const embIds = fused.map(r => r.embedding_id);
    expect(embIds).toContain('emb-vlm-1');
    expect(embIds).toContain('emb-vlm-2');
    expect(embIds).toContain('emb-vlm-3');

    // All should be VLM type
    for (const result of fused) {
      expect(result.result_type).toBe('vlm');
      expect(result.chunk_id).toBeNull();
      expect(result.image_id).toBeTruthy();
    }

    // Scores should be ordered descending
    for (let i = 0; i < fused.length - 1; i++) {
      expect(fused[i].rrf_score).toBeGreaterThanOrEqual(fused[i + 1].rrf_score);
    }
  });

  it('same embedding from BM25 and semantic merges into one entry with both scores', () => {
    const fusion = new RRFFusion();

    const sharedEmbId = 'emb-shared-1';

    const bm25Results: RankedResult[] = [
      {
        chunk_id: null,
        image_id: 'img-1',
        embedding_id: sharedEmbId,
        rank: 1,
        score: 5.0,
        result_type: 'vlm',
        document_id: 'doc-1',
        original_text: 'Shared VLM description',
        source_file_path: '/test/doc.pdf',
        source_file_name: 'doc.pdf',
        source_file_hash: 'sha256:aaa',
        page_number: 1,
        character_start: 0,
        character_end: 22,
        chunk_index: 0,
        provenance_id: 'prov-bm25',
        content_hash: 'sha256:shared',
      },
    ];

    const semanticResults: RankedResult[] = [
      {
        chunk_id: null,
        image_id: 'img-1',
        embedding_id: sharedEmbId,
        rank: 2,
        score: 0.92,
        result_type: 'vlm',
        document_id: 'doc-1',
        original_text: 'Shared VLM description',
        source_file_path: '/test/doc.pdf',
        source_file_name: 'doc.pdf',
        source_file_hash: 'sha256:aaa',
        page_number: 1,
        character_start: 0,
        character_end: 22,
        chunk_index: 0,
        provenance_id: 'prov-semantic',
        content_hash: 'sha256:shared',
      },
    ];

    const fused = fusion.fuse(bm25Results, semanticResults, 10);

    // Should merge into single entry
    expect(fused).toHaveLength(1);
    expect(fused[0].embedding_id).toBe(sharedEmbId);
    expect(fused[0].found_in_bm25).toBe(true);
    expect(fused[0].found_in_semantic).toBe(true);
    expect(fused[0].bm25_rank).toBe(1);
    expect(fused[0].bm25_score).toBe(5.0);
    expect(fused[0].semantic_rank).toBe(2);
    expect(fused[0].semantic_score).toBe(0.92);

    // RRF score should be sum of both contributions: 1/(60+1) + 1/(60+2)
    const expectedScore = 1.0 / (60 + 1) + 1.0 / (60 + 2);
    expect(fused[0].rrf_score).toBeCloseTo(expectedScore, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA V6 VERIFICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Schema v6 VLM FTS Verification', () => {
  let tempDir: string;
  let db: DatabaseService;

  beforeEach(() => {
    tempDir = createTempDir('vlm-schema-');
    const dbName = createUniqueName('vlm-schema');
    db = DatabaseService.create(dbName, undefined, tempDir);
  });

  afterEach(() => {
    db.close();
  });

  it.skipIf(!sqliteVecAvailable)('vlm_fts table exists after database creation', () => {
    const conn = db.getConnection();
    const result = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'"
    ).get() as { name: string } | undefined;

    expect(result).toBeDefined();
    expect(result?.name).toBe('vlm_fts');
  });

  it.skipIf(!sqliteVecAvailable)('vlm_fts triggers exist (ai, ad, au)', () => {
    const conn = db.getConnection();
    const triggers = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'vlm_fts_%'"
    ).all() as Array<{ name: string }>;

    const triggerNames = triggers.map(t => t.name);

    expect(triggerNames).toContain('vlm_fts_ai');
    expect(triggerNames).toContain('vlm_fts_ad');
    expect(triggerNames).toContain('vlm_fts_au');
  });

  it.skipIf(!sqliteVecAvailable)('fts_index_metadata allows id=2 for VLM FTS', () => {
    const conn = db.getConnection();

    // Insert VLM FTS metadata (id=2)
    conn.prepare(`
      INSERT INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (2, ?, 0, 'porter unicode61', 6, NULL)
      ON CONFLICT(id) DO UPDATE SET chunks_indexed = 0
    `).run(new Date().toISOString());

    const meta = conn.prepare('SELECT * FROM fts_index_metadata WHERE id = 2').get() as {
      id: number;
      chunks_indexed: number;
      tokenizer: string;
    } | undefined;

    expect(meta).toBeDefined();
    expect(meta?.id).toBe(2);
    expect(meta?.tokenizer).toBe('porter unicode61');
  });

  it.skipIf(!sqliteVecAvailable)('VLM FTS auto-syncs on embedding insert (trigger fires)', () => {
    const vlmText = 'This photograph depicts an intricate neural network architecture';
    setupVLMTestData(db, vlmText, '/test/neuro.pdf', 'neuro.pdf');

    const conn = db.getConnection();

    // Query vlm_fts directly to verify the trigger populated it
    const ftsCount = conn.prepare(
      "SELECT COUNT(*) as cnt FROM vlm_fts WHERE vlm_fts MATCH 'neural AND network'"
    ).get() as { cnt: number };

    expect(ftsCount.cnt).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('rebuildIndex covers both chunks and VLM', () => {
    // Insert chunk data
    const docId = uuidv4();
    const chunkId = uuidv4();
    const { docProvId, fileHash } = insertTestDocument(db, docId, 'test.pdf', '/test/test.pdf');
    const { ocrResultId, ocrProvId } = insertTestOCRResult(db, docId, docProvId, 'Test chunk text');
    insertTestChunk(db, chunkId, docId, ocrResultId, ocrProvId, docProvId, 'Test chunk text for indexing', 0);

    // Insert VLM data
    const vlmText = 'Photograph of a chemical reaction vessel';
    const imageId = insertTestImage(
      db, uuidv4(), docId, ocrResultId, ocrProvId, docProvId, vlmText
    );
    const conn = db.getConnection();
    const imgRow = conn.prepare('SELECT provenance_id FROM images WHERE id = ?').get(imageId) as { provenance_id: string };

    const vlmEmbId = uuidv4();
    insertVLMEmbedding(
      db, vlmEmbId, imageId, docId, imgRow.provenance_id, docProvId,
      '/test/test.pdf', 'test.pdf', fileHash, vlmText
    );

    const bm25 = new BM25SearchService(db.getConnection());
    const result = bm25.rebuildIndex();

    expect(result.chunks_indexed).toBe(1);
    expect(result.vlm_indexed).toBe(1);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.content_hash).toMatch(/^sha256:/);
  });

  it.skipIf(!sqliteVecAvailable)('getStatus returns vlm_indexed count', () => {
    // Insert VLM data so rebuild produces counts
    const vlmText = 'Diagram of a molecular structure with carbon rings';
    setupVLMTestData(db, vlmText, '/test/chem.pdf', 'chem.pdf');

    const bm25 = new BM25SearchService(db.getConnection());
    bm25.rebuildIndex();

    const status = bm25.getStatus();

    expect(status.vlm_indexed).toBe(1);
    expect(status.vlm_last_rebuild_at).toBeTruthy();
    expect(status.tokenizer).toBe('porter unicode61');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VLM SEMANTIC SEARCH WITH REAL GPU
// ═══════════════════════════════════════════════════════════════════════════════

describe('VLM Semantic Search with Real GPU', () => {
  let tempDir: string;
  let db: DatabaseService;

  beforeEach(() => {
    tempDir = createTempDir('vlm-semantic-');
    const dbName = createUniqueName('vlm-semantic');
    db = DatabaseService.create(dbName, undefined, tempDir);
  });

  afterEach(() => {
    db.close();
    resetEmbeddingService();
  });

  it.skipIf(!sqliteVecAvailable)('semantic search finds VLM description embeddings', async () => {
    const vlmDescription =
      'A detailed bar chart showing quarterly revenue growth for the technology sector ' +
      'with significant increases in Q3 and Q4 driven by artificial intelligence adoption';

    const {
      docId, imageId, embeddingId, docProvId, fileHash, imageProvId,
    } = setupVLMTestData(db, vlmDescription, '/test/finance.pdf', 'finance.pdf');

    // Use real EmbeddingService to generate the vector for the VLM description
    const embedder = new EmbeddingService();
    const vlmVector = await embedder.embedSearchQuery(vlmDescription);

    expect(vlmVector).toBeInstanceOf(Float32Array);
    expect(vlmVector.length).toBe(768);

    // Store the real vector
    const vector = new VectorService(db.getConnection());
    vector.storeVector(embeddingId, vlmVector);

    // Now search with a semantically similar query
    const queryText = 'revenue growth chart technology AI';
    const queryVector = await embedder.embedSearchQuery(queryText);

    const results = vector.searchSimilar(queryVector, { limit: 5 });

    // Should find the VLM embedding
    expect(results.length).toBeGreaterThanOrEqual(1);

    const vlmResult = results.find(r => r.embedding_id === embeddingId);
    expect(vlmResult).toBeDefined();
    expect(vlmResult!.result_type).toBe('vlm');
    expect(vlmResult!.chunk_id).toBeNull();
    expect(vlmResult!.image_id).toBe(imageId);
    expect(vlmResult!.original_text).toContain('bar chart');
    expect(vlmResult!.similarity_score).toBeGreaterThan(0.3);
    expect(vlmResult!.document_id).toBe(docId);
    expect(vlmResult!.provenance_id).toBeTruthy();
    expect(vlmResult!.content_hash).toMatch(/^sha256:/);
  }, 120000);
});

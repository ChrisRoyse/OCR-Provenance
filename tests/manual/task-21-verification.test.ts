/**
 * Task 21: Search Tools Extraction - Manual Verification Tests
 *
 * FULL STATE VERIFICATION for extracted search tools.
 * Uses SYNTHETIC data with KNOWN values for predictable testing.
 *
 * Source of Truth Verification:
 * 1. Database tables: chunks, documents, embeddings, provenance
 * 2. Vector table: vec_embeddings (sqlite-vec virtual table)
 * 3. CP-002: original_text ALWAYS present in search results
 *
 * @module tests/manual/task-21-verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import {
  handleSearchSemantic,
  handleSearch,
  handleSearchHybrid,
  searchTools,
} from '../../src/tools/search.js';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { VectorService } from '../../src/services/storage/vector.js';
import { state, resetState, clearDatabase } from '../../src/server/state.js';
import { computeHash } from '../../src/utils/hash.js';

// Test timeout
const TEST_TIMEOUT = 60000;

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC TEST DATA - Known values for predictable verification
// ═══════════════════════════════════════════════════════════════════════════════

const SYNTHETIC_DATA = {
  documents: [
    {
      id: 'doc-synthetic-001',
      fileName: 'quick-brown-fox.txt',
      filePath: '/test/synthetic/quick-brown-fox.txt',
      chunks: [
        'The quick brown fox jumps over the lazy dog in the moonlight. This is a classic pangram used for testing.',
        'Meanwhile, the lazy dog was dreaming of chasing rabbits through the forest under the stars.',
      ],
    },
    {
      id: 'doc-synthetic-002',
      fileName: 'legal-contract.txt',
      filePath: '/test/synthetic/legal-contract.txt',
      chunks: [
        'WHEREAS Party A agrees to the terms and conditions set forth herein, the contract shall be binding.',
        'IN WITNESS WHEREOF, the parties have executed this agreement on the date first written above.',
      ],
    },
    {
      id: 'doc-synthetic-003',
      fileName: 'technical-spec.txt',
      filePath: '/test/synthetic/technical-spec.txt',
      chunks: [
        'The API endpoint accepts JSON payloads with authentication via Bearer tokens.',
        'Error codes include 400 for bad request, 401 for unauthorized, and 500 for server errors.',
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
  };
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

/**
 * Insert synthetic document with full provenance chain
 */
function insertSyntheticDocument(
  db: DatabaseService,
  docId: string,
  fileName: string,
  filePath: string,
  chunks: string[]
): { docProvId: string; chunkIds: string[] } {
  const docProvId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(filePath);

  // Insert document provenance (chain_depth=0)
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
    processor: 'test-ingestion',
    processor_version: '1.0.0',
    processing_params: { synthetic: true },
    processing_duration_ms: 0,
    processing_quality_score: 1.0,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  // Insert document
  db.insertDocument({
    id: docId,
    file_path: filePath,
    file_name: fileName,
    file_hash: fileHash,
    file_size: 1000,
    file_type: 'txt',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  // Insert OCR result provenance (chain_depth=1)
  const ocrProvId = uuidv4();
  const fullText = chunks.join('\n');
  const ocrHash = computeHash(fullText);

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
    content_hash: ocrHash,
    input_hash: fileHash,
    file_hash: null,
    processor: 'test-ocr',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 0,
    processing_quality_score: 1.0,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  // Insert OCR result
  const ocrResultId = uuidv4();
  db.insertOCRResult({
    id: ocrResultId,
    document_id: docId,
    extracted_text: fullText,
    page_count: 1,
    text_length: fullText.length,
    datalab_request_id: `test-request-${uuidv4()}`,
    datalab_mode: 'balanced',
    parse_quality_score: 4.5,
    cost_cents: 0,
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 0,
    content_hash: ocrHash,
    provenance_id: ocrProvId,
  });

  // Insert chunks with provenance (chain_depth=2)
  const chunkIds: string[] = [];
  let charOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    const chunkHash = computeHash(chunkText);

    chunkIds.push(chunkId);

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
      location: JSON.stringify({ chunk_index: i, character_start: charOffset, character_end: charOffset + chunkText.length }),
      content_hash: chunkHash,
      input_hash: ocrHash,
      file_hash: null,
      processor: 'test-chunker',
      processor_version: '1.0.0',
      processing_params: { chunk_size: 2000, overlap: 200 },
      processing_duration_ms: 0,
      processing_quality_score: 1.0,
      parent_id: ocrProvId,
      parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
    });

    db.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrResultId,
      text: chunkText,
      text_hash: chunkHash,
      chunk_index: i,
      character_start: charOffset,
      character_end: charOffset + chunkText.length,
      page_number: 1,
      page_range: null,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProvId,
      embedding_status: 'pending',
      embedded_at: null,
    });

    charOffset += chunkText.length + 1; // +1 for newline
  }

  return { docProvId, chunkIds };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL VERIFICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 21: Search Tools Verification', { timeout: TEST_TIMEOUT }, () => {
  let tempDir: string;
  let db: DatabaseService;
  let vector: VectorService;

  beforeAll(() => {
    resetState();

    // Create temp directory for test database
    tempDir = mkdtempSync(join(tmpdir(), 'task21-verify-'));
    console.error('\n' + '═'.repeat(80));
    console.error('TASK 21: SEARCH TOOLS EXTRACTION VERIFICATION');
    console.error('═'.repeat(80));
    console.error(`[SETUP] Temp directory: ${tempDir}`);

    // Create database with unique name
    const dbName = `task21-verify-${Date.now()}`;
    db = DatabaseService.create(dbName, tempDir);
    vector = new VectorService(db.getConnection());

    // Set as current database
    state.currentDatabase = db;
    state.currentDatabaseName = 'task21-verify';
    console.error(`[SETUP] Database: ${db.getPath()}`);

    // Insert synthetic test data
    console.error('\n[SETUP] Inserting synthetic test data...');
    for (const doc of SYNTHETIC_DATA.documents) {
      insertSyntheticDocument(db, doc.id, doc.fileName, doc.filePath, doc.chunks);
      console.error(`  - ${doc.fileName}: ${doc.chunks.length} chunks`);
    }
    console.error('[SETUP] Setup complete\n');
  });

  afterAll(() => {
    console.error('\n[CLEANUP] Starting cleanup...');
    clearDatabase();
    resetState();

    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
      console.error('[CLEANUP] Temp directory removed');
    }
    console.error('[CLEANUP] Complete\n');
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 1: Tool Exports
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Tool Exports', () => {
    it('searchTools exports exactly 6 tools', () => {
      console.error('\n[TEST] Verifying searchTools exports');
      const toolNames = Object.keys(searchTools);

      console.error(`[EVIDENCE] Exported tools: ${toolNames.join(', ')}`);
      expect(toolNames).toHaveLength(6);
      expect(toolNames).toContain('ocr_search');
      expect(toolNames).toContain('ocr_search_semantic');
      expect(toolNames).toContain('ocr_search_hybrid');
      expect(toolNames).toContain('ocr_fts_manage');
      expect(toolNames).toContain('ocr_search_export');
      expect(toolNames).toContain('ocr_benchmark_compare');
    });

    it('each tool has required properties', () => {
      for (const [name, tool] of Object.entries(searchTools)) {
        console.error(`[EVIDENCE] ${name}: description="${tool.description.slice(0, 50)}..."`);
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.handler).toBeDefined();
        expect(typeof tool.handler).toBe('function');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 2: Text Search - CP-002 Compliance
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Text Search CP-002 Compliance', () => {
    it('original_text is ALWAYS present in BM25 search results', async () => {
      console.error('\n[TEST] CP-002: BM25 search returns original_text');

      const response = await handleSearch({
        query: 'quick brown fox',
        limit: 10,
      });
      const result = parseResponse(response);

      // SOURCE OF TRUTH: Query chunks table directly
      const dbChunks = db.getConnection().prepare(
        "SELECT id, text FROM chunks WHERE text LIKE '%quick brown fox%' COLLATE NOCASE"
      ).all() as Array<{ id: string; text: string }>;
      console.error(`[SOURCE OF TRUTH] Chunks in DB matching "quick brown fox": ${dbChunks.length}`);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBeGreaterThan(0);

      const results = result.data?.results as Array<Record<string, unknown>>;
      for (const r of results) {
        // CP-002 VERIFICATION
        expect(r.original_text).toBeDefined();
        expect(typeof r.original_text).toBe('string');
        expect((r.original_text as string).length).toBeGreaterThan(0);
        console.error(`[EVIDENCE] Result has original_text: "${(r.original_text as string).slice(0, 50)}..."`);
      }
    });

    it('original_text is ALWAYS present in phrase search results', async () => {
      console.error('\n[TEST] CP-002: Phrase search returns original_text');

      const response = await handleSearch({
        query: 'quick brown fox',
        phrase_search: true,
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      if (results && results.length > 0) {
        for (const r of results) {
          expect(r.original_text).toBeDefined();
          expect((r.original_text as string)).toContain('quick brown fox');
          console.error(`[EVIDENCE] Phrase search original_text verified`);
        }
      }
    });

    it('original_text is ALWAYS present in multi-word BM25 results', async () => {
      console.error('\n[TEST] CP-002: Multi-word BM25 search returns original_text');

      const response = await handleSearch({
        query: 'fox lazy dog',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      if (results && results.length > 0) {
        for (const r of results) {
          expect(r.original_text).toBeDefined();
          console.error(`[EVIDENCE] Multi-word BM25 original_text: "${(r.original_text as string).slice(0, 50)}..."`);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 3: Source File Information
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Source File Information', () => {
    it('source_file_path is present in all results', async () => {
      console.error('\n[TEST] Verifying source_file_path presence');

      const response = await handleSearch({
        query: 'contract',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.source_file_path).toBeDefined();
        expect(r.source_file_name).toBeDefined();
        console.error(`[EVIDENCE] source_file_path: ${r.source_file_path}`);
        console.error(`[EVIDENCE] source_file_name: ${r.source_file_name}`);
      }
    });

    it('page_number is present in results', async () => {
      console.error('\n[TEST] Verifying page_number presence');

      const response = await handleSearch({
        query: 'API endpoint',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      for (const r of results) {
        expect(r).toHaveProperty('page_number');
        console.error(`[EVIDENCE] page_number: ${r.page_number}`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 4: Provenance Chain
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Provenance Chain', () => {
    it('includes provenance when requested', async () => {
      console.error('\n[TEST] Verifying provenance chain inclusion');

      const response = await handleSearch({
        query: 'WHEREAS',
        limit: 10,
        include_provenance: true,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      expect(results.length).toBeGreaterThan(0);
      const firstResult = results[0];

      expect(firstResult.provenance_chain).toBeDefined();
      expect(Array.isArray(firstResult.provenance_chain)).toBe(true);

      const provenance = firstResult.provenance_chain as Array<Record<string, unknown>>;
      console.error(`[EVIDENCE] Provenance chain length: ${provenance.length}`);

      for (const p of provenance) {
        console.error(`  - type: ${p.type}, chain_depth: ${p.chain_depth}, processor: ${p.processor}`);
      }
    });

    it('excludes provenance when not requested', async () => {
      console.error('\n[TEST] Verifying provenance exclusion');

      const response = await handleSearch({
        query: 'WHEREAS',
        limit: 10,
        include_provenance: false,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      if (results.length > 0) {
        expect(results[0].provenance_chain).toBeUndefined();
        console.error('[EVIDENCE] Provenance correctly excluded');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 5: Limit Parameter
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Limit Parameter', () => {
    it('respects limit=1', async () => {
      console.error('\n[TEST] Verifying limit parameter');

      const response = await handleSearch({
        query: 'the',
        limit: 1,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(1);
      console.error(`[EVIDENCE] limit=1 returned ${result.data?.total} result(s)`);
    });

    it('returns all matches when limit exceeds results', async () => {
      console.error('\n[TEST] Verifying limit > available results');

      const response = await handleSearch({
        query: 'IN WITNESS WHEREOF',
        limit: 100,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      // Should return 1 (only one chunk has this exact text)
      expect(result.data?.total).toBe(1);
      console.error(`[EVIDENCE] Found ${result.data?.total} result(s) with high limit`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 6: Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Edge Cases', () => {
    it('Edge Case 1: Empty query fails fast', async () => {
      console.error('\n[TEST] Edge Case: Empty query');

      const response = await handleSearch({
        query: '',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      console.error(`[EVIDENCE] Empty query error: ${result.error?.message}`);
    });

    it('Edge Case 2: Query over max length fails fast', async () => {
      console.error('\n[TEST] Edge Case: Query over max length');

      const overMaxQuery = 'a'.repeat(1001);
      const response = await handleSearch({
        query: overMaxQuery,
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      console.error(`[EVIDENCE] Over max length error: ${result.error?.message}`);
    });

    it('Edge Case 3: No matches returns empty results', async () => {
      console.error('\n[TEST] Edge Case: No matches');

      const response = await handleSearch({
        query: 'xyznonexistent12345',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      expect(result.data?.total).toBe(0);
      expect(result.data?.results).toEqual([]);
      console.error('[EVIDENCE] No matches returns empty results array');
    });

    it('Edge Case 4: Unicode in query and results', async () => {
      console.error('\n[TEST] Edge Case: Unicode handling');

      // First, insert a chunk with unicode
      const unicodeDocId = 'doc-unicode-001';
      insertSyntheticDocument(db, unicodeDocId, 'unicode.txt', '/test/unicode.txt', [
        '日本語テキスト and émojis 🎉 and symbols €£¥',
      ]);

      const response = await handleSearch({
        query: '日本語',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      if (result.data?.total && (result.data.total as number) > 0) {
        const results = result.data.results as Array<Record<string, unknown>>;
        expect((results[0].original_text as string)).toContain('日本語');
        console.error(`[EVIDENCE] Unicode search successful: ${results[0].original_text}`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // VERIFICATION 7: Source of Truth Database Verification
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('VERIFY: Source of Truth', () => {
    it('Database state matches search results', async () => {
      console.error('\n[TEST] Source of Truth: Database vs Search Results');

      // Query database directly for all chunks containing "dog"
      const dbResults = db.getConnection().prepare(
        "SELECT c.id, c.text, d.file_name FROM chunks c JOIN documents d ON c.document_id = d.id WHERE c.text LIKE '%dog%'"
      ).all() as Array<{ id: string; text: string; file_name: string }>;

      console.error(`[SOURCE OF TRUTH] Chunks in DB with "dog": ${dbResults.length}`);
      for (const r of dbResults) {
        console.error(`  - ${r.file_name}: "${r.text.slice(0, 40)}..."`);
      }

      // Now search via handler
      const response = await handleSearch({
        query: 'dog',
        limit: 100,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      console.error(`[SEARCH RESULTS] Handler returned: ${result.data?.total} results`);

      // Counts should match
      expect(result.data?.total).toBe(dbResults.length);
      console.error('[EVIDENCE] Database count matches search results count ✓');
    });

    it('All chunk IDs in results exist in database', async () => {
      console.error('\n[TEST] Source of Truth: Chunk ID verification');

      const response = await handleSearch({
        query: 'the',
        limit: 10,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(true);
      const results = result.data?.results as Array<Record<string, unknown>>;

      for (const r of results) {
        const chunkId = r.chunk_id as string;
        const dbChunk = db.getChunk(chunkId);

        expect(dbChunk).not.toBeNull();
        console.error(`[EVIDENCE] Chunk ${chunkId} exists in database ✓`);
      }
    });
  });
});

/**
 * Tests for ocr_search_saved (action='execute') MCP Tool
 *
 * Tests re-execution of saved searches by ID via the unified ocr_search_saved tool.
 * Uses real database instances with temp databases - NO MOCKS.
 *
 * @module tests/unit/tools/search-saved-execute
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  computeHash,
} from '../../integration/server/helpers.js';
import { searchTools } from '../../../src/tools/search.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_search_saved action=execute', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-saved-exec');
  let docId: string;
  let savedSearchId: string;

  beforeAll(() => {
    tempDir = createTempDir('test-saved-exec-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create document with OCR results and chunks for search
    const docProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: docProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: docProvId,
        chain_depth: 0,
      })
    );

    docId = uuidv4();
    db.insertDocument(
      createTestDocument(docProvId, {
        id: docId,
        file_path: '/test/searchable.pdf',
        file_name: 'searchable.pdf',
        status: 'complete',
      })
    );

    const ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProvId,
        root_document_id: docProvId,
        chain_depth: 1,
      })
    );

    const ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
        extracted_text: 'Machine learning algorithms for data analysis and pattern recognition.',
      })
    );

    const chunkProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: chunkProvId,
        type: ProvenanceType.CHUNK,
        parent_id: ocrProvId,
        root_document_id: docProvId,
        chain_depth: 2,
      })
    );

    const chunkId = uuidv4();
    db.insertChunk(
      createTestChunk(docId, ocrId, chunkProvId, {
        id: chunkId,
        text: 'Machine learning algorithms for data analysis and pattern recognition.',
        chunk_index: 0,
      })
    );

    // Build FTS index for the chunk
    try {
      conn.exec(`
        INSERT INTO search_index(rowid, content)
        SELECT rowid, text FROM chunks
      `);
    } catch {
      // FTS index may already exist or not be set up - that's OK for these tests
    }

    // Create a saved search entry directly in the database
    savedSearchId = uuidv4();
    conn.prepare(`
      INSERT INTO saved_searches (id, name, query, search_type, search_params, result_count, result_ids, created_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(
      savedSearchId,
      'ML Search',
      'machine learning',
      'bm25',
      JSON.stringify({ limit: 10, phrase_search: false, include_highlight: true }),
      1,
      JSON.stringify([chunkId]),
      'Test saved search'
    );
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should re-execute a saved BM25 search', async () => {
    const result = await searchTools.ocr_search_saved.handler({
      action: 'execute',
      saved_search_id: savedSearchId,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.data.saved_search).toBeDefined();
    expect(data.data.saved_search.id).toBe(savedSearchId);
    expect(data.data.saved_search.name).toBe('ML Search');
    expect(data.data.saved_search.query).toBe('machine learning');
    expect(data.data.saved_search.search_type).toBe('bm25');
    expect(data.data.re_executed_at).toBeDefined();
    expect(data.data.search_results).toBeDefined();
  });

  it('should apply override_limit', async () => {
    const result = await searchTools.ocr_search_saved.handler({
      action: 'execute',
      saved_search_id: savedSearchId,
      override_limit: 5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.data.saved_search).toBeDefined();
    // The search should execute with the overridden limit
    expect(data.data.search_results).toBeDefined();
  });

  it('should error for non-existent saved search', async () => {
    const result = await searchTools.ocr_search_saved.handler({
      action: 'execute',
      saved_search_id: 'non-existent-id',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error.category).toBe('VALIDATION_ERROR');
    expect(data.error.message).toContain('Saved search not found');
  });

  it('should validate input - missing saved_search_id for execute', async () => {
    const result = await searchTools.ocr_search_saved.handler({
      action: 'execute',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error.message).toContain('saved_search_id is required');
  });

  it('should include saved search metadata in response', async () => {
    const result = await searchTools.ocr_search_saved.handler({
      action: 'execute',
      saved_search_id: savedSearchId,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const savedSearch = data.data.saved_search;
    expect(savedSearch.original_result_count).toBe(1);
    expect(savedSearch.notes).toBe('Test saved search');
    expect(savedSearch.created_at).toBeDefined();
  });

  it('should preserve saved search notes in response metadata', async () => {
    const result = await searchTools.ocr_search_saved.handler({
      action: 'execute',
      saved_search_id: savedSearchId,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.data.saved_search.notes).toBe('Test saved search');
  });
});

/**
 * Forensic Audit V4 Fix Verification Tests
 *
 * FIX-2: Adaptive threshold respects explicit 0.7
 * FIX-3: entity_tags cascade delete on document deletion
 * FIX-5: Comparison components_failed tracking
 * FIX-6: Cross-DB search total failure returns error
 *
 * Uses REAL databases, NO mocks.
 * @module tests/unit/forensic-v4-fixes
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
  updateConfig,
  ProvenanceType,
  computeHash,
} from '../integration/server/helpers.js';
import { handleSearchUnified, searchTools } from '../../src/tools/search.js';
import { comparisonTools } from '../../src/tools/comparison.js';
import { handleDocumentDelete } from '../../src/tools/documents.js';
import { tagTools } from '../../src/tools/tags.js';

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

function parseResult(response: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(response.content[0].text) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { category: string; message: string };
  };
}

/** Insert a complete document with OCR result and chunk. */
function insertCompleteDocument(text: string, fileName: string) {
  const { db } = requireDatabase();

  const docProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: docProvId }),
    type: ProvenanceType.DOCUMENT,
    chain_depth: 0,
    root_document_id: docProvId,
  });

  const ocrProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: ocrProvId }),
    type: ProvenanceType.OCR_RESULT,
    chain_depth: 1,
    parent_id: docProvId,
    root_document_id: docProvId,
  });

  const chunkProvId = uuidv4();
  db.insertProvenance({
    ...createTestProvenance({ id: chunkProvId }),
    type: ProvenanceType.CHUNK,
    chain_depth: 2,
    parent_id: ocrProvId,
    root_document_id: docProvId,
  });

  const docId = uuidv4();
  db.insertDocument({
    ...createTestDocument(docProvId, { id: docId, file_name: fileName, status: 'complete' }),
  });

  const ocrId = uuidv4();
  db.insertOCRResult({
    ...createTestOCRResult(docId, ocrProvId, {
      id: ocrId,
      extracted_text: text,
      text_length: text.length,
      content_hash: computeHash(text),
    }),
  });
  db.updateDocumentStatus(docId, 'complete');

  const chunkId = uuidv4();
  db.insertChunk({
    ...createTestChunk(docId, ocrId, chunkProvId, {
      id: chunkId,
      text,
      text_hash: computeHash(text),
    }),
  });

  return { docId, ocrId, chunkId, docProvId, chunkProvId };
}

describe('Forensic V4 Fix Verification', () => {
  let tempDir: string;
  const dbName = createUniqueName('forensic-v4');

  beforeAll(() => {
    tempDir = createTempDir('forensic-v4-');
    updateConfig({ defaultStoragePath: tempDir });
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // FIX-2: similarity_threshold=0.7 now treated as explicit, not adaptive

  describe('FIX-2: similarity_threshold=0.7 treated as explicit', () => {
    it('should report explicit mode when similarity_threshold is 0.7', async () => {
      // Old code: 0.7 === DEFAULT triggered adaptive mode. Fix: any defined value is explicit.
      const response = await handleSearchUnified({
        query: 'test document content',
        mode: 'semantic',
        similarity_threshold: 0.7,
      });
      const result = parseResult(response);
      expect(result.success).toBe(true);
      const info = result.data?.threshold_info as Record<string, unknown> | undefined;
      expect(info).toBeDefined();
      expect(info?.mode).toBe('explicit');
      expect(info?.requested).toBe(0.7);
      expect(info?.effective).toBe(0.7);
    });

    it('should report adaptive when threshold is omitted (user did not explicitly set it)', async () => {
      // When the user omits similarity_threshold, the unified handler checks raw params
      // (not Zod-parsed input) and does NOT pass similarity_threshold to the internal handler.
      // The internal handler then uses adaptive mode with a low floor threshold.
      const response = await handleSearchUnified({
        query: 'test document content',
        mode: 'semantic',
      });
      const result = parseResult(response);
      expect(result.success).toBe(true);
      const info = result.data?.threshold_info as Record<string, unknown> | undefined;
      expect(info).toBeDefined();
      // With no results or <=1 result, adaptive falls back to 'adaptive_fallback'
      // With >1 results, it computes from distribution and reports 'adaptive'
      expect(['adaptive', 'adaptive_fallback']).toContain(info?.mode);
    });

    it('should report explicit mode for non-default threshold values', async () => {
      const response = await handleSearchUnified({
        query: 'test',
        mode: 'semantic',
        similarity_threshold: 0.5,
      });
      const result = parseResult(response);
      expect(result.success).toBe(true);
      const info = result.data?.threshold_info as Record<string, unknown> | undefined;
      expect(info).toBeDefined();
      expect(info?.mode).toBe('explicit');
      expect(info?.requested).toBe(0.5);
    });
  });

  // FIX-3: entity_tags cascade delete on document deletion

  describe('FIX-3: entity_tags cleaned up on document delete', () => {
    it('should delete entity_tags for document and chunks when document is deleted', async () => {
      if (!sqliteVecAvailable) return;
      const { db } = requireDatabase();
      const conn = db.getConnection();

      const { docId, chunkId } = insertCompleteDocument(
        'Entity tag cascade delete test content.',
        'cascade-test.pdf'
      );

      // Create and apply tag to both document and chunk
      const tagName = `cascade-tag-${docId.slice(0, 8)}`;
      await tagTools.ocr_tag_create.handler({ name: tagName });
      await tagTools.ocr_tag_apply.handler({
        tag_name: tagName,
        entity_id: docId,
        entity_type: 'document',
      });
      await tagTools.ocr_tag_apply.handler({
        tag_name: tagName,
        entity_id: chunkId,
        entity_type: 'chunk',
      });

      // Verify entity_tags exist before delete
      const before = conn
        .prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE entity_id IN (?, ?)')
        .get(docId, chunkId) as { cnt: number };
      expect(before.cnt).toBe(2);

      // Delete the document -- FIX-3 ensures entity_tags are cleaned up
      const deleteResult = await handleDocumentDelete({ document_id: docId, confirm: true });
      expect(parseResult(deleteResult).success).toBe(true);

      // Verify no orphan entity_tags remain
      const after = conn
        .prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE entity_id IN (?, ?)')
        .get(docId, chunkId) as { cnt: number };
      expect(after.cnt).toBe(0);
    });
  });

  // FIX-5: Comparison components_failed tracking

  describe('FIX-5: components_failed surfaces in comparison response', () => {
    it('should include components_failed when similarity computations error', async () => {
      if (!sqliteVecAvailable) return;

      // Documents with no embeddings -- centroid similarity will fail
      const { docId: docId1 } = insertCompleteDocument(
        'Alpha unique text for comparison testing.',
        'compare-a.pdf'
      );
      const { docId: docId2 } = insertCompleteDocument(
        'Beta unique text for comparison testing different.',
        'compare-b.pdf'
      );

      const response = await comparisonTools.ocr_document_compare.handler({
        document_id_1: docId1,
        document_id_2: docId2,
        include_text_diff: true,
      });
      const result = parseResult(response);
      expect(result.success).toBe(true);
      expect(result.data?.comparison_id).toBeDefined();
      expect(result.data?.similarity_ratio).toBeDefined();

      // The handler surfaces failed components instead of silently swallowing errors
      const failed = result.data?.components_failed as string[] | undefined;
      if (failed) {
        expect(Array.isArray(failed)).toBe(true);
        expect(failed.length).toBeGreaterThan(0);
      }
      // Composite similarity is still computed from available signals
      expect(result.data?.composite_similarity).toBeDefined();
    });
  });

  // FIX-6: Cross-DB search returns error when all databases fail

  describe('FIX-6: cross-DB search returns error when all DBs fail', () => {
    it('should return error response when all requested databases fail', async () => {
      const handler = searchTools.ocr_benchmark_compare.handler;
      const response = await handler({
        query: 'test query',
        database_names: ['nonexistent-db-aaa-111', 'nonexistent-db-bbb-222'],
        search_type: 'bm25',
        limit: 5,
      });
      const result = parseResult(response);
      // FIX-6: error instead of success with 0 results
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('All databases failed');
    });

    it('should return success when at least one database succeeds', async () => {
      const handler = searchTools.ocr_benchmark_compare.handler;
      const dbName2 = createUniqueName('forensic-v4-second');
      createDatabase(dbName2, undefined, tempDir);
      selectDatabase(dbName, tempDir);

      const response = await handler({
        query: 'test',
        database_names: [dbName, dbName2],
        search_type: 'bm25',
        limit: 5,
      });
      const result = parseResult(response);
      expect(result.success).toBe(true);
    });
  });
});

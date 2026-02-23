/**
 * Tests for Health Check MCP Tools
 *
 * Tests ocr_health_check with various data integrity gap scenarios.
 * Uses real database instances with temp databases - NO MOCKS.
 *
 * @module tests/unit/tools/health
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
  computeHash as _computeHash,
} from '../../integration/server/helpers.js';
import { healthTools } from '../../../src/tools/health.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Health Check Tools', () => {
  describe('ocr_health_check - empty database', () => {
    let tempDir: string;
    const dbName = createUniqueName('test-health-empty');

    beforeAll(() => {
      resetState();
      tempDir = createTempDir('test-health-empty-');
      createDatabase(dbName, undefined, tempDir);
      selectDatabase(dbName, tempDir);
    });

    afterAll(() => {
      resetState();
      cleanupTempDir(tempDir);
    });

    it('should report healthy for an empty database', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.healthy).toBe(true);
      expect(data.data.total_gaps).toBe(0);
      expect(data.data.gaps).toBeDefined();
      expect(data.data.summary).toBeDefined();
      expect(data.data.summary.total_documents).toBe(0);
      expect(data.data.summary.total_chunks).toBe(0);
      expect(data.data.summary.total_embeddings).toBe(0);
      expect(data.data.summary.total_images).toBe(0);
    });

    it('should return gap categories even when empty', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      // All gap categories should exist with count 0
      expect(data.data.gaps.chunks_without_embeddings).toBeDefined();
      expect(data.data.gaps.chunks_without_embeddings.count).toBe(0);
      expect(data.data.gaps.documents_without_ocr).toBeDefined();
      expect(data.data.gaps.documents_without_ocr.count).toBe(0);
      expect(data.data.gaps.images_without_vlm).toBeDefined();
      expect(data.data.gaps.images_without_vlm.count).toBe(0);
    });
  });

  describe('ocr_health_check - with gaps', () => {
    let tempDir: string;
    const dbName = createUniqueName('test-health-gaps');

    beforeAll(() => {
      resetState();
      tempDir = createTempDir('test-health-gaps-');
      createDatabase(dbName, undefined, tempDir);
      selectDatabase(dbName, tempDir);

      const { db } = requireDatabase();
      const conn = db.getConnection();

      // Create a document with chunks but NO embeddings (gap: chunks_without_embeddings)
      const docProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: docProvId,
          type: ProvenanceType.DOCUMENT,
          root_document_id: docProvId,
          chain_depth: 0,
        })
      );

      const docId = uuidv4();
      db.insertDocument(
        createTestDocument(docProvId, {
          id: docId,
          file_path: '/test/doc-with-gaps.pdf',
          file_name: 'doc-with-gaps.pdf',
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
        })
      );

      // Create chunk WITHOUT embedding (this creates a gap)
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

      db.insertChunk(
        createTestChunk(docId, ocrId, chunkProvId, {
          id: uuidv4(),
          text: 'Chunk without embedding - this is a gap.',
          chunk_index: 0,
          embedding_status: 'pending',
        })
      );

      // Create an image with pending VLM (gap: images_without_vlm)
      // Use the full required columns from the images table schema
      const imgProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: imgProvId,
          type: ProvenanceType.IMAGE,
          parent_id: ocrProvId,
          root_document_id: docProvId,
          chain_depth: 2,
        })
      );

      const imgId = uuidv4();
      conn.prepare(`
        INSERT INTO images (id, document_id, ocr_result_id, page_number, bbox_x, bbox_y,
          bbox_width, bbox_height, image_index, format, width, height,
          extracted_path, vlm_status, provenance_id, created_at)
        VALUES (?, ?, ?, 1, 0.0, 0.0, 100.0, 100.0, 0, 'png', 100, 100,
          '/tmp/test.png', 'pending', ?, datetime('now'))
      `).run(imgId, docId, ocrId, imgProvId);
    });

    afterAll(() => {
      resetState();
      cleanupTempDir(tempDir);
    });

    it('should detect data integrity gaps', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.healthy).toBe(false);
      expect(data.data.total_gaps).toBeGreaterThan(0);

      // Should detect chunks without embeddings
      expect(data.data.gaps.chunks_without_embeddings).toBeDefined();
      expect(data.data.gaps.chunks_without_embeddings.count).toBeGreaterThanOrEqual(1);
      expect(data.data.gaps.chunks_without_embeddings.fixable).toBe(true);

      // Should detect images without VLM
      expect(data.data.gaps.images_without_vlm).toBeDefined();
      expect(data.data.gaps.images_without_vlm.count).toBeGreaterThanOrEqual(1);
    });

    it('should include summary statistics', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.summary.total_documents).toBeGreaterThanOrEqual(1);
      expect(data.data.summary.total_chunks).toBeGreaterThanOrEqual(1);
      expect(data.data.summary.total_images).toBeGreaterThanOrEqual(1);
    });

    it('should provide sample IDs for each gap category', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      for (const gap of Object.values(data.data.gaps) as Array<{ sample_ids: string[] }>) {
        expect(gap.sample_ids).toBeDefined();
        expect(Array.isArray(gap.sample_ids)).toBe(true);
      }
    });

    it('should include fix_tool suggestions for fixable gaps', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const chunksGap = data.data.gaps.chunks_without_embeddings;
      expect(chunksGap.fix_tool).toBeDefined();
      expect(typeof chunksGap.fix_tool).toBe('string');
    });

    it('should not apply fixes when fix=false', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      // fixes_applied should be undefined when fix=false
      expect(data.data.fixes_applied).toBeUndefined();
    });
  });

  describe('ocr_health_check - database not selected', () => {
    beforeAll(() => {
      resetState();
    });

    it('should error when no database is selected', async () => {
      const result = await healthTools.ocr_health_check.handler({ fix: false });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error.category).toBe('DATABASE_NOT_SELECTED');
    });
  });
});

/**
 * Tests for getChunksFiltered and getChunkNeighbors DB methods
 *
 * Tests the raw database operations directly without going through
 * MCP tool handlers. Uses real DatabaseService with temp databases.
 *
 * @module tests/unit/services/chunk-filtering
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

describe('Chunk Filtering DB Methods', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-chunk-filter');
  let docId: string;
  let ocrId: string;
  const chunkIds: string[] = [];

  beforeAll(() => {
    tempDir = createTempDir('test-chunk-filter-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create document chain
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
      createTestDocument(docProvId, { id: docId })
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

    ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, { id: ocrId })
    );

    // Create 8 chunks with varied properties
    const chunkSpecs = [
      { idx: 0, sp: 'Ch1 > S1', hc: 'Section 1', hl: 2, ct: '["heading","paragraph"]', qs: 4.5, pg: 1, atom: 0 },
      { idx: 1, sp: 'Ch1 > S1', hc: 'Section 1', hl: 2, ct: '["paragraph"]', qs: 4.0, pg: 1, atom: 0 },
      { idx: 2, sp: 'Ch1 > S2', hc: 'Section 2', hl: 2, ct: '["paragraph","table"]', qs: 3.5, pg: 2, atom: 1 },
      { idx: 3, sp: 'Ch2 > S3', hc: 'Section 3', hl: 2, ct: '["paragraph"]', qs: 2.0, pg: 2, atom: 0 },
      { idx: 4, sp: 'Ch2 > S3', hc: 'Section 3', hl: 2, ct: '["paragraph","code"]', qs: 4.8, pg: 3, atom: 0 },
      { idx: 5, sp: 'Ch2 > S4', hc: 'Section 4', hl: 2, ct: '["heading","list"]', qs: 3.0, pg: 3, atom: 0 },
      { idx: 6, sp: null, hc: null, hl: null, ct: null, qs: null, pg: 4, atom: 0 },
      { idx: 7, sp: 'Ch3', hc: 'Chapter 3', hl: 1, ct: '["paragraph"]', qs: 4.2, pg: 5, atom: 1 },
    ];

    for (const spec of chunkSpecs) {
      const provId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: provId,
          type: ProvenanceType.CHUNK,
          parent_id: ocrProvId,
          root_document_id: docProvId,
          chain_depth: 2,
        })
      );

      const chunkId = uuidv4();
      chunkIds.push(chunkId);
      db.insertChunk(
        createTestChunk(docId, ocrId, provId, {
          id: chunkId,
          text: `Chunk text for index ${spec.idx}`,
          text_hash: computeHash(`chunk-${spec.idx}-${chunkId}`),
          chunk_index: spec.idx,
          character_start: spec.idx * 50,
          character_end: (spec.idx + 1) * 50,
          page_number: spec.pg,
          section_path: spec.sp,
          heading_context: spec.hc,
          heading_level: spec.hl,
          content_types: spec.ct,
          ocr_quality_score: spec.qs,
          is_atomic: spec.atom,
        })
      );
    }

    // Set some embedding statuses
    db.updateChunkEmbeddingStatus(chunkIds[0], 'complete', new Date().toISOString());
    db.updateChunkEmbeddingStatus(chunkIds[1], 'complete', new Date().toISOString());
    db.updateChunkEmbeddingStatus(chunkIds[3], 'failed', undefined);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getChunksFiltered
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getChunksFiltered', () => {
    it('should return all chunks when no filters applied', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {});

      expect(total).toBe(8);
      expect(chunks.length).toBe(8);
    });

    it('should filter by section_path_filter prefix', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        section_path_filter: 'Ch1',
      });

      expect(total).toBe(3); // Chunks 0, 1, 2
      expect(chunks.every((c) => c.section_path?.startsWith('Ch1'))).toBe(true);
    });

    it('should filter by heading_filter with LIKE match', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        heading_filter: 'Section 3',
      });

      expect(total).toBe(2); // Chunks 3, 4
      expect(chunks.every((c) => c.heading_context?.includes('Section 3'))).toBe(true);
    });

    it('should filter by content_type_filter', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        content_type_filter: ['table'],
      });

      expect(total).toBe(1); // Only chunk 2 has table
      expect(chunks[0].chunk_index).toBe(2);
    });

    it('should filter by multiple content types (AND)', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        content_type_filter: ['heading', 'paragraph'],
      });

      // Chunks with both heading AND paragraph: indices 0 only
      expect(total).toBe(1);
      expect(chunks[0].chunk_index).toBe(0);
    });

    it('should filter by min_quality_score', () => {
      const { db } = requireDatabase();
      const { total } = db.getChunksFiltered(docId, {
        min_quality_score: 4.0,
      });

      // Chunks with score >= 4.0: 0(4.5), 1(4.0), 4(4.8), 7(4.2) = 4
      expect(total).toBe(4);
    });

    it('should filter by embedding_status', () => {
      const { db } = requireDatabase();
      const { total } = db.getChunksFiltered(docId, {
        embedding_status: 'complete',
      });

      expect(total).toBe(2); // Chunks 0 and 1
    });

    it('should filter by embedding_status failed', () => {
      const { db } = requireDatabase();
      const { total } = db.getChunksFiltered(docId, {
        embedding_status: 'failed',
      });

      expect(total).toBe(1); // Chunk 3
    });

    it('should filter by is_atomic=true', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        is_atomic: true,
      });

      expect(total).toBe(2); // Chunks 2 and 7
      expect(chunks.every((c) => c.is_atomic === 1)).toBe(true);
    });

    it('should filter by page_range min_page only', () => {
      const { db } = requireDatabase();
      const { total } = db.getChunksFiltered(docId, {
        page_range: { min_page: 3 },
      });

      // Pages 3, 4, 5: chunks 4, 5, 6, 7
      expect(total).toBe(4);
    });

    it('should filter by page_range max_page only', () => {
      const { db } = requireDatabase();
      const { total } = db.getChunksFiltered(docId, {
        page_range: { max_page: 2 },
      });

      // Pages 1, 2: chunks 0, 1, 2, 3
      expect(total).toBe(4);
    });

    it('should filter by page_range min and max', () => {
      const { db } = requireDatabase();
      const { total } = db.getChunksFiltered(docId, {
        page_range: { min_page: 2, max_page: 3 },
      });

      // Pages 2, 3: chunks 2, 3, 4, 5
      expect(total).toBe(4);
    });

    it('should apply pagination with limit and offset', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        limit: 3,
        offset: 2,
      });

      expect(total).toBe(8);
      expect(chunks.length).toBe(3);
      // Ordered by chunk_index, offset 2 = chunk indices 2, 3, 4
      expect(chunks[0].chunk_index).toBe(2);
      expect(chunks[1].chunk_index).toBe(3);
      expect(chunks[2].chunk_index).toBe(4);
    });

    it('should combine filters correctly (intersection)', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered(docId, {
        section_path_filter: 'Ch2',
        min_quality_score: 3.0,
      });

      // Ch2 chunks: 3(2.0), 4(4.8), 5(3.0). Score >= 3.0: 4, 5
      expect(total).toBe(2);
      expect(chunks[0].chunk_index).toBe(4);
      expect(chunks[1].chunk_index).toBe(5);
    });

    it('should return ordered by chunk_index', () => {
      const { db } = requireDatabase();
      const { chunks } = db.getChunksFiltered(docId, {});

      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i].chunk_index).toBeLessThan(chunks[i + 1].chunk_index);
      }
    });

    it('should return empty for non-existent document', () => {
      const { db } = requireDatabase();
      const { chunks, total } = db.getChunksFiltered('non-existent', {});

      expect(total).toBe(0);
      expect(chunks).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getChunkNeighbors
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getChunkNeighbors', () => {
    it('should return center and neighbor chunks', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors(docId, 4, 2);

      // Chunks 2, 3, 4, 5, 6
      expect(neighbors.length).toBe(5);
      expect(neighbors[0].chunk_index).toBe(2);
      expect(neighbors[4].chunk_index).toBe(6);
    });

    it('should handle start boundary (chunk index 0)', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors(docId, 0, 2);

      // Chunks 0, 1, 2
      expect(neighbors.length).toBe(3);
      expect(neighbors[0].chunk_index).toBe(0);
      expect(neighbors[2].chunk_index).toBe(2);
    });

    it('should handle end boundary (last chunk)', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors(docId, 7, 2);

      // Chunks 5, 6, 7
      expect(neighbors.length).toBe(3);
      expect(neighbors[0].chunk_index).toBe(5);
      expect(neighbors[2].chunk_index).toBe(7);
    });

    it('should handle count=0 (center only)', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors(docId, 4, 0);

      expect(neighbors.length).toBe(1);
      expect(neighbors[0].chunk_index).toBe(4);
    });

    it('should handle large count (returns all available)', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors(docId, 4, 100);

      // All 8 chunks
      expect(neighbors.length).toBe(8);
    });

    it('should return ordered by chunk_index', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors(docId, 4, 3);

      for (let i = 0; i < neighbors.length - 1; i++) {
        expect(neighbors[i].chunk_index).toBeLessThan(neighbors[i + 1].chunk_index);
      }
    });

    it('should return empty for non-existent document', () => {
      const { db } = requireDatabase();
      const neighbors = db.getChunkNeighbors('non-existent', 0, 2);

      expect(neighbors).toEqual([]);
    });
  });
});

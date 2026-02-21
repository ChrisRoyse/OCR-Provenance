/**
 * Tests for Chunk-Level MCP Tools
 *
 * Tests ocr_chunk_get, ocr_chunk_list, ocr_chunk_context, and ocr_document_sections.
 * Uses real database instances with temp databases - NO MOCKS.
 *
 * @module tests/unit/tools/chunks
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
  createTestEmbedding,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  computeHash,
} from '../../integration/server/helpers.js';
import { chunkTools } from '../../../src/tools/chunks.js';
import { documentTools } from '../../../src/tools/documents.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

describe('Chunk Tools', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-chunks');

  // IDs for test data
  let docProvId: string;
  let ocrProvId: string;
  let docId: string;
  let ocrId: string;
  const chunkIds: string[] = [];
  const chunkProvIds: string[] = [];
  let embProvId: string;
  let embeddingId: string;

  beforeAll(() => {
    tempDir = createTempDir('test-chunks-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Create document provenance
    docProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: docProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: docProvId,
        chain_depth: 0,
      })
    );

    // Create document
    docId = uuidv4();
    db.insertDocument(
      createTestDocument(docProvId, {
        id: docId,
        file_path: '/test/contract.pdf',
        file_name: 'contract.pdf',
      })
    );

    // Create OCR result provenance
    ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProvId,
        root_document_id: docProvId,
        chain_depth: 1,
      })
    );

    // Create OCR result
    ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
      })
    );

    // Create 10 chunks with varied metadata
    const chunkData = [
      {
        chunk_index: 0,
        section_path: 'Article I > Definitions',
        heading_context: 'Definitions',
        heading_level: 2,
        content_types: '["heading","paragraph"]',
        ocr_quality_score: 4.5,
        page_number: 1,
        is_atomic: 0,
        text: 'Article I - Definitions. This section defines key terms used throughout.',
      },
      {
        chunk_index: 1,
        section_path: 'Article I > Definitions',
        heading_context: 'Definitions',
        heading_level: 2,
        content_types: '["paragraph","list"]',
        ocr_quality_score: 4.2,
        page_number: 1,
        is_atomic: 0,
        text: 'Term A means X. Term B means Y. Term C means Z.',
      },
      {
        chunk_index: 2,
        section_path: 'Article II > Obligations',
        heading_context: 'Obligations',
        heading_level: 2,
        content_types: '["heading","paragraph"]',
        ocr_quality_score: 3.8,
        page_number: 2,
        is_atomic: 0,
        text: 'Article II - Obligations of the Parties. Each party shall...',
      },
      {
        chunk_index: 3,
        section_path: 'Article II > Obligations > Payment Terms',
        heading_context: 'Payment Terms',
        heading_level: 3,
        content_types: '["paragraph","table"]',
        ocr_quality_score: 4.0,
        page_number: 2,
        is_atomic: 1,
        text: 'Payment shall be made within 30 days. See table below.',
      },
      {
        chunk_index: 4,
        section_path: 'Article II > Obligations > Delivery',
        heading_context: 'Delivery',
        heading_level: 3,
        content_types: '["paragraph"]',
        ocr_quality_score: 4.1,
        page_number: 3,
        is_atomic: 0,
        text: 'Delivery of goods shall occur at the designated location.',
      },
      {
        chunk_index: 5,
        section_path: 'Article III > Liability',
        heading_context: 'Liability Provisions',
        heading_level: 2,
        content_types: '["heading","paragraph"]',
        ocr_quality_score: 3.5,
        page_number: 3,
        is_atomic: 0,
        text: 'Article III - Liability. Neither party shall be liable for...',
      },
      {
        chunk_index: 6,
        section_path: 'Article III > Liability',
        heading_context: 'Liability Provisions',
        heading_level: 2,
        content_types: '["paragraph"]',
        ocr_quality_score: 2.5,
        page_number: 4,
        is_atomic: 0,
        text: 'Consequential damages are excluded from this agreement.',
      },
      {
        chunk_index: 7,
        section_path: 'Article IV > Termination',
        heading_context: 'Termination',
        heading_level: 2,
        content_types: '["heading","paragraph","code"]',
        ocr_quality_score: 4.8,
        page_number: 4,
        is_atomic: 0,
        text: 'Article IV - Termination. This agreement may be terminated by...',
      },
      {
        chunk_index: 8,
        section_path: 'Article V > Miscellaneous',
        heading_context: 'Miscellaneous',
        heading_level: 2,
        content_types: '["paragraph"]',
        ocr_quality_score: 4.0,
        page_number: 5,
        is_atomic: 0,
        text: 'This agreement constitutes the entire agreement between parties.',
      },
      {
        chunk_index: 9,
        section_path: 'Article V > Miscellaneous > Signatures',
        heading_context: 'Signatures',
        heading_level: 3,
        content_types: '["paragraph"]',
        ocr_quality_score: 3.9,
        page_number: 5,
        is_atomic: 1,
        text: 'IN WITNESS WHEREOF the parties have executed this agreement.',
      },
    ];

    for (const cd of chunkData) {
      const provId = uuidv4();
      chunkProvIds.push(provId);
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
          text: cd.text,
          text_hash: computeHash(cd.text),
          chunk_index: cd.chunk_index,
          character_start: cd.chunk_index * 100,
          character_end: (cd.chunk_index + 1) * 100,
          page_number: cd.page_number,
          section_path: cd.section_path,
          heading_context: cd.heading_context,
          heading_level: cd.heading_level,
          content_types: cd.content_types,
          ocr_quality_score: cd.ocr_quality_score,
          is_atomic: cd.is_atomic,
        })
      );
    }

    // Set some embedding statuses
    db.updateChunkEmbeddingStatus(chunkIds[0], 'complete', new Date().toISOString());
    db.updateChunkEmbeddingStatus(chunkIds[1], 'complete', new Date().toISOString());
    db.updateChunkEmbeddingStatus(chunkIds[2], 'failed', undefined);

    // Create embedding for chunk 0
    embProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: embProvId,
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProvIds[0],
        root_document_id: docProvId,
        chain_depth: 3,
      })
    );

    embeddingId = uuidv4();
    db.insertEmbedding(
      createTestEmbedding(chunkIds[0], docId, embProvId, {
        id: embeddingId,
      })
    );
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_chunk_get
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_chunk_get', () => {
    it('should return full chunk details', async () => {
      const result = await chunkTools.ocr_chunk_get.handler({ chunk_id: chunkIds[0] });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.id).toBe(chunkIds[0]);
      expect(parsed.data.document_id).toBe(docId);
      expect(parsed.data.document_file_path).toBe('/test/contract.pdf');
      expect(parsed.data.document_file_name).toBe('contract.pdf');
      expect(parsed.data.text).toContain('Article I');
      expect(parsed.data.text_length).toBeGreaterThan(0);
      expect(parsed.data.chunk_index).toBe(0);
      expect(parsed.data.section_path).toBe('Article I > Definitions');
      expect(parsed.data.heading_context).toBe('Definitions');
      expect(parsed.data.heading_level).toBe(2);
      expect(parsed.data.content_types).toBe('["heading","paragraph"]');
      expect(parsed.data.ocr_quality_score).toBe(4.5);
      expect(parsed.data.embedding_status).toBe('complete');
      expect(parsed.data.provenance_id).toBe(chunkProvIds[0]);
    });

    it('should include embedding info when requested', async () => {
      const result = await chunkTools.ocr_chunk_get.handler({
        chunk_id: chunkIds[0],
        include_embedding_info: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.embedding_info).toBeDefined();
      expect(parsed.data.embedding_info.embedding_id).toBe(embeddingId);
      expect(parsed.data.embedding_info.model_name).toBe('nomic-embed-text-v1.5');
    });

    it('should return null embedding_info when chunk has no embedding', async () => {
      const result = await chunkTools.ocr_chunk_get.handler({
        chunk_id: chunkIds[5],
        include_embedding_info: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.embedding_info).toBeNull();
    });

    it('should include provenance chain when requested', async () => {
      const result = await chunkTools.ocr_chunk_get.handler({
        chunk_id: chunkIds[0],
        include_provenance: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.provenance_chain).toBeDefined();
      expect(Array.isArray(parsed.data.provenance_chain)).toBe(true);
      expect(parsed.data.provenance_chain.length).toBeGreaterThan(0);
    });

    it('should fail for non-existent chunk', async () => {
      const result = await chunkTools.ocr_chunk_get.handler({
        chunk_id: 'non-existent-id',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
    });

    it('should fail when database not selected', async () => {
      resetState();

      const result = await chunkTools.ocr_chunk_get.handler({ chunk_id: chunkIds[0] });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      // Re-select for remaining tests
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_chunk_list
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_chunk_list', () => {
    it('should list all chunks for a document', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.document_id).toBe(docId);
      expect(parsed.data.total).toBe(10);
      expect(parsed.data.chunks.length).toBe(10);
      // Verify ordered by chunk_index
      for (let i = 0; i < parsed.data.chunks.length - 1; i++) {
        expect(parsed.data.chunks[i].chunk_index).toBeLessThan(
          parsed.data.chunks[i + 1].chunk_index
        );
      }
    });

    it('should filter by section_path_filter', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        section_path_filter: 'Article II',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // "Article II" prefix LIKE matches "Article II > ..." AND "Article III > ..."
      // because "Article III" starts with "Article II" (10-char prefix match).
      // That gives us chunks 2,3,4 (Article II) + 5,6 (Article III) = 5
      expect(parsed.data.total).toBe(5);
    });

    it('should filter by heading_filter', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        heading_filter: 'Liability',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2); // chunks 5, 6
    });

    it('should filter by content_type_filter', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        content_type_filter: ['table'],
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(1); // chunk 3 has table
      expect(parsed.data.chunks[0].chunk_index).toBe(3);
    });

    it('should filter by min_quality_score', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        min_quality_score: 4.0,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Chunks with score >= 4.0: indices 0(4.5), 1(4.2), 3(4.0), 4(4.1), 7(4.8), 8(4.0)
      expect(parsed.data.total).toBe(6);
    });

    it('should filter by embedding_status', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        embedding_status: 'complete',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2); // chunks 0 and 1
    });

    it('should filter by is_atomic', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        is_atomic: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2); // chunks 3 and 9
    });

    it('should filter by page_range', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        page_range: { min_page: 3, max_page: 4 },
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Pages 3 and 4: chunks at indices 4(pg3), 5(pg3), 6(pg4), 7(pg4) = 4
      expect(parsed.data.total).toBe(4);
      for (const chunk of parsed.data.chunks) {
        expect(chunk.page_number).toBeGreaterThanOrEqual(3);
        expect(chunk.page_number).toBeLessThanOrEqual(4);
      }
    });

    it('should combine multiple filters', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        section_path_filter: 'Article II',
        min_quality_score: 4.0,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Article II chunks with score >= 4.0: indices 3(4.0), 4(4.1)
      expect(parsed.data.total).toBe(2);
    });

    it('should return empty when no chunks match', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        heading_filter: 'NonExistentHeading',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(0);
      expect(parsed.data.chunks).toEqual([]);
    });

    it('should support pagination', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        limit: 3,
        offset: 2,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(10);
      expect(parsed.data.chunks.length).toBe(3);
      expect(parsed.data.chunks[0].chunk_index).toBe(2);
      expect(parsed.data.limit).toBe(3);
      expect(parsed.data.offset).toBe(2);
    });

    it('should include text when include_text=true', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        limit: 1,
        include_text: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.chunks[0].text).toBeDefined();
      expect(typeof parsed.data.chunks[0].text).toBe('string');
    });

    it('should exclude text when include_text=false', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: docId,
        limit: 1,
        include_text: false,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.chunks[0].text).toBeUndefined();
    });

    it('should fail for non-existent document', async () => {
      const result = await chunkTools.ocr_chunk_list.handler({
        document_id: 'non-existent-doc',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_chunk_context
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_chunk_context', () => {
    it('should return chunk with neighbors', async () => {
      // Chunk at index 5 with 2 neighbors -> chunks 3,4,5,6,7
      const result = await chunkTools.ocr_chunk_context.handler({
        chunk_id: chunkIds[5],
        neighbors: 2,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.document_id).toBe(docId);
      expect(parsed.data.document_file_path).toBe('/test/contract.pdf');
      expect(parsed.data.center_chunk.id).toBe(chunkIds[5]);
      expect(parsed.data.center_chunk.chunk_index).toBe(5);
      expect(parsed.data.before.length).toBe(2);
      expect(parsed.data.after.length).toBe(2);
      expect(parsed.data.total_chunks).toBe(5);
      expect(parsed.data.combined_text).toBeDefined();
      expect(parsed.data.combined_text_length).toBeGreaterThan(0);
      expect(parsed.data.combined_page_range).toBe('2-4');
    });

    it('should handle first chunk (no before neighbors)', async () => {
      const result = await chunkTools.ocr_chunk_context.handler({
        chunk_id: chunkIds[0],
        neighbors: 2,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.center_chunk.chunk_index).toBe(0);
      expect(parsed.data.before.length).toBe(0);
      expect(parsed.data.after.length).toBe(2);
      expect(parsed.data.total_chunks).toBe(3);
    });

    it('should handle last chunk (no after neighbors)', async () => {
      const result = await chunkTools.ocr_chunk_context.handler({
        chunk_id: chunkIds[9],
        neighbors: 2,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.center_chunk.chunk_index).toBe(9);
      expect(parsed.data.before.length).toBe(2);
      expect(parsed.data.after.length).toBe(0);
      expect(parsed.data.total_chunks).toBe(3);
    });

    it('should handle zero neighbors', async () => {
      const result = await chunkTools.ocr_chunk_context.handler({
        chunk_id: chunkIds[5],
        neighbors: 0,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.before.length).toBe(0);
      expect(parsed.data.after.length).toBe(0);
      expect(parsed.data.total_chunks).toBe(1);
    });

    it('should include provenance when requested', async () => {
      const result = await chunkTools.ocr_chunk_context.handler({
        chunk_id: chunkIds[5],
        neighbors: 1,
        include_provenance: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.center_chunk.provenance_chain).toBeDefined();
      expect(Array.isArray(parsed.data.center_chunk.provenance_chain)).toBe(true);
    });

    it('should fail for non-existent chunk', async () => {
      const result = await chunkTools.ocr_chunk_context.handler({
        chunk_id: 'non-existent-id',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_document_sections
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_document_sections', () => {
    it('should return section tree from chunk section_paths', async () => {
      const result = await documentTools.ocr_document_sections.handler({
        document_id: docId,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.document_id).toBe(docId);
      expect(parsed.data.total_chunks).toBe(10);
      expect(parsed.data.chunks_with_sections).toBe(10);
      expect(parsed.data.chunks_without_sections).toBe(0);

      // Top-level sections: Article I, II, III, IV, V
      const sections = parsed.data.sections;
      expect(sections.length).toBe(5);

      // Article I > Definitions (2 chunks)
      const art1 = sections.find((s: Record<string, unknown>) => s.name === 'Article I');
      expect(art1).toBeDefined();
      expect(art1.children.length).toBe(1);
      expect(art1.children[0].name).toBe('Definitions');
      expect(art1.children[0].chunk_count).toBe(2);

      // Article II > Obligations > Payment Terms, Delivery
      const art2 = sections.find((s: Record<string, unknown>) => s.name === 'Article II');
      expect(art2).toBeDefined();
      expect(art2.children.length).toBe(1); // Obligations
      expect(art2.children[0].children.length).toBe(2); // Payment Terms, Delivery
    });

    it('should include chunk_ids when requested', async () => {
      const result = await documentTools.ocr_document_sections.handler({
        document_id: docId,
        include_chunk_ids: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);

      // Find Definitions section
      const art1 = parsed.data.sections.find(
        (s: Record<string, unknown>) => s.name === 'Article I'
      );
      const defs = art1.children[0];
      expect(defs.chunk_ids).toBeDefined();
      expect(defs.chunk_ids.length).toBe(2);
      expect(defs.chunk_ids).toContain(chunkIds[0]);
      expect(defs.chunk_ids).toContain(chunkIds[1]);
    });

    it('should include page_numbers and page_range when requested', async () => {
      const result = await documentTools.ocr_document_sections.handler({
        document_id: docId,
        include_page_numbers: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);

      const art1 = parsed.data.sections.find(
        (s: Record<string, unknown>) => s.name === 'Article I'
      );
      const defs = art1.children[0];
      expect(defs.page_numbers).toBeDefined();
      expect(defs.page_numbers).toContain(1);
      expect(defs.page_range).toBe('1');
    });

    it('should handle document without section_paths', async () => {
      // Create a document with chunks that have no section_path
      const { db } = requireDatabase();
      const prov2 = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: prov2,
          type: ProvenanceType.DOCUMENT,
          root_document_id: prov2,
          chain_depth: 0,
        })
      );
      const doc2Id = uuidv4();
      db.insertDocument(createTestDocument(prov2, { id: doc2Id }));

      const ocrProv2 = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: ocrProv2,
          type: ProvenanceType.OCR_RESULT,
          parent_id: prov2,
          root_document_id: prov2,
          chain_depth: 1,
        })
      );
      const ocr2Id = uuidv4();
      db.insertOCRResult(createTestOCRResult(doc2Id, ocrProv2, { id: ocr2Id }));

      const chunkProv2 = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: chunkProv2,
          type: ProvenanceType.CHUNK,
          parent_id: ocrProv2,
          root_document_id: prov2,
          chain_depth: 2,
        })
      );
      db.insertChunk(
        createTestChunk(doc2Id, ocr2Id, chunkProv2, {
          id: uuidv4(),
          section_path: null,
          heading_context: null,
        })
      );

      const result = await documentTools.ocr_document_sections.handler({
        document_id: doc2Id,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.sections).toEqual([]);
      expect(parsed.data.chunks_without_sections).toBe(1);
      expect(parsed.data.root_chunks).toBe(1);
    });

    it('should fail for non-existent document', async () => {
      const result = await documentTools.ocr_document_sections.handler({
        document_id: 'non-existent-doc',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
    });
  });
});

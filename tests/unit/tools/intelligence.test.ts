/**
 * Tests for Intelligence MCP Tools
 *
 * Tests ocr_document_tables, ocr_document_recommend, ocr_document_extras.
 * Uses real database instances with temp databases - NO MOCKS.
 *
 * @module tests/unit/tools/intelligence
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
import { intelligenceTools } from '../../../src/tools/intelligence.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

describe('Intelligence Tools', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-intelligence');

  // IDs for test data
  let docId: string;
  let doc2Id: string;

  beforeAll(() => {
    tempDir = createTempDir('test-intelligence-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // ── Document 1: with tables, extras, and chunks ──
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
        file_path: '/test/report.pdf',
        file_name: 'report.pdf',
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

    // OCR result with json_blocks containing a table
    const jsonBlocks = JSON.stringify([
      {
        block_type: 'Page',
        id: 0,
        children: [
          {
            block_type: 'Table',
            html: '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table>',
            children: [],
          },
          {
            block_type: 'SectionHeader',
            text: 'Introduction',
            level: 1,
            children: [],
          },
        ],
      },
    ]);

    const extrasJson = JSON.stringify({
      charts: [{ type: 'bar', page: 1, title: 'Revenue Chart' }],
      links: [{ url: 'https://example.com', text: 'Example Link', page: 2 }],
      tracked_changes: [],
    });

    const ocrId = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(docId, ocrProvId, {
        id: ocrId,
        json_blocks: jsonBlocks,
        extras_json: extrasJson,
      })
    );

    // Create a chunk for doc 1
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
        text: 'Introduction to the report with key findings.',
        chunk_index: 0,
      })
    );

    // ── Document 2: for recommend tests (cluster peer) ──
    const doc2ProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: doc2ProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: doc2ProvId,
        chain_depth: 0,
      })
    );

    doc2Id = uuidv4();
    db.insertDocument(
      createTestDocument(doc2ProvId, {
        id: doc2Id,
        file_path: '/test/analysis.pdf',
        file_name: 'analysis.pdf',
        status: 'complete',
      })
    );

    const ocrProv2Id = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProv2Id,
        type: ProvenanceType.OCR_RESULT,
        parent_id: doc2ProvId,
        root_document_id: doc2ProvId,
        chain_depth: 1,
      })
    );

    const ocr2Id = uuidv4();
    db.insertOCRResult(
      createTestOCRResult(doc2Id, ocrProv2Id, {
        id: ocr2Id,
      })
    );

    const chunk2ProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: chunk2ProvId,
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv2Id,
        root_document_id: doc2ProvId,
        chain_depth: 2,
      })
    );

    db.insertChunk(
      createTestChunk(doc2Id, ocr2Id, chunk2ProvId, {
        id: uuidv4(),
        text: 'Analysis of the key findings from the report.',
        chunk_index: 0,
      })
    );

    // Create a cluster and put both documents in it using the correct schema
    const runId = uuidv4();
    const clusterId = uuidv4();
    const clusterProvId = uuidv4();

    db.insertProvenance(
      createTestProvenance({
        id: clusterProvId,
        type: ProvenanceType.CLUSTERING,
        parent_id: docProvId,
        root_document_id: docProvId,
        chain_depth: 2,
      })
    );

    conn
      .prepare(
        `
      INSERT INTO clusters (id, run_id, cluster_index, label, description, document_count,
        algorithm, algorithm_params_json, content_hash, provenance_id, created_at)
      VALUES (?, ?, 0, 'test-cluster', 'Test cluster for recommendations', 2,
        'manual', '{}', ?, ?, datetime('now'))
    `
      )
      .run(clusterId, runId, computeHash('test-cluster'), clusterProvId);

    const dc1Id = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO document_clusters (id, document_id, cluster_id, run_id, similarity_to_centroid, assigned_at)
      VALUES (?, ?, ?, ?, 0.9, datetime('now'))
    `
      )
      .run(dc1Id, docId, clusterId, runId);

    const dc2Id = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO document_clusters (id, document_id, cluster_id, run_id, similarity_to_centroid, assigned_at)
      VALUES (?, ?, ?, ?, 0.85, datetime('now'))
    `
      )
      .run(dc2Id, doc2Id, clusterId, runId);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_document_tables tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_document_tables', () => {
    it('should extract tables from json_blocks', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({
        document_id: docId,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.document_id).toBe(docId);
      expect(data.data.file_name).toBe('report.pdf');
      expect(data.data.total_tables).toBe(1);
      expect(data.data.tables).toHaveLength(1);

      const table = data.data.tables[0];
      expect(table.table_index).toBe(0);
      expect(table.row_count).toBeGreaterThan(0);
      expect(table.column_count).toBeGreaterThan(0);
      // Default mode returns cell_count instead of cells (summary-first)
      expect(table.cell_count).toBeDefined();
      expect(table.cells).toBeUndefined();
    });

    it('should parse HTML table cells correctly', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({
        document_id: docId,
        include_cells: true,
      });

      const data = JSON.parse(result.content[0].text);
      const table = data.data.tables[0];

      // HTML has 3 rows (header + 2 data) and 2 columns
      expect(table.row_count).toBe(3);
      expect(table.column_count).toBe(2);

      // Check that cells contain expected text
      const cellTexts = table.cells.map((c: { text: string }) => c.text);
      expect(cellTexts).toContain('Name');
      expect(cellTexts).toContain('Value');
      expect(cellTexts).toContain('A');
      expect(cellTexts).toContain('1');
    });

    it('should return specific table by index', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({
        document_id: docId,
        table_index: 0,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.tables).toHaveLength(1);
      expect(data.data.tables[0].table_index).toBe(0);
    });

    it('should handle out-of-range table index gracefully', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({
        document_id: docId,
        table_index: 99,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.tables).toHaveLength(0);
      expect(data.data.message).toContain('out of range');
    });

    it('should handle document without json_blocks', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({
        document_id: doc2Id,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.total_tables).toBe(0);
      expect(data.data.tables).toHaveLength(0);
    });

    it('should error for non-existent document', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({
        document_id: 'non-existent-id',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should validate input - missing document_id', async () => {
      const result = await intelligenceTools.ocr_document_tables.handler({});

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_document_recommend tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_document_recommend', () => {
    it('should recommend documents from cluster peers', async () => {
      const result = await intelligenceTools.ocr_document_recommend.handler({
        document_id: docId,
        limit: 10,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.source_document_id).toBe(docId);
      expect(data.data.source_file_name).toBe('report.pdf');
      expect(data.data.source_cluster_count).toBeGreaterThan(0);
      expect(data.data.recommendations).toBeDefined();
      expect(Array.isArray(data.data.recommendations)).toBe(true);

      // doc2 should be recommended as a cluster peer
      const rec = data.data.recommendations.find(
        (r: { document_id: string }) => r.document_id === doc2Id
      );
      expect(rec).toBeDefined();
      expect(rec.cluster_match).toBe(true);
      expect(rec.score).toBeGreaterThan(0);
      expect(rec.reasons).toBeDefined();
      expect(Array.isArray(rec.reasons)).toBe(true);
    });

    it('should error for non-existent document', async () => {
      const result = await intelligenceTools.ocr_document_recommend.handler({
        document_id: 'non-existent-id',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should respect limit parameter', async () => {
      const result = await intelligenceTools.ocr_document_recommend.handler({
        document_id: docId,
        limit: 1,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.recommendations.length).toBeLessThanOrEqual(1);
    });

    it('should handle document with no cluster memberships', async () => {
      const { db } = requireDatabase();
      const isoProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: isoProvId,
          type: ProvenanceType.DOCUMENT,
          root_document_id: isoProvId,
          chain_depth: 0,
        })
      );

      const isoDocId = uuidv4();
      db.insertDocument(
        createTestDocument(isoProvId, {
          id: isoDocId,
          file_path: '/test/isolated.pdf',
          file_name: 'isolated.pdf',
          status: 'complete',
        })
      );

      const result = await intelligenceTools.ocr_document_recommend.handler({
        document_id: isoDocId,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.source_cluster_count).toBe(0);
    });

    it('should return total_candidates and returned counts', async () => {
      const result = await intelligenceTools.ocr_document_recommend.handler({
        document_id: docId,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(typeof data.data.total_candidates).toBe('number');
      expect(typeof data.data.returned).toBe('number');
      expect(data.data.returned).toBeLessThanOrEqual(data.data.total_candidates);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_document_extras tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_document_extras', () => {
    it('should return all extras sections', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: docId,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.document_id).toBe(docId);
      expect(data.data.file_name).toBe('report.pdf');
      // Default mode returns sections manifest (summary-first), not full extras
      expect(data.data.sections).toBeDefined();
      expect(Array.isArray(data.data.sections)).toBe(true);
      expect(data.data.available_sections).toBeDefined();
      expect(Array.isArray(data.data.available_sections)).toBe(true);
      expect(data.data.available_sections).toContain('charts');
      expect(data.data.available_sections).toContain('links');
    });

    it('should return specific section when requested', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: docId,
        section: 'charts',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.section).toBe('charts');
      expect(data.data.data).toBeDefined();
      expect(Array.isArray(data.data.data)).toBe(true);
      expect(data.data.data[0].type).toBe('bar');
    });

    it('should return links section', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: docId,
        section: 'links',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.section).toBe('links');
      expect(data.data.data).toBeDefined();
      expect(data.data.data[0].url).toBe('https://example.com');
    });

    it('should handle document with no extras', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: doc2Id,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.available_sections).toHaveLength(0);
    });

    it('should error for non-existent document', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: 'non-existent-id',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should error for unknown section on document with extras', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: docId,
        section: 'nonexistent_section',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error.category).toBe('VALIDATION_ERROR');
    });

    it('should include tracked_changes section even if empty array', async () => {
      const result = await intelligenceTools.ocr_document_extras.handler({
        document_id: docId,
        section: 'tracked_changes',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.section).toBe('tracked_changes');
      expect(data.data.data).toEqual([]);
    });
  });
});

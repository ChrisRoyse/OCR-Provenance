/**
 * Tests for Phase 5 provenance query tools:
 * - ocr_provenance_query
 * - ocr_provenance_timeline
 * - ocr_provenance_processor_stats
 *
 * Uses real DatabaseService instances with temp databases. NO MOCK DATA.
 *
 * @module tests/unit/tools/provenance-query-tools
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  uuidv4,
} from '../../integration/server/helpers.js';
import {
  handleProvenanceQuery,
  handleProvenanceTimeline,
  handleProvenanceProcessorStats,
} from '../../../src/tools/provenance.js';

describe('Phase 5: Provenance Query Tools', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-prov-tools');

  // Store IDs for assertions
  let docId1: string;
  let docProvId1: string;
  let docId2: string;
  let docProvId2: string;

  beforeAll(() => {
    tempDir = createTempDir('test-prov-tools-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // ---- Document 1: full pipeline (DOC -> OCR -> CHUNK x2 -> EMBEDDING x2) ----
    const rootId1 = uuidv4();
    docProvId1 = rootId1;

    const pDoc1 = createTestProvenance({
      id: rootId1,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 40,
      processing_quality_score: null,
      root_document_id: rootId1,
      created_at: '2026-02-01T08:00:00.000Z',
      processed_at: '2026-02-01T08:00:00.000Z',
    });
    db.insertProvenance(pDoc1);

    const doc1 = createTestDocument(rootId1, { id: uuidv4() });
    db.insertDocument(doc1);
    docId1 = doc1.id;

    const pOcr1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 3000,
      processing_quality_score: 4.2,
      parent_id: rootId1,
      root_document_id: rootId1,
      created_at: '2026-02-01T08:01:00.000Z',
      processed_at: '2026-02-01T08:01:00.000Z',
    });
    db.insertProvenance(pOcr1);

    const ocr1 = createTestOCRResult(doc1.id, pOcr1.id);
    db.insertOCRResult(ocr1);

    const pChunk1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.2.0',
      chain_depth: 2,
      processing_duration_ms: 12,
      processing_quality_score: 0.85,
      parent_id: pOcr1.id,
      root_document_id: rootId1,
      created_at: '2026-02-01T08:02:00.000Z',
      processed_at: '2026-02-01T08:02:00.000Z',
    });
    db.insertProvenance(pChunk1);

    const chunk1 = createTestChunk(doc1.id, ocr1.id, pChunk1.id, { chunk_index: 0 });
    db.insertChunk(chunk1);

    const pChunk2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.2.0',
      chain_depth: 2,
      processing_duration_ms: 14,
      processing_quality_score: 0.88,
      parent_id: pOcr1.id,
      root_document_id: rootId1,
      created_at: '2026-02-01T08:02:01.000Z',
      processed_at: '2026-02-01T08:02:01.000Z',
    });
    db.insertProvenance(pChunk2);

    const chunk2 = createTestChunk(doc1.id, ocr1.id, pChunk2.id, { chunk_index: 1 });
    db.insertChunk(chunk2);

    const pEmb1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 100,
      processing_quality_score: null,
      parent_id: pChunk1.id,
      root_document_id: rootId1,
      created_at: '2026-02-01T08:03:00.000Z',
      processed_at: '2026-02-01T08:03:00.000Z',
    });
    db.insertProvenance(pEmb1);

    const pEmb2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 110,
      processing_quality_score: null,
      parent_id: pChunk2.id,
      root_document_id: rootId1,
      created_at: '2026-02-01T08:03:01.000Z',
      processed_at: '2026-02-01T08:03:01.000Z',
    });
    db.insertProvenance(pEmb2);

    // ---- Document 2: smaller pipeline (DOC -> OCR) ----
    const rootId2 = uuidv4();
    docProvId2 = rootId2;

    const pDoc2 = createTestProvenance({
      id: rootId2,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 30,
      processing_quality_score: null,
      root_document_id: rootId2,
      created_at: '2026-02-15T10:00:00.000Z',
      processed_at: '2026-02-15T10:00:00.000Z',
    });
    db.insertProvenance(pDoc2);

    const doc2 = createTestDocument(rootId2, { id: uuidv4() });
    db.insertDocument(doc2);
    docId2 = doc2.id;

    const pOcr2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 4000,
      processing_quality_score: 3.5,
      parent_id: rootId2,
      root_document_id: rootId2,
      created_at: '2026-02-15T10:01:00.000Z',
      processed_at: '2026-02-15T10:01:00.000Z',
    });
    db.insertProvenance(pOcr2);

    const ocr2 = createTestOCRResult(doc2.id, pOcr2.id);
    db.insertOCRResult(ocr2);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_provenance_query
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_provenance_query', () => {
    it('should return all records with no filters', async () => {
      const result = await handleProvenanceQuery({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(8); // 6 for doc1 + 2 for doc2
      expect(parsed.data.records.length).toBe(8);
      expect(parsed.data.limit).toBe(50);
      expect(parsed.data.offset).toBe(0);
      expect(parsed.data.filters_applied).toEqual({});
    });

    it('should filter by processor', async () => {
      const result = await handleProvenanceQuery({ processor: 'chunker' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2);
      expect(parsed.data.filters_applied.processor).toBe('chunker');
      parsed.data.records.forEach((r: Record<string, unknown>) => {
        expect(r.processor).toBe('chunker');
      });
    });

    it('should filter by type', async () => {
      const result = await handleProvenanceQuery({ type: 'OCR_RESULT' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2);
      parsed.data.records.forEach((r: Record<string, unknown>) => {
        expect(r.type).toBe('OCR_RESULT');
      });
    });

    it('should filter by chain_depth', async () => {
      const result = await handleProvenanceQuery({ chain_depth: 3 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2); // 2 embeddings
      parsed.data.records.forEach((r: Record<string, unknown>) => {
        expect(r.chain_depth).toBe(3);
      });
    });

    it('should filter by min_quality_score', async () => {
      const result = await handleProvenanceQuery({ min_quality_score: 1.0 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // 4.2, 3.5 qualify
      expect(parsed.data.total).toBe(2);
    });

    it('should filter by root_document_id', async () => {
      const result = await handleProvenanceQuery({ root_document_id: docProvId1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(6); // 6 records for doc1
    });

    it('should handle ordering', async () => {
      const result = await handleProvenanceQuery({
        order_by: 'processing_duration_ms',
        order_dir: 'desc',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      const durations = parsed.data.records.map(
        (r: Record<string, unknown>) => r.processing_duration_ms
      );
      for (let i = 1; i < durations.length; i++) {
        expect(durations[i - 1] >= durations[i]).toBe(true);
      }
    });

    it('should handle pagination', async () => {
      const page1 = await handleProvenanceQuery({ limit: 3, offset: 0 });
      const p1 = JSON.parse(page1.content[0].text);

      const page2 = await handleProvenanceQuery({ limit: 3, offset: 3 });
      const p2 = JSON.parse(page2.content[0].text);

      expect(p1.data.records.length).toBe(3);
      expect(p2.data.records.length).toBe(3);
      expect(p1.data.total).toBe(8);

      const ids1 = p1.data.records.map((r: Record<string, unknown>) => r.id);
      const ids2 = p2.data.records.map((r: Record<string, unknown>) => r.id);
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }
    });

    it('should return empty for non-matching filter', async () => {
      const result = await handleProvenanceQuery({ processor: 'does-not-exist' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(0);
      expect(parsed.data.records).toEqual([]);
    });

    it('should fail with database not selected', async () => {
      resetState();
      const result = await handleProvenanceQuery({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      // Re-select for remaining tests
      selectDatabase(dbName, tempDir);
    });

    it('should include correct record fields', async () => {
      const result = await handleProvenanceQuery({ type: 'DOCUMENT', limit: 1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      const record = parsed.data.records[0];
      expect(record).toHaveProperty('id');
      expect(record).toHaveProperty('type');
      expect(record).toHaveProperty('chain_depth');
      expect(record).toHaveProperty('processor');
      expect(record).toHaveProperty('processor_version');
      expect(record).toHaveProperty('processing_duration_ms');
      expect(record).toHaveProperty('processing_quality_score');
      expect(record).toHaveProperty('content_hash');
      expect(record).toHaveProperty('root_document_id');
      expect(record).toHaveProperty('parent_id');
      expect(record).toHaveProperty('created_at');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_provenance_timeline
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_provenance_timeline', () => {
    it('should return full timeline for document 1', async () => {
      const result = await handleProvenanceTimeline({ document_id: docId1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.document_id).toBe(docId1);
      expect(parsed.data.steps_count).toBe(6);

      // Total: 40 + 3000 + 12 + 14 + 100 + 110 = 3276
      expect(parsed.data.total_processing_time_ms).toBe(3276);

      // Verify chronological order
      const timestamps = parsed.data.timeline.map(
        (s: Record<string, unknown>) => s.timestamp as string
      );
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1] <= timestamps[i]).toBe(true);
      }

      // Verify step numbers
      const steps = parsed.data.timeline.map(
        (s: Record<string, unknown>) => s.step as number
      );
      expect(steps).toEqual([1, 2, 3, 4, 5, 6]);

      // Verify types appear in expected pipeline order
      const types = parsed.data.timeline.map(
        (s: Record<string, unknown>) => s.type as string
      );
      expect(types[0]).toBe('DOCUMENT');
      expect(types[1]).toBe('OCR_RESULT');
      expect(types[2]).toBe('CHUNK');
      expect(types[3]).toBe('CHUNK');
    });

    it('should return timeline for document 2 (smaller pipeline)', async () => {
      const result = await handleProvenanceTimeline({ document_id: docId2 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.document_id).toBe(docId2);
      expect(parsed.data.steps_count).toBe(2);
      expect(parsed.data.total_processing_time_ms).toBe(4030); // 30 + 4000
    });

    it('should include processing params when requested', async () => {
      const result = await handleProvenanceTimeline({
        document_id: docId1,
        include_params: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      parsed.data.timeline.forEach((step: Record<string, unknown>) => {
        expect(step).toHaveProperty('processing_params');
      });
    });

    it('should not include processing params by default', async () => {
      const result = await handleProvenanceTimeline({ document_id: docId1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      parsed.data.timeline.forEach((step: Record<string, unknown>) => {
        expect(step).not.toHaveProperty('processing_params');
      });
    });

    it('should fail for non-existent document', async () => {
      const result = await handleProvenanceTimeline({
        document_id: 'non-existent-doc-id',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DOCUMENT_NOT_FOUND');
    });

    it('should fail with database not selected', async () => {
      resetState();
      const result = await handleProvenanceTimeline({ document_id: docId1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      selectDatabase(dbName, tempDir);
    });

    it('should include provenance_id and parent_id in each step', async () => {
      const result = await handleProvenanceTimeline({ document_id: docId1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      parsed.data.timeline.forEach((step: Record<string, unknown>) => {
        expect(step).toHaveProperty('provenance_id');
        expect(step).toHaveProperty('parent_id');
        expect(step).toHaveProperty('chain_depth');
        expect(step).toHaveProperty('processor');
        expect(step).toHaveProperty('processor_version');
        expect(step).toHaveProperty('duration_ms');
        expect(step).toHaveProperty('quality_score');
        expect(step).toHaveProperty('timestamp');
      });

      // First step (DOCUMENT) should have null parent_id
      expect(parsed.data.timeline[0].parent_id).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_provenance_processor_stats
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_provenance_processor_stats', () => {
    it('should return stats for all processors', async () => {
      const result = await handleProvenanceProcessorStats({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total_processors).toBe(4);

      // Check specific processor: ingest
      const ingestStats = parsed.data.stats.find(
        (s: Record<string, unknown>) => s.processor === 'ingest'
      );
      expect(ingestStats).toBeDefined();
      expect(ingestStats.total_operations).toBe(2);

      // Check specific processor: datalab-ocr
      const ocrStats = parsed.data.stats.find(
        (s: Record<string, unknown>) => s.processor === 'datalab-ocr'
      );
      expect(ocrStats).toBeDefined();
      expect(ocrStats.total_operations).toBe(2);
      expect(ocrStats.total_processing_time_ms).toBe(7000); // 3000 + 4000
    });

    it('should filter by specific processor', async () => {
      const result = await handleProvenanceProcessorStats({ processor: 'chunker' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total_processors).toBe(1);
      expect(parsed.data.stats[0].processor).toBe('chunker');
      expect(parsed.data.stats[0].total_operations).toBe(2);
      expect(parsed.data.stats[0].min_duration_ms).toBe(12);
      expect(parsed.data.stats[0].max_duration_ms).toBe(14);
    });

    it('should filter by date range', async () => {
      const result = await handleProvenanceProcessorStats({
        created_after: '2026-02-15T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only doc2: ingest + datalab-ocr
      expect(parsed.data.total_processors).toBe(2);
    });

    it('should handle null quality scores correctly', async () => {
      const result = await handleProvenanceProcessorStats({
        processor: 'nomic-embed-text-v1.5',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.stats[0].avg_quality_score).toBeNull();
    });

    it('should return empty stats for non-matching filter', async () => {
      const result = await handleProvenanceProcessorStats({
        processor: 'nonexistent-processor',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total_processors).toBe(0);
      expect(parsed.data.stats).toEqual([]);
    });

    it('should fail with database not selected', async () => {
      resetState();
      const result = await handleProvenanceProcessorStats({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      selectDatabase(dbName, tempDir);
    });

    it('should verify aggregation accuracy with direct SQL', async () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();

      // Verify chunker stats via direct SQL
      const row = conn
        .prepare(
          `SELECT
            COUNT(*) as cnt,
            AVG(processing_duration_ms) as avg_dur,
            MIN(processing_duration_ms) as min_dur,
            MAX(processing_duration_ms) as max_dur,
            SUM(processing_duration_ms) as total_dur
          FROM provenance WHERE processor = ?`
        )
        .get('chunker') as {
        cnt: number;
        avg_dur: number;
        min_dur: number;
        max_dur: number;
        total_dur: number;
      };

      const result = await handleProvenanceProcessorStats({ processor: 'chunker' });
      const parsed = JSON.parse(result.content[0].text);
      const stats = parsed.data.stats[0];

      expect(stats.total_operations).toBe(row.cnt);
      expect(stats.min_duration_ms).toBe(row.min_dur);
      expect(stats.max_duration_ms).toBe(row.max_dur);
      expect(stats.total_processing_time_ms).toBe(row.total_dur);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool export verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe('tool export', () => {
    it('should export all 6 provenance tools', async () => {
      const { provenanceTools } = await import('../../../src/tools/provenance.js');
      const toolNames = Object.keys(provenanceTools);

      expect(toolNames).toContain('ocr_provenance_get');
      expect(toolNames).toContain('ocr_provenance_verify');
      expect(toolNames).toContain('ocr_provenance_export');
      expect(toolNames).toContain('ocr_provenance_query');
      expect(toolNames).toContain('ocr_provenance_timeline');
      expect(toolNames).toContain('ocr_provenance_processor_stats');
      expect(toolNames.length).toBe(6);
    });

    it('should have handlers for all new tools', async () => {
      const { provenanceTools } = await import('../../../src/tools/provenance.js');

      expect(typeof provenanceTools.ocr_provenance_query.handler).toBe('function');
      expect(typeof provenanceTools.ocr_provenance_timeline.handler).toBe('function');
      expect(typeof provenanceTools.ocr_provenance_processor_stats.handler).toBe('function');
    });
  });
});

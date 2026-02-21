/**
 * Tests for provenance query and processor stats DB operations
 *
 * Uses real DatabaseService instances with temp databases.
 * NO MOCK DATA.
 *
 * @module tests/unit/services/provenance-query
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  uuidv4,
} from '../../integration/server/helpers.js';

describe('provenance-query operations', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-prov-query');

  // Track provenance IDs for assertions
  const provIds: string[] = [];

  beforeAll(() => {
    tempDir = createTempDir('test-prov-query-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Insert 12 provenance records with varied processors, types, depths, timestamps, and quality scores
    const rootId = uuidv4();

    // Record 0: DOCUMENT, processor=ingest, depth=0, quality=null, duration=50
    const p0 = createTestProvenance({
      id: rootId,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 50,
      processing_quality_score: null,
      root_document_id: rootId,
      created_at: '2026-02-01T10:00:00.000Z',
      processed_at: '2026-02-01T10:00:00.000Z',
    });
    db.insertProvenance(p0);
    provIds.push(p0.id);

    // Record 1: OCR_RESULT, processor=datalab-ocr, depth=1, quality=4.5, duration=2500
    const p1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 2500,
      processing_quality_score: 4.5,
      parent_id: rootId,
      root_document_id: rootId,
      created_at: '2026-02-01T10:01:00.000Z',
      processed_at: '2026-02-01T10:01:00.000Z',
    });
    db.insertProvenance(p1);
    provIds.push(p1.id);

    // Record 2: CHUNK, processor=chunker, depth=2, quality=0.9, duration=10
    const p2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.2.0',
      chain_depth: 2,
      processing_duration_ms: 10,
      processing_quality_score: 0.9,
      parent_id: p1.id,
      root_document_id: rootId,
      created_at: '2026-02-01T10:02:00.000Z',
      processed_at: '2026-02-01T10:02:00.000Z',
    });
    db.insertProvenance(p2);
    provIds.push(p2.id);

    // Record 3: CHUNK, processor=chunker, depth=2, quality=0.8, duration=15
    const p3 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.2.0',
      chain_depth: 2,
      processing_duration_ms: 15,
      processing_quality_score: 0.8,
      parent_id: p1.id,
      root_document_id: rootId,
      created_at: '2026-02-01T10:02:01.000Z',
      processed_at: '2026-02-01T10:02:01.000Z',
    });
    db.insertProvenance(p3);
    provIds.push(p3.id);

    // Record 4: EMBEDDING, processor=nomic-embed, depth=3, quality=null, duration=200
    const p4 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 200,
      processing_quality_score: null,
      parent_id: p2.id,
      root_document_id: rootId,
      created_at: '2026-02-01T10:03:00.000Z',
      processed_at: '2026-02-01T10:03:00.000Z',
    });
    db.insertProvenance(p4);
    provIds.push(p4.id);

    // Record 5: IMAGE, processor=image-extractor, depth=2, quality=0.95, duration=300
    const p5 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      processor: 'image-extractor',
      processor_version: '1.0.0',
      chain_depth: 2,
      processing_duration_ms: 300,
      processing_quality_score: 0.95,
      parent_id: p1.id,
      root_document_id: rootId,
      created_at: '2026-02-01T10:04:00.000Z',
      processed_at: '2026-02-01T10:04:00.000Z',
    });
    db.insertProvenance(p5);
    provIds.push(p5.id);

    // Record 6: VLM_DESCRIPTION, processor=gemini-3-flash, depth=3, quality=0.92, duration=1500
    const p6 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.VLM_DESCRIPTION,
      processor: 'gemini-3-flash-preview',
      processor_version: '3.0.0',
      chain_depth: 3,
      processing_duration_ms: 1500,
      processing_quality_score: 0.92,
      parent_id: p5.id,
      root_document_id: rootId,
      created_at: '2026-02-01T10:05:00.000Z',
      processed_at: '2026-02-01T10:05:00.000Z',
    });
    db.insertProvenance(p6);
    provIds.push(p6.id);

    // Second document root for cross-document testing
    const rootId2 = uuidv4();

    // Record 7: DOCUMENT, processor=ingest, depth=0
    const p7 = createTestProvenance({
      id: rootId2,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 60,
      processing_quality_score: null,
      root_document_id: rootId2,
      created_at: '2026-02-10T12:00:00.000Z',
      processed_at: '2026-02-10T12:00:00.000Z',
    });
    db.insertProvenance(p7);
    provIds.push(p7.id);

    // Record 8: OCR_RESULT, processor=datalab-ocr, depth=1, quality=3.8, duration=5000
    const p8 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 5000,
      processing_quality_score: 3.8,
      parent_id: rootId2,
      root_document_id: rootId2,
      created_at: '2026-02-10T12:01:00.000Z',
      processed_at: '2026-02-10T12:01:00.000Z',
    });
    db.insertProvenance(p8);
    provIds.push(p8.id);

    // Record 9: CHUNK, processor=chunker, depth=2, quality=0.7, duration=8
    const p9 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.2.0',
      chain_depth: 2,
      processing_duration_ms: 8,
      processing_quality_score: 0.7,
      parent_id: p8.id,
      root_document_id: rootId2,
      created_at: '2026-02-10T12:02:00.000Z',
      processed_at: '2026-02-10T12:02:00.000Z',
    });
    db.insertProvenance(p9);
    provIds.push(p9.id);

    // Record 10: EMBEDDING, processor=nomic-embed, depth=3, quality=null, duration=150
    const p10 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 150,
      processing_quality_score: null,
      parent_id: p9.id,
      root_document_id: rootId2,
      created_at: '2026-02-10T12:03:00.000Z',
      processed_at: '2026-02-10T12:03:00.000Z',
    });
    db.insertProvenance(p10);
    provIds.push(p10.id);

    // Record 11: EMBEDDING with high duration for min_duration_ms testing
    const p11 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 500,
      processing_quality_score: null,
      parent_id: p3.id,
      root_document_id: rootId,
      created_at: '2026-02-01T10:03:30.000Z',
      processed_at: '2026-02-01T10:03:30.000Z',
    });
    db.insertProvenance(p11);
    provIds.push(p11.id);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // queryProvenance
  // ═══════════════════════════════════════════════════════════════════════════

  describe('queryProvenance', () => {
    it('should return all records with no filters', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({});
      expect(result.total).toBe(12);
      expect(result.records.length).toBe(12);
    });

    it('should filter by processor', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ processor: 'chunker' });
      expect(result.total).toBe(3);
      result.records.forEach((r) => {
        expect(r.processor).toBe('chunker');
      });
    });

    it('should filter by type', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ type: 'EMBEDDING' });
      expect(result.total).toBe(3);
      result.records.forEach((r) => {
        expect(r.type).toBe(ProvenanceType.EMBEDDING);
      });
    });

    it('should filter by chain_depth', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ chain_depth: 2 });
      // depth 2: p2, p3, p5, p9 = 4 records
      expect(result.total).toBe(4);
      result.records.forEach((r) => {
        expect(r.chain_depth).toBe(2);
      });
    });

    it('should filter by created_after', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ created_after: '2026-02-10T00:00:00.000Z' });
      // Records 7-10: 4 records from Feb 10
      expect(result.total).toBe(4);
      result.records.forEach((r) => {
        expect(r.created_at >= '2026-02-10T00:00:00.000Z').toBe(true);
      });
    });

    it('should filter by created_before', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ created_before: '2026-02-01T10:02:00.000Z' });
      // Records 0,1,2 (at or before 10:02:00)
      expect(result.total).toBe(3);
    });

    it('should filter by min_quality_score', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ min_quality_score: 0.9 });
      // p0 default 0.95, p1(4.5), p2(0.9), p5(0.95), p6(0.92) = 5 records
      // Note: createTestProvenance defaults to processing_quality_score: 0.95
      // but p0 overrides to null, p7 overrides to null. So: p1(4.5), p2(0.9), p5(0.95), p6(0.92), p7(null->no) = 4
      // Actually let me recount: p0(null), p1(4.5), p2(0.9), p3(0.8), p4(null), p5(0.95), p6(0.92), p7(null), p8(3.8), p9(0.7), p10(null), p11(null)
      // >= 0.9: p1(4.5), p2(0.9), p5(0.95), p6(0.92), p8(3.8) = 5 records
      expect(result.total).toBe(5);
      result.records.forEach((r) => {
        expect(r.processing_quality_score).toBeGreaterThanOrEqual(0.9);
      });
    });

    it('should filter by min_duration_ms', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ min_duration_ms: 1000 });
      // p1(2500), p6(1500), p8(5000) = 3 records
      expect(result.total).toBe(3);
      result.records.forEach((r) => {
        expect(r.processing_duration_ms).toBeGreaterThanOrEqual(1000);
      });
    });

    it('should filter by root_document_id', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ root_document_id: provIds[0] });
      // Records 0-6, 11 = 8 records with rootId
      expect(result.total).toBe(8);
      result.records.forEach((r) => {
        expect(r.root_document_id).toBe(provIds[0]);
      });
    });

    it('should combine multiple filters', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({
        processor: 'chunker',
        chain_depth: 2,
        root_document_id: provIds[0],
      });
      // p2, p3 = 2 records
      expect(result.total).toBe(2);
      result.records.forEach((r) => {
        expect(r.processor).toBe('chunker');
        expect(r.chain_depth).toBe(2);
        expect(r.root_document_id).toBe(provIds[0]);
      });
    });

    it('should order by created_at DESC by default', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ limit: 5 });
      for (let i = 1; i < result.records.length; i++) {
        expect(result.records[i - 1].created_at >= result.records[i].created_at).toBe(true);
      }
    });

    it('should order by created_at ASC', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ order_by: 'created_at', order_dir: 'asc', limit: 5 });
      for (let i = 1; i < result.records.length; i++) {
        expect(result.records[i - 1].created_at <= result.records[i].created_at).toBe(true);
      }
    });

    it('should order by processing_duration_ms DESC', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({
        order_by: 'processing_duration_ms',
        order_dir: 'desc',
      });
      for (let i = 1; i < result.records.length; i++) {
        const prevDur = result.records[i - 1].processing_duration_ms ?? 0;
        const curDur = result.records[i].processing_duration_ms ?? 0;
        expect(prevDur >= curDur).toBe(true);
      }
    });

    it('should handle pagination with limit and offset', () => {
      const { db } = requireDatabase();
      const page1 = db.queryProvenance({ limit: 3, offset: 0, order_by: 'created_at', order_dir: 'asc' });
      const page2 = db.queryProvenance({ limit: 3, offset: 3, order_by: 'created_at', order_dir: 'asc' });

      expect(page1.total).toBe(12);
      expect(page2.total).toBe(12);
      expect(page1.records.length).toBe(3);
      expect(page2.records.length).toBe(3);

      // Ensure no overlap
      const page1Ids = page1.records.map((r) => r.id);
      const page2Ids = page2.records.map((r) => r.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it('should return empty results for non-matching filter', () => {
      const { db } = requireDatabase();
      const result = db.queryProvenance({ processor: 'nonexistent-processor' });
      expect(result.total).toBe(0);
      expect(result.records.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getProvenanceProcessorStats
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getProvenanceProcessorStats', () => {
    it('should return stats for all processors', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats();

      // We have 5 distinct processors: ingest, datalab-ocr, chunker, nomic-embed-text-v1.5, image-extractor, gemini-3-flash-preview
      expect(stats.length).toBe(6);

      const chunkerStats = stats.find((s) => s.processor === 'chunker');
      expect(chunkerStats).toBeDefined();
      expect(chunkerStats!.total_operations).toBe(3);
      expect(chunkerStats!.processor_version).toBe('1.2.0');
      // avg of 10, 15, 8 = 11
      expect(chunkerStats!.avg_duration_ms).toBe(11);
      expect(chunkerStats!.min_duration_ms).toBe(8);
      expect(chunkerStats!.max_duration_ms).toBe(15);
      // avg of 0.9, 0.8, 0.7 = 0.8
      expect(chunkerStats!.avg_quality_score).toBe(0.8);
      // sum: 10 + 15 + 8 = 33
      expect(chunkerStats!.total_processing_time_ms).toBe(33);
    });

    it('should filter by processor', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats({ processor: 'datalab-ocr' });
      expect(stats.length).toBe(1);
      expect(stats[0].processor).toBe('datalab-ocr');
      expect(stats[0].total_operations).toBe(2);
      // avg quality: (4.5 + 3.8) / 2 = 4.15
      expect(stats[0].avg_quality_score).toBe(4.15);
    });

    it('should filter by created_after', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats({ created_after: '2026-02-10T00:00:00.000Z' });
      // Only records 7-10 from Feb 10
      // ingest(1), datalab-ocr(1), chunker(1), nomic-embed(1) = 4 processors
      expect(stats.length).toBe(4);
    });

    it('should filter by created_before', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats({ created_before: '2026-02-01T10:02:00.000Z' });
      // Records 0,1,2: ingest(1), datalab-ocr(1), chunker(1) = 3 processors
      expect(stats.length).toBe(3);
    });

    it('should handle null quality scores', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats({ processor: 'nomic-embed-text-v1.5' });
      expect(stats.length).toBe(1);
      expect(stats[0].total_operations).toBe(3);
      // All 3 nomic-embed records have null quality
      expect(stats[0].avg_quality_score).toBeNull();
    });

    it('should return empty for non-matching filter', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats({ processor: 'nonexistent' });
      expect(stats.length).toBe(0);
    });

    it('should combine date filters', () => {
      const { db } = requireDatabase();
      const stats = db.getProvenanceProcessorStats({
        created_after: '2026-02-01T10:00:00.000Z',
        created_before: '2026-02-01T10:03:00.000Z',
      });
      // Records 0-4: ingest(1), datalab-ocr(1), chunker(2), nomic-embed(1) = 4 processors
      expect(stats.length).toBe(4);
    });
  });
});

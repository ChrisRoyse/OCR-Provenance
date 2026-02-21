/**
 * Tests for Phase 6 temporal analytics tools:
 * - ocr_timeline_analytics (in timeline.ts)
 * - ocr_throughput_analytics (in timeline.ts)
 * - ocr_quality_trends (in reports.ts)
 *
 * Also tests the underlying DB methods:
 * - getTimelineStats
 * - getQualityTrends
 * - getThroughputAnalytics
 *
 * Uses real DatabaseService instances with temp databases. NO MOCK DATA.
 *
 * @module tests/unit/tools/timeline
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
  createTestEmbedding,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  uuidv4,
} from '../../integration/server/helpers.js';
import { timelineTools } from '../../../src/tools/timeline.js';
import { reportTools } from '../../../src/tools/reports.js';

// Extract handlers from exported tool definitions
const handleTimelineAnalytics = timelineTools.ocr_timeline_analytics.handler;
const handleThroughputAnalytics = timelineTools.ocr_throughput_analytics.handler;
const handleQualityTrends = reportTools.ocr_quality_trends.handler;

describe('Phase 6: Temporal Analytics Tools', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-timeline');

  beforeAll(() => {
    tempDir = createTempDir('test-timeline-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // Insert test data across different timestamps for timeline analytics

    // --- Document 1: Jan 15 ---
    const rootId1 = uuidv4();
    const pDoc1 = createTestProvenance({
      id: rootId1,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 30,
      processing_quality_score: null,
      root_document_id: rootId1,
      created_at: '2026-01-15T10:00:00.000Z',
      processed_at: '2026-01-15T10:00:00.000Z',
    });
    db.insertProvenance(pDoc1);

    const doc1 = createTestDocument(rootId1, {
      id: uuidv4(),
      page_count: 5,
      status: 'complete',
      created_at: '2026-01-15T10:00:00.000Z',
    });
    db.insertDocument(doc1);

    const pOcr1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 3000,
      processing_quality_score: 4.2,
      root_document_id: rootId1,
      parent_id: rootId1,
      created_at: '2026-01-15T10:01:00.000Z',
      processed_at: '2026-01-15T10:01:00.000Z',
    });
    db.insertProvenance(pOcr1);

    const ocr1 = createTestOCRResult(doc1.id, pOcr1.id, {
      parse_quality_score: 4.2,
      cost_cents: 10,
      page_count: 5,
      datalab_mode: 'balanced',
      processing_completed_at: '2026-01-15T10:01:00.000Z',
      processing_started_at: '2026-01-15T10:00:30.000Z',
      processing_duration_ms: 3000,
    });
    db.insertOCRResult(ocr1);

    // Chunks for doc1
    const pChunk1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.0.0',
      chain_depth: 2,
      processing_duration_ms: 50,
      processing_quality_score: null,
      root_document_id: rootId1,
      parent_id: pOcr1.id,
      created_at: '2026-01-15T10:02:00.000Z',
      processed_at: '2026-01-15T10:02:00.000Z',
    });
    db.insertProvenance(pChunk1);

    const chunk1 = createTestChunk(doc1.id, ocr1.id, pChunk1.id, {
      chunk_index: 0,
      created_at: '2026-01-15T10:02:00.000Z',
    });
    db.insertChunk(chunk1);

    // Embedding for chunk1
    const pEmb1 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 45,
      processing_quality_score: null,
      root_document_id: rootId1,
      parent_id: pChunk1.id,
      created_at: '2026-01-15T10:03:00.000Z',
      processed_at: '2026-01-15T10:03:00.000Z',
    });
    db.insertProvenance(pEmb1);

    const emb1 = createTestEmbedding(chunk1.id, doc1.id, pEmb1.id, {
      created_at: '2026-01-15T10:03:00.000Z',
    });
    db.insertEmbedding(emb1);

    // --- Document 2: Jan 15 (same day, different hour) ---
    const rootId2 = uuidv4();
    const pDoc2 = createTestProvenance({
      id: rootId2,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 25,
      processing_quality_score: null,
      root_document_id: rootId2,
      created_at: '2026-01-15T14:00:00.000Z',
      processed_at: '2026-01-15T14:00:00.000Z',
    });
    db.insertProvenance(pDoc2);

    const doc2 = createTestDocument(rootId2, {
      id: uuidv4(),
      page_count: 3,
      status: 'complete',
      created_at: '2026-01-15T14:00:00.000Z',
    });
    db.insertDocument(doc2);

    const pOcr2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 2000,
      processing_quality_score: 3.8,
      root_document_id: rootId2,
      parent_id: rootId2,
      created_at: '2026-01-15T14:01:00.000Z',
      processed_at: '2026-01-15T14:01:00.000Z',
    });
    db.insertProvenance(pOcr2);

    const ocr2 = createTestOCRResult(doc2.id, pOcr2.id, {
      parse_quality_score: 3.8,
      cost_cents: 6,
      page_count: 3,
      datalab_mode: 'fast',
      processing_completed_at: '2026-01-15T14:01:00.000Z',
      processing_started_at: '2026-01-15T14:00:30.000Z',
      processing_duration_ms: 2000,
    });
    db.insertOCRResult(ocr2);

    // Chunk for doc2
    const pChunk2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      processor: 'chunker',
      processor_version: '1.0.0',
      chain_depth: 2,
      processing_duration_ms: 30,
      processing_quality_score: null,
      root_document_id: rootId2,
      parent_id: pOcr2.id,
      created_at: '2026-01-15T14:02:00.000Z',
      processed_at: '2026-01-15T14:02:00.000Z',
    });
    db.insertProvenance(pChunk2);

    const chunk2 = createTestChunk(doc2.id, ocr2.id, pChunk2.id, {
      chunk_index: 0,
      created_at: '2026-01-15T14:02:00.000Z',
    });
    db.insertChunk(chunk2);

    // Embedding for chunk2
    const pEmb2 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      chain_depth: 3,
      processing_duration_ms: 40,
      processing_quality_score: null,
      root_document_id: rootId2,
      parent_id: pChunk2.id,
      created_at: '2026-01-15T14:03:00.000Z',
      processed_at: '2026-01-15T14:03:00.000Z',
    });
    db.insertProvenance(pEmb2);

    const emb2 = createTestEmbedding(chunk2.id, doc2.id, pEmb2.id, {
      created_at: '2026-01-15T14:03:00.000Z',
    });
    db.insertEmbedding(emb2);

    // --- Document 3: Feb 10 (different month) ---
    const rootId3 = uuidv4();
    const pDoc3 = createTestProvenance({
      id: rootId3,
      type: ProvenanceType.DOCUMENT,
      processor: 'ingest',
      processor_version: '1.0.0',
      chain_depth: 0,
      processing_duration_ms: 20,
      processing_quality_score: null,
      root_document_id: rootId3,
      created_at: '2026-02-10T09:00:00.000Z',
      processed_at: '2026-02-10T09:00:00.000Z',
    });
    db.insertProvenance(pDoc3);

    const doc3 = createTestDocument(rootId3, {
      id: uuidv4(),
      page_count: 10,
      status: 'complete',
      created_at: '2026-02-10T09:00:00.000Z',
    });
    db.insertDocument(doc3);

    const pOcr3 = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      processor: 'datalab-ocr',
      processor_version: '2.0.0',
      chain_depth: 1,
      processing_duration_ms: 5000,
      processing_quality_score: 4.8,
      root_document_id: rootId3,
      parent_id: rootId3,
      created_at: '2026-02-10T09:01:00.000Z',
      processed_at: '2026-02-10T09:01:00.000Z',
    });
    db.insertProvenance(pOcr3);

    const ocr3 = createTestOCRResult(doc3.id, pOcr3.id, {
      parse_quality_score: 4.8,
      cost_cents: 15,
      page_count: 10,
      datalab_mode: 'accurate',
      processing_completed_at: '2026-02-10T09:01:00.000Z',
      processing_started_at: '2026-02-10T09:00:30.000Z',
      processing_duration_ms: 5000,
    });
    db.insertOCRResult(ocr3);

    // Two chunks for doc3
    for (let i = 0; i < 2; i++) {
      const pChunkN = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.CHUNK,
        processor: 'chunker',
        processor_version: '1.0.0',
        chain_depth: 2,
        processing_duration_ms: 35,
        processing_quality_score: null,
        root_document_id: rootId3,
        parent_id: pOcr3.id,
        created_at: '2026-02-10T09:02:00.000Z',
        processed_at: '2026-02-10T09:02:00.000Z',
      });
      db.insertProvenance(pChunkN);

      const chunkN = createTestChunk(doc3.id, ocr3.id, pChunkN.id, {
        chunk_index: i,
        created_at: '2026-02-10T09:02:00.000Z',
      });
      db.insertChunk(chunkN);

      const pEmbN = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        processor: 'nomic-embed-text-v1.5',
        processor_version: '1.5.0',
        chain_depth: 3,
        processing_duration_ms: 50,
        processing_quality_score: null,
        root_document_id: rootId3,
        parent_id: pChunkN.id,
        created_at: '2026-02-10T09:03:00.000Z',
        processed_at: '2026-02-10T09:03:00.000Z',
      });
      db.insertProvenance(pEmbN);

      const embN = createTestEmbedding(chunkN.id, doc3.id, pEmbN.id, {
        created_at: '2026-02-10T09:03:00.000Z',
      });
      db.insertEmbedding(embN);
    }

    // Add IMAGE provenance for doc3
    const pImg = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      processor: 'image-extractor',
      processor_version: '1.0.0',
      chain_depth: 2,
      processing_duration_ms: 200,
      processing_quality_score: null,
      root_document_id: rootId3,
      parent_id: pOcr3.id,
      created_at: '2026-02-10T09:04:00.000Z',
      processed_at: '2026-02-10T09:04:00.000Z',
    });
    db.insertProvenance(pImg);

    // ---- Fix created_at timestamps via raw SQL ----
    // insertDocument/insertChunk/insertEmbedding always set created_at = now(),
    // so we must UPDATE after insertion to get historical timestamps for timeline tests.
    const conn = db.getConnection();

    // Documents: doc1 & doc2 on Jan 15, doc3 on Feb 10
    conn.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run(
      '2026-01-15T10:00:00.000Z',
      doc1.id
    );
    conn.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run(
      '2026-01-15T14:00:00.000Z',
      doc2.id
    );
    conn.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run(
      '2026-02-10T09:00:00.000Z',
      doc3.id
    );

    // Chunks: update based on document_id
    conn.prepare('UPDATE chunks SET created_at = ? WHERE document_id = ?').run(
      '2026-01-15T10:02:00.000Z',
      doc1.id
    );
    conn.prepare('UPDATE chunks SET created_at = ? WHERE document_id = ?').run(
      '2026-01-15T14:02:00.000Z',
      doc2.id
    );
    conn.prepare('UPDATE chunks SET created_at = ? WHERE document_id = ?').run(
      '2026-02-10T09:02:00.000Z',
      doc3.id
    );

    // Embeddings: update based on document_id
    conn.prepare('UPDATE embeddings SET created_at = ? WHERE document_id = ?').run(
      '2026-01-15T10:03:00.000Z',
      doc1.id
    );
    conn.prepare('UPDATE embeddings SET created_at = ? WHERE document_id = ?').run(
      '2026-01-15T14:03:00.000Z',
      doc2.id
    );
    conn.prepare('UPDATE embeddings SET created_at = ? WHERE document_id = ?').run(
      '2026-02-10T09:03:00.000Z',
      doc3.id
    );
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // =====================================================================
  // TOOL EXPORT TESTS
  // =====================================================================

  describe('Tool exports', () => {
    it('should export 2 timeline tools', () => {
      expect(Object.keys(timelineTools)).toHaveLength(2);
      expect(timelineTools.ocr_timeline_analytics).toBeDefined();
      expect(timelineTools.ocr_throughput_analytics).toBeDefined();
    });

    it('should have ocr_quality_trends in reportTools', () => {
      expect(reportTools.ocr_quality_trends).toBeDefined();
      expect(reportTools.ocr_quality_trends.handler).toBeDefined();
    });
  });

  // =====================================================================
  // ocr_timeline_analytics
  // =====================================================================

  describe('ocr_timeline_analytics', () => {
    it('should return daily document counts', async () => {
      const result = await handleTimelineAnalytics({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('daily');
      expect(parsed.data.metric).toBe('documents');
      expect(parsed.data.total_count).toBe(3);
      expect(parsed.data.data.length).toBeGreaterThanOrEqual(2);

      // Jan 15 should have 2 documents
      const jan15 = parsed.data.data.find((d: { period: string }) => d.period === '2026-01-15');
      expect(jan15).toBeDefined();
      expect(jan15.count).toBe(2);

      // Feb 10 should have 1 document
      const feb10 = parsed.data.data.find((d: { period: string }) => d.period === '2026-02-10');
      expect(feb10).toBeDefined();
      expect(feb10.count).toBe(1);
    });

    it('should return hourly document counts', async () => {
      const result = await handleTimelineAnalytics({ bucket: 'hourly' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('hourly');

      // Jan 15 10:00 and 14:00 should be separate buckets
      const morning = parsed.data.data.find(
        (d: { period: string }) => d.period === '2026-01-15 10:00'
      );
      const afternoon = parsed.data.data.find(
        (d: { period: string }) => d.period === '2026-01-15 14:00'
      );
      expect(morning).toBeDefined();
      expect(morning.count).toBe(1);
      expect(afternoon).toBeDefined();
      expect(afternoon.count).toBe(1);
    });

    it('should return weekly document counts', async () => {
      const result = await handleTimelineAnalytics({ bucket: 'weekly' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('weekly');
      expect(parsed.data.data.length).toBeGreaterThanOrEqual(2);
    });

    it('should return monthly document counts', async () => {
      const result = await handleTimelineAnalytics({ bucket: 'monthly' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('monthly');

      // Jan should have 2, Feb should have 1
      const jan = parsed.data.data.find((d: { period: string }) => d.period === '2026-01');
      const feb = parsed.data.data.find((d: { period: string }) => d.period === '2026-02');
      expect(jan).toBeDefined();
      expect(jan.count).toBe(2);
      expect(feb).toBeDefined();
      expect(feb.count).toBe(1);
    });

    it('should return pages metric', async () => {
      const result = await handleTimelineAnalytics({ metric: 'pages' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.metric).toBe('pages');
      // Total pages: 5 + 3 + 10 = 18
      expect(parsed.data.total_count).toBe(18);
    });

    it('should return chunks metric', async () => {
      const result = await handleTimelineAnalytics({ metric: 'chunks' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.metric).toBe('chunks');
      // 1 + 1 + 2 = 4 chunks
      expect(parsed.data.total_count).toBe(4);
    });

    it('should return embeddings metric', async () => {
      const result = await handleTimelineAnalytics({ metric: 'embeddings' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.metric).toBe('embeddings');
      // 1 + 1 + 2 = 4 embeddings
      expect(parsed.data.total_count).toBe(4);
    });

    it('should return cost metric', async () => {
      const result = await handleTimelineAnalytics({ metric: 'cost' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.metric).toBe('cost');
      // 10 + 6 + 15 = 31 cents
      expect(parsed.data.total_count).toBe(31);
    });

    it('should filter by created_after', async () => {
      const result = await handleTimelineAnalytics({
        created_after: '2026-02-01T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only Feb documents
      expect(parsed.data.total_count).toBe(1);
      expect(parsed.data.filters.created_after).toBe('2026-02-01T00:00:00.000Z');
    });

    it('should filter by created_before', async () => {
      const result = await handleTimelineAnalytics({
        created_before: '2026-01-31T23:59:59.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only Jan documents
      expect(parsed.data.total_count).toBe(2);
      expect(parsed.data.filters.created_before).toBe('2026-01-31T23:59:59.000Z');
    });

    it('should filter by date range', async () => {
      const result = await handleTimelineAnalytics({
        created_after: '2026-01-15T12:00:00.000Z',
        created_before: '2026-01-15T23:59:59.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only the afternoon document
      expect(parsed.data.total_count).toBe(1);
    });

    it('should return empty data for no matches', async () => {
      const result = await handleTimelineAnalytics({
        created_after: '2030-01-01T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total_count).toBe(0);
      expect(parsed.data.data).toHaveLength(0);
    });

    it('should fail with database not selected', async () => {
      resetState();
      const result = await handleTimelineAnalytics({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      // Re-select for remaining tests
      selectDatabase(dbName, tempDir);
    });
  });

  // =====================================================================
  // ocr_throughput_analytics
  // =====================================================================

  describe('ocr_throughput_analytics', () => {
    it('should return daily throughput data', async () => {
      const result = await handleThroughputAnalytics({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('daily');
      expect(parsed.data.data.length).toBeGreaterThanOrEqual(2);

      // Summary should have totals
      expect(parsed.data.summary.total_pages_processed).toBeGreaterThan(0);
      expect(parsed.data.summary.total_embeddings_generated).toBeGreaterThan(0);
    });

    it('should show correct throughput breakdown per bucket', async () => {
      const result = await handleThroughputAnalytics({ bucket: 'monthly' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);

      // Check Jan has OCR_RESULTs (pages_processed)
      const jan = parsed.data.data.find((d: { period: string }) => d.period === '2026-01');
      expect(jan).toBeDefined();
      // 2 OCR_RESULT provenance records in Jan
      expect(jan.pages_processed).toBe(2);
      // 2 EMBEDDING provenance records in Jan
      expect(jan.embeddings_generated).toBe(2);
      // No IMAGE provenance in Jan
      expect(jan.images_processed).toBe(0);

      // Feb should have IMAGE provenance
      const feb = parsed.data.data.find((d: { period: string }) => d.period === '2026-02');
      expect(feb).toBeDefined();
      expect(feb.images_processed).toBe(1);
      expect(feb.embeddings_generated).toBe(2);
    });

    it('should compute avg_ms_per_page correctly', async () => {
      const result = await handleThroughputAnalytics({ bucket: 'monthly' });
      const parsed = JSON.parse(result.content[0].text);

      const jan = parsed.data.data.find((d: { period: string }) => d.period === '2026-01');
      // Jan: 2 OCR_RESULT provenance with 3000ms + 2000ms = 5000ms total, 2 pages_processed
      expect(jan.avg_ms_per_page).toBe(2500);
    });

    it('should compute summary totals', async () => {
      const result = await handleThroughputAnalytics({});
      const parsed = JSON.parse(result.content[0].text);

      const summary = parsed.data.summary;
      // 3 OCR_RESULT provenance records total
      expect(summary.total_pages_processed).toBe(3);
      // 4 EMBEDDING provenance records total
      expect(summary.total_embeddings_generated).toBe(4);
      // 1 IMAGE provenance record total
      expect(summary.total_images_processed).toBe(1);
      expect(summary.total_ocr_duration_ms).toBe(10000); // 3000 + 2000 + 5000
      expect(summary.total_embedding_duration_ms).toBe(185); // 45 + 40 + 50 + 50
    });

    it('should filter by date range', async () => {
      const result = await handleThroughputAnalytics({
        created_after: '2026-02-01T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only Feb data
      expect(parsed.data.summary.total_pages_processed).toBe(1); // 1 OCR_RESULT in Feb
      expect(parsed.data.summary.total_images_processed).toBe(1);
    });

    it('should return empty data for no matches', async () => {
      const result = await handleThroughputAnalytics({
        created_after: '2030-01-01T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.data).toHaveLength(0);
      expect(parsed.data.summary.total_pages_processed).toBe(0);
    });

    it('should fail with database not selected', async () => {
      resetState();
      const result = await handleThroughputAnalytics({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      selectDatabase(dbName, tempDir);
    });
  });

  // =====================================================================
  // ocr_quality_trends
  // =====================================================================

  describe('ocr_quality_trends', () => {
    it('should return daily quality trends (no grouping)', async () => {
      const result = await handleQualityTrends({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('daily');
      expect(parsed.data.group_by).toBe('none');
      expect(parsed.data.data.length).toBeGreaterThanOrEqual(2);

      // Jan 15 has 2 OCR results: quality 4.2 and 3.8
      const jan15 = parsed.data.data.find((d: { period: string }) => d.period === '2026-01-15');
      expect(jan15).toBeDefined();
      expect(jan15.avg_quality).toBe(4.0); // (4.2 + 3.8) / 2
      expect(jan15.min_quality).toBe(3.8);
      expect(jan15.max_quality).toBe(4.2);
      expect(jan15.sample_count).toBe(2);

      // Feb 10 has 1 OCR result: quality 4.8
      const feb10 = parsed.data.data.find((d: { period: string }) => d.period === '2026-02-10');
      expect(feb10).toBeDefined();
      expect(feb10.avg_quality).toBe(4.8);
      expect(feb10.sample_count).toBe(1);
    });

    it('should return monthly quality trends', async () => {
      const result = await handleQualityTrends({ bucket: 'monthly' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.bucket).toBe('monthly');

      const jan = parsed.data.data.find((d: { period: string }) => d.period === '2026-01');
      expect(jan).toBeDefined();
      expect(jan.sample_count).toBe(2);
    });

    it('should group by ocr_mode', async () => {
      const result = await handleQualityTrends({ group_by: 'ocr_mode' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.group_by).toBe('ocr_mode');

      // Should have entries with group field
      for (const d of parsed.data.data) {
        expect(d.group).toBeDefined();
        expect(['balanced', 'fast', 'accurate']).toContain(d.group);
      }

      // Find the 'balanced' entry for Jan 15
      const balancedJan = parsed.data.data.find(
        (d: { period: string; group: string }) =>
          d.period === '2026-01-15' && d.group === 'balanced'
      );
      expect(balancedJan).toBeDefined();
      expect(balancedJan.avg_quality).toBe(4.2);

      // Find the 'fast' entry for Jan 15
      const fastJan = parsed.data.data.find(
        (d: { period: string; group: string }) =>
          d.period === '2026-01-15' && d.group === 'fast'
      );
      expect(fastJan).toBeDefined();
      expect(fastJan.avg_quality).toBe(3.8);
    });

    it('should group by processor', async () => {
      const result = await handleQualityTrends({ group_by: 'processor' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.group_by).toBe('processor');

      // Processor grouping uses provenance table, which has quality scores
      // for datalab-ocr and test processors
      for (const d of parsed.data.data) {
        expect(d.group).toBeDefined();
        expect(d.avg_quality).toBeGreaterThan(0);
        expect(d.sample_count).toBeGreaterThan(0);
      }
    });

    it('should filter by created_after', async () => {
      const result = await handleQualityTrends({
        created_after: '2026-02-01T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only Feb data
      expect(parsed.data.data.length).toBe(1);
      expect(parsed.data.data[0].avg_quality).toBe(4.8);
    });

    it('should filter by created_before', async () => {
      const result = await handleQualityTrends({
        created_before: '2026-01-31T23:59:59.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      // Only Jan data
      expect(parsed.data.data.length).toBe(1);
      expect(parsed.data.data[0].sample_count).toBe(2);
    });

    it('should return empty data for no matches', async () => {
      const result = await handleQualityTrends({
        created_after: '2030-01-01T00:00:00.000Z',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.data.data).toHaveLength(0);
    });

    it('should fail with database not selected', async () => {
      resetState();
      const result = await handleQualityTrends({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');

      selectDatabase(dbName, tempDir);
    });
  });

  // =====================================================================
  // DB METHOD TESTS
  // =====================================================================

  describe('getTimelineStats (DB method)', () => {
    it('should handle all bucket types', () => {
      const { db } = requireDatabase();

      for (const bucket of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
        const data = db.getTimelineStats({ bucket, metric: 'documents' });
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
        for (const point of data) {
          expect(point.period).toBeDefined();
          expect(typeof point.count).toBe('number');
        }
      }
    });

    it('should handle all metric types', () => {
      const { db } = requireDatabase();

      for (const metric of [
        'documents',
        'pages',
        'chunks',
        'embeddings',
        'images',
        'cost',
      ] as const) {
        const data = db.getTimelineStats({ bucket: 'monthly', metric });
        expect(Array.isArray(data)).toBe(true);
        // Should return at least some data (images might be 0 in some periods)
      }
    });
  });

  describe('getQualityTrends (DB method)', () => {
    it('should return trends with correct fields', () => {
      const { db } = requireDatabase();

      const data = db.getQualityTrends({ bucket: 'daily' });
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      for (const point of data) {
        expect(point.period).toBeDefined();
        expect(typeof point.avg_quality).toBe('number');
        expect(typeof point.min_quality).toBe('number');
        expect(typeof point.max_quality).toBe('number');
        expect(typeof point.sample_count).toBe('number');
        expect(point.min_quality).toBeLessThanOrEqual(point.avg_quality);
        expect(point.max_quality).toBeGreaterThanOrEqual(point.avg_quality);
      }
    });

    it('should return group field for ocr_mode grouping', () => {
      const { db } = requireDatabase();

      const data = db.getQualityTrends({ bucket: 'daily', group_by: 'ocr_mode' });
      for (const point of data) {
        expect(point.group).toBeDefined();
      }
    });

    it('should return group field for processor grouping', () => {
      const { db } = requireDatabase();

      const data = db.getQualityTrends({ bucket: 'daily', group_by: 'processor' });
      for (const point of data) {
        expect(point.group).toBeDefined();
      }
    });
  });

  describe('getThroughputAnalytics (DB method)', () => {
    it('should return throughput with correct fields', () => {
      const { db } = requireDatabase();

      const data = db.getThroughputAnalytics({ bucket: 'daily' });
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      for (const point of data) {
        expect(point.period).toBeDefined();
        expect(typeof point.pages_processed).toBe('number');
        expect(typeof point.embeddings_generated).toBe('number');
        expect(typeof point.images_processed).toBe('number');
        expect(typeof point.total_ocr_duration_ms).toBe('number');
        expect(typeof point.total_embedding_duration_ms).toBe('number');
        expect(typeof point.avg_ms_per_page).toBe('number');
        expect(typeof point.avg_ms_per_embedding).toBe('number');
      }
    });
  });
});

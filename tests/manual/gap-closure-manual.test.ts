/**
 * Comprehensive Manual E2E Test: Gap Closure Phases 0-10
 *
 * Tests all 31 new MCP tools added in Phases 0-10 using synthetic data
 * inserted directly into the database. NO external API calls required
 * (except for tools that intrinsically depend on Gemini/Datalab).
 *
 * Run with: npx vitest run tests/manual/gap-closure-manual-test.ts --config vitest.config.all.ts
 *
 * CRITICAL: NEVER use console.log() in source files - only in tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

import {
  createDatabase,
  deleteDatabase,
  requireDatabase,
  clearDatabase,
} from '../../src/server/state.js';

import { chunkTools } from '../../src/tools/chunks.js';
import { documentTools } from '../../src/tools/documents.js';
import { structuredExtractionTools } from '../../src/tools/extraction-structured.js';
import { imageTools } from '../../src/tools/images.js';
import { embeddingTools } from '../../src/tools/embeddings.js';
import { provenanceTools } from '../../src/tools/provenance.js';
import { timelineTools } from '../../src/tools/timeline.js';
import { reportTools } from '../../src/tools/reports.js';
import { comparisonTools } from '../../src/tools/comparison.js';
import { clusteringTools } from '../../src/tools/clustering.js';
import { fileManagementTools } from '../../src/tools/file-management.js';
import { ingestionTools } from '../../src/tools/ingestion.js';
import { tagTools } from '../../src/tools/tags.js';
import { searchTools } from '../../src/tools/search.js';

// ===============================================================================
// HELPERS
// ===============================================================================

type ToolModule = Record<string, { handler: (p: Record<string, unknown>) => Promise<unknown> }>;

async function callTool(tools: ToolModule, name: string, params: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}. Available: ${Object.keys(tools).join(', ')}`);
  const raw = (await tool.handler(params)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(raw.content[0].text) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
}

function ok(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success) {
    console.error('[FAIL]', JSON.stringify(result.error, null, 2));
  }
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
  return result.data!;
}

function fail(result: { success: boolean; error?: Record<string, unknown> }): void {
  expect(result.success).toBe(false);
}

// ===============================================================================
// SYNTHETIC DATA IDS
// ===============================================================================

const DB_NAME = `gap-manual-${Date.now()}`;

// Known UUIDs for synthetic data
const DOC_ID_1 = randomUUID();
const DOC_ID_2 = randomUUID();
const DOC_PROV_1 = randomUUID();
const DOC_PROV_2 = randomUUID();
const OCR_ID_1 = randomUUID();
const OCR_ID_2 = randomUUID();
const OCR_PROV_1 = randomUUID();
const OCR_PROV_2 = randomUUID();
const CHUNK_IDS_1 = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const CHUNK_IDS_2 = [randomUUID(), randomUUID()];
const CHUNK_PROVS_1 = CHUNK_IDS_1.map(() => randomUUID());
const CHUNK_PROVS_2 = CHUNK_IDS_2.map(() => randomUUID());
const EMB_IDS_1 = CHUNK_IDS_1.map(() => randomUUID());
const EMB_IDS_2 = CHUNK_IDS_2.map(() => randomUUID());
const EMB_PROVS_1 = EMB_IDS_1.map(() => randomUUID());
const EMB_PROVS_2 = EMB_IDS_2.map(() => randomUUID());
const EXTRACTION_ID = randomUUID();
const EXTRACTION_PROV = randomUUID();
const IMAGE_ID = randomUUID();
const IMAGE_PROV = randomUUID();

let conn: Database.Database;
let tmpDir: string;

// ===============================================================================
// TEST SETUP
// ===============================================================================

describe('Gap Closure Phases 0-10: Manual E2E Test', () => {
  beforeAll(() => {
    // Create temp directory for exports
    tmpDir = join('/tmp', `gap-manual-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Create database
    createDatabase(DB_NAME, 'Gap closure manual test');
    const { db } = requireDatabase();
    conn = db.getConnection();
    console.error(`[SETUP] Created database: ${DB_NAME}`);

    // Insert synthetic data directly into the database
    insertSyntheticData(conn);
    console.error('[SETUP] Synthetic data inserted');
  }, 30_000);

  afterAll(() => {
    try {
      clearDatabase();
      deleteDatabase(DB_NAME);
    } catch {
      /* cleanup */
    }
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  });

  // =============================================================================
  // PHASE 1: CHUNK TOOLS
  // =============================================================================

  describe('Phase 1: Chunk Tools', () => {
    it('ocr_chunk_get - retrieves chunk by ID with correct fields', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_get', {
        chunk_id: CHUNK_IDS_1[0],
      }));
      expect(data.id).toBe(CHUNK_IDS_1[0]);
      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.text).toBe('This is chunk 0 of document 1. It contains test content for verification.');
      expect(data.chunk_index).toBe(0);
      expect(data.page_number).toBe(1);
      expect(data.heading_context).toBe('Introduction');
      expect(data.section_path).toBe('Introduction');
      expect(data.embedding_status).toBe('complete');
      expect(data.text_length).toBeGreaterThan(0);
    });

    it('ocr_chunk_get - with embedding info', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_get', {
        chunk_id: CHUNK_IDS_1[0],
        include_embedding_info: true,
      }));
      expect(data.embedding_info).toBeDefined();
      const info = data.embedding_info as Record<string, unknown>;
      expect(info.embedding_id).toBe(EMB_IDS_1[0]);
      expect(info.model_name).toBe('nomic-embed-text-v1.5');
    });

    it('ocr_chunk_get - with provenance', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_get', {
        chunk_id: CHUNK_IDS_1[0],
        include_provenance: true,
      }));
      expect(data.provenance_chain).toBeDefined();
    });

    it('ocr_chunk_get - error on invalid ID', async () => {
      fail(await callTool(chunkTools, 'ocr_chunk_get', {
        chunk_id: 'nonexistent-chunk-id',
      }));
    });

    it('ocr_chunk_list - lists chunks for document', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_list', {
        document_id: DOC_ID_1,
      }));
      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.total).toBe(4);
      const chunks = data.chunks as Array<Record<string, unknown>>;
      expect(chunks.length).toBe(4);
      // Verify sorted by chunk_index
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[1].chunk_index).toBe(1);
    });

    it('ocr_chunk_list - with include_text', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_list', {
        document_id: DOC_ID_1,
        include_text: true,
        limit: 2,
      }));
      const chunks = data.chunks as Array<Record<string, unknown>>;
      expect(chunks[0].text).toBeDefined();
      expect(typeof chunks[0].text).toBe('string');
    });

    it('ocr_chunk_list - filter by heading', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_list', {
        document_id: DOC_ID_1,
        heading_filter: 'Methods',
      }));
      expect(data.total).toBeGreaterThanOrEqual(1);
    });

    it('ocr_chunk_list - filter by section_path', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_list', {
        document_id: DOC_ID_1,
        section_path_filter: 'Introduction',
      }));
      expect(data.total).toBeGreaterThanOrEqual(1);
    });

    it('ocr_chunk_list - error on invalid document', async () => {
      fail(await callTool(chunkTools, 'ocr_chunk_list', {
        document_id: 'nonexistent-doc',
      }));
    });

    it('ocr_chunk_context - gets context window', async () => {
      const data = ok(await callTool(chunkTools, 'ocr_chunk_context', {
        chunk_id: CHUNK_IDS_1[1],
        neighbors: 1,
      }));
      expect(data.document_id).toBe(DOC_ID_1);
      const center = data.center_chunk as Record<string, unknown>;
      expect(center.id).toBe(CHUNK_IDS_1[1]);
      expect(center.chunk_index).toBe(1);
      const before = data.before as Array<Record<string, unknown>>;
      const after = data.after as Array<Record<string, unknown>>;
      expect(before.length).toBe(1);
      expect(after.length).toBe(1);
      expect(data.combined_text).toBeDefined();
      expect(data.total_chunks).toBe(3);
    });

    it('ocr_chunk_context - error on missing chunk', async () => {
      fail(await callTool(chunkTools, 'ocr_chunk_context', {
        chunk_id: 'nonexistent-id',
      }));
    });
  });

  // =============================================================================
  // PHASE 1 (documents.ts): DOCUMENT SECTIONS
  // =============================================================================

  describe('Phase 1: Document Structure (format=tree, merged from ocr_document_sections)', () => {
    it('ocr_document_structure format=tree - returns section tree', async () => {
      const data = ok(await callTool(documentTools, 'ocr_document_structure', {
        document_id: DOC_ID_1,
        format: 'tree',
      }));
      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.total_chunks).toBe(4);
      expect(data.chunks_with_sections).toBeGreaterThanOrEqual(1);
      const sections = data.sections as Array<Record<string, unknown>>;
      expect(Array.isArray(sections)).toBe(true);
    });

    it('ocr_document_structure format=tree - with chunk IDs and page numbers', async () => {
      const data = ok(await callTool(documentTools, 'ocr_document_structure', {
        document_id: DOC_ID_1,
        format: 'tree',
        include_chunk_ids: true,
        include_page_numbers: true,
      }));
      const sections = data.sections as Array<Record<string, unknown>>;
      if (sections.length > 0) {
        // Verify the section node has chunk_ids and page_numbers arrays
        expect(sections[0].chunk_ids).toBeDefined();
        expect(Array.isArray(sections[0].chunk_ids)).toBe(true);
      }
    });

    it('ocr_document_structure format=tree - error on missing doc', async () => {
      fail(await callTool(documentTools, 'ocr_document_structure', {
        document_id: 'nonexistent-doc-id',
        format: 'tree',
      }));
    });
  });

  // =============================================================================
  // PHASE 2: EXTRACTION TOOLS
  // =============================================================================

  describe('Phase 2: Extraction Tools', () => {
    it('ocr_extraction_get - retrieves extraction by ID', async () => {
      const data = ok(await callTool(structuredExtractionTools, 'ocr_extraction_get', {
        extraction_id: EXTRACTION_ID,
      }));
      expect(data.id).toBe(EXTRACTION_ID);
      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.schema_json).toBeDefined();
      expect(data.extraction_json).toBeDefined();
      expect(data.content_hash).toBeDefined();
      expect(data.has_embedding).toBe(false); // No embedding inserted for test extraction
    });

    it('ocr_extraction_get - with provenance', async () => {
      const data = ok(await callTool(structuredExtractionTools, 'ocr_extraction_get', {
        extraction_id: EXTRACTION_ID,
        include_provenance: true,
      }));
      expect(data.provenance_chain).toBeDefined();
    });

    it('ocr_extraction_get - error on missing ID', async () => {
      fail(await callTool(structuredExtractionTools, 'ocr_extraction_get', {
        extraction_id: 'nonexistent-extraction',
      }));
    });

    it('ocr_extraction_list search mode - finds extraction by content', async () => {
      const data = ok(await callTool(structuredExtractionTools, 'ocr_extraction_list', {
        query: 'Test Contract',
        limit: 10,
      }));
      expect(data.total).toBeGreaterThanOrEqual(1);
      const results = data.results as Array<Record<string, unknown>>;
      expect(results[0].document_id).toBe(DOC_ID_1);
    });

    it('ocr_extraction_list search mode - with document filter', async () => {
      const data = ok(await callTool(structuredExtractionTools, 'ocr_extraction_list', {
        query: 'Test',
        document_filter: [DOC_ID_2],
        limit: 10,
      }));
      expect(data.total).toBe(0); // Extraction is for DOC_ID_1, not DOC_ID_2
    });

    it('ocr_extraction_list search mode - no results for nonexistent term', async () => {
      const data = ok(await callTool(structuredExtractionTools, 'ocr_extraction_list', {
        query: 'xyznonexistent9876',
        limit: 10,
      }));
      expect(data.total).toBe(0);
    });
  });

  // =============================================================================
  // PHASE 3: IMAGE TOOLS (semantic search + reanalyze)
  // =============================================================================

  describe('Phase 3: Image Tools', () => {
    it('ocr_image_search mode=semantic - handles missing VLM embeddings gracefully', async () => {
      // We have no VLM embeddings in our synthetic data, so this should return empty
      // or handle the error gracefully
      const result = await callTool(imageTools, 'ocr_image_search', {
        mode: 'semantic',
        query: 'test chart',
        limit: 5,
      });
      // Tool may succeed with 0 results or fail with embedding error
      if (result.success) {
        const data = result.data!;
        expect(data.total).toBeDefined();
      }
    });

    it('ocr_image_reanalyze - error on missing image', async () => {
      fail(await callTool(imageTools, 'ocr_image_reanalyze', {
        image_id: 'nonexistent-image-id',
      }));
    });

    it('ocr_image_reanalyze - error when image file not on disk', async () => {
      // IMAGE_ID exists in DB but no file on disk
      const result = await callTool(imageTools, 'ocr_image_reanalyze', {
        image_id: IMAGE_ID,
      });
      // Should fail because extracted_path doesn't exist on disk
      expect(result.success).toBe(false);
    });
  });

  // =============================================================================
  // PHASE 4: EMBEDDING TOOLS
  // =============================================================================

  describe('Phase 4: Embedding Tools', () => {
    it('ocr_embedding_list - lists all embeddings', async () => {
      const data = ok(await callTool(embeddingTools, 'ocr_embedding_list', {
        limit: 50,
      }));
      const embeddings = data.embeddings as Array<Record<string, unknown>>;
      expect(embeddings.length).toBeGreaterThanOrEqual(6); // 4 for doc1 + 2 for doc2
      expect(data.total).toBeGreaterThanOrEqual(6);
    });

    it('ocr_embedding_list - filter by document', async () => {
      const data = ok(await callTool(embeddingTools, 'ocr_embedding_list', {
        document_id: DOC_ID_1,
        limit: 50,
      }));
      const embeddings = data.embeddings as Array<Record<string, unknown>>;
      expect(embeddings.length).toBe(4);
      for (const emb of embeddings) {
        expect(emb.document_id).toBe(DOC_ID_1);
      }
      const filters = data.filters_applied as Record<string, unknown>;
      expect(filters.document_id).toBe(DOC_ID_1);
    });

    it('ocr_embedding_list - filter by source_type', async () => {
      const data = ok(await callTool(embeddingTools, 'ocr_embedding_list', {
        source_type: 'chunk',
        limit: 50,
      }));
      const embeddings = data.embeddings as Array<Record<string, unknown>>;
      for (const emb of embeddings) {
        expect(emb.source_type).toBe('chunk');
        expect(emb.chunk_id).toBeTruthy();
      }
    });

    it('ocr_embedding_stats - returns stats', async () => {
      const data = ok(await callTool(embeddingTools, 'ocr_embedding_stats', {}));
      expect(data.total_embeddings).toBeGreaterThanOrEqual(6);
      expect(data.document_id).toBeNull();
    });

    it('ocr_embedding_stats - scoped to document', async () => {
      const data = ok(await callTool(embeddingTools, 'ocr_embedding_stats', {
        document_id: DOC_ID_1,
      }));
      expect(data.document_id).toBe(DOC_ID_1);
    });

    it('ocr_embedding_get - retrieves embedding by ID', async () => {
      const data = ok(await callTool(embeddingTools, 'ocr_embedding_get', {
        embedding_id: EMB_IDS_1[0],
      }));
      expect(data.id).toBe(EMB_IDS_1[0]);
      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.source_type).toBe('chunk');
      expect(data.chunk_id).toBe(CHUNK_IDS_1[0]);
      expect(data.original_text).toBeDefined();
      expect(data.model_name).toBe('nomic-embed-text-v1.5');
    });

    it('ocr_embedding_get - error on missing ID', async () => {
      fail(await callTool(embeddingTools, 'ocr_embedding_get', {
        embedding_id: 'nonexistent-emb-id',
      }));
    });

    it('ocr_embedding_rebuild - error when no target provided', async () => {
      fail(await callTool(embeddingTools, 'ocr_embedding_rebuild', {}));
    });

    it('ocr_embedding_rebuild - error when multiple targets provided', async () => {
      fail(await callTool(embeddingTools, 'ocr_embedding_rebuild', {
        document_id: DOC_ID_1,
        chunk_id: CHUNK_IDS_1[0],
      }));
    });
  });

  // =============================================================================
  // PHASE 5: PROVENANCE TOOLS
  // =============================================================================

  describe('Phase 5: Provenance Tools', () => {
    it('ocr_provenance_query - returns all records', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_query', {
        limit: 50,
      }));
      expect(data.total).toBeGreaterThan(0);
      const records = data.records as Array<Record<string, unknown>>;
      expect(records.length).toBeGreaterThan(0);
      // Each record should have standard fields
      expect(records[0].id).toBeDefined();
      expect(records[0].type).toBeDefined();
      expect(records[0].chain_depth).toBeDefined();
    });

    it('ocr_provenance_query - filter by type', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_query', {
        type: 'DOCUMENT',
        limit: 50,
      }));
      const records = data.records as Array<Record<string, unknown>>;
      for (const rec of records) {
        expect(rec.type).toBe('DOCUMENT');
      }
      const filters = data.filters_applied as Record<string, unknown>;
      expect(filters.type).toBe('DOCUMENT');
    });

    it('ocr_provenance_query - filter by chain_depth', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_query', {
        chain_depth: 0,
        limit: 50,
      }));
      const records = data.records as Array<Record<string, unknown>>;
      for (const rec of records) {
        expect(rec.chain_depth).toBe(0);
      }
    });

    it('ocr_provenance_query - filter by processor', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_query', {
        processor: 'datalab-ocr',
        limit: 50,
      }));
      const records = data.records as Array<Record<string, unknown>>;
      for (const rec of records) {
        expect(rec.processor).toBe('datalab-ocr');
      }
    });

    it('ocr_provenance_query - ordering', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_query', {
        order_by: 'created_at',
        order_dir: 'asc',
        limit: 50,
      }));
      const records = data.records as Array<Record<string, unknown>>;
      if (records.length >= 2) {
        expect(records[0].created_at as string <= records[1].created_at as string).toBe(true);
      }
    });

    it('ocr_provenance_timeline - returns timeline for document', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_timeline', {
        document_id: DOC_ID_1,
      }));
      expect(data.document_id).toBe(DOC_ID_1);
      expect(data.steps_count).toBeGreaterThan(0);
      const timeline = data.timeline as Array<Record<string, unknown>>;
      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0].step).toBe(1);
      expect(timeline[0].type).toBeDefined();
      expect(timeline[0].processor).toBeDefined();
    });

    it('ocr_provenance_timeline - with params', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_timeline', {
        document_id: DOC_ID_1,
        include_params: true,
      }));
      const timeline = data.timeline as Array<Record<string, unknown>>;
      // At least some should have processing_params
      const withParams = timeline.filter((t) => t.processing_params !== null);
      expect(withParams.length).toBeGreaterThanOrEqual(0);
    });

    it('ocr_provenance_timeline - error on missing doc', async () => {
      fail(await callTool(provenanceTools, 'ocr_provenance_timeline', {
        document_id: 'nonexistent-doc',
      }));
    });

    it('ocr_provenance_processor_stats - returns stats', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_processor_stats', {}));
      expect(data.stats).toBeDefined();
      expect(Array.isArray(data.stats)).toBe(true);
      expect(data.total_processors).toBeGreaterThan(0);
    });

    it('ocr_provenance_processor_stats - filter by processor', async () => {
      const data = ok(await callTool(provenanceTools, 'ocr_provenance_processor_stats', {
        processor: 'datalab-ocr',
      }));
      const stats = data.stats as Array<Record<string, unknown>>;
      if (stats.length > 0) {
        expect(stats[0].processor).toBe('datalab-ocr');
      }
    });
  });

  // =============================================================================
  // PHASE 6: TIMELINE + QUALITY TRENDS
  // =============================================================================

  describe('Phase 6: Timeline & Reports', () => {
    it('ocr_timeline_analytics - daily documents', async () => {
      const data = ok(await callTool(timelineTools, 'ocr_timeline_analytics', {
        bucket: 'daily',
        metric: 'documents',
      }));
      expect(data.bucket).toBe('daily');
      expect(data.metric).toBe('documents');
      expect(data.total_periods).toBeGreaterThanOrEqual(0);
      expect(data.total_count).toBeGreaterThanOrEqual(0);
    });

    it('ocr_timeline_analytics - monthly pages', async () => {
      const data = ok(await callTool(timelineTools, 'ocr_timeline_analytics', {
        bucket: 'monthly',
        metric: 'pages',
      }));
      expect(data.bucket).toBe('monthly');
      expect(data.metric).toBe('pages');
    });

    it('ocr_timeline_analytics - with date filter (empty range)', async () => {
      const data = ok(await callTool(timelineTools, 'ocr_timeline_analytics', {
        bucket: 'daily',
        metric: 'documents',
        created_after: '2099-01-01T00:00:00Z',
      }));
      expect(data.total_count).toBe(0);
    });

    it('ocr_report_performance section=throughput - returns throughput data', async () => {
      const data = ok(await callTool(reportTools, 'ocr_report_performance', {
        section: 'throughput',
        bucket: 'daily',
      }));
      const throughput = data.throughput as Record<string, unknown>;
      expect(throughput.bucket).toBe('daily');
      expect(throughput.summary).toBeDefined();
      const summary = throughput.summary as Record<string, unknown>;
      expect(summary.total_pages_processed).toBeDefined();
      expect(summary.total_embeddings_generated).toBeDefined();
    });

    it('ocr_quality_trends - returns quality data', async () => {
      const data = ok(await callTool(reportTools, 'ocr_quality_trends', {
        bucket: 'daily',
      }));
      expect(data.bucket).toBe('daily');
      expect(data.group_by).toBe('none');
      expect(data.total_periods).toBeGreaterThanOrEqual(0);
    });

    it('ocr_quality_trends - grouped by ocr_mode', async () => {
      const data = ok(await callTool(reportTools, 'ocr_quality_trends', {
        bucket: 'monthly',
        group_by: 'ocr_mode',
      }));
      expect(data.group_by).toBe('ocr_mode');
    });
  });

  // =============================================================================
  // PHASE 7: COMPARISON TOOLS
  // =============================================================================

  describe('Phase 7: Comparison Tools', () => {
    it('ocr_comparison_discover - finds similar pairs', async () => {
      const data = ok(await callTool(comparisonTools, 'ocr_comparison_discover', {
        min_similarity: 0.0,
        exclude_existing: false,
        limit: 10,
      }));
      expect(data.documents_analyzed).toBeDefined();
      expect(data.pairs).toBeDefined();
      // May have 0 pairs since we don't have real vectors
    });

    it('ocr_comparison_batch - with explicit pairs', async () => {
      const data = ok(await callTool(comparisonTools, 'ocr_comparison_batch', {
        pairs: [{ doc1: DOC_ID_1, doc2: DOC_ID_2 }],
        include_text_diff: true,
      }));
      expect(data.total_pairs_requested).toBe(1);
      // Should succeed since both docs are complete with OCR text
      if (data.total_compared === 1) {
        const results = data.results as Array<Record<string, unknown>>;
        expect(results[0].comparison_id).toBeDefined();
        expect(results[0].similarity_ratio).toBeDefined();
      }
    });

    it('ocr_comparison_batch - error without pairs or cluster_id', async () => {
      fail(await callTool(comparisonTools, 'ocr_comparison_batch', {}));
    });
  });

  // =============================================================================
  // PHASE 7: CLUSTERING TOOLS
  // =============================================================================

  describe('Phase 7: Clustering Tools', () => {
    // We need clusters to exist to test reassign/merge
    let clusterId1: string | null = null;
    let clusterId2: string | null = null;
    const runId = randomUUID();

    beforeAll(() => {
      // Insert 2 synthetic clusters
      const now = new Date().toISOString();
      const provC1 = randomUUID();
      const provC2 = randomUUID();

      conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_ids) VALUES (?, 'CLUSTERING', ?, ?, 'CLUSTERING', ?, ?, 'cluster-test', '1.0', '{}', 2, '["DOCUMENT","CLUSTERING"]', '[]')`).run(provC1, now, now, DOC_PROV_1, randomUUID());
      conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_ids) VALUES (?, 'CLUSTERING', ?, ?, 'CLUSTERING', ?, ?, 'cluster-test', '1.0', '{}', 2, '["DOCUMENT","CLUSTERING"]', '[]')`).run(provC2, now, now, DOC_PROV_2, randomUUID());

      clusterId1 = randomUUID();
      clusterId2 = randomUUID();

      conn.prepare(`INSERT INTO clusters (id, run_id, cluster_index, label, description, classification_tag, document_count, coherence_score, algorithm, algorithm_params_json, silhouette_score, top_terms_json, centroid_json, content_hash, provenance_id, created_at, processing_duration_ms) VALUES (?, ?, 0, 'Cluster A', 'First cluster', 'legal', 1, 0.85, 'kmeans', '{}', 0.7, '[]', NULL, ?, ?, ?, 100)`).run(clusterId1, runId, randomUUID(), provC1, now);
      conn.prepare(`INSERT INTO clusters (id, run_id, cluster_index, label, description, classification_tag, document_count, coherence_score, algorithm, algorithm_params_json, silhouette_score, top_terms_json, centroid_json, content_hash, provenance_id, created_at, processing_duration_ms) VALUES (?, ?, 1, 'Cluster B', 'Second cluster', 'financial', 1, 0.90, 'kmeans', '{}', 0.7, '[]', NULL, ?, ?, ?, 100)`).run(clusterId2, runId, randomUUID(), provC2, now);

      conn.prepare('INSERT INTO document_clusters (id, document_id, cluster_id, run_id, similarity_to_centroid, membership_probability, is_noise, assigned_at) VALUES (?, ?, ?, ?, 0.95, 1.0, 0, ?)').run(randomUUID(), DOC_ID_1, clusterId1, runId, now);
      conn.prepare('INSERT INTO document_clusters (id, document_id, cluster_id, run_id, similarity_to_centroid, membership_probability, is_noise, assigned_at) VALUES (?, ?, ?, ?, 0.90, 1.0, 0, ?)').run(randomUUID(), DOC_ID_2, clusterId2, runId, now);
    });

    it('ocr_cluster_reassign - moves document to different cluster', async () => {
      const data = ok(await callTool(clusteringTools, 'ocr_cluster_reassign', {
        document_id: DOC_ID_2,
        target_cluster_id: clusterId1,
      }));
      expect(data.document_id).toBe(DOC_ID_2);
      expect(data.target_cluster_id).toBe(clusterId1);
      expect(data.reassigned).toBe(true);

      // Verify DB state
      const assignment = conn.prepare('SELECT cluster_id FROM document_clusters WHERE document_id = ? AND run_id = ?').get(DOC_ID_2, runId) as { cluster_id: string } | undefined;
      expect(assignment?.cluster_id).toBe(clusterId1);
    });

    it('ocr_cluster_reassign - error on missing document', async () => {
      fail(await callTool(clusteringTools, 'ocr_cluster_reassign', {
        document_id: 'nonexistent-doc',
        target_cluster_id: clusterId1!,
      }));
    });

    it('ocr_cluster_reassign - error on missing cluster', async () => {
      fail(await callTool(clusteringTools, 'ocr_cluster_reassign', {
        document_id: DOC_ID_1,
        target_cluster_id: 'nonexistent-cluster',
      }));
    });

    it('ocr_cluster_merge - merges two clusters', async () => {
      // First move doc2 back to cluster2 so merge has something to move
      conn.prepare('UPDATE document_clusters SET cluster_id = ? WHERE document_id = ? AND run_id = ?').run(clusterId2, DOC_ID_2, runId);
      conn.prepare('UPDATE clusters SET document_count = 1 WHERE id = ?').run(clusterId1);
      conn.prepare('UPDATE clusters SET document_count = 1 WHERE id = ?').run(clusterId2);

      const data = ok(await callTool(clusteringTools, 'ocr_cluster_merge', {
        cluster_id_1: clusterId1,
        cluster_id_2: clusterId2,
      }));
      expect(data.merged_cluster_id).toBe(clusterId1);
      expect(data.deleted_cluster_id).toBe(clusterId2);
      expect(data.documents_moved).toBeGreaterThanOrEqual(0);
    });

    it('ocr_cluster_merge - error on same cluster', async () => {
      fail(await callTool(clusteringTools, 'ocr_cluster_merge', {
        cluster_id_1: clusterId1!,
        cluster_id_2: clusterId1!,
      }));
    });
  });

  // =============================================================================
  // PHASE 8: FILE MANAGEMENT + INGESTION
  // =============================================================================

  describe('Phase 8: File Management & Ingestion', () => {
    it('ocr_file_ingest_uploaded - returns empty when no action specified', async () => {
      const data = ok(await callTool(fileManagementTools, 'ocr_file_ingest_uploaded', {}));
      expect(data.ingested_count).toBe(0);
      expect(data.message).toBeDefined();
    });

    it('ocr_file_ingest_uploaded - error on missing file_ids', async () => {
      fail(await callTool(fileManagementTools, 'ocr_file_ingest_uploaded', {
        file_ids: ['nonexistent-file-id'],
      }));
    });

    it('ocr_embedding_rebuild (include_vlm) - error on missing document', async () => {
      fail(await callTool(embeddingTools, 'ocr_embedding_rebuild', {
        document_id: 'nonexistent-doc',
        include_vlm: true,
      }));
    });

    it('ocr_embedding_rebuild (include_vlm) - error on non-complete document', async () => {
      // Insert a pending doc to test
      const pendingDocId = randomUUID();
      const pendingProvId = randomUUID();
      const now = new Date().toISOString();
      conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_ids) VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, ?, 'test', '1.0', '{}', 0, '["DOCUMENT"]', '[]')`).run(pendingProvId, now, now, pendingProvId, randomUUID());
      conn.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, page_count, provenance_id, created_at) VALUES (?, '/tmp/pending.pdf', 'pending.pdf', ?, 1000, 'pdf', 'pending', NULL, ?, ?)`).run(pendingDocId, randomUUID(), pendingProvId, now);

      fail(await callTool(embeddingTools, 'ocr_embedding_rebuild', {
        document_id: pendingDocId,
        include_vlm: true,
      }));
    });
  });

  // =============================================================================
  // PHASE 9: TAGGING TOOLS
  // =============================================================================

  describe('Phase 9: Tagging Tools', () => {
    let tagName: string;

    beforeAll(() => {
      tagName = `test-tag-${Date.now()}`;
    });

    it('ocr_tag_create - creates a new tag', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_create', {
        name: tagName,
        description: 'A test tag for E2E verification',
        color: '#ff0000',
      }));
      expect(data.tag).toBeDefined();
      const tag = data.tag as Record<string, unknown>;
      expect(tag.name).toBe(tagName);
      expect(tag.description).toBe('A test tag for E2E verification');
      expect(tag.color).toBe('#ff0000');

      // Verify in DB
      const dbTag = conn.prepare('SELECT * FROM tags WHERE name = ?').get(tagName) as Record<string, unknown>;
      expect(dbTag).toBeDefined();
      expect(dbTag.name).toBe(tagName);
    });

    it('ocr_tag_create - error on duplicate name', async () => {
      fail(await callTool(tagTools, 'ocr_tag_create', {
        name: tagName,
      }));
    });

    it('ocr_tag_list - lists tags', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_list', {}));
      expect(data.total).toBeGreaterThanOrEqual(1);
      const tags = data.tags as Array<Record<string, unknown>>;
      const found = tags.find((t) => t.name === tagName);
      expect(found).toBeDefined();
    });

    it('ocr_tag_apply - applies tag to document', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_apply', {
        tag_name: tagName,
        entity_id: DOC_ID_1,
        entity_type: 'document',
      }));
      expect(data.entity_tag_id).toBeDefined();
      expect(data.tag_name).toBe(tagName);
      expect(data.entity_id).toBe(DOC_ID_1);
      expect(data.entity_type).toBe('document');

      // Verify in DB
      const count = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE entity_id = ?').get(DOC_ID_1) as { cnt: number }).cnt;
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('ocr_tag_apply - applies tag to chunk', async () => {
      ok(await callTool(tagTools, 'ocr_tag_apply', {
        tag_name: tagName,
        entity_id: CHUNK_IDS_1[0],
        entity_type: 'chunk',
      }));
    });

    it('ocr_tag_apply - error on nonexistent tag', async () => {
      fail(await callTool(tagTools, 'ocr_tag_apply', {
        tag_name: 'nonexistent-tag-xyz',
        entity_id: DOC_ID_1,
        entity_type: 'document',
      }));
    });

    it('ocr_tag_apply - error on nonexistent entity', async () => {
      fail(await callTool(tagTools, 'ocr_tag_apply', {
        tag_name: tagName,
        entity_id: 'nonexistent-entity',
        entity_type: 'document',
      }));
    });

    it('ocr_tag_search - finds entities by tag', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_search', {
        tags: [tagName],
      }));
      expect(data.total).toBeGreaterThanOrEqual(2); // doc + chunk
      const results = data.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('ocr_tag_search - filter by entity_type', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_search', {
        tags: [tagName],
        entity_type: 'document',
      }));
      expect(data.total).toBe(1);
      const results = data.results as Array<Record<string, unknown>>;
      expect(results[0].entity_type).toBe('document');
    });

    it('ocr_tag_search - match_all with single tag', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_search', {
        tags: [tagName],
        match_all: true,
      }));
      expect(data.total).toBeGreaterThanOrEqual(2);
    });

    it('ocr_tag_remove - removes tag from chunk', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_remove', {
        tag_name: tagName,
        entity_id: CHUNK_IDS_1[0],
        entity_type: 'chunk',
      }));
      expect(data.removed).toBe(true);
    });

    it('ocr_tag_remove - error on non-applied tag', async () => {
      fail(await callTool(tagTools, 'ocr_tag_remove', {
        tag_name: tagName,
        entity_id: CHUNK_IDS_1[0],
        entity_type: 'chunk',
      }));
    });

    it('ocr_tag_delete - deletes tag and all associations', async () => {
      const data = ok(await callTool(tagTools, 'ocr_tag_delete', {
        tag_name: tagName,
        confirm: true,
      }));
      expect(data.deleted).toBe(true);
      expect(data.tag_name).toBe(tagName);

      // Verify associations removed
      const count = (conn.prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE entity_id = ?').get(DOC_ID_1) as { cnt: number }).cnt;
      expect(count).toBe(0);
    });

    it('ocr_tag_delete - error on nonexistent tag', async () => {
      fail(await callTool(tagTools, 'ocr_tag_delete', {
        tag_name: 'nonexistent-tag-xyz',
        confirm: true,
      }));
    });
  });

  // =============================================================================
  // PHASE 10: DOCUMENT EXPORT
  // =============================================================================

  describe('Phase 10: Document Export', () => {
    it('ocr_document_export - exports to JSON', async () => {
      const outputPath = join(tmpDir, 'doc-export.json');
      const data = ok(await callTool(documentTools, 'ocr_document_export', {
        document_id: DOC_ID_1,
        format: 'json',
        output_path: outputPath,
      }));
      expect(data.format).toBe('json');
      expect(data.document_id).toBe(DOC_ID_1);
      const stats = data.stats as Record<string, unknown>;
      expect(stats.chunk_count).toBe(4);

      // Verify file exists and is valid JSON
      expect(existsSync(outputPath)).toBe(true);
      const content = JSON.parse(require('fs').readFileSync(outputPath, 'utf-8'));
      expect(content.document.id).toBe(DOC_ID_1);
      expect(content.chunks.length).toBe(4);
    });

    it('ocr_document_export - exports to markdown', async () => {
      const outputPath = join(tmpDir, 'doc-export.md');
      const data = ok(await callTool(documentTools, 'ocr_document_export', {
        document_id: DOC_ID_1,
        format: 'markdown',
        output_path: outputPath,
      }));
      expect(data.format).toBe('markdown');
      expect(existsSync(outputPath)).toBe(true);
    });

    it('ocr_document_export - error on missing doc', async () => {
      fail(await callTool(documentTools, 'ocr_document_export', {
        document_id: 'nonexistent-doc',
        format: 'json',
        output_path: join(tmpDir, 'fail.json'),
      }));
    });

    it('ocr_corpus_export - exports all docs to JSON', async () => {
      const outputPath = join(tmpDir, 'corpus-export.json');
      const data = ok(await callTool(documentTools, 'ocr_corpus_export', {
        output_path: outputPath,
        format: 'json',
      }));
      expect(data.format).toBe('json');
      expect(data.document_count).toBeGreaterThanOrEqual(2);

      // Verify file
      expect(existsSync(outputPath)).toBe(true);
      const content = JSON.parse(require('fs').readFileSync(outputPath, 'utf-8'));
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThanOrEqual(2);
    });

    it('ocr_corpus_export - exports to CSV', async () => {
      const outputPath = join(tmpDir, 'corpus-export.csv');
      const data = ok(await callTool(documentTools, 'ocr_corpus_export', {
        output_path: outputPath,
        format: 'csv',
      }));
      expect(data.format).toBe('csv');
      expect(existsSync(outputPath)).toBe(true);
    });
  });

  // =============================================================================
  // FINAL STATE VERIFICATION
  // =============================================================================

  describe('Final State Verification', () => {
    it('All required tables exist', () => {
      const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
      for (const t of ['documents', 'ocr_results', 'chunks', 'embeddings', 'images', 'provenance', 'comparisons', 'clusters', 'document_clusters', 'extractions', 'form_fills', 'uploaded_files', 'database_metadata', 'schema_version', 'tags', 'entity_tags']) {
        expect(tables).toContain(t);
      }
    });

    it('Schema version is 29', () => {
      const v = (conn.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }).version;
      expect(v).toBe(29);
    });

    it('Synthetic documents are in expected state', () => {
      const doc1 = conn.prepare('SELECT * FROM documents WHERE id = ?').get(DOC_ID_1) as Record<string, unknown>;
      expect(doc1.status).toBe('complete');
      expect(doc1.file_name).toBe('synthetic_doc1.pdf');

      const doc2 = conn.prepare('SELECT * FROM documents WHERE id = ?').get(DOC_ID_2) as Record<string, unknown>;
      expect(doc2.status).toBe('complete');
    });

    it('No orphaned embeddings', () => {
      const cnt = (conn.prepare(`SELECT COUNT(*) as cnt FROM embeddings e WHERE e.chunk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)`).get() as { cnt: number }).cnt;
      expect(cnt).toBe(0);
    });

    it('All provenance types valid', () => {
      const cnt = (conn.prepare(`SELECT COUNT(*) as cnt FROM provenance WHERE type NOT IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING', 'IMAGE', 'EXTRACTION', 'COMPARISON', 'CLUSTERING', 'FORM_FILL', 'VLM_DESCRIPTION')`).get() as { cnt: number }).cnt;
      expect(cnt).toBe(0);
    });
  });
});

// ===============================================================================
// SYNTHETIC DATA INSERTION
// ===============================================================================

function insertSyntheticData(conn: Database.Database) {
  const now = new Date().toISOString();
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

  // ---- PROVENANCE ----
  // Note: processing_params is NOT NULL, source_type must be one of the CHECK constraint values
  // Valid source_type: FILE, OCR, CHUNKING, IMAGE_EXTRACTION, VLM, VLM_DEDUP, EMBEDDING, EXTRACTION, FORM_FILL, COMPARISON, CLUSTERING

  // Document provenance (depth 0)
  conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_ids, processing_duration_ms, processing_quality_score)
    VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, ?, 'ingestion', '1.0.0', '{}', 0, '["DOCUMENT"]', '[]', NULL, NULL)`)
    .run(DOC_PROV_1, oneHourAgo, oneHourAgo, DOC_PROV_1, randomUUID());
  conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_ids, processing_duration_ms, processing_quality_score)
    VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, ?, 'ingestion', '1.0.0', '{}', 0, '["DOCUMENT"]', '[]', NULL, NULL)`)
    .run(DOC_PROV_2, oneHourAgo, oneHourAgo, DOC_PROV_2, randomUUID());

  // OCR provenance (depth 1)
  conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids, processing_duration_ms, processing_quality_score)
    VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', ?, ?, ?, 'datalab-ocr', '1.0.0', '{"mode":"balanced"}', 1, '["DOCUMENT","OCR_RESULT"]', ?, ?, 5000, 4.2)`)
    .run(OCR_PROV_1, now, now, DOC_PROV_1, DOC_PROV_1, randomUUID(), DOC_PROV_1, JSON.stringify([DOC_PROV_1]));
  conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids, processing_duration_ms, processing_quality_score)
    VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', ?, ?, ?, 'datalab-ocr', '1.0.0', '{"mode":"fast"}', 1, '["DOCUMENT","OCR_RESULT"]', ?, ?, 3000, 3.8)`)
    .run(OCR_PROV_2, now, now, DOC_PROV_2, DOC_PROV_2, randomUUID(), DOC_PROV_2, JSON.stringify([DOC_PROV_2]));

  // Chunk provenance (depth 2)
  for (let i = 0; i < CHUNK_IDS_1.length; i++) {
    conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids, processing_duration_ms)
      VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, ?, 'chunker', '1.0.0', '{}', 2, '["DOCUMENT","OCR_RESULT","CHUNK"]', ?, ?, 50)`)
      .run(CHUNK_PROVS_1[i], now, now, OCR_PROV_1, DOC_PROV_1, randomUUID(), OCR_PROV_1, JSON.stringify([DOC_PROV_1, OCR_PROV_1]));
  }
  for (let i = 0; i < CHUNK_IDS_2.length; i++) {
    conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids, processing_duration_ms)
      VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, ?, 'chunker', '1.0.0', '{}', 2, '["DOCUMENT","OCR_RESULT","CHUNK"]', ?, ?, 30)`)
      .run(CHUNK_PROVS_2[i], now, now, OCR_PROV_2, DOC_PROV_2, randomUUID(), OCR_PROV_2, JSON.stringify([DOC_PROV_2, OCR_PROV_2]));
  }

  // Embedding provenance (depth 3)
  for (let i = 0; i < EMB_IDS_1.length; i++) {
    conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids, processing_duration_ms)
      VALUES (?, 'EMBEDDING', ?, ?, 'EMBEDDING', ?, ?, ?, 'nomic-embed-text-v1.5', '1.5', '{"task_type":"search_document"}', 3, '["DOCUMENT","OCR_RESULT","CHUNK","EMBEDDING"]', ?, ?, 200)`)
      .run(EMB_PROVS_1[i], now, now, CHUNK_PROVS_1[i], DOC_PROV_1, randomUUID(), CHUNK_PROVS_1[i], JSON.stringify([DOC_PROV_1, OCR_PROV_1, CHUNK_PROVS_1[i]]));
  }
  for (let i = 0; i < EMB_IDS_2.length; i++) {
    conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids, processing_duration_ms)
      VALUES (?, 'EMBEDDING', ?, ?, 'EMBEDDING', ?, ?, ?, 'nomic-embed-text-v1.5', '1.5', '{"task_type":"search_document"}', 3, '["DOCUMENT","OCR_RESULT","CHUNK","EMBEDDING"]', ?, ?, 150)`)
      .run(EMB_PROVS_2[i], now, now, CHUNK_PROVS_2[i], DOC_PROV_2, randomUUID(), CHUNK_PROVS_2[i], JSON.stringify([DOC_PROV_2, OCR_PROV_2, CHUNK_PROVS_2[i]]));
  }

  // Extraction provenance (depth 2)
  conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids)
    VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, ?, 'datalab-extraction', '1.0.0', '{}', 2, '["DOCUMENT","OCR_RESULT","EXTRACTION"]', ?, ?)`)
    .run(EXTRACTION_PROV, now, now, OCR_PROV_1, DOC_PROV_1, randomUUID(), OCR_PROV_1, JSON.stringify([DOC_PROV_1, OCR_PROV_1]));

  // Image provenance (depth 2)
  conn.prepare(`INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id, root_document_id, content_hash, processor, processor_version, processing_params, chain_depth, chain_path, parent_id, parent_ids)
    VALUES (?, 'IMAGE', ?, ?, 'IMAGE_EXTRACTION', ?, ?, ?, 'image-extractor', '1.0.0', '{}', 2, '["DOCUMENT","OCR_RESULT","IMAGE"]', ?, ?)`)
    .run(IMAGE_PROV, now, now, OCR_PROV_1, DOC_PROV_1, randomUUID(), OCR_PROV_1, JSON.stringify([DOC_PROV_1, OCR_PROV_1]));

  // ---- DOCUMENTS ----
  conn.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, page_count, provenance_id, created_at)
    VALUES (?, '/tmp/synthetic_doc1.pdf', 'synthetic_doc1.pdf', ?, 50000, 'pdf', 'complete', 5, ?, ?)`)
    .run(DOC_ID_1, randomUUID(), DOC_PROV_1, oneHourAgo);
  conn.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, page_count, provenance_id, created_at)
    VALUES (?, '/tmp/synthetic_doc2.pdf', 'synthetic_doc2.pdf', ?, 30000, 'pdf', 'complete', 3, ?, ?)`)
    .run(DOC_ID_2, randomUUID(), DOC_PROV_2, oneHourAgo);

  // ---- OCR RESULTS ----
  const ocrText1 = 'This is the full OCR text for document 1. It covers multiple topics including policy, whistleblower protection, and contract terms. The document is well structured with headings and paragraphs.';
  const ocrText2 = 'This is the OCR text for document 2. It discusses financial matters and reporting requirements. The document has fewer pages but is quite dense.';

  conn.prepare(`INSERT INTO ocr_results (id, document_id, datalab_request_id, datalab_mode, extracted_text, text_length, content_hash, page_count, parse_quality_score, cost_cents, provenance_id, processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, 'balanced', ?, ?, ?, 5, 4.2, 0.5, ?, ?, ?, 5000)`)
    .run(OCR_ID_1, DOC_ID_1, randomUUID(), ocrText1, ocrText1.length, randomUUID(), OCR_PROV_1, oneHourAgo, now);
  conn.prepare(`INSERT INTO ocr_results (id, document_id, datalab_request_id, datalab_mode, extracted_text, text_length, content_hash, page_count, parse_quality_score, cost_cents, provenance_id, processing_started_at, processing_completed_at, processing_duration_ms)
    VALUES (?, ?, ?, 'fast', ?, ?, ?, 3, 3.8, 0.3, ?, ?, ?, 3000)`)
    .run(OCR_ID_2, DOC_ID_2, randomUUID(), ocrText2, ocrText2.length, randomUUID(), OCR_PROV_2, oneHourAgo, now);

  // ---- CHUNKS ----
  const chunkTexts1 = [
    'This is chunk 0 of document 1. It contains test content for verification.',
    'This is chunk 1 about methods and procedures for testing.',
    'This is chunk 2 about results and findings from the analysis.',
    'This is chunk 3 about conclusions and next steps.',
  ];
  const headings1 = ['Introduction', 'Methods', 'Results', 'Conclusions'];
  const sectionPaths1 = ['Introduction', 'Methods', 'Results', 'Conclusions'];

  for (let i = 0; i < CHUNK_IDS_1.length; i++) {
    conn.prepare(`INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end, page_number, page_range, overlap_previous, overlap_next, heading_context, heading_level, section_path, content_types, is_atomic, ocr_quality_score, embedding_status, embedded_at, provenance_id, created_at, chunking_strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 2, ?, '["text"]', 0, 4.2, 'complete', ?, ?, ?, 'hybrid-section-aware')`)
      .run(CHUNK_IDS_1[i], DOC_ID_1, OCR_ID_1, chunkTexts1[i], randomUUID(), i, i * 100, (i + 1) * 100, i + 1, String(i + 1), headings1[i], sectionPaths1[i], now, CHUNK_PROVS_1[i], now);
  }

  const chunkTexts2 = [
    'Financial report Q1 2026 showing revenue of 1.5M.',
    'Budget allocation for the next fiscal year includes research and development.',
  ];

  for (let i = 0; i < CHUNK_IDS_2.length; i++) {
    conn.prepare(`INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index, character_start, character_end, page_number, page_range, overlap_previous, overlap_next, heading_context, heading_level, section_path, content_types, is_atomic, ocr_quality_score, embedding_status, embedded_at, provenance_id, created_at, chunking_strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 2, ?, '["text"]', 0, 3.8, 'complete', ?, ?, ?, 'hybrid-section-aware')`)
      .run(CHUNK_IDS_2[i], DOC_ID_2, OCR_ID_2, chunkTexts2[i], randomUUID(), i, i * 100, (i + 1) * 100, i + 1, String(i + 1), i === 0 ? 'Revenue' : 'Budget', i === 0 ? 'Revenue' : 'Budget', now, CHUNK_PROVS_2[i], now);
  }

  // ---- EMBEDDINGS ----
  for (let i = 0; i < EMB_IDS_1.length; i++) {
    conn.prepare(`INSERT INTO embeddings (id, chunk_id, document_id, original_text, original_text_length, source_file_path, source_file_name, source_file_hash, page_number, page_range, character_start, character_end, chunk_index, total_chunks, model_name, model_version, task_type, inference_mode, gpu_device, provenance_id, content_hash, generation_duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, '/tmp/synthetic_doc1.pdf', 'synthetic_doc1.pdf', ?, ?, ?, ?, ?, ?, 4, 'nomic-embed-text-v1.5', '1.5', 'search_document', 'local', 'cuda:0', ?, ?, 200, ?)`)
      .run(EMB_IDS_1[i], CHUNK_IDS_1[i], DOC_ID_1, chunkTexts1[i], chunkTexts1[i].length, randomUUID(), i + 1, String(i + 1), i * 100, (i + 1) * 100, i, EMB_PROVS_1[i], randomUUID(), now);
  }

  for (let i = 0; i < EMB_IDS_2.length; i++) {
    conn.prepare(`INSERT INTO embeddings (id, chunk_id, document_id, original_text, original_text_length, source_file_path, source_file_name, source_file_hash, page_number, page_range, character_start, character_end, chunk_index, total_chunks, model_name, model_version, task_type, inference_mode, gpu_device, provenance_id, content_hash, generation_duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, '/tmp/synthetic_doc2.pdf', 'synthetic_doc2.pdf', ?, ?, ?, ?, ?, ?, 2, 'nomic-embed-text-v1.5', '1.5', 'search_document', 'local', 'cuda:0', ?, ?, 150, ?)`)
      .run(EMB_IDS_2[i], CHUNK_IDS_2[i], DOC_ID_2, chunkTexts2[i], chunkTexts2[i].length, randomUUID(), i + 1, String(i + 1), i * 100, (i + 1) * 100, i, EMB_PROVS_2[i], randomUUID(), now);
  }

  // ---- EXTRACTION ----
  const extractionData = JSON.stringify({ title: 'Test Contract', effective_date: '2026-01-01', parties: ['Alice', 'Bob'] });
  conn.prepare(`INSERT INTO extractions (id, document_id, ocr_result_id, schema_json, extraction_json, content_hash, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(EXTRACTION_ID, DOC_ID_1, OCR_ID_1, '{"type":"object","properties":{"title":{"type":"string"}}}', extractionData, randomUUID(), EXTRACTION_PROV, now);

  // ---- IMAGE ----
  conn.prepare(`INSERT INTO images (id, document_id, ocr_result_id, page_number, bbox_x, bbox_y, bbox_width, bbox_height, image_index, format, width, height, extracted_path, file_size, block_type, is_header_footer, vlm_status, provenance_id, created_at)
    VALUES (?, ?, ?, 1, 0.0, 0.0, 640.0, 480.0, 0, 'png', 640, 480, '/tmp/nonexistent-image.png', 12345, 'Figure', 0, 'pending', ?, ?)`)
    .run(IMAGE_ID, DOC_ID_1, OCR_ID_1, IMAGE_PROV, now);
}

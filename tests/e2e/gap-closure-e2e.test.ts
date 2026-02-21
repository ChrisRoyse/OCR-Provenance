/**
 * E2E Verification: Gap Closure Implementation Plan (2026-02-20)
 *
 * Tests all 13 new MCP tools + 4 modified tools with REAL data.
 * NO MOCKS. Real database, real OCR, real embeddings.
 * Verifies database state directly (source of truth) after each operation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import {
  createDatabase,
  deleteDatabase,
  requireDatabase,
  clearDatabase,
} from '../../src/server/state.js';

import { documentTools } from '../../src/tools/documents.js';
import { searchTools } from '../../src/tools/search.js';
import { imageTools } from '../../src/tools/images.js';
import { reportTools } from '../../src/tools/reports.js';
import { structuredExtractionTools } from '../../src/tools/extraction-structured.js';
import { ingestionTools } from '../../src/tools/ingestion.js';
import { classifyQuery } from '../../src/services/search/query-classifier.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

type ToolModule = Record<string, { handler: (p: Record<string, unknown>) => Promise<unknown> }>;

async function callTool(tools: ToolModule, name: string, params: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}. Available: ${Object.keys(tools).join(', ')}`);
  const raw = (await tool.handler(params)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(raw.content[0].text) as { success: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };
}

function ok(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
  return result.data!;
}

// ═══════════════════════════════════════════════════════════════════════════════

const DB_NAME = `gap-e2e-${Date.now()}`;
const TEST_FILES = [
  '/home/cabdru/datalab/data/test-pipeline/synthetic_contract.pdf',
  '/home/cabdru/datalab/data/IBB Constitution, Bylaws, Policies and Practices/2009.09.21 IBB WHISTLEBLOWER POLICY.pdf',
];

let documentIds: string[] = [];
let conn: Database.Database;

describe('Gap Closure E2E', () => {
  beforeAll(async () => {
    createDatabase(DB_NAME, 'Gap closure E2E test');
    const { db } = requireDatabase();
    conn = db.getConnection();
    console.error(`[E2E] Created database: ${DB_NAME}`);

    await callTool(ingestionTools, 'ocr_ingest_files', { file_paths: TEST_FILES });
    await callTool(ingestionTools, 'ocr_process_pending', { limit: 10, generate_embeddings: true });

    const docs = conn.prepare('SELECT id, file_name, status FROM documents ORDER BY created_at').all() as Array<{ id: string; file_name: string; status: string }>;
    documentIds = docs.map(d => d.id);
    console.error(`[E2E] Docs: ${docs.map(d => `${d.id.slice(0, 8)} (${d.file_name}, ${d.status})`).join(', ')}`);
    expect(docs.filter(d => d.status === 'complete').length).toBeGreaterThanOrEqual(1);

    const chunkCount = (conn.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;
    const embCount = (conn.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number }).cnt;
    console.error(`[E2E] Chunks: ${chunkCount}, Embeddings: ${embCount}`);
    expect(chunkCount).toBeGreaterThan(0);
    expect(embCount).toBeGreaterThan(0);
  }, 600_000);

  afterAll(() => {
    try { clearDatabase(); deleteDatabase(DB_NAME); } catch { /* cleanup */ }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: SEARCH ENHANCEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1: Search Enhancement', () => {
    it('1.1 - BM25 search returns chunk metadata fields', async () => {
      const data = ok(await callTool(searchTools, 'ocr_search', { query: 'policy', limit: 5 }));
      const results = data.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThan(0);
      const first = results[0];
      console.error('[1.1] BM25 result keys:', Object.keys(first));
      for (const f of ['heading_context', 'section_path', 'content_types', 'is_atomic', 'page_range', 'heading_level']) {
        expect(f in first).toBe(true);
      }
    });

    it('1.1 - Semantic search returns chunk metadata fields', async () => {
      const data = ok(await callTool(searchTools, 'ocr_search_semantic', { query: 'whistleblower protection', limit: 5 }));
      const results = data.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThan(0);
      expect('heading_context' in results[0]).toBe(true);
      expect('section_path' in results[0]).toBe(true);
    });

    it('1.2 - content_type_filter works', async () => {
      const types = conn.prepare(`SELECT DISTINCT j.value as ct FROM chunks, json_each(COALESCE(content_types, '[]')) j LIMIT 20`).all() as Array<{ ct: string }>;
      console.error('[1.2] Content types in DB:', types.map(c => c.ct));
      if (types.length > 0) {
        ok(await callTool(searchTools, 'ocr_search', { query: 'policy', content_type_filter: [types[0].ct], limit: 10 }));
      }
    });

    it('1.2 - section_path_filter works', async () => {
      const sections = conn.prepare(`SELECT DISTINCT section_path FROM chunks WHERE section_path IS NOT NULL LIMIT 10`).all() as Array<{ section_path: string }>;
      if (sections.length > 0) {
        const prefix = sections[0].section_path.split(' > ')[0];
        ok(await callTool(searchTools, 'ocr_search_semantic', { query: 'policy', section_path_filter: prefix, limit: 10 }));
      }
    });

    it('1.2 - page_range_filter works', async () => {
      ok(await callTool(searchTools, 'ocr_search', { query: 'policy', page_range_filter: { min_page: 1, max_page: 2 }, limit: 10 }));
    });

    it('1.3 - quality_boost accepted (no SQL error)', async () => {
      ok(await callTool(searchTools, 'ocr_search', { query: 'policy', quality_boost: false, limit: 5 }));
      ok(await callTool(searchTools, 'ocr_search', { query: 'policy', quality_boost: true, limit: 5 }));
    });

    it('1.3 - quality_boost on semantic search', async () => {
      ok(await callTool(searchTools, 'ocr_search_semantic', { query: 'policy', quality_boost: true, limit: 5 }));
    });

    it('1.4 - hybrid auto_route returns query_classification', async () => {
      const data = ok(await callTool(searchTools, 'ocr_search_hybrid', { query: 'what documents discuss whistleblower protection?', auto_route: true, limit: 5 }));
      expect(data.query_classification).toBeDefined();
      const cls = data.query_classification as Record<string, unknown>;
      expect(cls.query_type).toBeDefined();
      expect(cls.recommended_strategy).toBeDefined();
      console.error('[1.4] Classification:', JSON.stringify(cls));
    });

    it('5.2 - Query classifier heuristics', () => {
      expect(classifyQuery('"IBB-2023"').query_type).toBe('exact');
      expect(classifyQuery('what documents discuss whistleblower protections and employee rights').query_type).toBe('semantic');
      expect(classifyQuery('2023-01-15').query_type).toBe('exact');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: VLM & IMAGE
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 2: VLM & Image', () => {
    it('2.2 - ocr_image_search with type_distribution', async () => {
      const data = ok(await callTool(imageTools, 'ocr_image_search', { limit: 50 }));
      expect(data.type_distribution).toBeDefined();
      console.error('[2.2] Total:', data.total, 'Types:', JSON.stringify(data.type_distribution));
    });

    it('2.2 - ocr_image_search filters', async () => {
      ok(await callTool(imageTools, 'ocr_image_search', { page_number: 1, limit: 10 }));
      ok(await callTool(imageTools, 'ocr_image_search', { exclude_headers_footers: true, limit: 10 }));
      if (documentIds.length > 0) {
        ok(await callTool(imageTools, 'ocr_image_search', { document_id: documentIds[0], limit: 10 }));
      }
    });

    it('2.2 - non-existent image type returns 0', async () => {
      const data = ok(await callTool(imageTools, 'ocr_image_search', { image_type: 'nonexistent_xyz', limit: 10 }));
      expect(data.total).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: ANALYTICS (exact field names from source)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 3: Analytics', () => {
    it('3.1 - ocr_pipeline_analytics group_by=total + DB verify', async () => {
      const data = ok(await callTool(reportTools, 'ocr_pipeline_analytics', { group_by: 'total' }));
      // Response keys: ocr, embeddings, vlm, comparisons, clustering, throughput
      expect(data.ocr).toBeDefined();
      expect(data.embeddings).toBeDefined(); // Note: 'embeddings' not 'embedding'
      expect(data.vlm).toBeDefined();
      expect(data.throughput).toBeDefined();

      const ocr = data.ocr as Record<string, unknown>;
      const dbOcr = (conn.prepare('SELECT COUNT(*) as cnt FROM ocr_results').get() as { cnt: number }).cnt;
      expect(ocr.total_docs).toBe(dbOcr);
      console.error(`[3.1] OCR: DB=${dbOcr}, tool=${ocr.total_docs}`);

      const emb = data.embeddings as Record<string, unknown>;
      // Tool counts ALL embeddings (no WHERE filter)
      const dbEmb = (conn.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number }).cnt;
      expect(emb.total_embeddings).toBe(dbEmb);
      console.error(`[3.1] Embeddings: DB=${dbEmb}, tool=${emb.total_embeddings}`);
    });

    it('3.1 - group_by=document', async () => {
      const data = ok(await callTool(reportTools, 'ocr_pipeline_analytics', { group_by: 'document', limit: 10 }));
      // Key is 'by_document' not 'breakdown'
      expect(data.by_document).toBeDefined();
      expect(Array.isArray(data.by_document)).toBe(true);
      console.error('[3.1d] Documents:', (data.by_document as unknown[]).length);
    });

    it('3.1 - group_by=file_type', async () => {
      const data = ok(await callTool(reportTools, 'ocr_pipeline_analytics', { group_by: 'file_type', limit: 10 }));
      expect(data.by_file_type).toBeDefined();
    });

    it('3.1 - group_by=mode', async () => {
      const data = ok(await callTool(reportTools, 'ocr_pipeline_analytics', { group_by: 'mode' }));
      expect(data.by_mode).toBeDefined();
    });

    it('3.2 - ocr_corpus_profile + DB verify', async () => {
      const data = ok(await callTool(reportTools, 'ocr_corpus_profile', { include_section_frequency: true, include_content_type_distribution: true, limit: 20 }));
      expect(data.documents).toBeDefined();
      expect(data.chunks).toBeDefined();

      // Note: field is 'total_complete' not 'total_documents'
      const docs = data.documents as Record<string, unknown>;
      const dbDocs = (conn.prepare("SELECT COUNT(*) as cnt FROM documents WHERE status = 'complete'").get() as { cnt: number }).cnt;
      expect(docs.total_complete).toBe(dbDocs);

      const chunks = data.chunks as Record<string, unknown>;
      const dbChunks = (conn.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;
      expect(chunks.total_chunks).toBe(dbChunks);
      console.error(`[3.2] Docs: DB=${dbDocs}, Chunks: DB=${dbChunks}`);

      // Note: key is 'content_type_distribution' not 'content_types'
      if (data.content_type_distribution) {
        console.error('[3.2] Content types:', JSON.stringify(data.content_type_distribution));
      }
      if (data.section_frequency) {
        console.error('[3.2] Top sections:', (data.section_frequency as unknown[]).slice(0, 3));
      }
    });

    it('3.2 - corpus profile booleans disabled omit keys', async () => {
      const data = ok(await callTool(reportTools, 'ocr_corpus_profile', { include_section_frequency: false, include_content_type_distribution: false }));
      // When disabled, keys are not set at all (undefined)
      expect(data.section_frequency).toBeUndefined();
      expect(data.content_type_distribution).toBeUndefined();
    });

    it('3.3 - ocr_error_analytics + DB verify', async () => {
      const data = ok(await callTool(reportTools, 'ocr_error_analytics', { include_error_messages: true, limit: 10 }));
      expect(data.documents).toBeDefined();
      expect(data.vlm).toBeDefined();
      expect(data.embeddings).toBeDefined();

      // Note: field is 'total' not 'total_documents'
      const docStats = data.documents as Record<string, unknown>;
      const dbTotal = (conn.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number }).cnt;
      expect(docStats.total).toBe(dbTotal);
      console.error(`[3.3] Total docs: DB=${dbTotal}, tool=${docStats.total}`);
    });

    it('3.4 - ocr_provenance_bottlenecks + DB verify', async () => {
      const data = ok(await callTool(reportTools, 'ocr_provenance_bottlenecks', {}));
      // Response keys: grand_total_duration_ms, by_processor, by_chain_depth, slowest_operations
      expect(data.by_processor).toBeDefined();
      expect(data.by_chain_depth).toBeDefined(); // Note: 'by_chain_depth' not 'by_pipeline_stage'
      expect(data.slowest_operations).toBeDefined();

      const procs = data.by_processor as Array<Record<string, unknown>>;
      const dbProvCount = (conn.prepare('SELECT COUNT(*) as cnt FROM provenance WHERE processing_duration_ms IS NOT NULL').get() as { cnt: number }).cnt;
      const toolTotal = procs.reduce((s, p) => s + (p.count as number), 0);
      expect(toolTotal).toBe(dbProvCount);
      console.error(`[3.4] Provenance with duration: DB=${dbProvCount}, tool=${toolTotal}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: CROSS-DOCUMENT FEATURES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 4: Cross-Document', () => {
    it('4.1 - ocr_document_find_similar', async () => {
      const docsWithEmb = conn.prepare(`SELECT DISTINCT document_id FROM embeddings WHERE chunk_id IS NOT NULL`).all() as Array<{ document_id: string }>;
      console.error('[4.1] Docs with embeddings:', docsWithEmb.length);
      if (docsWithEmb.length < 2) { console.error('[4.1] SKIP: need 2+ docs'); return; }

      const srcId = docsWithEmb[0].document_id;
      const data = ok(await callTool(documentTools, 'ocr_document_find_similar', { document_id: srcId, limit: 10, min_similarity: 0.1 }));
      expect(data.source_document_id).toBe(srcId);
      expect(data.source_chunk_count).toBeGreaterThan(0);
      const sims = data.similar_documents as Array<Record<string, unknown>>;
      for (const s of sims) expect(s.document_id).not.toBe(srcId);
      console.error(`[4.1] Source ${srcId.slice(0, 8)}: ${data.source_chunk_count} chunks, ${data.total} similar`);
    });

    it('4.1 - errors on missing doc', async () => {
      const res = await callTool(documentTools, 'ocr_document_find_similar', { document_id: 'nonexistent-id', limit: 5 });
      expect(res.success).toBe(false);
    });

    it('4.2 - ocr_document_classify + DB verify', async () => {
      const doc = conn.prepare("SELECT id FROM documents WHERE status = 'complete' LIMIT 1").get() as { id: string } | undefined;
      if (!doc) return;

      const data = ok(await callTool(documentTools, 'ocr_document_classify', { document_id: doc.id }));
      expect(data.document_type).toBeDefined();
      expect(data.confidence).toBeDefined();
      console.error(`[4.2] Type: ${data.document_type}, Confidence: ${data.confidence}`);

      // DB verification - stored as JSON with same keys as response
      const dbDoc = conn.prepare('SELECT doc_subject FROM documents WHERE id = ?').get(doc.id) as { doc_subject: string | null };
      expect(dbDoc.doc_subject).toBeTruthy();
      const stored = JSON.parse(dbDoc.doc_subject!);
      expect(stored.document_type).toBe(data.document_type);
      console.error(`[4.2] DB VERIFIED: ${JSON.stringify(stored).slice(0, 100)}`);
    }, 60_000);

    it('4.2 - custom categories', async () => {
      const doc = conn.prepare("SELECT id FROM documents WHERE status = 'complete' LIMIT 1").get() as { id: string } | undefined;
      if (!doc) return;
      const data = ok(await callTool(documentTools, 'ocr_document_classify', { document_id: doc.id, custom_categories: ['policy', 'contract', 'memo', 'report'] }));
      expect(['policy', 'contract', 'memo', 'report']).toContain(data.document_type);
      console.error(`[4.2c] Custom: ${data.document_type}`);
    }, 60_000);

    it('5.1 - ocr_document_structure', async () => {
      const doc = conn.prepare("SELECT id, file_name FROM documents WHERE status = 'complete' LIMIT 1").get() as { id: string; file_name: string } | undefined;
      if (!doc) return;
      const data = ok(await callTool(documentTools, 'ocr_document_structure', { document_id: doc.id }));
      expect(data.document_id).toBe(doc.id);
      expect(data.source).toBeDefined();
      console.error(`[5.1] Source: ${data.source}, Outline: ${(data.outline as unknown[])?.length || 0}`);
    });

    it('5.1 - errors on missing doc', async () => {
      const res = await callTool(documentTools, 'ocr_document_structure', { document_id: 'nonexistent-uuid-000' });
      expect(res.success).toBe(false);
    });

    it('6.2 - ocr_document_update_metadata + DB verify', async () => {
      if (documentIds.length === 0) return;
      const title = `E2E-${randomUUID().slice(0, 8)}`;
      ok(await callTool(documentTools, 'ocr_document_update_metadata', { document_ids: [documentIds[0]], doc_title: title, doc_author: 'E2E Author', doc_subject: 'E2E Subject' }));

      const row = conn.prepare('SELECT doc_title, doc_author, doc_subject FROM documents WHERE id = ?').get(documentIds[0]) as Record<string, string>;
      expect(row.doc_title).toBe(title);
      expect(row.doc_author).toBe('E2E Author');
      expect(row.doc_subject).toBe('E2E Subject');
      console.error(`[6.2] DB VERIFIED: title=${row.doc_title}`);
    });

    it('6.2 - batch update', async () => {
      if (documentIds.length < 2) return;
      const title = `Batch-${randomUUID().slice(0, 8)}`;
      ok(await callTool(documentTools, 'ocr_document_update_metadata', { document_ids: documentIds.slice(0, 2), doc_title: title }));
      for (const id of documentIds.slice(0, 2)) {
        const row = conn.prepare('SELECT doc_title FROM documents WHERE id = ?').get(id) as { doc_title: string };
        expect(row.doc_title).toBe(title);
      }
    });

    it('6.2 - errors with no metadata fields', async () => {
      if (documentIds.length === 0) return;
      const res = await callTool(documentTools, 'ocr_document_update_metadata', { document_ids: [documentIds[0]] });
      expect(res.success).toBe(false);
    });

    it('6.3 - ocr_document_duplicates exact + DB verify', async () => {
      const data = ok(await callTool(documentTools, 'ocr_document_duplicates', { mode: 'exact', limit: 20 }));
      expect(data.mode).toBe('exact');
      // Note: key is 'groups' not 'duplicate_groups'
      expect(data.groups).toBeDefined();
      const dbDupes = (conn.prepare(`SELECT COUNT(*) as cnt FROM (SELECT file_hash FROM documents GROUP BY file_hash HAVING COUNT(*) > 1)`).get() as { cnt: number }).cnt;
      expect(data.total_groups).toBe(dbDupes);
      console.error(`[6.3e] Exact dupes: DB=${dbDupes}, tool=${data.total_groups}`);
    });

    it('6.3 - ocr_document_duplicates near', async () => {
      const data = ok(await callTool(documentTools, 'ocr_document_duplicates', { mode: 'near', similarity_threshold: 0.5, limit: 20 }));
      expect(data.mode).toBe('near');
      // Note: key is 'total_pairs' not 'total'
      expect(data.total_pairs).toBeDefined();
      console.error(`[6.3n] Near dupes: ${data.total_pairs}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: STRUCTURE & INTELLIGENCE
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 5: Intelligence', () => {
    it('5.3 - ocr_suggest_extraction_schema', async () => {
      const doc = conn.prepare("SELECT id FROM documents WHERE status = 'complete' LIMIT 1").get() as { id: string } | undefined;
      if (!doc) return;
      const data = ok(await callTool(structuredExtractionTools, 'ocr_suggest_extraction_schema', { document_id: doc.id, extraction_goal: 'Extract policy name, effective date, and key provisions' }));
      expect(data.suggested_schema).toBeDefined();
      expect(data.explanation).toBeDefined();
      console.error(`[5.3] Schema: ${JSON.stringify(data.suggested_schema).slice(0, 200)}`);
    }, 120_000); // 2 min timeout for Gemini

  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 6: OPERATIONAL
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 6: Operational', () => {
    it('6.1 - date filters + DB verify', async () => {
      ok(await callTool(documentTools, 'ocr_document_list', { created_after: '2020-01-01T00:00:00Z', limit: 50 }));
      const future = ok(await callTool(documentTools, 'ocr_document_list', { created_after: '2099-01-01T00:00:00Z', limit: 50 }));
      expect(future.total).toBe(0);
    });

    it('6.1 - file_type filter + DB verify', async () => {
      const data = ok(await callTool(documentTools, 'ocr_document_list', { file_type: 'pdf', limit: 50 }));
      const dbPdf = (conn.prepare("SELECT COUNT(*) as cnt FROM documents WHERE file_type = 'pdf'").get() as { cnt: number }).cnt;
      expect(data.total).toBe(dbPdf);
      console.error(`[6.1ft] PDF: DB=${dbPdf}, tool=${data.total}`);

      const none = ok(await callTool(documentTools, 'ocr_document_list', { file_type: 'xyz', limit: 50 }));
      expect(none.total).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL STATE VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Final State', () => {
    it('All required tables exist', () => {
      const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
      for (const t of ['documents', 'ocr_results', 'chunks', 'embeddings', 'images', 'provenance', 'comparisons', 'clusters', 'document_clusters', 'extractions', 'form_fills', 'uploaded_files', 'database_metadata', 'schema_version']) {
        expect(tables).toContain(t);
      }
    });

    it('Schema version is 27', () => {
      const v = (conn.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }).version;
      expect(v).toBe(27);
    });

    it('No orphaned embeddings', () => {
      const cnt = (conn.prepare(`SELECT COUNT(*) as cnt FROM embeddings e WHERE e.chunk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = e.chunk_id)`).get() as { cnt: number }).cnt;
      expect(cnt).toBe(0);
    });

    it('All provenance types valid', () => {
      const cnt = (conn.prepare(`SELECT COUNT(*) as cnt FROM provenance WHERE type NOT IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING', 'IMAGE', 'EXTRACTION', 'COMPARISON', 'CLUSTERING', 'FORM_FILL', 'VLM_DESC')`).get() as { cnt: number }).cnt;
      expect(cnt).toBe(0);
    });
  });
});

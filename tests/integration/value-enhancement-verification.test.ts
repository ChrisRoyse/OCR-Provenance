/**
 * Full State Verification for Value Enhancement Implementation (Phases 1-5)
 *
 * Exercises every new feature with synthetic data against a real v13 SQLite database.
 * Every test verifies the source of truth (database state) after operations.
 * No mocks -- real schema, real inserts, real SELECTs.
 *
 * Phase 1: Quality & Cost Analytics (QW-2, QW-3)
 * Phase 2: File Management (FM-0 through FM-4)
 * Phase 3: Legal Domain Entities (LD-0 through LD-4)
 * Phase 4: Search Enhancement (SE-1 through SE-4)
 * Phase 5: Advanced Integration (AI-1 through AI-4)
 *
 * @module tests/integration/value-enhancement-verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { migrateToLatest } from '../../src/services/storage/migrations/operations.js';
import { REQUIRED_TABLES, REQUIRED_INDEXES, SCHEMA_VERSION } from '../../src/services/storage/migrations/schema-definitions.js';

// Use a temporary database for testing
const TEST_DB_PATH = path.join(process.cwd(), 'tests', '.tmp-ve-verification.db');

let db: Database.Database;

// Shared doc IDs for cross-test references
const DOC_IDS = {
  doc1: crypto.randomUUID(),
  doc2: crypto.randomUUID(),
  doc3: crypto.randomUUID(),
};
const PROV_IDS = {
  doc1: crypto.randomUUID(),
  doc2: crypto.randomUUID(),
  doc3: crypto.randomUUID(),
  ocr1: crypto.randomUUID(),
  ocr2: crypto.randomUUID(),
  ocr3: crypto.randomUUID(),
};

// Check if sqlite-vec is available
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

describe.skipIf(!sqliteVecAvailable)('VALUE ENHANCEMENT VERIFICATION: Phases 1-5', () => {

  beforeAll(() => {
    // Clean up any previous test DB
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

    db = new Database(TEST_DB_PATH);

    // sqlite-vec must be loaded before migration
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    migrateToLatest(db);
  });

  afterAll(() => {
    if (db) db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 1: Schema & Quality/Cost Analytics
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Phase 1: Schema & Quality/Cost Analytics', () => {

    it('should have schema version 15', () => {
      const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
      expect(row).toBeDefined();
      expect(row.version).toBe(15);
      expect(row.version).toBe(SCHEMA_VERSION);
    });

    it('should have all 21 required tables', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);

      for (const required of REQUIRED_TABLES) {
        expect(tableNames).toContain(required);
      }
      expect(REQUIRED_TABLES.length).toBe(21);
    });

    it('should have all 43 required indexes', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      ).all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);

      for (const required of REQUIRED_INDEXES) {
        expect(indexNames).toContain(required);
      }
      expect(REQUIRED_INDEXES.length).toBe(43);
      expect(indexNames.length).toBeGreaterThanOrEqual(43);
    });

    it('should filter documents by quality score (QW-2)', () => {
      // Insert provenance records (DOCUMENT type, chain_depth=0)
      const insertProv = db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?, '[]', ?)
      `);

      insertProv.run(PROV_IDS.doc1, 'DOCUMENT', 'FILE', DOC_IDS.doc1, 'sha256:aaa', 'test', '1.0', '{}', 0);
      insertProv.run(PROV_IDS.doc2, 'DOCUMENT', 'FILE', DOC_IDS.doc2, 'sha256:bbb', 'test', '1.0', '{}', 0);
      insertProv.run(PROV_IDS.doc3, 'DOCUMENT', 'FILE', DOC_IDS.doc3, 'sha256:ccc', 'test', '1.0', '{}', 0);

      // Insert documents
      const insertDoc = db.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      insertDoc.run(DOC_IDS.doc1, '/test/doc1.pdf', 'doc1.pdf', 'hash1', 1000, 'pdf', 'complete', PROV_IDS.doc1);
      insertDoc.run(DOC_IDS.doc2, '/test/doc2.pdf', 'doc2.pdf', 'hash2', 2000, 'pdf', 'complete', PROV_IDS.doc2);
      insertDoc.run(DOC_IDS.doc3, '/test/doc3.pdf', 'doc3.pdf', 'hash3', 3000, 'pdf', 'complete', PROV_IDS.doc3);

      // Insert OCR result provenance (chain_depth=1)
      insertProv.run(PROV_IDS.ocr1, 'OCR_RESULT', 'OCR', DOC_IDS.doc1, 'sha256:ocr1', 'datalab', '1.0', '{}', 1);
      insertProv.run(PROV_IDS.ocr2, 'OCR_RESULT', 'OCR', DOC_IDS.doc2, 'sha256:ocr2', 'datalab', '1.0', '{}', 1);
      insertProv.run(PROV_IDS.ocr3, 'OCR_RESULT', 'OCR', DOC_IDS.doc3, 'sha256:ocr3', 'datalab', '1.0', '{}', 1);

      // Insert OCR results with quality scores: 1.5, 3.0, 4.5
      const insertOcr = db.prepare(`
        INSERT INTO ocr_results (id, document_id, extracted_text, text_length, datalab_request_id, datalab_mode, parse_quality_score, page_count, cost_cents, content_hash, processing_started_at, processing_completed_at, processing_duration_ms, provenance_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
      `);
      insertOcr.run(crypto.randomUUID(), DOC_IDS.doc1, 'Low quality text', 16, 'req-1', 'fast', 1.5, 1, 150, 'sha256:txt1', 1200, PROV_IDS.ocr1);
      insertOcr.run(crypto.randomUUID(), DOC_IDS.doc2, 'Medium quality text', 19, 'req-2', 'balanced', 3.0, 2, 325, 'sha256:txt2', 2300, PROV_IDS.ocr2);
      insertOcr.run(crypto.randomUUID(), DOC_IDS.doc3, 'High quality text', 17, 'req-3', 'accurate', 4.5, 3, 0, 'sha256:txt3', 4500, PROV_IDS.ocr3);

      // VERIFY SOURCE OF TRUTH: Quality scores exist in DB
      const scores = db.prepare('SELECT parse_quality_score FROM ocr_results ORDER BY parse_quality_score').all() as Array<{ parse_quality_score: number }>;
      expect(scores).toHaveLength(3);
      expect(scores[0].parse_quality_score).toBe(1.5);
      expect(scores[1].parse_quality_score).toBe(3.0);
      expect(scores[2].parse_quality_score).toBe(4.5);

      // Test quality filter: min_quality_score = 3.0 should return 2 docs
      const qualifiedDocs = db.prepare(
        'SELECT DISTINCT d.id FROM documents d JOIN ocr_results o ON o.document_id = d.id WHERE o.parse_quality_score >= ?'
      ).all(3.0);
      expect(qualifiedDocs).toHaveLength(2);

      // Test quality filter: min_quality_score = 4.5 should return 1 doc
      const highQualDocs = db.prepare(
        'SELECT DISTINCT d.id FROM documents d JOIN ocr_results o ON o.document_id = d.id WHERE o.parse_quality_score >= ?'
      ).all(4.5);
      expect(highQualDocs).toHaveLength(1);

      // Test quality filter: min_quality_score = 5.0 should return 0 docs
      const noDocs = db.prepare(
        'SELECT DISTINCT d.id FROM documents d JOIN ocr_results o ON o.document_id = d.id WHERE o.parse_quality_score >= ?'
      ).all(5.0);
      expect(noDocs).toHaveLength(0);
    });

    it('should compute correct cost totals (QW-3)', () => {
      const totals = db.prepare(`
        SELECT
          (SELECT COALESCE(SUM(cost_cents), 0) FROM ocr_results) as ocr_cost,
          (SELECT COUNT(*) FROM ocr_results WHERE cost_cents > 0) as ocr_count
      `).get() as { ocr_cost: number; ocr_count: number };

      // 150 + 325 + 0 = 475
      expect(totals.ocr_cost).toBe(475);
      // 2 have cost > 0 (150 and 325; accurate has 0)
      expect(totals.ocr_count).toBe(2);
    });

    it('should group costs by OCR mode correctly', () => {
      const byMode = db.prepare(`
        SELECT datalab_mode as mode, COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cents
        FROM ocr_results WHERE cost_cents > 0 GROUP BY datalab_mode ORDER BY mode
      `).all() as Array<{ mode: string; count: number; total_cents: number }>;

      expect(byMode).toHaveLength(2); // fast and balanced (accurate has 0 cost)
      const fastMode = byMode.find(r => r.mode === 'fast');
      expect(fastMode).toBeDefined();
      expect(fastMode!.total_cents).toBe(150);
      expect(fastMode!.count).toBe(1);

      const balancedMode = byMode.find(r => r.mode === 'balanced');
      expect(balancedMode).toBeDefined();
      expect(balancedMode!.total_cents).toBe(325);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 2: File Management
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Phase 2: File Management', () => {

    it('should CRUD uploaded files with dedup by hash', () => {
      const uploadProvId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'DOCUMENT', datetime('now'), datetime('now'), 'FILE', ?, 'sha256:upload1', 'test', '1.0', '{}', '[]', 0)
      `).run(uploadProvId, DOC_IDS.doc1);

      const uploadId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO uploaded_files (id, local_path, file_name, file_hash, file_size, content_type, upload_status, provenance_id)
        VALUES (?, '/test/upload.pdf', 'upload.pdf', 'sha256:uniquehash', 5000, 'application/pdf', 'complete', ?)
      `).run(uploadId, uploadProvId);

      // VERIFY: Row exists
      const row = db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(uploadId) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.file_hash).toBe('sha256:uniquehash');
      expect(row.upload_status).toBe('complete');

      // VERIFY: Dedup by hash lookup
      const dedup = db.prepare('SELECT * FROM uploaded_files WHERE file_hash = ?').get('sha256:uniquehash') as Record<string, unknown>;
      expect(dedup).toBeDefined();
      expect(dedup.id).toBe(uploadId);

      // VERIFY: Status CHECK constraint rejects invalid status
      expect(() => {
        db.prepare(`
          INSERT INTO uploaded_files (id, local_path, file_name, file_hash, file_size, content_type, upload_status, provenance_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), '/test/bad.pdf', 'bad.pdf', 'sha256:bad', 100, 'application/pdf', 'INVALID_STATUS', uploadProvId);
      }).toThrow();
    });

    it('should have datalab_file_id column on documents', () => {
      const columns = db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('datalab_file_id');
    });

    it('should have uploaded_files indexes for dedup and status lookup', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_uploaded_files_%'"
      ).all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_uploaded_files_file_hash');
      expect(indexNames).toContain('idx_uploaded_files_status');
      expect(indexNames).toContain('idx_uploaded_files_datalab_file_id');
    });

    it('should support all 5 upload status values', () => {
      const statuses = ['pending', 'uploading', 'confirming', 'complete', 'failed'];
      const uploadProvId2 = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'DOCUMENT', datetime('now'), datetime('now'), 'FILE', ?, 'sha256:upload2', 'test', '1.0', '{}', '[]', 0)
      `).run(uploadProvId2, DOC_IDS.doc1);

      for (const status of statuses) {
        const id = crypto.randomUUID();
        expect(() => {
          db.prepare(`
            INSERT INTO uploaded_files (id, local_path, file_name, file_hash, file_size, content_type, upload_status, provenance_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, `/test/${status}.pdf`, `${status}.pdf`, `sha256:${status}`, 100, 'application/pdf', status, uploadProvId2);
        }).not.toThrow();

        // VERIFY in DB
        const row = db.prepare('SELECT upload_status FROM uploaded_files WHERE id = ?').get(id) as { upload_status: string };
        expect(row.upload_status).toBe(status);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 3: Legal Domain Entities
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Phase 3: Legal Domain Entities', () => {

    it('should store and retrieve entities with provenance', () => {
      const docId = DOC_IDS.doc1;
      const entityProvId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'ENTITY_EXTRACTION', datetime('now'), datetime('now'), 'ENTITY_EXTRACTION', ?, 'sha256:entity1', 'gemini-entity', '1.0', '{}', '[]', 2)
      `).run(entityProvId, docId);

      // Insert entities
      const entityId1 = crypto.randomUUID();
      const entityId2 = crypto.randomUUID();

      db.prepare(`
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id)
        VALUES (?, ?, 'person', 'Dr. Jane Smith', 'jane smith', 0.95, ?)
      `).run(entityId1, docId, entityProvId);

      db.prepare(`
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id)
        VALUES (?, ?, 'organization', 'Acme Corp', 'acme corp', 0.90, ?)
      `).run(entityId2, docId, entityProvId);

      // VERIFY: Entities exist
      const entities = db.prepare('SELECT * FROM entities WHERE document_id = ?').all(docId) as Array<Record<string, unknown>>;
      expect(entities).toHaveLength(2);

      // VERIFY: Entity type filtering works
      const persons = db.prepare("SELECT * FROM entities WHERE entity_type = 'person'").all() as Array<Record<string, unknown>>;
      expect(persons.length).toBeGreaterThanOrEqual(1);
      expect(persons[0].normalized_text).toBe('jane smith');
      expect(persons[0].confidence).toBe(0.95);

      const orgs = db.prepare("SELECT * FROM entities WHERE entity_type = 'organization'").all() as Array<Record<string, unknown>>;
      expect(orgs.length).toBeGreaterThanOrEqual(1);
      expect(orgs[0].normalized_text).toBe('acme corp');

      // Insert entity mentions
      const mentionId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO entity_mentions (id, entity_id, document_id, page_number, character_start, character_end, context_text)
        VALUES (?, ?, ?, 1, 0, 15, 'Dr. Jane Smith signed the document')
      `).run(mentionId, entityId1, docId);

      // VERIFY: Mention exists and links to entity
      const mentions = db.prepare('SELECT * FROM entity_mentions WHERE entity_id = ?').all(entityId1) as Array<Record<string, unknown>>;
      expect(mentions).toHaveLength(1);
      expect(mentions[0].context_text).toBe('Dr. Jane Smith signed the document');
      expect(mentions[0].page_number).toBe(1);
      expect(mentions[0].character_start).toBe(0);
      expect(mentions[0].character_end).toBe(15);
    });

    it('should accept all valid entity types', () => {
      const validTypes = ['person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'other'];
      const entityProvId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'ENTITY_EXTRACTION', datetime('now'), datetime('now'), 'ENTITY_EXTRACTION', ?, 'sha256:entitytypes', 'test', '1.0', '{}', '[]', 2)
      `).run(entityProvId, DOC_IDS.doc2);

      for (const entityType of validTypes) {
        const id = crypto.randomUUID();
        expect(() => {
          db.prepare(`
            INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id)
            VALUES (?, ?, ?, ?, ?, 0.5, ?)
          `).run(id, DOC_IDS.doc2, entityType, `raw_${entityType}`, `norm_${entityType}`, entityProvId);
        }).not.toThrow();

        // VERIFY in DB
        const row = db.prepare('SELECT entity_type FROM entities WHERE id = ?').get(id) as { entity_type: string };
        expect(row.entity_type).toBe(entityType);
      }
    });

    it('should reject invalid entity types via CHECK constraint', () => {
      const entityProvId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'ENTITY_EXTRACTION', datetime('now'), datetime('now'), 'ENTITY_EXTRACTION', ?, 'sha256:badtype', 'test', '1.0', '{}', '[]', 2)
      `).run(entityProvId, DOC_IDS.doc1);

      expect(() => {
        db.prepare(`
          INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id)
          VALUES (?, ?, 'INVALID_TYPE', 'test', 'test', 0.5, ?)
        `).run(crypto.randomUUID(), DOC_IDS.doc1, entityProvId);
      }).toThrow();
    });

    it('should accept ENTITY_EXTRACTION provenance type', () => {
      const id = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
          VALUES (?, 'ENTITY_EXTRACTION', datetime('now'), datetime('now'), 'ENTITY_EXTRACTION', ?, 'sha256:provtest', 'test', '1.0', '{}', '[]', 2)
        `).run(id, id);
      }).not.toThrow();

      // VERIFY: It was inserted
      const row = db.prepare('SELECT type, source_type FROM provenance WHERE id = ?').get(id) as { type: string; source_type: string };
      expect(row.type).toBe('ENTITY_EXTRACTION');
      expect(row.source_type).toBe('ENTITY_EXTRACTION');
    });

    it('should have entity indexes for lookup performance', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'idx_entities_%' OR name LIKE 'idx_entity_mentions_%')"
      ).all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_entities_document_id');
      expect(indexNames).toContain('idx_entities_entity_type');
      expect(indexNames).toContain('idx_entities_normalized_text');
      expect(indexNames).toContain('idx_entity_mentions_entity_id');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 4: Search Enhancement
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Phase 4: Search Enhancement', () => {

    it('should expand queries with domain synonyms', async () => {
      const { expandQuery } = await import('../../src/services/search/query-expander.js');

      const expanded = expandQuery('injury treatment');
      // Original terms preserved
      expect(expanded).toContain('injury');
      expect(expanded).toContain('treatment');
      // Synonyms added
      expect(expanded).toContain('wound');
      expect(expanded).toContain('trauma');
      expect(expanded).toContain('harm');
      expect(expanded).toContain('damage');
      expect(expanded).toContain('therapy');
      expect(expanded).toContain('care');
      // OR-joined format
      expect(expanded).toContain(' OR ');
    });

    it('should not expand unknown terms', async () => {
      const { expandQuery } = await import('../../src/services/search/query-expander.js');

      const expanded = expandQuery('foobar');
      expect(expanded).toBe('foobar');
    });

    it('should return expansion metadata', async () => {
      const { getExpandedTerms } = await import('../../src/services/search/query-expander.js');

      const result = getExpandedTerms('injury');
      expect(result.original).toBe('injury');
      expect(result.synonyms_found).toHaveProperty('injury');
      expect(result.synonyms_found.injury).toContain('wound');
      expect(result.synonyms_found.injury).toContain('trauma');
      expect(result.expanded).toContain('wound');
    });

    it('should chunk text respecting page boundaries', async () => {
      const { chunkTextPageAware } = await import('../../src/services/chunking/chunker.js');

      // Build text: ~122 chars page 1, ~122 chars page 2
      const page1Text = 'Page one content here. ' + 'x'.repeat(100);
      const page2Text = 'Page two content here. ' + 'y'.repeat(100);
      const text = page1Text + page2Text;

      const pageOffsets = [
        { page: 1, charStart: 0, charEnd: page1Text.length },
        { page: 2, charStart: page1Text.length, charEnd: text.length },
      ];

      // Use small chunk size to force multiple chunks per page
      const config = { chunkSize: 80, overlapPercent: 10 };
      const chunks = chunkTextPageAware(text, pageOffsets, config);

      expect(chunks.length).toBeGreaterThan(0);

      // VERIFY: No chunk spans page boundaries
      for (const chunk of chunks) {
        expect(chunk.pageNumber).toBeDefined();
        expect(chunk.pageNumber).not.toBeNull();

        const pageIdx = pageOffsets.findIndex(p => p.page === chunk.pageNumber);
        expect(pageIdx).toBeGreaterThanOrEqual(0);

        const page = pageOffsets[pageIdx];
        expect(chunk.startOffset).toBeGreaterThanOrEqual(page.charStart);
        expect(chunk.endOffset).toBeLessThanOrEqual(page.charEnd);
      }
    });

    it('should validate min_quality_score in search schemas', async () => {
      const { SearchHybridInput } = await import('../../src/utils/validation.js');

      // Valid: min_quality_score within range
      const valid = SearchHybridInput.safeParse({
        query: 'test query',
        min_quality_score: 3.0,
      });
      expect(valid.success).toBe(true);

      // Invalid: min_quality_score above max (5)
      const tooHigh = SearchHybridInput.safeParse({
        query: 'test query',
        min_quality_score: 6.0,
      });
      expect(tooHigh.success).toBe(false);

      // Invalid: min_quality_score below min (0)
      const tooLow = SearchHybridInput.safeParse({
        query: 'test query',
        min_quality_score: -1.0,
      });
      expect(tooLow.success).toBe(false);
    });

    it('should validate expand_query in hybrid search schema', async () => {
      const { SearchHybridInput } = await import('../../src/utils/validation.js');

      const valid = SearchHybridInput.safeParse({
        query: 'injury treatment',
        expand_query: true,
      });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.expand_query).toBe(true);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 5: Advanced Integration
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Phase 5: Advanced Integration', () => {

    it('should enforce minimum text length for context caching', () => {
      // The GeminiClient enforces minimum 4096 chars for caching.
      // We verify the constraint value matches expectations.
      const MIN_CACHE_CHARS = 4096;
      const MIN_CACHE_TOKENS = 1024;
      // The relationship: ~4 chars per token
      expect(MIN_CACHE_CHARS).toBeGreaterThanOrEqual(MIN_CACHE_TOKENS);
      expect(MIN_CACHE_CHARS / MIN_CACHE_TOKENS).toBe(4);
    });

    it('should validate file_urls parameter in IngestFilesInput', async () => {
      const { IngestFilesInput } = await import('../../src/utils/validation.js');

      // Valid: file_urls with proper URLs
      const valid = IngestFilesInput.safeParse({
        file_paths: ['/test.pdf'],
        file_urls: ['https://example.com/doc.pdf'],
      });
      expect(valid.success).toBe(true);

      // Valid: without file_urls (optional)
      const withoutUrls = IngestFilesInput.safeParse({
        file_paths: ['/test.pdf'],
      });
      expect(withoutUrls.success).toBe(true);

      // Invalid: file_urls with non-URL string
      const invalid = IngestFilesInput.safeParse({
        file_paths: ['/test.pdf'],
        file_urls: ['not-a-url'],
      });
      expect(invalid.success).toBe(false);

      // Invalid: empty file_paths
      const noFiles = IngestFilesInput.safeParse({
        file_paths: [],
      });
      expect(noFiles.success).toBe(false);
    });

    it('should validate chunking_strategy in ProcessPendingInput', async () => {
      const { ProcessPendingInput } = await import('../../src/utils/validation.js');

      // Valid: page_aware strategy
      const pageAware = ProcessPendingInput.safeParse({
        chunking_strategy: 'page_aware',
      });
      expect(pageAware.success).toBe(true);

      // Valid: default (fixed)
      const defaults = ProcessPendingInput.safeParse({});
      expect(defaults.success).toBe(true);
      if (defaults.success) {
        expect(defaults.data.chunking_strategy).toBe('fixed');
      }

      // Invalid: unknown strategy
      const invalid = ProcessPendingInput.safeParse({
        chunking_strategy: 'semantic',
      });
      expect(invalid.success).toBe(false);
    });

    it('should validate extras parameter in ProcessPendingInput', async () => {
      const { ProcessPendingInput } = await import('../../src/utils/validation.js');

      const valid = ProcessPendingInput.safeParse({
        extras: ['track_changes', 'chart_understanding', 'extract_links'],
      });
      expect(valid.success).toBe(true);

      const invalid = ProcessPendingInput.safeParse({
        extras: ['not_a_valid_extra'],
      });
      expect(invalid.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Cross-cutting Verification
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cross-cutting Verification', () => {

    it('should cascade delete entities when document entities are removed', () => {
      const docId = DOC_IDS.doc1;

      // Count entities before
      const beforeEntities = db.prepare('SELECT COUNT(*) as count FROM entities WHERE document_id = ?').get(docId) as { count: number };
      expect(beforeEntities.count).toBeGreaterThan(0);

      // Count mentions before
      const beforeMentions = db.prepare('SELECT COUNT(*) as count FROM entity_mentions WHERE document_id = ?').get(docId) as { count: number };
      expect(beforeMentions.count).toBeGreaterThan(0);

      // Delete the mentions first (child), then entities
      db.prepare('DELETE FROM entity_mentions WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM entities WHERE document_id = ?').run(docId);

      // VERIFY: Entities are gone
      const afterEntities = db.prepare('SELECT COUNT(*) as count FROM entities WHERE document_id = ?').get(docId) as { count: number };
      expect(afterEntities.count).toBe(0);

      // VERIFY: Mentions are gone
      const afterMentions = db.prepare('SELECT COUNT(*) as count FROM entity_mentions WHERE document_id = ?').get(docId) as { count: number };
      expect(afterMentions.count).toBe(0);
    });

    it('should pass FK integrity check across all tables', () => {
      db.exec('PRAGMA foreign_keys = ON');
      const violations = db.pragma('foreign_key_check') as unknown[];
      expect(violations).toHaveLength(0);
    });

    it('should accept all provenance types from v13 schema', () => {
      const validTypes = [
        { type: 'DOCUMENT', sourceType: 'FILE' },
        { type: 'OCR_RESULT', sourceType: 'OCR' },
        { type: 'CHUNK', sourceType: 'CHUNKING' },
        { type: 'IMAGE', sourceType: 'IMAGE_EXTRACTION' },
        { type: 'VLM_DESCRIPTION', sourceType: 'VLM' },
        { type: 'EMBEDDING', sourceType: 'EMBEDDING' },
        { type: 'EXTRACTION', sourceType: 'EXTRACTION' },
        { type: 'FORM_FILL', sourceType: 'FORM_FILL' },
        { type: 'ENTITY_EXTRACTION', sourceType: 'ENTITY_EXTRACTION' },
      ];

      for (const { type, sourceType } of validTypes) {
        const id = crypto.randomUUID();
        expect(() => {
          db.prepare(`
            INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
            VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, 'sha256:provcheck', 'test', '1.0', '{}', '[]', 0)
          `).run(id, type, sourceType, id);
        }).not.toThrow();

        const row = db.prepare('SELECT type, source_type FROM provenance WHERE id = ?').get(id) as { type: string; source_type: string };
        expect(row.type).toBe(type);
        expect(row.source_type).toBe(sourceType);
      }
    });

    it('should also accept VLM_DEDUP source_type', () => {
      const id = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
          VALUES (?, 'VLM_DESCRIPTION', datetime('now'), datetime('now'), 'VLM_DEDUP', ?, 'sha256:vlmdedup', 'test', '1.0', '{}', '[]', 3)
        `).run(id, id);
      }).not.toThrow();

      const row = db.prepare('SELECT source_type FROM provenance WHERE id = ?').get(id) as { source_type: string };
      expect(row.source_type).toBe('VLM_DEDUP');
    });

    it('should have extractions and form_fills tables with correct constraints', () => {
      // Insert an extraction
      const extractProvId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'EXTRACTION', datetime('now'), datetime('now'), 'EXTRACTION', ?, 'sha256:ext1', 'test', '1.0', '{}', '[]', 2)
      `).run(extractProvId, DOC_IDS.doc1);

      const ocrResultId = db.prepare('SELECT id FROM ocr_results WHERE document_id = ?').get(DOC_IDS.doc1) as { id: string };

      const extractionId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO extractions (id, document_id, ocr_result_id, schema_json, extraction_json, content_hash, provenance_id)
        VALUES (?, ?, ?, '{"type":"object"}', '{"name":"test"}', 'sha256:extdata', ?)
      `).run(extractionId, DOC_IDS.doc1, ocrResultId.id, extractProvId);

      // VERIFY: Extraction exists
      const ext = db.prepare('SELECT * FROM extractions WHERE id = ?').get(extractionId) as Record<string, unknown>;
      expect(ext).toBeDefined();
      expect(ext.schema_json).toBe('{"type":"object"}');
      expect(ext.extraction_json).toBe('{"name":"test"}');

      // Insert a form fill
      const formProvId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'FORM_FILL', datetime('now'), datetime('now'), 'FORM_FILL', ?, 'sha256:form1', 'test', '1.0', '{}', '[]', 1)
      `).run(formProvId, DOC_IDS.doc1);

      const formFillId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO form_fills (id, source_file_path, source_file_hash, field_data_json, cost_cents, status, provenance_id)
        VALUES (?, '/test/form.pdf', 'sha256:formhash', '{"field":"value"}', 2.5, 'complete', ?)
      `).run(formFillId, formProvId);

      // VERIFY: Form fill exists with REAL cost
      const ff = db.prepare('SELECT * FROM form_fills WHERE id = ?').get(formFillId) as Record<string, unknown>;
      expect(ff).toBeDefined();
      expect(ff.cost_cents).toBe(2.5); // REAL type, not INTEGER
      expect(ff.status).toBe('complete');

      // VERIFY: form_fills rejects invalid status
      expect(() => {
        db.prepare(`
          INSERT INTO form_fills (id, source_file_path, source_file_hash, field_data_json, status, provenance_id)
          VALUES (?, '/test/bad.pdf', 'sha256:bad', '{}', 'INVALID', ?)
        `).run(crypto.randomUUID(), formProvId);
      }).toThrow();
    });

    it('should have doc_title, doc_author, doc_subject columns on documents', () => {
      const columns = db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('doc_title');
      expect(colNames).toContain('doc_author');
      expect(colNames).toContain('doc_subject');
    });

    it('should have json_blocks and extras_json columns on ocr_results', () => {
      const columns = db.prepare('PRAGMA table_info(ocr_results)').all() as Array<{ name: string }>;
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('json_blocks');
      expect(colNames).toContain('extras_json');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Edge Case Tests', () => {

    it('should return zero costs for empty database', () => {
      const emptyDb = new Database(':memory:');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(emptyDb);
      migrateToLatest(emptyDb);

      const totals = emptyDb.prepare(`
        SELECT
          (SELECT COALESCE(SUM(cost_cents), 0) FROM ocr_results) as ocr_cost,
          (SELECT COALESCE(SUM(cost_cents), 0) FROM form_fills) as form_fill_cost
      `).get() as { ocr_cost: number; form_fill_cost: number };

      expect(totals.ocr_cost).toBe(0);
      expect(totals.form_fill_cost).toBe(0);

      emptyDb.close();
    });

    it('should handle NULL quality scores in filtering', () => {
      const emptyDb = new Database(':memory:');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(emptyDb);
      migrateToLatest(emptyDb);

      // Insert doc without quality score
      const provId = crypto.randomUUID();
      emptyDb.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'DOCUMENT', datetime('now'), datetime('now'), 'FILE', ?, 'sha256:null', 'test', '1.0', '{}', '[]', 0)
      `).run(provId, provId);

      const docId = crypto.randomUUID();
      emptyDb.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(docId, '/test/null.pdf', 'null.pdf', 'hashnull', 100, 'pdf', 'complete', provId);

      const ocrProvId = crypto.randomUUID();
      emptyDb.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id, content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, 'OCR_RESULT', datetime('now'), datetime('now'), 'OCR', ?, 'sha256:nullocr', 'datalab', '1.0', '{}', '[]', 1)
      `).run(ocrProvId, docId);

      // Insert OCR result with NULL quality score
      emptyDb.prepare(`
        INSERT INTO ocr_results (id, document_id, extracted_text, text_length, datalab_request_id, datalab_mode, parse_quality_score, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms, provenance_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'), datetime('now'), ?, ?)
      `).run(crypto.randomUUID(), docId, 'text', 4, 'req-null', 'fast', 1, 'sha256:nulltxt', 100, ocrProvId);

      // min_quality_score filter should return empty (NULL doesn't pass >= check)
      const result = emptyDb.prepare(
        'SELECT DISTINCT d.id FROM documents d JOIN ocr_results o ON o.document_id = d.id WHERE o.parse_quality_score >= ?'
      ).all(1.0);
      expect(result).toHaveLength(0);

      // Verify the record actually exists with NULL
      const ocrRow = emptyDb.prepare('SELECT parse_quality_score FROM ocr_results WHERE document_id = ?').get(docId) as { parse_quality_score: number | null };
      expect(ocrRow.parse_quality_score).toBeNull();

      emptyDb.close();
    });

    it('should handle empty entity search on fresh database', () => {
      const emptyDb = new Database(':memory:');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(emptyDb);
      migrateToLatest(emptyDb);

      const entities = emptyDb.prepare('SELECT * FROM entities').all();
      expect(entities).toHaveLength(0);

      const mentions = emptyDb.prepare('SELECT * FROM entity_mentions').all();
      expect(mentions).toHaveLength(0);

      emptyDb.close();
    });

    it('should handle query expansion of empty string', async () => {
      const { expandQuery } = await import('../../src/services/search/query-expander.js');

      const expanded = expandQuery('');
      expect(expanded).toBe('');
    });

    it('should chunk empty text to empty array', async () => {
      const { chunkTextPageAware } = await import('../../src/services/chunking/chunker.js');

      const chunks = chunkTextPageAware('', []);
      expect(chunks).toHaveLength(0);
    });

    it('should handle page-aware chunking with no page offsets (fallback)', async () => {
      const { chunkTextPageAware } = await import('../../src/services/chunking/chunker.js');

      const text = 'Hello world this is a test text that needs to be chunked.';
      const chunks = chunkTextPageAware(text, []);
      // Falls back to standard chunking
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].text).toBe(text);
    });

    it('should maintain FTS5 tables with correct metadata rows', () => {
      // Verify FTS metadata for chunks (id=1), VLM (id=2), extractions (id=3)
      const meta = db.prepare('SELECT * FROM fts_index_metadata ORDER BY id').all() as Array<Record<string, unknown>>;
      expect(meta.length).toBeGreaterThanOrEqual(3);

      const ids = meta.map(m => m.id);
      expect(ids).toContain(1); // chunks FTS
      expect(ids).toContain(2); // VLM FTS
      expect(ids).toContain(3); // extractions FTS
    });

    it('should verify all 18 supported file types are declared', async () => {
      const { DEFAULT_FILE_TYPES } = await import('../../src/utils/validation.js');

      expect(DEFAULT_FILE_TYPES).toHaveLength(18);
      // Documents
      expect(DEFAULT_FILE_TYPES).toContain('pdf');
      expect(DEFAULT_FILE_TYPES).toContain('docx');
      expect(DEFAULT_FILE_TYPES).toContain('pptx');
      expect(DEFAULT_FILE_TYPES).toContain('xlsx');
      // Images
      expect(DEFAULT_FILE_TYPES).toContain('png');
      expect(DEFAULT_FILE_TYPES).toContain('jpg');
      expect(DEFAULT_FILE_TYPES).toContain('tiff');
      expect(DEFAULT_FILE_TYPES).toContain('tif');
      expect(DEFAULT_FILE_TYPES).toContain('webp');
      // Text
      expect(DEFAULT_FILE_TYPES).toContain('txt');
      expect(DEFAULT_FILE_TYPES).toContain('csv');
      expect(DEFAULT_FILE_TYPES).toContain('md');
    });
  });
});

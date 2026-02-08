/**
 * Migration v7 to v8 Tests
 *
 * Tests the v7->v8 migration which adds:
 * - extractions table for structured data from page_schema
 * - form_fills table for Datalab /fill API results
 * - doc_title, doc_author, doc_subject columns to documents
 * - EXTRACTION and FORM_FILL to provenance CHECK constraints
 * - New indexes: idx_extractions_document_id, idx_form_fills_status, idx_documents_doc_title
 *
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
} from './helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Migration v7 to v8', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v8');
    const result = createTestDb(tmpDir);
    db = result.db;
    dbPath = result.dbPath;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v7 schema.
   * sqlite-vec is required for the vec_embeddings table used in migration path.
   */
  function createV7Schema(): void {
    // Load sqlite-vec extension
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Schema version
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_version VALUES (1, 7, datetime('now'), datetime('now'));
    `);

    // Provenance (v7 CHECK constraints: no EXTRACTION/FORM_FILL)
    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING')),
        source_path TEXT,
        source_id TEXT,
        root_document_id TEXT NOT NULL,
        location TEXT,
        content_hash TEXT NOT NULL,
        input_hash TEXT,
        file_hash TEXT,
        processor TEXT NOT NULL,
        processor_version TEXT NOT NULL,
        processing_params TEXT NOT NULL,
        processing_duration_ms INTEGER,
        processing_quality_score REAL,
        parent_id TEXT,
        parent_ids TEXT NOT NULL,
        chain_depth INTEGER NOT NULL,
        chain_path TEXT,
        FOREIGN KEY (source_id) REFERENCES provenance(id),
        FOREIGN KEY (parent_id) REFERENCES provenance(id)
      );
    `);

    // Database metadata
    db.exec(`
      CREATE TABLE database_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        database_name TEXT NOT NULL,
        database_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_modified_at TEXT NOT NULL,
        total_documents INTEGER NOT NULL DEFAULT 0,
        total_ocr_results INTEGER NOT NULL DEFAULT 0,
        total_chunks INTEGER NOT NULL DEFAULT 0,
        total_embeddings INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO database_metadata VALUES (1, 'test', '1.0.0', datetime('now'), datetime('now'), 0, 0, 0, 0);
    `);

    // Documents (v7: no doc_title, doc_author, doc_subject)
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','failed')),
        page_count INTEGER,
        provenance_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        modified_at TEXT,
        ocr_completed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    // OCR results
    db.exec(`
      CREATE TABLE ocr_results (
        id TEXT PRIMARY KEY,
        provenance_id TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL,
        extracted_text TEXT NOT NULL,
        text_length INTEGER NOT NULL,
        datalab_request_id TEXT NOT NULL,
        datalab_mode TEXT NOT NULL CHECK (datalab_mode IN ('fast', 'balanced', 'accurate')),
        parse_quality_score REAL,
        page_count INTEGER NOT NULL,
        cost_cents REAL,
        content_hash TEXT NOT NULL,
        processing_started_at TEXT NOT NULL,
        processing_completed_at TEXT NOT NULL,
        processing_duration_ms INTEGER NOT NULL,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id),
        FOREIGN KEY (document_id) REFERENCES documents(id)
      );
    `);

    // Chunks
    db.exec(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        ocr_result_id TEXT NOT NULL,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        character_start INTEGER NOT NULL,
        character_end INTEGER NOT NULL,
        page_number INTEGER,
        page_range TEXT,
        overlap_previous INTEGER NOT NULL,
        overlap_next INTEGER NOT NULL,
        provenance_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        embedding_status TEXT NOT NULL CHECK (embedding_status IN ('pending', 'complete', 'failed')),
        embedded_at TEXT,
        FOREIGN KEY (document_id) REFERENCES documents(id),
        FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    // Images
    db.exec(`
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        ocr_result_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        bbox_x REAL NOT NULL,
        bbox_y REAL NOT NULL,
        bbox_width REAL NOT NULL,
        bbox_height REAL NOT NULL,
        image_index INTEGER NOT NULL,
        format TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        extracted_path TEXT,
        file_size INTEGER,
        vlm_status TEXT NOT NULL DEFAULT 'pending' CHECK (vlm_status IN ('pending', 'processing', 'complete', 'failed')),
        vlm_description TEXT,
        vlm_structured_data TEXT,
        vlm_embedding_id TEXT,
        vlm_model TEXT,
        vlm_confidence REAL,
        vlm_processed_at TEXT,
        vlm_tokens_used INTEGER,
        context_text TEXT,
        provenance_id TEXT,
        created_at TEXT NOT NULL,
        error_message TEXT,
        block_type TEXT,
        is_header_footer INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id) ON DELETE CASCADE,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    // Embeddings (v3+ schema with image_id)
    db.exec(`
      CREATE TABLE embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT,
        image_id TEXT,
        document_id TEXT NOT NULL,
        original_text TEXT NOT NULL,
        original_text_length INTEGER NOT NULL,
        source_file_path TEXT NOT NULL,
        source_file_name TEXT NOT NULL,
        source_file_hash TEXT NOT NULL,
        page_number INTEGER,
        page_range TEXT,
        character_start INTEGER NOT NULL,
        character_end INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK (task_type IN ('search_document', 'search_query')),
        inference_mode TEXT NOT NULL CHECK (inference_mode = 'local'),
        gpu_device TEXT,
        provenance_id TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        generation_duration_ms INTEGER,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id),
        FOREIGN KEY (image_id) REFERENCES images(id),
        FOREIGN KEY (document_id) REFERENCES documents(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id),
        CHECK (chunk_id IS NOT NULL OR image_id IS NOT NULL)
      );
    `);

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 7, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 7, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 7, NULL);`);
    db.exec(`CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`);

    // vec_embeddings
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`);

    // FTS triggers
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ai AFTER INSERT ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ad AFTER DELETE ON embeddings WHEN old.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_au AFTER UPDATE OF original_text ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);

    // v7 indexes
    db.exec('CREATE INDEX idx_documents_file_path ON documents(file_path);');
    db.exec('CREATE INDEX idx_documents_file_hash ON documents(file_hash);');
    db.exec('CREATE INDEX idx_documents_status ON documents(status);');
    db.exec('CREATE INDEX idx_ocr_results_document_id ON ocr_results(document_id);');
    db.exec('CREATE INDEX idx_chunks_document_id ON chunks(document_id);');
    db.exec('CREATE INDEX idx_chunks_ocr_result_id ON chunks(ocr_result_id);');
    db.exec('CREATE INDEX idx_chunks_embedding_status ON chunks(embedding_status);');
    db.exec('CREATE INDEX idx_embeddings_chunk_id ON embeddings(chunk_id);');
    db.exec('CREATE INDEX idx_embeddings_image_id ON embeddings(image_id);');
    db.exec('CREATE INDEX idx_embeddings_document_id ON embeddings(document_id);');
    db.exec('CREATE INDEX idx_embeddings_source_file ON embeddings(source_file_path);');
    db.exec('CREATE INDEX idx_embeddings_page ON embeddings(page_number);');
    db.exec('CREATE INDEX idx_images_document_id ON images(document_id);');
    db.exec('CREATE INDEX idx_images_ocr_result_id ON images(ocr_result_id);');
    db.exec('CREATE INDEX idx_images_page ON images(document_id, page_number);');
    db.exec('CREATE INDEX idx_images_vlm_status ON images(vlm_status);');
    db.exec('CREATE INDEX idx_images_content_hash ON images(content_hash);');
    db.exec(`CREATE INDEX idx_images_pending ON images(vlm_status) WHERE vlm_status = 'pending';`);
    db.exec('CREATE INDEX idx_images_provenance_id ON images(provenance_id);');
    db.exec('CREATE INDEX idx_provenance_source_id ON provenance(source_id);');
    db.exec('CREATE INDEX idx_provenance_type ON provenance(type);');
    db.exec('CREATE INDEX idx_provenance_root_document_id ON provenance(root_document_id);');
    db.exec('CREATE INDEX idx_provenance_parent_id ON provenance(parent_id);');
  }

  it.skipIf(!sqliteVecAvailable)('creates extractions table with correct columns', () => {
    createV7Schema();
    migrateToLatest(db);
    const info = db.prepare('PRAGMA table_info(extractions)').all() as { name: string }[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('document_id');
    expect(cols).toContain('ocr_result_id');
    expect(cols).toContain('schema_json');
    expect(cols).toContain('extraction_json');
    expect(cols).toContain('content_hash');
    expect(cols).toContain('provenance_id');
    expect(cols).toContain('created_at');
  });

  it.skipIf(!sqliteVecAvailable)('creates form_fills table with correct columns', () => {
    createV7Schema();
    migrateToLatest(db);
    const info = db.prepare('PRAGMA table_info(form_fills)').all() as { name: string }[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('source_file_path');
    expect(cols).toContain('source_file_hash');
    expect(cols).toContain('field_data_json');
    expect(cols).toContain('context');
    expect(cols).toContain('confidence_threshold');
    expect(cols).toContain('output_file_path');
    expect(cols).toContain('output_base64');
    expect(cols).toContain('fields_filled');
    expect(cols).toContain('fields_not_found');
    expect(cols).toContain('page_count');
    expect(cols).toContain('cost_cents');
    expect(cols).toContain('status');
    expect(cols).toContain('error_message');
    expect(cols).toContain('provenance_id');
    expect(cols).toContain('created_at');
  });

  it.skipIf(!sqliteVecAvailable)('adds doc metadata columns to documents', () => {
    createV7Schema();
    migrateToLatest(db);
    const info = db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('doc_title');
    expect(cols).toContain('doc_author');
    expect(cols).toContain('doc_subject');
  });

  it.skipIf(!sqliteVecAvailable)('updates provenance CHECK constraints for EXTRACTION and FORM_FILL types', () => {
    createV7Schema();
    // Insert a v7 provenance record first to ensure it survives migration
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('prov-1', 'DOCUMENT', now, now, 'FILE', 'prov-1', 'sha256:abc', 'test', '1.0', '{}', '[]', 0);

    migrateToLatest(db);

    // Should now accept EXTRACTION type in provenance
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
          root_document_id, content_hash, processor, processor_version, processing_params,
          parent_id, parent_ids, chain_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-ext', 'EXTRACTION', now, now, 'EXTRACTION', 'prov-1',
        'prov-1', 'sha256:def', 'test', '1.0', '{}', 'prov-1', '["prov-1"]', 2);
    }).not.toThrow();

    // Should accept FORM_FILL type in provenance
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type,
          root_document_id, content_hash, processor, processor_version, processing_params,
          parent_ids, chain_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-ff', 'FORM_FILL', now, now, 'FORM_FILL',
        'prov-ff', 'sha256:ghi', 'test', '1.0', '{}', '[]', 0);
    }).not.toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('creates new indexes', () => {
    createV7Schema();
    migrateToLatest(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_extractions_document_id');
    expect(indexNames).toContain('idx_form_fills_status');
    expect(indexNames).toContain('idx_documents_doc_title');
  });

  it.skipIf(!sqliteVecAvailable)('updates schema version to 8', () => {
    createV7Schema();
    migrateToLatest(db);
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(8);
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing provenance records after migration', () => {
    createV7Schema();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('prov-keep', 'DOCUMENT', now, now, 'FILE', 'prov-keep', 'sha256:xyz', 'test', '1.0', '{}', '[]', 0);

    migrateToLatest(db);

    const row = db.prepare('SELECT * FROM provenance WHERE id = ?').get('prov-keep') as { id: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe('prov-keep');
    expect(row!.type).toBe('DOCUMENT');
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing documents after migration', () => {
    createV7Schema();
    const now = new Date().toISOString();
    // Insert provenance first (FK constraint)
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('prov-doc-keep', 'DOCUMENT', now, now, 'FILE', 'prov-doc-keep', 'sha256:abc', 'test', '1.0', '{}', '[]', 0);

    db.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('doc-keep', '/test/keep.pdf', 'keep.pdf', 'sha256:abc', 1000, 'pdf', 'complete', 'prov-doc-keep', now);

    migrateToLatest(db);

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get('doc-keep') as { id: string; file_name: string; doc_title: string | null } | undefined;
    expect(doc).toBeDefined();
    expect(doc!.id).toBe('doc-keep');
    expect(doc!.file_name).toBe('keep.pdf');
    // New columns should default to NULL for existing docs
    expect(doc!.doc_title).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('passes FK integrity check after migration', () => {
    createV7Schema();
    migrateToLatest(db);
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('form_fills status CHECK constraint works', () => {
    createV7Schema();
    migrateToLatest(db);
    const now = new Date().toISOString();

    // Create provenance for FK
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('prov-ff-check', 'FORM_FILL', now, now, 'FORM_FILL', 'prov-ff-check', 'sha256:ff', 'test', '1.0', '{}', '[]', 0);

    // Valid status
    expect(() => {
      db.prepare(`
        INSERT INTO form_fills (id, source_file_path, source_file_hash, field_data_json, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ff-valid', '/form.pdf', 'sha256:form', '{}', 'complete', 'prov-ff-check', now);
    }).not.toThrow();

    // Invalid status should fail CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO form_fills (id, source_file_path, source_file_hash, field_data_json, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ff-invalid', '/form.pdf', 'sha256:form', '{}', 'bogus', 'prov-ff-check', now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('is idempotent - running migration twice does not error', () => {
    createV7Schema();
    migrateToLatest(db);
    // Running again should be a no-op (already at v8)
    expect(() => migrateToLatest(db)).not.toThrow();
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(8);
  });
});

/**
 * Migration v13 to v14 Tests
 *
 * Tests the v13->v14 migration which adds:
 * - COMPARISON to provenance type and source_type CHECK constraints
 * - comparisons table for document comparison results
 * - 3 new indexes: idx_comparisons_doc1, idx_comparisons_doc2, idx_comparisons_created
 *
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  getIndexNames,
  getTableNames,
  getTableColumns,
  insertTestProvenance,
  insertTestDocument,
} from './helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Migration v13 to v14 (Document Comparison)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v14');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v13 schema.
   * v13 = v12 + entities + entity_mentions + ENTITY_EXTRACTION in provenance CHECK.
   */
  function createV13Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 13, datetime('now'), datetime('now'));
    `);

    // Provenance (v13 CHECK constraints: includes ENTITY_EXTRACTION but NOT COMPARISON)
    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION')),
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

    // Documents (v12+: includes datalab_file_id)
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
        doc_title TEXT,
        doc_author TEXT,
        doc_subject TEXT,
        datalab_file_id TEXT,
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
        json_blocks TEXT,
        extras_json TEXT,
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
        bbox_x REAL NOT NULL, bbox_y REAL NOT NULL,
        bbox_width REAL NOT NULL, bbox_height REAL NOT NULL,
        image_index INTEGER NOT NULL, format TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL,
        extracted_path TEXT, file_size INTEGER,
        vlm_status TEXT NOT NULL DEFAULT 'pending' CHECK (vlm_status IN ('pending','processing','complete','failed')),
        vlm_description TEXT, vlm_structured_data TEXT, vlm_embedding_id TEXT,
        vlm_model TEXT, vlm_confidence REAL, vlm_processed_at TEXT, vlm_tokens_used INTEGER,
        context_text TEXT, provenance_id TEXT, created_at TEXT NOT NULL, error_message TEXT,
        block_type TEXT, is_header_footer INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id) ON DELETE CASCADE,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    // Embeddings
    db.exec(`
      CREATE TABLE embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT, image_id TEXT, extraction_id TEXT,
        document_id TEXT NOT NULL, original_text TEXT NOT NULL,
        original_text_length INTEGER NOT NULL,
        source_file_path TEXT NOT NULL, source_file_name TEXT NOT NULL,
        source_file_hash TEXT NOT NULL, page_number INTEGER, page_range TEXT,
        character_start INTEGER NOT NULL, character_end INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL, total_chunks INTEGER NOT NULL,
        model_name TEXT NOT NULL, model_version TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK (task_type IN ('search_document','search_query')),
        inference_mode TEXT NOT NULL CHECK (inference_mode = 'local'),
        gpu_device TEXT, provenance_id TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, generation_duration_ms INTEGER,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id),
        FOREIGN KEY (image_id) REFERENCES images(id),
        FOREIGN KEY (extraction_id) REFERENCES extractions(id),
        FOREIGN KEY (document_id) REFERENCES documents(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id),
        CHECK (chunk_id IS NOT NULL OR image_id IS NOT NULL OR extraction_id IS NOT NULL)
      );
    `);

    // Extractions
    db.exec(`
      CREATE TABLE extractions (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ocr_result_id TEXT NOT NULL REFERENCES ocr_results(id) ON DELETE CASCADE,
        schema_json TEXT NOT NULL, extraction_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Form fills
    db.exec(`
      CREATE TABLE form_fills (
        id TEXT PRIMARY KEY NOT NULL,
        source_file_path TEXT NOT NULL, source_file_hash TEXT NOT NULL,
        field_data_json TEXT NOT NULL, context TEXT,
        confidence_threshold REAL NOT NULL DEFAULT 0.5,
        output_file_path TEXT, output_base64 TEXT,
        fields_filled TEXT NOT NULL DEFAULT '[]',
        fields_not_found TEXT NOT NULL DEFAULT '[]',
        page_count INTEGER, cost_cents REAL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','failed')),
        error_message TEXT,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Uploaded files (v12)
    db.exec(`
      CREATE TABLE uploaded_files (
        id TEXT PRIMARY KEY NOT NULL,
        local_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        datalab_file_id TEXT,
        datalab_reference TEXT,
        upload_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (upload_status IN ('pending', 'uploading', 'confirming', 'complete', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        provenance_id TEXT NOT NULL REFERENCES provenance(id)
      );
    `);

    // Entities (v13)
    db.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'other')),
        raw_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.0,
        metadata TEXT,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Entity mentions (v13)
    db.exec(`
      CREATE TABLE entity_mentions (
        id TEXT PRIMARY KEY NOT NULL,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        document_id TEXT NOT NULL REFERENCES documents(id),
        chunk_id TEXT REFERENCES chunks(id),
        page_number INTEGER,
        character_start INTEGER,
        character_end INTEGER,
        context_text TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 13, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 13, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 13, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 13, NULL);`);
    db.exec(`CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE extractions_fts USING fts5(extraction_json, content='extractions', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`);

    // Triggers
    db.exec(`CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
    db.exec(`CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;`);
    db.exec(`CREATE TRIGGER chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
    db.exec(`CREATE TRIGGER vlm_fts_ai AFTER INSERT ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);
    db.exec(`CREATE TRIGGER vlm_fts_ad AFTER DELETE ON embeddings WHEN old.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); END;`);
    db.exec(`CREATE TRIGGER vlm_fts_au AFTER UPDATE OF original_text ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);
    db.exec(`CREATE TRIGGER extractions_fts_ai AFTER INSERT ON extractions BEGIN INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json); END;`);
    db.exec(`CREATE TRIGGER extractions_fts_ad AFTER DELETE ON extractions BEGIN INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json); END;`);
    db.exec(`CREATE TRIGGER extractions_fts_au AFTER UPDATE OF extraction_json ON extractions BEGIN INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json); INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json); END;`);

    // All 34 indexes from v13
    db.exec('CREATE INDEX idx_documents_file_path ON documents(file_path);');
    db.exec('CREATE INDEX idx_documents_file_hash ON documents(file_hash);');
    db.exec('CREATE INDEX idx_documents_status ON documents(status);');
    db.exec('CREATE INDEX idx_ocr_results_document_id ON ocr_results(document_id);');
    db.exec('CREATE INDEX idx_chunks_document_id ON chunks(document_id);');
    db.exec('CREATE INDEX idx_chunks_ocr_result_id ON chunks(ocr_result_id);');
    db.exec('CREATE INDEX idx_chunks_embedding_status ON chunks(embedding_status);');
    db.exec('CREATE INDEX idx_embeddings_chunk_id ON embeddings(chunk_id);');
    db.exec('CREATE INDEX idx_embeddings_image_id ON embeddings(image_id);');
    db.exec('CREATE INDEX idx_embeddings_extraction_id ON embeddings(extraction_id);');
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
    db.exec('CREATE INDEX idx_extractions_document_id ON extractions(document_id);');
    db.exec('CREATE INDEX idx_form_fills_status ON form_fills(status);');
    db.exec('CREATE INDEX idx_documents_doc_title ON documents(doc_title);');
    db.exec('CREATE INDEX idx_uploaded_files_file_hash ON uploaded_files(file_hash);');
    db.exec('CREATE INDEX idx_uploaded_files_status ON uploaded_files(upload_status);');
    db.exec('CREATE INDEX idx_uploaded_files_datalab_file_id ON uploaded_files(datalab_file_id);');
    db.exec('CREATE INDEX idx_entities_document_id ON entities(document_id);');
    db.exec('CREATE INDEX idx_entities_entity_type ON entities(entity_type);');
    db.exec('CREATE INDEX idx_entities_normalized_text ON entities(normalized_text);');
    db.exec('CREATE INDEX idx_entity_mentions_entity_id ON entity_mentions(entity_id);');
  }

  it.skipIf(!sqliteVecAvailable)('creates comparisons table from v13 schema', () => {
    createV13Schema();
    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('comparisons');
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing provenance rows during migration', () => {
    createV13Schema();

    // Insert provenance records before migration
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-pre-1', 'DOCUMENT', ?, ?, 'FILE', 'prov-pre-1',
        'sha256:existing1', 'test', '1.0', '{}', '[]', 0)
    `).run(now, now);
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-pre-2', 'OCR_RESULT', ?, ?, 'OCR', 'prov-pre-1',
        'sha256:existing2', 'datalab', '1.0', '{}', '["prov-pre-1"]', 1)
    `).run(now, now);

    const countBefore = (db.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number }).cnt;

    migrateToLatest(db);

    const countAfter = (db.prepare('SELECT COUNT(*) as cnt FROM provenance').get() as { cnt: number }).cnt;
    expect(countAfter).toBe(countBefore);

    // Verify data integrity
    const row1 = db.prepare('SELECT * FROM provenance WHERE id = ?').get('prov-pre-1') as { type: string; content_hash: string };
    expect(row1).toBeDefined();
    expect(row1.type).toBe('DOCUMENT');
    expect(row1.content_hash).toBe('sha256:existing1');

    const row2 = db.prepare('SELECT * FROM provenance WHERE id = ?').get('prov-pre-2') as { type: string; content_hash: string };
    expect(row2).toBeDefined();
    expect(row2.type).toBe('OCR_RESULT');
    expect(row2.content_hash).toBe('sha256:existing2');
  });

  it.skipIf(!sqliteVecAvailable)('COMPARISON type accepted in provenance after migration', () => {
    createV13Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Should succeed: insert COMPARISON provenance
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES ('prov-comp-1', 'COMPARISON', ?, ?, 'COMPARISON', 'prov-comp-1',
          'sha256:comparison1', 'document-comparison', '1.0.0', '{}', '[]', 2)
      `).run(now, now);
    }).not.toThrow();

    // Verify the record exists in DB
    const row = db.prepare('SELECT type, source_type FROM provenance WHERE id = ?').get('prov-comp-1') as { type: string; source_type: string };
    expect(row.type).toBe('COMPARISON');
    expect(row.source_type).toBe('COMPARISON');
  });

  it.skipIf(!sqliteVecAvailable)('schema version is 14 after migration', () => {
    createV13Schema();
    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(24);
  });

  it.skipIf(!sqliteVecAvailable)('all 3 comparison indexes exist', () => {
    createV13Schema();
    migrateToLatest(db);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_comparisons_doc1');
    expect(indexes).toContain('idx_comparisons_doc2');
    expect(indexes).toContain('idx_comparisons_created');
  });

  it.skipIf(!sqliteVecAvailable)('FK integrity clean after migration', () => {
    createV13Schema();
    migrateToLatest(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('fresh database init creates v14 schema', () => {
    // Load sqlite-vec for fresh init
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('comparisons');
    expect(tables).toContain('provenance');
    expect(tables).toContain('documents');

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(24);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_comparisons_doc1');
    expect(indexes).toContain('idx_comparisons_doc2');
    expect(indexes).toContain('idx_comparisons_created');
  });

  it.skipIf(!sqliteVecAvailable)('comparisons table has correct columns', () => {
    createV13Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'comparisons');
    expect(columns).toContain('id');
    expect(columns).toContain('document_id_1');
    expect(columns).toContain('document_id_2');
    expect(columns).toContain('similarity_ratio');
    expect(columns).toContain('text_diff_json');
    expect(columns).toContain('structural_diff_json');
    expect(columns).toContain('entity_diff_json');
    expect(columns).toContain('summary');
    expect(columns).toContain('content_hash');
    expect(columns).toContain('provenance_id');
    expect(columns).toContain('created_at');
    expect(columns).toContain('processing_duration_ms');
    expect(columns.length).toBe(12);
  });

  it.skipIf(!sqliteVecAvailable)('COMPARISON type NOT accepted before migration (v13 CHECK)', () => {
    createV13Schema();

    const now = new Date().toISOString();
    // Should fail: v13 provenance CHECK does not include COMPARISON
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES ('prov-bad-1', 'COMPARISON', ?, ?, 'COMPARISON', 'prov-bad-1',
          'sha256:badcomp', 'test', '1.0', '{}', '[]', 2)
      `).run(now, now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running migration twice does not error', () => {
    createV13Schema();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(24);
  });

  it.skipIf(!sqliteVecAvailable)('comparisons table enforces document FK constraints', () => {
    createV13Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Create provenance for the comparison
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-fk-test', 'COMPARISON', ?, ?, 'COMPARISON', 'prov-fk-test',
        'sha256:fktest', 'document-comparison', '1.0.0', '{}', '[]', 2)
    `).run(now, now);

    // Should fail: document_id_1 does not exist
    expect(() => {
      db.prepare(`
        INSERT INTO comparisons (id, document_id_1, document_id_2, similarity_ratio,
          text_diff_json, structural_diff_json, entity_diff_json, summary,
          content_hash, provenance_id, created_at, processing_duration_ms)
        VALUES ('cmp-fk-bad', 'nonexistent-doc1', 'nonexistent-doc2', 0.5,
          '{}', '{}', '{}', 'test summary',
          'sha256:fkbad', 'prov-fk-test', ?, 100)
      `).run(now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('can insert and query comparison after migration', () => {
    createV13Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Create two documents with provenance
    insertTestProvenance(db, 'prov-doc-a', 'DOCUMENT', 'prov-doc-a');
    insertTestDocument(db, 'doc-a', 'prov-doc-a', 'complete');
    insertTestProvenance(db, 'prov-doc-b', 'DOCUMENT', 'prov-doc-b');
    insertTestDocument(db, 'doc-b', 'prov-doc-b', 'complete');

    // Create comparison provenance
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-cmp-1', 'COMPARISON', ?, ?, 'COMPARISON', 'prov-doc-a',
        'sha256:cmp1hash', 'document-comparison', '1.0.0', '{}', '["prov-doc-a"]', 2)
    `).run(now, now);

    // Insert comparison
    const textDiff = JSON.stringify({ operations: [], similarity_ratio: 0.85 });
    const structDiff = JSON.stringify({ doc1_page_count: 5, doc2_page_count: 5 });
    const entityDiff = JSON.stringify({ doc1_total_entities: 10, doc2_total_entities: 12 });

    db.prepare(`
      INSERT INTO comparisons (id, document_id_1, document_id_2, similarity_ratio,
        text_diff_json, structural_diff_json, entity_diff_json, summary,
        content_hash, provenance_id, created_at, processing_duration_ms)
      VALUES ('cmp-1', 'doc-a', 'doc-b', 0.85, ?, ?, ?, 'Documents are 85% similar',
        'sha256:cmpcontentsha', 'prov-cmp-1', ?, 250)
    `).run(textDiff, structDiff, entityDiff, now);

    // Query and verify
    const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get('cmp-1') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.document_id_1).toBe('doc-a');
    expect(row.document_id_2).toBe('doc-b');
    expect(row.similarity_ratio).toBe(0.85);
    expect(row.summary).toBe('Documents are 85% similar');
    expect(row.processing_duration_ms).toBe(250);

    // Verify JSON round-trip
    const parsed = JSON.parse(row.text_diff_json as string);
    expect(parsed.similarity_ratio).toBe(0.85);
  });
});

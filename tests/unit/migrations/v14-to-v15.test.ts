/**
 * Migration v14 to v15 Tests
 *
 * Tests the v14->v15 migration which adds:
 * - CLUSTERING to provenance type and source_type CHECK constraints
 * - clusters table for document clustering results
 * - document_clusters table for document-cluster assignments
 * - 6 new indexes: idx_clusters_run_id, idx_clusters_tag, idx_clusters_created,
 *   idx_doc_clusters_document, idx_doc_clusters_cluster, idx_doc_clusters_run
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

describe('Migration v14 to v15 (Document Clustering)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v15');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v14 schema.
   * v14 = v13 + comparisons + COMPARISON in provenance CHECK.
   */
  function createV14Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 14, datetime('now'), datetime('now'));
    `);

    // Provenance (v14 CHECK constraints: includes COMPARISON but NOT CLUSTERING)
    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON')),
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

    // Comparisons (v14)
    db.exec(`
      CREATE TABLE comparisons (
        id TEXT PRIMARY KEY NOT NULL,
        document_id_1 TEXT NOT NULL REFERENCES documents(id),
        document_id_2 TEXT NOT NULL REFERENCES documents(id),
        similarity_ratio REAL NOT NULL,
        text_diff_json TEXT NOT NULL,
        structural_diff_json TEXT NOT NULL,
        entity_diff_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processing_duration_ms INTEGER
      );
    `);

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 14, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 14, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 14, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 14, NULL);`);
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

    // All 37 indexes from v14
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
    db.exec('CREATE INDEX idx_comparisons_doc1 ON comparisons(document_id_1);');
    db.exec('CREATE INDEX idx_comparisons_doc2 ON comparisons(document_id_2);');
    db.exec('CREATE INDEX idx_comparisons_created ON comparisons(created_at);');
  }

  it.skipIf(!sqliteVecAvailable)('creates clusters table from v14 schema', () => {
    createV14Schema();
    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('clusters');
  });

  it.skipIf(!sqliteVecAvailable)('creates document_clusters table from v14 schema', () => {
    createV14Schema();
    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('document_clusters');
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing provenance rows during migration', () => {
    createV14Schema();

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

  it.skipIf(!sqliteVecAvailable)('CLUSTERING type accepted in provenance after migration', () => {
    createV14Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Should succeed: insert CLUSTERING provenance
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES ('prov-clust-1', 'CLUSTERING', ?, ?, 'CLUSTERING', 'prov-clust-1',
          'sha256:clustering1', 'document-clustering', '1.0.0', '{}', '[]', 2)
      `).run(now, now);
    }).not.toThrow();

    // Verify the record exists in DB
    const row = db.prepare('SELECT type, source_type FROM provenance WHERE id = ?').get('prov-clust-1') as { type: string; source_type: string };
    expect(row.type).toBe('CLUSTERING');
    expect(row.source_type).toBe('CLUSTERING');
  });

  it.skipIf(!sqliteVecAvailable)('CLUSTERING type NOT accepted before migration (v14 CHECK)', () => {
    createV14Schema();

    const now = new Date().toISOString();
    // Should fail: v14 provenance CHECK does not include CLUSTERING
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES ('prov-bad-1', 'CLUSTERING', ?, ?, 'CLUSTERING', 'prov-bad-1',
          'sha256:badclust', 'test', '1.0', '{}', '[]', 2)
      `).run(now, now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('invalid provenance type rejected after migration', () => {
    createV14Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();
    // Should fail: INVALID_TYPE is not in the CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES ('prov-invalid', 'INVALID_TYPE', ?, ?, 'FILE', 'prov-invalid',
          'sha256:invalid', 'test', '1.0', '{}', '[]', 0)
      `).run(now, now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('schema version is 15 after migration', () => {
    createV14Schema();
    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(22);
  });

  it.skipIf(!sqliteVecAvailable)('all 6 clustering indexes exist', () => {
    createV14Schema();
    migrateToLatest(db);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_clusters_run_id');
    expect(indexes).toContain('idx_clusters_tag');
    expect(indexes).toContain('idx_clusters_created');
    expect(indexes).toContain('idx_doc_clusters_document');
    expect(indexes).toContain('idx_doc_clusters_cluster');
    expect(indexes).toContain('idx_doc_clusters_run');
  });

  it.skipIf(!sqliteVecAvailable)('FK integrity clean after migration', () => {
    createV14Schema();
    migrateToLatest(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('fresh database init creates clusters and document_clusters tables', () => {
    // Load sqlite-vec for fresh init
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('clusters');
    expect(tables).toContain('document_clusters');
    expect(tables).toContain('provenance');
    expect(tables).toContain('documents');

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(22);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_clusters_run_id');
    expect(indexes).toContain('idx_clusters_tag');
    expect(indexes).toContain('idx_clusters_created');
    expect(indexes).toContain('idx_doc_clusters_document');
    expect(indexes).toContain('idx_doc_clusters_cluster');
    expect(indexes).toContain('idx_doc_clusters_run');
  });

  it.skipIf(!sqliteVecAvailable)('clusters table has correct columns', () => {
    createV14Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'clusters');
    expect(columns).toContain('id');
    expect(columns).toContain('run_id');
    expect(columns).toContain('cluster_index');
    expect(columns).toContain('label');
    expect(columns).toContain('description');
    expect(columns).toContain('classification_tag');
    expect(columns).toContain('document_count');
    expect(columns).toContain('centroid_json');
    expect(columns).toContain('top_terms_json');
    expect(columns).toContain('coherence_score');
    expect(columns).toContain('algorithm');
    expect(columns).toContain('algorithm_params_json');
    expect(columns).toContain('silhouette_score');
    expect(columns).toContain('content_hash');
    expect(columns).toContain('provenance_id');
    expect(columns).toContain('created_at');
    expect(columns).toContain('processing_duration_ms');
    expect(columns.length).toBe(17);
  });

  it.skipIf(!sqliteVecAvailable)('document_clusters table has correct columns', () => {
    createV14Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'document_clusters');
    expect(columns).toContain('id');
    expect(columns).toContain('document_id');
    expect(columns).toContain('cluster_id');
    expect(columns).toContain('run_id');
    expect(columns).toContain('similarity_to_centroid');
    expect(columns).toContain('membership_probability');
    expect(columns).toContain('is_noise');
    expect(columns).toContain('assigned_at');
    expect(columns.length).toBe(8);
  });

  it.skipIf(!sqliteVecAvailable)('UNIQUE constraint on document_clusters(document_id, run_id)', () => {
    createV14Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Create provenance + document + cluster for test
    insertTestProvenance(db, 'prov-doc-u1', 'DOCUMENT', 'prov-doc-u1');
    insertTestDocument(db, 'doc-u1', 'prov-doc-u1', 'complete');

    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-clust-u1', 'CLUSTERING', ?, ?, 'CLUSTERING', 'prov-doc-u1',
        'sha256:clustu1', 'document-clustering', '1.0.0', '{}', '["prov-doc-u1"]', 2)
    `).run(now, now);

    db.prepare(`
      INSERT INTO clusters (id, run_id, cluster_index, algorithm, algorithm_params_json,
        content_hash, provenance_id, created_at, document_count)
      VALUES ('clust-u1', 'run-u1', 0, 'kmeans', '{"k":3}',
        'sha256:clustcontentsha', 'prov-clust-u1', ?, 1)
    `).run(now);

    // First insert should succeed
    db.prepare(`
      INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
        similarity_to_centroid, membership_probability, is_noise, assigned_at)
      VALUES ('dc-1', 'doc-u1', 'clust-u1', 'run-u1', 0.95, 1.0, 0, ?)
    `).run(now);

    // Second insert with same document_id + run_id should fail (UNIQUE constraint)
    expect(() => {
      db.prepare(`
        INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
          similarity_to_centroid, membership_probability, is_noise, assigned_at)
        VALUES ('dc-2', 'doc-u1', 'clust-u1', 'run-u1', 0.90, 1.0, 0, ?)
      `).run(now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running migration twice does not error', () => {
    createV14Schema();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(22);
  });

  it.skipIf(!sqliteVecAvailable)('can insert and query cluster after migration', () => {
    createV14Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Create a document with provenance
    insertTestProvenance(db, 'prov-doc-c1', 'DOCUMENT', 'prov-doc-c1');
    insertTestDocument(db, 'doc-c1', 'prov-doc-c1', 'complete');

    // Create clustering provenance
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-clust-c1', 'CLUSTERING', ?, ?, 'CLUSTERING', 'prov-doc-c1',
        'sha256:clustc1hash', 'document-clustering', '1.0.0', '{"algorithm":"kmeans","k":3}', '["prov-doc-c1"]', 2)
    `).run(now, now);

    // Insert cluster
    const centroid = JSON.stringify([0.1, 0.2, 0.3]);
    const topTerms = JSON.stringify(['contract', 'agreement', 'clause']);
    const params = JSON.stringify({ algorithm: 'kmeans', k: 3 });

    db.prepare(`
      INSERT INTO clusters (id, run_id, cluster_index, label, description, classification_tag,
        document_count, centroid_json, top_terms_json, coherence_score, algorithm,
        algorithm_params_json, silhouette_score, content_hash, provenance_id, created_at,
        processing_duration_ms)
      VALUES ('clust-c1', 'run-c1', 0, 'Legal Contracts', 'Cluster of legal contract documents',
        'legal-contracts', 5, ?, ?, 0.82, 'kmeans', ?, 0.75,
        'sha256:clustcontentc1', 'prov-clust-c1', ?, 350)
    `).run(centroid, topTerms, params, now);

    // Insert document_clusters assignment
    db.prepare(`
      INSERT INTO document_clusters (id, document_id, cluster_id, run_id,
        similarity_to_centroid, membership_probability, is_noise, assigned_at)
      VALUES ('dc-c1', 'doc-c1', 'clust-c1', 'run-c1', 0.92, 1.0, 0, ?)
    `).run(now);

    // Query and verify cluster
    const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get('clust-c1') as Record<string, unknown>;
    expect(cluster).toBeDefined();
    expect(cluster.run_id).toBe('run-c1');
    expect(cluster.cluster_index).toBe(0);
    expect(cluster.label).toBe('Legal Contracts');
    expect(cluster.classification_tag).toBe('legal-contracts');
    expect(cluster.document_count).toBe(5);
    expect(cluster.coherence_score).toBe(0.82);
    expect(cluster.algorithm).toBe('kmeans');
    expect(cluster.silhouette_score).toBe(0.75);
    expect(cluster.processing_duration_ms).toBe(350);

    // Verify JSON round-trip
    const parsedCentroid = JSON.parse(cluster.centroid_json as string);
    expect(parsedCentroid).toEqual([0.1, 0.2, 0.3]);
    const parsedTerms = JSON.parse(cluster.top_terms_json as string);
    expect(parsedTerms).toEqual(['contract', 'agreement', 'clause']);

    // Query and verify document_clusters assignment
    const assignment = db.prepare('SELECT * FROM document_clusters WHERE id = ?').get('dc-c1') as Record<string, unknown>;
    expect(assignment).toBeDefined();
    expect(assignment.document_id).toBe('doc-c1');
    expect(assignment.cluster_id).toBe('clust-c1');
    expect(assignment.run_id).toBe('run-c1');
    expect(assignment.similarity_to_centroid).toBe(0.92);
    expect(assignment.membership_probability).toBe(1.0);
    expect(assignment.is_noise).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('existing data survives migration', () => {
    createV14Schema();

    const now = new Date().toISOString();

    // Insert test data before migration
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-surv-1', 'DOCUMENT', ?, ?, 'FILE', 'prov-surv-1',
        'sha256:survdoc', 'file-ingester', '1.0.0', '{}', '[]', 0)
    `).run(now, now);

    db.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type,
        status, provenance_id, created_at)
      VALUES ('doc-surv', '/test/survive.pdf', 'survive.pdf', 'sha256:survdocfile',
        2048, 'pdf', 'complete', 'prov-surv-1', ?)
    `).run(now);

    // Run migration
    migrateToLatest(db);

    // Verify document survived
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get('doc-surv') as Record<string, unknown>;
    expect(doc).toBeDefined();
    expect(doc.file_name).toBe('survive.pdf');
    expect(doc.file_hash).toBe('sha256:survdocfile');
    expect(doc.status).toBe('complete');

    // Verify provenance survived
    const prov = db.prepare('SELECT * FROM provenance WHERE id = ?').get('prov-surv-1') as Record<string, unknown>;
    expect(prov).toBeDefined();
    expect(prov.type).toBe('DOCUMENT');
    expect(prov.content_hash).toBe('sha256:survdoc');
  });
});

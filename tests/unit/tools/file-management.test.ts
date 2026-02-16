/**
 * File Management Upload Operations Tests
 *
 * Tests CRUD operations for uploaded_files table using REAL databases.
 * NO mocks - uses better-sqlite3 temp files with v12 schema.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
} from '../migrations/helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';
import {
  insertUploadedFile,
  getUploadedFile,
  getUploadedFileByHash,
  listUploadedFiles,
  updateUploadedFileStatus,
  updateUploadedFileDatalabInfo,
  deleteUploadedFile,
} from '../../../src/services/storage/database/upload-operations.js';
import type { UploadedFile } from '../../../src/models/uploaded-file.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('File Management Upload Operations', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-file-mgmt');
    const result = createTestDb(tmpDir);
    db = result.db;

    if (!sqliteVecAvailable) return;

    // Create a fresh v12 database using migrateToLatest from scratch
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Build v11 schema then migrate to v12
    buildV11Schema();
    migrateToLatest(db);
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  function buildV11Schema(): void {
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_version VALUES (1, 11, datetime('now'), datetime('now'));
    `);

    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL')),
        created_at TEXT NOT NULL, processed_at TEXT NOT NULL,
        source_file_created_at TEXT, source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL')),
        source_path TEXT, source_id TEXT, root_document_id TEXT NOT NULL, location TEXT,
        content_hash TEXT NOT NULL, input_hash TEXT, file_hash TEXT,
        processor TEXT NOT NULL, processor_version TEXT NOT NULL, processing_params TEXT NOT NULL,
        processing_duration_ms INTEGER, processing_quality_score REAL,
        parent_id TEXT, parent_ids TEXT NOT NULL, chain_depth INTEGER NOT NULL, chain_path TEXT,
        FOREIGN KEY (source_id) REFERENCES provenance(id),
        FOREIGN KEY (parent_id) REFERENCES provenance(id)
      );
    `);

    db.exec(`
      CREATE TABLE database_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        database_name TEXT NOT NULL, database_version TEXT NOT NULL,
        created_at TEXT NOT NULL, last_modified_at TEXT NOT NULL,
        total_documents INTEGER NOT NULL DEFAULT 0, total_ocr_results INTEGER NOT NULL DEFAULT 0,
        total_chunks INTEGER NOT NULL DEFAULT 0, total_embeddings INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO database_metadata VALUES (1, 'test', '1.0.0', datetime('now'), datetime('now'), 0, 0, 0, 0);
    `);

    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, file_path TEXT NOT NULL, file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL, file_size INTEGER NOT NULL, file_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','failed')),
        page_count INTEGER, provenance_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        modified_at TEXT, ocr_completed_at TEXT, error_message TEXT,
        doc_title TEXT, doc_author TEXT, doc_subject TEXT,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    db.exec(`
      CREATE TABLE ocr_results (
        id TEXT PRIMARY KEY, provenance_id TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL,
        extracted_text TEXT NOT NULL, text_length INTEGER NOT NULL, datalab_request_id TEXT NOT NULL,
        datalab_mode TEXT NOT NULL CHECK (datalab_mode IN ('fast', 'balanced', 'accurate')),
        parse_quality_score REAL, page_count INTEGER NOT NULL, cost_cents REAL,
        content_hash TEXT NOT NULL, processing_started_at TEXT NOT NULL,
        processing_completed_at TEXT NOT NULL, processing_duration_ms INTEGER NOT NULL,
        json_blocks TEXT, extras_json TEXT,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id),
        FOREIGN KEY (document_id) REFERENCES documents(id)
      );
    `);

    db.exec(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ocr_result_id TEXT NOT NULL,
        text TEXT NOT NULL, text_hash TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        character_start INTEGER NOT NULL, character_end INTEGER NOT NULL,
        page_number INTEGER, page_range TEXT, overlap_previous INTEGER NOT NULL,
        overlap_next INTEGER NOT NULL, provenance_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        embedding_status TEXT NOT NULL CHECK (embedding_status IN ('pending', 'complete', 'failed')),
        embedded_at TEXT,
        FOREIGN KEY (document_id) REFERENCES documents(id),
        FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    db.exec(`
      CREATE TABLE images (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ocr_result_id TEXT NOT NULL,
        page_number INTEGER NOT NULL, bbox_x REAL NOT NULL, bbox_y REAL NOT NULL,
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

    db.exec(`
      CREATE TABLE embeddings (
        id TEXT PRIMARY KEY, chunk_id TEXT, image_id TEXT, extraction_id TEXT,
        document_id TEXT NOT NULL, original_text TEXT NOT NULL, original_text_length INTEGER NOT NULL,
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

    db.exec(`
      CREATE TABLE extractions (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ocr_result_id TEXT NOT NULL REFERENCES ocr_results(id) ON DELETE CASCADE,
        schema_json TEXT NOT NULL, extraction_json TEXT NOT NULL,
        content_hash TEXT NOT NULL, provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.exec(`
      CREATE TABLE form_fills (
        id TEXT PRIMARY KEY NOT NULL,
        source_file_path TEXT NOT NULL, source_file_hash TEXT NOT NULL,
        field_data_json TEXT NOT NULL, context TEXT,
        confidence_threshold REAL NOT NULL DEFAULT 0.5,
        output_file_path TEXT, output_base64 TEXT,
        fields_filled TEXT NOT NULL DEFAULT '[]', fields_not_found TEXT NOT NULL DEFAULT '[]',
        page_count INTEGER, cost_cents REAL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','failed')),
        error_message TEXT, provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // FTS + vec tables
    db.exec(
      `CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`
    );
    db.exec(
      `CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 11, content_hash TEXT);`
    );
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 11, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 11, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 11, NULL);`);
    db.exec(
      `CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`
    );
    db.exec(
      `CREATE VIRTUAL TABLE extractions_fts USING fts5(extraction_json, content='extractions', content_rowid='rowid', tokenize='porter unicode61');`
    );
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`
    );

    // Triggers
    db.exec(
      `CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`
    );
    db.exec(
      `CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;`
    );
    db.exec(
      `CREATE TRIGGER chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`
    );
    db.exec(
      `CREATE TRIGGER vlm_fts_ai AFTER INSERT ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`
    );
    db.exec(
      `CREATE TRIGGER vlm_fts_ad AFTER DELETE ON embeddings WHEN old.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); END;`
    );
    db.exec(
      `CREATE TRIGGER vlm_fts_au AFTER UPDATE OF original_text ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`
    );
    db.exec(
      `CREATE TRIGGER extractions_fts_ai AFTER INSERT ON extractions BEGIN INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json); END;`
    );
    db.exec(
      `CREATE TRIGGER extractions_fts_ad AFTER DELETE ON extractions BEGIN INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json); END;`
    );
    db.exec(
      `CREATE TRIGGER extractions_fts_au AFTER UPDATE OF extraction_json ON extractions BEGIN INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json); INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json); END;`
    );

    // Indexes
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
  }

  /**
   * Helper: create a provenance record for testing
   */
  function createTestProvenance(id: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, 'sha256:test', 'test', '1.0', '{}', '[]', 0)
    `
    ).run(id, now, now, id);
  }

  /**
   * Helper: create a test uploaded file record
   */
  function createTestUploadedFile(overrides: Partial<UploadedFile> = {}): UploadedFile {
    const now = new Date().toISOString();
    return {
      id: 'upload-1',
      local_path: '/test/document.pdf',
      file_name: 'document.pdf',
      file_hash: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      file_size: 1024,
      content_type: 'application/pdf',
      datalab_file_id: null,
      datalab_reference: null,
      upload_status: 'pending',
      error_message: null,
      created_at: now,
      completed_at: null,
      provenance_id: 'prov-upload-test',
      ...overrides,
    };
  }

  it.skipIf(!sqliteVecAvailable)('insertUploadedFile and getUploadedFile round-trip', () => {
    createTestProvenance('prov-upload-test');

    const data = createTestUploadedFile();
    const result = insertUploadedFile(db, data);

    expect(result.id).toBe('upload-1');

    const fetched = getUploadedFile(db, 'upload-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.file_name).toBe('document.pdf');
    expect(fetched!.file_hash).toBe(
      'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    );
    expect(fetched!.file_size).toBe(1024);
    expect(fetched!.content_type).toBe('application/pdf');
    expect(fetched!.upload_status).toBe('pending');
    expect(fetched!.provenance_id).toBe('prov-upload-test');
  });

  it.skipIf(!sqliteVecAvailable)('getUploadedFile returns null for non-existent ID', () => {
    const fetched = getUploadedFile(db, 'non-existent');
    expect(fetched).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('getUploadedFileByHash finds completed uploads', () => {
    createTestProvenance('prov-hash-1');

    const data = createTestUploadedFile({
      id: 'upload-hash-1',
      upload_status: 'complete',
      provenance_id: 'prov-hash-1',
    });
    insertUploadedFile(db, data);

    const found = getUploadedFileByHash(db, data.file_hash);
    expect(found).not.toBeNull();
    expect(found!.id).toBe('upload-hash-1');
  });

  it.skipIf(!sqliteVecAvailable)('getUploadedFileByHash returns null for pending uploads', () => {
    createTestProvenance('prov-hash-2');

    const data = createTestUploadedFile({
      id: 'upload-hash-2',
      upload_status: 'pending',
      provenance_id: 'prov-hash-2',
    });
    insertUploadedFile(db, data);

    // Should not find pending uploads
    const found = getUploadedFileByHash(db, data.file_hash);
    expect(found).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('getUploadedFileByHash returns null for unknown hash', () => {
    const found = getUploadedFileByHash(db, 'sha256:nonexistent');
    expect(found).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('listUploadedFiles returns all files', () => {
    createTestProvenance('prov-list-1');
    createTestProvenance('prov-list-2');

    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-list-1',
        provenance_id: 'prov-list-1',
        upload_status: 'complete',
      })
    );
    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-list-2',
        provenance_id: 'prov-list-2',
        upload_status: 'failed',
        file_hash: 'sha256:different1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      })
    );

    const all = listUploadedFiles(db);
    expect(all.length).toBe(2);
  });

  it.skipIf(!sqliteVecAvailable)('listUploadedFiles filters by status', () => {
    createTestProvenance('prov-filter-1');
    createTestProvenance('prov-filter-2');

    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-f1',
        provenance_id: 'prov-filter-1',
        upload_status: 'complete',
      })
    );
    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-f2',
        provenance_id: 'prov-filter-2',
        upload_status: 'failed',
        file_hash: 'sha256:different1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      })
    );

    const completed = listUploadedFiles(db, { status: 'complete' });
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe('upload-f1');

    const failed = listUploadedFiles(db, { status: 'failed' });
    expect(failed.length).toBe(1);
    expect(failed[0].id).toBe('upload-f2');
  });

  it.skipIf(!sqliteVecAvailable)('listUploadedFiles supports limit and offset', () => {
    createTestProvenance('prov-page-1');
    createTestProvenance('prov-page-2');
    createTestProvenance('prov-page-3');

    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-p1',
        provenance_id: 'prov-page-1',
        file_hash: 'sha256:a1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      })
    );
    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-p2',
        provenance_id: 'prov-page-2',
        file_hash: 'sha256:b1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      })
    );
    insertUploadedFile(
      db,
      createTestUploadedFile({
        id: 'upload-p3',
        provenance_id: 'prov-page-3',
        file_hash: 'sha256:c1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      })
    );

    const page1 = listUploadedFiles(db, { limit: 2 });
    expect(page1.length).toBe(2);

    const page2 = listUploadedFiles(db, { limit: 2, offset: 2 });
    expect(page2.length).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('updateUploadedFileStatus transitions correctly', () => {
    createTestProvenance('prov-status-1');
    insertUploadedFile(
      db,
      createTestUploadedFile({ id: 'upload-s1', provenance_id: 'prov-status-1' })
    );

    // Transition to uploading
    updateUploadedFileStatus(db, 'upload-s1', 'uploading');
    let file = getUploadedFile(db, 'upload-s1');
    expect(file!.upload_status).toBe('uploading');

    // Transition to complete (should set completed_at)
    updateUploadedFileStatus(db, 'upload-s1', 'complete');
    file = getUploadedFile(db, 'upload-s1');
    expect(file!.upload_status).toBe('complete');
    expect(file!.completed_at).not.toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('updateUploadedFileStatus sets error message on failure', () => {
    createTestProvenance('prov-status-2');
    insertUploadedFile(
      db,
      createTestUploadedFile({ id: 'upload-s2', provenance_id: 'prov-status-2' })
    );

    updateUploadedFileStatus(db, 'upload-s2', 'failed', 'Network timeout');
    const file = getUploadedFile(db, 'upload-s2');
    expect(file!.upload_status).toBe('failed');
    expect(file!.error_message).toBe('Network timeout');
  });

  it.skipIf(!sqliteVecAvailable)('updateUploadedFileDatalabInfo updates fields', () => {
    createTestProvenance('prov-datalab-1');
    insertUploadedFile(
      db,
      createTestUploadedFile({ id: 'upload-d1', provenance_id: 'prov-datalab-1' })
    );

    updateUploadedFileDatalabInfo(db, 'upload-d1', 'datalab-abc123', 'ref-xyz');
    const file = getUploadedFile(db, 'upload-d1');
    expect(file!.datalab_file_id).toBe('datalab-abc123');
    expect(file!.datalab_reference).toBe('ref-xyz');
  });

  it.skipIf(!sqliteVecAvailable)('deleteUploadedFile removes record', () => {
    createTestProvenance('prov-del-1');
    insertUploadedFile(
      db,
      createTestUploadedFile({ id: 'upload-del-1', provenance_id: 'prov-del-1' })
    );

    const deleted = deleteUploadedFile(db, 'upload-del-1');
    expect(deleted).toBe(true);

    const file = getUploadedFile(db, 'upload-del-1');
    expect(file).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('deleteUploadedFile returns false for non-existent', () => {
    const deleted = deleteUploadedFile(db, 'non-existent');
    expect(deleted).toBe(false);
  });
});

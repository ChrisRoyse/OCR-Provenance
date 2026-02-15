/**
 * Legacy Migration Chain Tests (v7 → v14)
 *
 * Consolidated from individual v7-to-v8, v9-to-v10, v10-to-v11, v11-to-v12,
 * v12-to-v13, and v13-to-v14 test files. Tests the full migration chain from
 * a v7 schema to the latest version, verifying all features added in v8-v14.
 *
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
} from '../unit/migrations/helpers.js';
import { migrateToLatest } from '../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getTableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(r => r.name);
}

function getIndexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map(r => r.name);
}

function getTableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map(r => r.name);
}

function insertTestProvenance(
  db: Database.Database, id: string, type: string, rootDocId: string
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
      content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, now, now, 'FILE', rootDocId, `sha256:${id}`, 'test', '1.0', '{}', '[]', 0);
}

function insertTestDocument(
  db: Database.Database, docId: string, provId: string, status: string = 'complete'
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type,
      status, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(docId, `/test/${docId}.pdf`, `${docId}.pdf`, `sha256:${docId}`, 1024, 'pdf', status, provId, now);
}

/**
 * Create a minimal but valid v7 schema.
 * This is the starting point for all legacy migration tests.
 */
function createV7Schema(db: Database.Database): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(db);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO schema_version VALUES (1, 7, datetime('now'), datetime('now'));
  `);

  db.exec(`
    CREATE TABLE provenance (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING')),
      created_at TEXT NOT NULL, processed_at TEXT NOT NULL,
      source_file_created_at TEXT, source_file_modified_at TEXT,
      source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING')),
      source_path TEXT, source_id TEXT,
      root_document_id TEXT NOT NULL, location TEXT,
      content_hash TEXT NOT NULL, input_hash TEXT, file_hash TEXT,
      processor TEXT NOT NULL, processor_version TEXT NOT NULL,
      processing_params TEXT NOT NULL, processing_duration_ms INTEGER,
      processing_quality_score REAL,
      parent_id TEXT, parent_ids TEXT NOT NULL,
      chain_depth INTEGER NOT NULL, chain_path TEXT,
      FOREIGN KEY (source_id) REFERENCES provenance(id),
      FOREIGN KEY (parent_id) REFERENCES provenance(id)
    );
  `);

  db.exec(`
    CREATE TABLE database_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      database_name TEXT NOT NULL, database_version TEXT NOT NULL,
      created_at TEXT NOT NULL, last_modified_at TEXT NOT NULL,
      total_documents INTEGER NOT NULL DEFAULT 0,
      total_ocr_results INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      total_embeddings INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO database_metadata VALUES (1, 'test', '1.0.0', datetime('now'), datetime('now'), 0, 0, 0, 0);
  `);

  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL, file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL, file_size INTEGER NOT NULL, file_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','failed')),
      page_count INTEGER, provenance_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, modified_at TEXT, ocr_completed_at TEXT, error_message TEXT,
      FOREIGN KEY (provenance_id) REFERENCES provenance(id)
    );
  `);

  db.exec(`
    CREATE TABLE ocr_results (
      id TEXT PRIMARY KEY, provenance_id TEXT NOT NULL UNIQUE,
      document_id TEXT NOT NULL, extracted_text TEXT NOT NULL,
      text_length INTEGER NOT NULL, datalab_request_id TEXT NOT NULL,
      datalab_mode TEXT NOT NULL CHECK (datalab_mode IN ('fast', 'balanced', 'accurate')),
      parse_quality_score REAL, page_count INTEGER NOT NULL,
      cost_cents REAL, content_hash TEXT NOT NULL,
      processing_started_at TEXT NOT NULL, processing_completed_at TEXT NOT NULL,
      processing_duration_ms INTEGER NOT NULL,
      FOREIGN KEY (provenance_id) REFERENCES provenance(id),
      FOREIGN KEY (document_id) REFERENCES documents(id)
    );
  `);

  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ocr_result_id TEXT NOT NULL,
      text TEXT NOT NULL, text_hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, character_start INTEGER NOT NULL,
      character_end INTEGER NOT NULL, page_number INTEGER, page_range TEXT,
      overlap_previous INTEGER NOT NULL, overlap_next INTEGER NOT NULL,
      provenance_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
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
      vlm_status TEXT NOT NULL DEFAULT 'pending' CHECK (vlm_status IN ('pending', 'processing', 'complete', 'failed')),
      vlm_description TEXT, vlm_structured_data TEXT, vlm_embedding_id TEXT,
      vlm_model TEXT, vlm_confidence REAL, vlm_processed_at TEXT, vlm_tokens_used INTEGER,
      context_text TEXT, provenance_id TEXT, created_at TEXT NOT NULL,
      error_message TEXT, block_type TEXT, is_header_footer INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id) ON DELETE CASCADE,
      FOREIGN KEY (provenance_id) REFERENCES provenance(id)
    );
  `);

  db.exec(`
    CREATE TABLE embeddings (
      id TEXT PRIMARY KEY, chunk_id TEXT, image_id TEXT,
      document_id TEXT NOT NULL, original_text TEXT NOT NULL,
      original_text_length INTEGER NOT NULL,
      source_file_path TEXT NOT NULL, source_file_name TEXT NOT NULL,
      source_file_hash TEXT NOT NULL, page_number INTEGER, page_range TEXT,
      character_start INTEGER NOT NULL, character_end INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL, total_chunks INTEGER NOT NULL,
      model_name TEXT NOT NULL, model_version TEXT NOT NULL,
      task_type TEXT NOT NULL CHECK (task_type IN ('search_document', 'search_query')),
      inference_mode TEXT NOT NULL CHECK (inference_mode = 'local'),
      gpu_device TEXT, provenance_id TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      generation_duration_ms INTEGER,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id),
      FOREIGN KEY (image_id) REFERENCES images(id),
      FOREIGN KEY (document_id) REFERENCES documents(id),
      FOREIGN KEY (provenance_id) REFERENCES provenance(id),
      CHECK (chunk_id IS NOT NULL OR image_id IS NOT NULL)
    );
  `);

  // FTS tables + triggers
  db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
  db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 7, content_hash TEXT);`);
  db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 7, NULL);`);
  db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 7, NULL);`);
  db.exec(`CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ai AFTER INSERT ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ad AFTER DELETE ON embeddings WHEN old.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_au AFTER UPDATE OF original_text ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);

  // v7 indexes
  const v7Indexes = [
    'CREATE INDEX idx_documents_file_path ON documents(file_path)',
    'CREATE INDEX idx_documents_file_hash ON documents(file_hash)',
    'CREATE INDEX idx_documents_status ON documents(status)',
    'CREATE INDEX idx_ocr_results_document_id ON ocr_results(document_id)',
    'CREATE INDEX idx_chunks_document_id ON chunks(document_id)',
    'CREATE INDEX idx_chunks_ocr_result_id ON chunks(ocr_result_id)',
    'CREATE INDEX idx_chunks_embedding_status ON chunks(embedding_status)',
    'CREATE INDEX idx_embeddings_chunk_id ON embeddings(chunk_id)',
    'CREATE INDEX idx_embeddings_image_id ON embeddings(image_id)',
    'CREATE INDEX idx_embeddings_document_id ON embeddings(document_id)',
    'CREATE INDEX idx_embeddings_source_file ON embeddings(source_file_path)',
    'CREATE INDEX idx_embeddings_page ON embeddings(page_number)',
    'CREATE INDEX idx_images_document_id ON images(document_id)',
    'CREATE INDEX idx_images_ocr_result_id ON images(ocr_result_id)',
    'CREATE INDEX idx_images_page ON images(document_id, page_number)',
    'CREATE INDEX idx_images_vlm_status ON images(vlm_status)',
    'CREATE INDEX idx_images_content_hash ON images(content_hash)',
    "CREATE INDEX idx_images_pending ON images(vlm_status) WHERE vlm_status = 'pending'",
    'CREATE INDEX idx_images_provenance_id ON images(provenance_id)',
    'CREATE INDEX idx_provenance_source_id ON provenance(source_id)',
    'CREATE INDEX idx_provenance_type ON provenance(type)',
    'CREATE INDEX idx_provenance_root_document_id ON provenance(root_document_id)',
    'CREATE INDEX idx_provenance_parent_id ON provenance(parent_id)',
  ];
  for (const idx of v7Indexes) db.exec(idx);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL CHAIN VERIFICATION: v7 → latest
// ═══════════════════════════════════════════════════════════════════════════════

describe('Legacy Migrations v7→v14 Chain', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTestDir('ocr-legacy-mig');
  });

  afterAll(() => {
    cleanupTestDir(tmpDir);
  });

  describe('Full chain end-state verification', () => {
    let db: Database.Database;

    beforeAll(() => {
      const result = createTestDb(tmpDir);
      db = result.db;
      createV7Schema(db);
      migrateToLatest(db);
    });

    afterAll(() => {
      closeDb(db);
    });

    // v8 features
    it.skipIf(!sqliteVecAvailable)('creates extractions table with correct columns', () => {
      const cols = getTableColumns(db, 'extractions');
      expect(cols).toContain('id');
      expect(cols).toContain('document_id');
      expect(cols).toContain('schema_json');
      expect(cols).toContain('extraction_json');
      expect(cols).toContain('content_hash');
      expect(cols).toContain('provenance_id');
    });

    it.skipIf(!sqliteVecAvailable)('creates form_fills table with correct columns', () => {
      const cols = getTableColumns(db, 'form_fills');
      expect(cols).toContain('id');
      expect(cols).toContain('source_file_path');
      expect(cols).toContain('field_data_json');
      expect(cols).toContain('status');
      expect(cols).toContain('provenance_id');
    });

    it.skipIf(!sqliteVecAvailable)('adds doc metadata columns to documents (v8)', () => {
      const cols = getTableColumns(db, 'documents');
      expect(cols).toContain('doc_title');
      expect(cols).toContain('doc_author');
      expect(cols).toContain('doc_subject');
    });

    // v9→v10 features
    it.skipIf(!sqliteVecAvailable)('adds extraction_id to embeddings (v10)', () => {
      const cols = getTableColumns(db, 'embeddings');
      expect(cols).toContain('extraction_id');
    });

    // v10→v11 features
    it.skipIf(!sqliteVecAvailable)('adds json_blocks and extras_json to ocr_results (v11)', () => {
      const cols = getTableColumns(db, 'ocr_results');
      expect(cols).toContain('json_blocks');
      expect(cols).toContain('extras_json');
    });

    // v11→v12 features
    it.skipIf(!sqliteVecAvailable)('creates uploaded_files table (v12)', () => {
      const tables = getTableNames(db);
      expect(tables).toContain('uploaded_files');
      const cols = getTableColumns(db, 'uploaded_files');
      expect(cols).toContain('id');
      expect(cols).toContain('file_hash');
      expect(cols).toContain('upload_status');
      expect(cols).toContain('datalab_file_id');
    });

    it.skipIf(!sqliteVecAvailable)('adds datalab_file_id to documents (v12)', () => {
      const cols = getTableColumns(db, 'documents');
      expect(cols).toContain('datalab_file_id');
    });

    // v12→v13 features
    it.skipIf(!sqliteVecAvailable)('creates entities and entity_mentions tables (v13)', () => {
      const tables = getTableNames(db);
      expect(tables).toContain('entities');
      expect(tables).toContain('entity_mentions');
      const entityCols = getTableColumns(db, 'entities');
      expect(entityCols).toContain('entity_type');
      expect(entityCols).toContain('normalized_text');
      expect(entityCols).toContain('document_id');
      const mentionCols = getTableColumns(db, 'entity_mentions');
      expect(mentionCols).toContain('entity_id');
      expect(mentionCols).toContain('chunk_id');
    });

    // v13→v14 features
    it.skipIf(!sqliteVecAvailable)('creates comparisons table with correct columns (v14)', () => {
      const tables = getTableNames(db);
      expect(tables).toContain('comparisons');
      const cols = getTableColumns(db, 'comparisons');
      expect(cols).toContain('document_id_1');
      expect(cols).toContain('document_id_2');
      expect(cols).toContain('similarity_ratio');
      expect(cols).toContain('text_diff_json');
      expect(cols).toContain('structural_diff_json');
      expect(cols.length).toBe(12);
    });

    // All indexes from v8-v14
    it.skipIf(!sqliteVecAvailable)('creates all expected indexes from v8-v14', () => {
      const indexes = getIndexNames(db);
      // v8 indexes
      expect(indexes).toContain('idx_extractions_document_id');
      expect(indexes).toContain('idx_form_fills_status');
      expect(indexes).toContain('idx_documents_doc_title');
      // v10 index
      expect(indexes).toContain('idx_embeddings_extraction_id');
      // v12 indexes
      expect(indexes).toContain('idx_uploaded_files_file_hash');
      expect(indexes).toContain('idx_uploaded_files_status');
      expect(indexes).toContain('idx_uploaded_files_datalab_file_id');
      // v13 indexes
      expect(indexes).toContain('idx_entities_document_id');
      expect(indexes).toContain('idx_entities_entity_type');
      expect(indexes).toContain('idx_entities_normalized_text');
      expect(indexes).toContain('idx_entity_mentions_entity_id');
      // v14 indexes
      expect(indexes).toContain('idx_comparisons_doc1');
      expect(indexes).toContain('idx_comparisons_doc2');
      expect(indexes).toContain('idx_comparisons_created');
    });

    it.skipIf(!sqliteVecAvailable)('passes FK integrity check', () => {
      const violations = db.pragma('foreign_key_check') as unknown[];
      expect(violations.length).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('schema version is latest', () => {
      const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      expect(version).toBeGreaterThanOrEqual(14);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTRAINT ENFORCEMENT AFTER MIGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Constraint enforcement after migration', () => {
    let db: Database.Database;

    beforeEach(() => {
      const result = createTestDb(tmpDir);
      db = result.db;
      createV7Schema(db);
      migrateToLatest(db);
    });

    afterEach(() => {
      closeDb(db);
    });

    it.skipIf(!sqliteVecAvailable)('accepts new provenance types (EXTRACTION, FORM_FILL, ENTITY_EXTRACTION, COMPARISON)', () => {
      const now = new Date().toISOString();
      const newTypes = ['EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON'];
      for (const type of newTypes) {
        expect(() => {
          db.prepare(`
            INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
              content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`prov-${type}`, type, now, now, 'FILE', `prov-${type}`, `sha256:${type}`, 'test', '1.0', '{}', '[]', 0);
        }).not.toThrow();
      }
    });

    it.skipIf(!sqliteVecAvailable)('rejects invalid provenance type', () => {
      const now = new Date().toISOString();
      expect(() => {
        db.prepare(`
          INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('prov-bad', 'INVALID_TYPE', now, now, 'FILE', 'prov-bad', 'sha256:bad', 'test', '1.0', '{}', '[]', 0);
      }).toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('form_fills status CHECK works', () => {
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-ff', 'FORM_FILL', 'prov-ff');
      expect(() => {
        db.prepare(`INSERT INTO form_fills (id, source_file_path, source_file_hash, field_data_json, status, provenance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ff-1', '/f.pdf', 'sha256:f', '{}', 'complete', 'prov-ff', now);
      }).not.toThrow();
      expect(() => {
        db.prepare(`INSERT INTO form_fills (id, source_file_path, source_file_hash, field_data_json, status, provenance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ff-bad', '/f.pdf', 'sha256:f', '{}', 'bogus', 'prov-ff', now);
      }).toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('entity_type CHECK works', () => {
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-e-doc', 'DOCUMENT', 'prov-e-doc');
      insertTestDocument(db, 'doc-entity', 'prov-e-doc');
      expect(() => {
        db.prepare(`INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('e-1', 'doc-entity', 'person', 'John', 'john', 0.9, 'prov-e-doc', now);
      }).not.toThrow();
      expect(() => {
        db.prepare(`INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('e-bad', 'doc-entity', 'invalid_type', 'X', 'x', 0.9, 'prov-e-doc', now);
      }).toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('embeddings CHECK accepts extraction_id-only (v10)', () => {
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-ext-doc', 'DOCUMENT', 'prov-ext-doc');
      insertTestDocument(db, 'doc-ext', 'prov-ext-doc');
      insertTestProvenance(db, 'prov-ocr-ext', 'OCR_RESULT', 'prov-ext-doc');
      db.prepare(`INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
        datalab_request_id, datalab_mode, page_count, content_hash, processing_started_at, processing_completed_at, processing_duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'ocr-ext', 'prov-ocr-ext', 'doc-ext', 'text', 4, 'req-1', 'fast', 1, 'sha256:ocr-ext', now, now, 100);
      insertTestProvenance(db, 'prov-extraction', 'EXTRACTION', 'prov-ext-doc');
      db.prepare(`INSERT INTO extractions (id, document_id, ocr_result_id, schema_json, extraction_json, content_hash, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ext-1', 'doc-ext', 'ocr-ext', '{}', '{}', 'sha256:ext1', 'prov-extraction', now);
      insertTestProvenance(db, 'prov-emb', 'EMBEDDING', 'prov-ext-doc');
      expect(() => {
        db.prepare(`INSERT INTO embeddings (id, extraction_id, document_id, original_text, original_text_length,
          source_file_path, source_file_name, source_file_hash, character_start, character_end,
          chunk_index, total_chunks, model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('emb-ext', 'ext-1', 'doc-ext', 'text', 4, '/f.pdf', 'f.pdf', 'sha256:f',
          0, 4, 0, 1, 'nomic', '1.5', 'search_document', 'local', 'prov-emb', 'sha256:emb', now);
      }).not.toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('upload_status CHECK works (v12)', () => {
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-uf', 'DOCUMENT', 'prov-uf');
      expect(() => {
        db.prepare(`INSERT INTO uploaded_files (id, local_path, file_name, file_hash, file_size, content_type, upload_status, provenance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('uf-1', '/tmp/f.pdf', 'f.pdf', 'sha256:f', 1024, 'application/pdf', 'pending', 'prov-uf', now);
      }).not.toThrow();
      expect(() => {
        db.prepare(`INSERT INTO uploaded_files (id, local_path, file_name, file_hash, file_size, content_type, upload_status, provenance_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('uf-bad', '/tmp/f.pdf', 'f.pdf', 'sha256:f', 1024, 'application/pdf', 'bad_status', 'prov-uf', now);
      }).toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA OPERATIONS AFTER MIGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Data operations after migration', () => {
    let db: Database.Database;

    beforeEach(() => {
      const result = createTestDb(tmpDir);
      db = result.db;
      createV7Schema(db);
      migrateToLatest(db);
    });

    afterEach(() => {
      closeDb(db);
    });

    it.skipIf(!sqliteVecAvailable)('can insert and query entities and mentions', () => {
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-ent-doc', 'DOCUMENT', 'prov-ent-doc');
      insertTestDocument(db, 'doc-ent', 'prov-ent-doc');
      insertTestProvenance(db, 'prov-ent-ext', 'ENTITY_EXTRACTION', 'prov-ent-doc');

      db.prepare(`INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ent-1', 'doc-ent', 'person', 'John Smith', 'john smith', 0.95, 'prov-ent-ext', now);

      const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get('ent-1') as Record<string, unknown>;
      expect(entity.entity_type).toBe('person');
      expect(entity.normalized_text).toBe('john smith');
    });

    it.skipIf(!sqliteVecAvailable)('can insert and query comparisons', () => {
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-cmp-d1', 'DOCUMENT', 'prov-cmp-d1');
      insertTestProvenance(db, 'prov-cmp-d2', 'DOCUMENT', 'prov-cmp-d2');
      insertTestDocument(db, 'doc-cmp-1', 'prov-cmp-d1');
      insertTestDocument(db, 'doc-cmp-2', 'prov-cmp-d2');
      insertTestProvenance(db, 'prov-cmp', 'COMPARISON', 'prov-cmp-d1');

      db.prepare(`INSERT INTO comparisons (id, document_id_1, document_id_2, similarity_ratio,
        text_diff_json, structural_diff_json, entity_diff_json, summary, content_hash, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'cmp-1', 'doc-cmp-1', 'doc-cmp-2', 0.85, '{}', '{}', '{}', 'Similar docs', 'sha256:cmp', 'prov-cmp', now);

      const cmp = db.prepare('SELECT * FROM comparisons WHERE id = ?').get('cmp-1') as Record<string, unknown>;
      expect(cmp.similarity_ratio).toBe(0.85);
      expect(cmp.document_id_1).toBe('doc-cmp-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA PRESERVATION ACROSS MIGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Data preservation', () => {
    let db: Database.Database;

    beforeEach(() => {
      const result = createTestDb(tmpDir);
      db = result.db;
    });

    afterEach(() => {
      closeDb(db);
    });

    it.skipIf(!sqliteVecAvailable)('preserves provenance and documents across v7→latest migration', () => {
      createV7Schema(db);
      const now = new Date().toISOString();

      // Insert data at v7
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-surv', 'DOCUMENT', now, now, 'FILE', 'prov-surv', 'sha256:surv', 'test', '1.0', '{}', '[]', 0);

      db.prepare(`
        INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type,
          status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('doc-surv', '/test/survive.pdf', 'survive.pdf', 'sha256:survfile', 2048, 'pdf', 'complete', 'prov-surv', now);

      migrateToLatest(db);

      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get('doc-surv') as Record<string, unknown>;
      expect(doc).toBeDefined();
      expect(doc.file_name).toBe('survive.pdf');
      expect(doc.doc_title).toBeNull(); // New v8 column defaults to NULL

      const prov = db.prepare('SELECT * FROM provenance WHERE id = ?').get('prov-surv') as Record<string, unknown>;
      expect(prov).toBeDefined();
      expect(prov.type).toBe('DOCUMENT');
    });

    it.skipIf(!sqliteVecAvailable)('existing ocr_results get NULL json_blocks/extras_json after migration (v11)', () => {
      createV7Schema(db);
      const now = new Date().toISOString();

      // Insert full chain at v7
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-ocr-doc', 'DOCUMENT', now, now, 'FILE', 'prov-ocr-doc', 'sha256:doc', 'test', '1.0', '{}', '[]', 0);

      db.prepare(`INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('doc-ocr', '/t.pdf', 't.pdf', 'sha256:t', 100, 'pdf', 'complete', 'prov-ocr-doc', now);

      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-ocr-res', 'OCR_RESULT', now, now, 'OCR', 'prov-ocr-doc', 'sha256:ocr', 'datalab', '1.0', '{}', '["prov-ocr-doc"]', 1);

      db.prepare(`INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
        datalab_request_id, datalab_mode, page_count, content_hash,
        processing_started_at, processing_completed_at, processing_duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'ocr-surv', 'prov-ocr-res', 'doc-ocr', 'text', 4, 'req-1', 'fast', 1, 'sha256:text', now, now, 100);

      migrateToLatest(db);

      const ocr = db.prepare('SELECT * FROM ocr_results WHERE id = ?').get('ocr-surv') as Record<string, unknown>;
      expect(ocr.json_blocks).toBeNull();
      expect(ocr.extras_json).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRE-MIGRATION CONSTRAINT CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Pre-migration constraint enforcement', () => {
    let db: Database.Database;

    beforeEach(() => {
      const result = createTestDb(tmpDir);
      db = result.db;
      createV7Schema(db);
    });

    afterEach(() => {
      closeDb(db);
    });

    it.skipIf(!sqliteVecAvailable)('v7 rejects EXTRACTION provenance type', () => {
      const now = new Date().toISOString();
      expect(() => {
        db.prepare(`
          INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
            content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('prov-ext', 'EXTRACTION', now, now, 'FILE', 'prov-ext', 'sha256:e', 'test', '1.0', '{}', '[]', 0);
      }).toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('v7 embeddings CHECK rejects extraction_id-only (no chunk_id or image_id)', () => {
      // At v7, the CHECK is: chunk_id IS NOT NULL OR image_id IS NOT NULL
      // extraction_id doesn't exist yet, so any insert without chunk_id/image_id fails
      const now = new Date().toISOString();
      insertTestProvenance(db, 'prov-emb-doc', 'DOCUMENT', 'prov-emb-doc');
      insertTestDocument(db, 'doc-emb-pre', 'prov-emb-doc');
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('prov-emb-pre', 'EMBEDDING', now, now, 'EMBEDDING', 'prov-emb-doc', 'sha256:emb', 'test', '1.0', '{}', '[]', 3);

      expect(() => {
        db.prepare(`INSERT INTO embeddings (id, document_id, original_text, original_text_length,
          source_file_path, source_file_name, source_file_hash, character_start, character_end,
          chunk_index, total_chunks, model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('emb-pre', 'doc-emb-pre', 't', 1, '/f.pdf', 'f.pdf', 'sha256:f',
          0, 1, 0, 1, 'nomic', '1.5', 'search_document', 'local', 'prov-emb-pre', 'sha256:emb', now);
      }).toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // IDEMPOTENCY
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Idempotency', () => {
    it.skipIf(!sqliteVecAvailable)('running migration twice from v7 does not error', () => {
      const result = createTestDb(tmpDir);
      const db = result.db;
      createV7Schema(db);
      migrateToLatest(db);
      expect(() => migrateToLatest(db)).not.toThrow();
      const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      expect(version).toBeGreaterThanOrEqual(14);
      closeDb(db);
    });
  });
});

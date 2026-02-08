/**
 * Migration v10 to v11 Tests
 *
 * Tests the v10->v11 migration which adds:
 * - json_blocks TEXT column to ocr_results
 * - extras_json TEXT column to ocr_results
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
} from './helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Migration v10 to v11', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v11');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v10 schema.
   * This is v9 + v10 additions (extraction_id on embeddings).
   * No json_blocks or extras_json on ocr_results.
   */
  function createV10Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 10, datetime('now'), datetime('now'));
    `);

    // Provenance (v8+ CHECK constraints)
    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL')),
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

    // Documents
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
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    // OCR results (v10: NO json_blocks, NO extras_json)
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

    // Embeddings (v10: includes extraction_id)
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

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 10, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 10, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 10, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 10, NULL);`);
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

    // All 27 indexes from v10
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
   * Helper: Insert prerequisite provenance + document + ocr_result
   */
  function insertOCRChain(): { docProvId: string; docId: string; ocrProvId: string; ocrId: string } {
    const now = new Date().toISOString();

    const docProvId = 'prov-doc-v11';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, 'sha256:doc', 'test', '1.0', '{}', '[]', 0)
    `).run(docProvId, now, now, docProvId);

    const docId = 'doc-v11';
    db.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES (?, '/test/v11.pdf', 'v11.pdf', 'sha256:v11file', 1024, 'pdf', 'complete', ?, ?)
    `).run(docId, docProvId, now);

    const ocrProvId = 'prov-ocr-v11';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', ?, ?, 'sha256:ocr', 'datalab', '1.0', '{}', ?, ?, 1)
    `).run(ocrProvId, now, now, docProvId, docProvId, docProvId, JSON.stringify([docProvId]));

    const ocrId = 'ocr-v11';
    db.prepare(`
      INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
        datalab_request_id, datalab_mode, parse_quality_score, page_count, cost_cents, content_hash,
        processing_started_at, processing_completed_at, processing_duration_ms)
      VALUES (?, ?, ?, 'Test text for v11', 17, 'req-v11', 'balanced', 4.2, 1, 3.5, 'sha256:text11', ?, ?, 100)
    `).run(ocrId, ocrProvId, docId, now, now);

    return { docProvId, docId, ocrProvId, ocrId };
  }

  it.skipIf(!sqliteVecAvailable)('adds json_blocks column to ocr_results', () => {
    createV10Schema();
    migrateToLatest(db);
    const info = db.prepare('PRAGMA table_info(ocr_results)').all() as { name: string }[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('json_blocks');
  });

  it.skipIf(!sqliteVecAvailable)('adds extras_json column to ocr_results', () => {
    createV10Schema();
    migrateToLatest(db);
    const info = db.prepare('PRAGMA table_info(ocr_results)').all() as { name: string }[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('extras_json');
  });

  it.skipIf(!sqliteVecAvailable)('existing rows have NULL for new columns', () => {
    createV10Schema();
    insertOCRChain();

    migrateToLatest(db);

    const row = db.prepare('SELECT json_blocks, extras_json FROM ocr_results WHERE id = ?').get('ocr-v11') as {
      json_blocks: string | null;
      extras_json: string | null;
    };
    expect(row).toBeDefined();
    expect(row.json_blocks).toBeNull();
    expect(row.extras_json).toBeNull();
  });

  it.skipIf(!sqliteVecAvailable)('new inserts work with non-null values', () => {
    createV10Schema();
    const { docId, docProvId } = insertOCRChain();

    migrateToLatest(db);

    const now = new Date().toISOString();
    const ocrProvId2 = 'prov-ocr-v11-2';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', ?, ?, 'sha256:ocr2', 'datalab', '1.0', '{}', ?, ?, 1)
    `).run(ocrProvId2, now, now, docProvId, docProvId, docProvId, JSON.stringify([docProvId]));

    const blocksJson = JSON.stringify({ children: [{ type: 'Text', text: 'hello' }] });
    const extrasJson = JSON.stringify({ metadata: { title: 'Test' }, cost_breakdown: { total_cost_cents: 5 } });

    expect(() => {
      db.prepare(`
        INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
          datalab_request_id, datalab_mode, page_count, content_hash,
          processing_started_at, processing_completed_at, processing_duration_ms,
          json_blocks, extras_json)
        VALUES ('ocr-v11-2', ?, ?, 'More text', 9, 'req-v11-2', 'fast', 1, 'sha256:text2', ?, ?, 50, ?, ?)
      `).run(ocrProvId2, docId, now, now, blocksJson, extrasJson);
    }).not.toThrow();

    const row = db.prepare('SELECT json_blocks, extras_json FROM ocr_results WHERE id = ?').get('ocr-v11-2') as {
      json_blocks: string;
      extras_json: string;
    };
    expect(JSON.parse(row.json_blocks)).toEqual({ children: [{ type: 'Text', text: 'hello' }] });
    expect(JSON.parse(row.extras_json)).toEqual({ metadata: { title: 'Test' }, cost_breakdown: { total_cost_cents: 5 } });
  });

  it.skipIf(!sqliteVecAvailable)('updates schema version to 11', () => {
    createV10Schema();
    migrateToLatest(db);
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(11);
  });

  it.skipIf(!sqliteVecAvailable)('passes FK integrity check', () => {
    createV10Schema();
    migrateToLatest(db);
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running twice does not error', () => {
    createV10Schema();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(11);
  });
});

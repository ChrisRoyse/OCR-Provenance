/**
 * Migration v9 to v10 Tests
 *
 * Tests the v9->v10 migration which adds:
 * - extraction_id column to embeddings table
 * - Updated CHECK constraint: (chunk_id IS NOT NULL OR image_id IS NOT NULL OR extraction_id IS NOT NULL)
 * - FK: extraction_id REFERENCES extractions(id)
 * - idx_embeddings_extraction_id index
 * - VLM FTS triggers recreated (embeddings table is dropped/recreated)
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

describe('Migration v9 to v10', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v10');
    const result = createTestDb(tmpDir);
    db = result.db;
    dbPath = result.dbPath;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v9 schema.
   * This is the v7 schema + v8 additions (extractions, form_fills, doc metadata, provenance CHECK)
   *   + v9 additions (extractions_fts, cost_cents REAL)
   * BUT with the OLD embeddings CHECK (no extraction_id).
   */
  function createV9Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 9, datetime('now'), datetime('now'));
    `);

    // Provenance (v8+ CHECK constraints: includes EXTRACTION, FORM_FILL)
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

    // Documents (v8+: includes doc_title, doc_author, doc_subject)
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

    // Embeddings (v9: OLD CHECK -- NO extraction_id column)
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

    // Extractions (v8+)
    db.exec(`
      CREATE TABLE extractions (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ocr_result_id TEXT NOT NULL REFERENCES ocr_results(id) ON DELETE CASCADE,
        schema_json TEXT NOT NULL,
        extraction_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Form fills (v9: cost_cents REAL)
    db.exec(`
      CREATE TABLE form_fills (
        id TEXT PRIMARY KEY NOT NULL,
        source_file_path TEXT NOT NULL,
        source_file_hash TEXT NOT NULL,
        field_data_json TEXT NOT NULL,
        context TEXT,
        confidence_threshold REAL NOT NULL DEFAULT 0.5,
        output_file_path TEXT,
        output_base64 TEXT,
        fields_filled TEXT NOT NULL DEFAULT '[]',
        fields_not_found TEXT NOT NULL DEFAULT '[]',
        page_count INTEGER,
        cost_cents REAL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'complete', 'failed')),
        error_message TEXT,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 9, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 9, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 9, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 9, NULL);`);
    db.exec(`CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE extractions_fts USING fts5(extraction_json, content='extractions', content_rowid='rowid', tokenize='porter unicode61');`);

    // vec_embeddings
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`);

    // FTS triggers (chunks)
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`);

    // VLM FTS triggers
    db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ai AFTER INSERT ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ad AFTER DELETE ON embeddings WHEN old.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_au AFTER UPDATE OF original_text ON embeddings WHEN new.image_id IS NOT NULL BEGIN INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text); INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text); END;`);

    // Extractions FTS triggers
    db.exec(`CREATE TRIGGER IF NOT EXISTS extractions_fts_ai AFTER INSERT ON extractions BEGIN INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS extractions_fts_ad AFTER DELETE ON extractions BEGIN INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS extractions_fts_au AFTER UPDATE OF extraction_json ON extractions BEGIN INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json); INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json); END;`);

    // v9 indexes (all 26 from v7-v9)
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
    db.exec('CREATE INDEX idx_extractions_document_id ON extractions(document_id);');
    db.exec('CREATE INDEX idx_form_fills_status ON form_fills(status);');
    db.exec('CREATE INDEX idx_documents_doc_title ON documents(doc_title);');
  }

  /**
   * Helper: Insert prerequisite provenance + document + ocr_result + extraction chain
   * Returns { docId, ocrId, extractionId, extractionProvId }
   */
  function insertExtractionChain(): {
    docProvId: string;
    docId: string;
    ocrProvId: string;
    ocrId: string;
    extractionProvId: string;
    extractionId: string;
  } {
    const now = new Date().toISOString();

    // Document provenance
    const docProvId = 'prov-doc-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES (?, 'DOCUMENT', ?, ?, 'FILE', ?, 'sha256:doc', 'test', '1.0', '{}', '[]', 0)
    `).run(docProvId, now, now, docProvId);

    // Document
    const docId = 'doc-v10';
    db.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES (?, '/test/v10.pdf', 'v10.pdf', 'sha256:v10file', 1024, 'pdf', 'complete', ?, ?)
    `).run(docId, docProvId, now);

    // OCR provenance
    const ocrProvId = 'prov-ocr-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'OCR_RESULT', ?, ?, 'OCR', ?, ?, 'sha256:ocr', 'datalab', '1.0', '{}', ?, ?, 1)
    `).run(ocrProvId, now, now, docProvId, docProvId, docProvId, JSON.stringify([docProvId]));

    // OCR result
    const ocrId = 'ocr-v10';
    db.prepare(`
      INSERT INTO ocr_results (id, provenance_id, document_id, extracted_text, text_length,
        datalab_request_id, datalab_mode, page_count, content_hash,
        processing_started_at, processing_completed_at, processing_duration_ms)
      VALUES (?, ?, ?, 'Test text', 9, 'req-v10', 'balanced', 1, 'sha256:text', ?, ?, 100)
    `).run(ocrId, ocrProvId, docId, now, now);

    // Extraction provenance
    const extractionProvId = 'prov-ext-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'EXTRACTION', ?, ?, 'EXTRACTION', ?, ?, 'sha256:ext', 'datalab', '1.0', '{}', ?, ?, 2)
    `).run(extractionProvId, now, now, ocrProvId, docProvId, ocrProvId, JSON.stringify([docProvId, ocrProvId]));

    // Extraction
    const extractionId = 'ext-v10';
    db.prepare(`
      INSERT INTO extractions (id, document_id, ocr_result_id, schema_json, extraction_json, content_hash, provenance_id, created_at)
      VALUES (?, ?, ?, '{"type":"object"}', '{"key":"value"}', 'sha256:extdata', ?, ?)
    `).run(extractionId, docId, ocrId, extractionProvId, now);

    return { docProvId, docId, ocrProvId, ocrId, extractionProvId, extractionId };
  }

  it.skipIf(!sqliteVecAvailable)('adds extraction_id column to embeddings table', () => {
    createV9Schema();
    migrateToLatest(db);
    const info = db.prepare('PRAGMA table_info(embeddings)').all() as { name: string }[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('extraction_id');
  });

  it.skipIf(!sqliteVecAvailable)('updates CHECK constraint to allow extraction_id-only rows', () => {
    createV9Schema();
    const { extractionId, docId, docProvId } = insertExtractionChain();

    migrateToLatest(db);

    // Create embedding provenance
    const now = new Date().toISOString();
    const embProvId = 'prov-emb-ext-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'EMBEDDING', ?, ?, 'EMBEDDING', ?, ?, 'sha256:emb', 'nomic', '1.5', '{}', ?, ?, 3)
    `).run(embProvId, now, now, 'prov-ext-v10', docProvId, 'prov-ext-v10',
      JSON.stringify([docProvId, 'prov-ocr-v10', 'prov-ext-v10']));

    // Insert embedding with ONLY extraction_id (chunk_id=NULL, image_id=NULL)
    expect(() => {
      db.prepare(`
        INSERT INTO embeddings (id, chunk_id, image_id, extraction_id, document_id,
          original_text, original_text_length, source_file_path, source_file_name,
          source_file_hash, page_number, character_start, character_end, chunk_index,
          total_chunks, model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at)
        VALUES ('emb-ext-v10', NULL, NULL, ?, ?,
          'test extraction text', 21, '/test/v10.pdf', 'v10.pdf',
          'sha256:v10file', 1, 0, 21, 0,
          1, 'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local',
          ?, 'sha256:embcontent', ?)
      `).run(extractionId, docId, embProvId, now);
    }).not.toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('rejects all-null embedding rows', () => {
    createV9Schema();
    insertExtractionChain();
    migrateToLatest(db);

    const now = new Date().toISOString();
    const embProvId = 'prov-emb-null-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth)
      VALUES (?, 'EMBEDDING', ?, ?, 'EMBEDDING', ?, 'sha256:null', 'nomic', '1.5', '{}', '[]', 3)
    `).run(embProvId, now, now, 'prov-doc-v10');

    // All three NULL should fail CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO embeddings (id, chunk_id, image_id, extraction_id, document_id,
          original_text, original_text_length, source_file_path, source_file_name,
          source_file_hash, page_number, character_start, character_end, chunk_index,
          total_chunks, model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at)
        VALUES ('emb-null-v10', NULL, NULL, NULL, 'doc-v10',
          'test', 4, '/test/v10.pdf', 'v10.pdf',
          'sha256:v10file', 1, 0, 4, 0,
          1, 'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local',
          ?, 'sha256:nullcontent', ?)
      `).run(embProvId, now);
    }).toThrow(/CHECK/);
  });

  it.skipIf(!sqliteVecAvailable)('creates idx_embeddings_extraction_id index', () => {
    createV9Schema();
    migrateToLatest(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_embeddings_extraction_id');
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing embeddings with extraction_id=NULL', () => {
    createV9Schema();
    const now = new Date().toISOString();

    // Insert prerequisite chain for a chunk-based embedding
    const { docId, ocrId, docProvId } = insertExtractionChain();

    // Chunk provenance
    const chunkProvId = 'prov-chunk-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'CHUNK', ?, ?, 'CHUNKING', ?, ?, 'sha256:chunk', 'chunker', '1.0', '{}', ?, ?, 2)
    `).run(chunkProvId, now, now, 'prov-ocr-v10', docProvId, 'prov-ocr-v10',
      JSON.stringify([docProvId, 'prov-ocr-v10']));

    // Chunk
    db.prepare(`
      INSERT INTO chunks (id, document_id, ocr_result_id, text, text_hash, chunk_index,
        character_start, character_end, page_number, overlap_previous, overlap_next,
        provenance_id, created_at, embedding_status)
      VALUES ('chunk-v10', ?, ?, 'Test chunk', 'sha256:chunktext', 0, 0, 10, 1, 0, 0, ?, ?, 'complete')
    `).run(docId, ocrId, chunkProvId, now);

    // Embedding provenance
    const embProvId = 'prov-emb-chunk-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, source_id,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_id, parent_ids, chain_depth)
      VALUES (?, 'EMBEDDING', ?, ?, 'EMBEDDING', ?, ?, 'sha256:emb', 'nomic', '1.5', '{}', ?, ?, 3)
    `).run(embProvId, now, now, chunkProvId, docProvId, chunkProvId,
      JSON.stringify([docProvId, 'prov-ocr-v10', chunkProvId]));

    // Chunk-based embedding (pre-migration: no extraction_id column)
    db.prepare(`
      INSERT INTO embeddings (id, chunk_id, image_id, document_id,
        original_text, original_text_length, source_file_path, source_file_name,
        source_file_hash, page_number, character_start, character_end, chunk_index,
        total_chunks, model_name, model_version, task_type, inference_mode,
        provenance_id, content_hash, created_at)
      VALUES ('emb-chunk-v10', 'chunk-v10', NULL, ?,
        'Test chunk', 10, '/test/v10.pdf', 'v10.pdf',
        'sha256:v10file', 1, 0, 10, 0,
        1, 'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local',
        ?, 'sha256:embchunk', ?)
    `).run(docId, embProvId, now);

    // Run migration
    migrateToLatest(db);

    // Verify the embedding still exists with extraction_id=NULL
    const row = db.prepare('SELECT * FROM embeddings WHERE id = ?').get('emb-chunk-v10') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.chunk_id).toBe('chunk-v10');
    expect(row.image_id).toBeNull();
    expect(row.extraction_id).toBeNull();
    expect(row.original_text).toBe('Test chunk');
  });

  it.skipIf(!sqliteVecAvailable)('adds extraction_id FK to embeddings', () => {
    createV9Schema();
    insertExtractionChain();
    migrateToLatest(db);

    const now = new Date().toISOString();
    const embProvId = 'prov-emb-fk-v10';
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type,
        root_document_id, content_hash, processor, processor_version, processing_params,
        parent_ids, chain_depth)
      VALUES (?, 'EMBEDDING', ?, ?, 'EMBEDDING', ?, 'sha256:fk', 'nomic', '1.5', '{}', '[]', 3)
    `).run(embProvId, now, now, 'prov-doc-v10');

    // Insert embedding with nonexistent extraction_id should fail FK check
    expect(() => {
      db.prepare(`
        INSERT INTO embeddings (id, chunk_id, image_id, extraction_id, document_id,
          original_text, original_text_length, source_file_path, source_file_name,
          source_file_hash, page_number, character_start, character_end, chunk_index,
          total_chunks, model_name, model_version, task_type, inference_mode,
          provenance_id, content_hash, created_at)
        VALUES ('emb-fk-v10', NULL, NULL, 'nonexistent', 'doc-v10',
          'test', 4, '/test/v10.pdf', 'v10.pdf',
          'sha256:v10file', 1, 0, 4, 0,
          1, 'nomic-embed-text-v1.5', '1.5.0', 'search_document', 'local',
          ?, 'sha256:fkcontent', ?)
      `).run(embProvId, now);
    }).toThrow(/FOREIGN KEY/);
  });

  it.skipIf(!sqliteVecAvailable)('preserves VLM FTS triggers after migration', () => {
    createV9Schema();
    migrateToLatest(db);

    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'"
    ).all() as { name: string }[];
    const triggerNames = triggers.map(t => t.name);

    expect(triggerNames).toContain('vlm_fts_ai');
    expect(triggerNames).toContain('vlm_fts_ad');
    expect(triggerNames).toContain('vlm_fts_au');
  });

  it.skipIf(!sqliteVecAvailable)('updates schema version to 10', () => {
    createV9Schema();
    migrateToLatest(db);
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBeGreaterThanOrEqual(10);
  });

  it.skipIf(!sqliteVecAvailable)('passes FK integrity check', () => {
    createV9Schema();
    migrateToLatest(db);
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running twice does not error', () => {
    createV9Schema();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();
    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBeGreaterThanOrEqual(10);
  });
});

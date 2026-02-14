/**
 * Migration v19 to v20 Tests
 *
 * Tests the v19->v20 migration which adds:
 * - knowledge_edges: valid_from, valid_until (TEXT) for temporal bounds
 * - knowledge_edges: normalized_weight (REAL DEFAULT 0) for weight normalization
 * - knowledge_edges: contradiction_count (INTEGER DEFAULT 0) for contradiction tracking
 * - knowledge_nodes: importance_score (REAL) for node ranking
 * - knowledge_nodes: resolution_type (TEXT) for entity resolution tracking
 * - chunks: ocr_quality_score (REAL)
 * - entity_embeddings: New table (placeholder, corrected by v21)
 * - vec_entity_embeddings: New sqlite-vec virtual table (placeholder, corrected by v21)
 * - 3 new indexes: idx_entity_embeddings_entity_id, idx_entity_embeddings_node_id,
 *   idx_entity_embeddings_content_hash
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
  virtualTableExists,
  insertTestProvenance,
  insertTestDocument,
} from './helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Migration v19 to v20 (Entity Embeddings, Temporal Edges, Node Scoring)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v20');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v19 schema.
   * v19 = v18 + entity_extraction_segments table + 3 indexes.
   * knowledge_nodes does NOT have importance_score or resolution_type at v19
   * (those were added by v18 migration but only when starting from v17;
   * a pure v19 from v18 would already have them from v18's table rebuild).
   *
   * For this test we simulate a v19 database where knowledge_edges does NOT yet
   * have valid_from/valid_until/normalized_weight/contradiction_count columns
   * (because v17 migration already included them in the table rebuild, but
   * v20 migration uses ALTER TABLE ADD COLUMN which is idempotent via column check).
   *
   * We create a v19 where knowledge_nodes DOES have importance_score/resolution_type
   * (from v18 rebuild) and knowledge_edges DOES have the v17 temporal columns
   * (from v17 rebuild) -- this tests the idempotent column-check logic in v20.
   */
  function createV19Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 19, datetime('now'), datetime('now'));
    `);

    // Provenance
    db.exec(`
      CREATE TABLE provenance (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON', 'CLUSTERING', 'KNOWLEDGE_GRAPH')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON', 'CLUSTERING', 'KNOWLEDGE_GRAPH')),
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

    // Chunks (v19: does NOT have ocr_quality_score yet)
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

    // Uploaded files
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

    // Entities (v18+)
    db.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other')),
        raw_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.0,
        metadata TEXT,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Entity mentions
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

    // Comparisons
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

    // Clusters
    db.exec(`
      CREATE TABLE clusters (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        cluster_index INTEGER NOT NULL,
        label TEXT,
        description TEXT,
        classification_tag TEXT,
        document_count INTEGER NOT NULL DEFAULT 0,
        centroid_json TEXT,
        top_terms_json TEXT,
        coherence_score REAL,
        algorithm TEXT NOT NULL,
        algorithm_params_json TEXT,
        silhouette_score REAL,
        content_hash TEXT NOT NULL,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processing_duration_ms INTEGER
      );
    `);

    // Document clusters
    db.exec(`
      CREATE TABLE document_clusters (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id),
        cluster_id TEXT NOT NULL REFERENCES clusters(id),
        run_id TEXT NOT NULL,
        similarity_to_centroid REAL,
        membership_probability REAL,
        is_noise INTEGER NOT NULL DEFAULT 0,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(document_id, run_id)
      );
    `);

    // Knowledge nodes (v18: has importance_score, resolution_type)
    db.exec(`
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other')),
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases TEXT,
        document_count INTEGER NOT NULL DEFAULT 1,
        mention_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        avg_confidence REAL NOT NULL DEFAULT 0.0,
        metadata TEXT,
        provenance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        importance_score REAL,
        resolution_type TEXT
      );
    `);

    // Knowledge edges (v17: already has valid_from/valid_until/normalized_weight/contradiction_count)
    db.exec(`
      CREATE TABLE knowledge_edges (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN (
          'co_mentioned', 'co_located', 'works_at', 'represents',
          'located_in', 'filed_in', 'cites', 'references',
          'party_to', 'related_to', 'precedes', 'occurred_at'
        )),
        weight REAL NOT NULL DEFAULT 1.0,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        document_ids TEXT NOT NULL,
        metadata TEXT,
        provenance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        normalized_weight REAL DEFAULT 0,
        contradiction_count INTEGER DEFAULT 0,
        FOREIGN KEY (source_node_id) REFERENCES knowledge_nodes(id),
        FOREIGN KEY (target_node_id) REFERENCES knowledge_nodes(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      );
    `);

    // Node entity links
    db.exec(`
      CREATE TABLE node_entity_links (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        entity_id TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL,
        similarity_score REAL NOT NULL DEFAULT 1.0,
        resolution_method TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES knowledge_nodes(id),
        FOREIGN KEY (entity_id) REFERENCES entities(id),
        FOREIGN KEY (document_id) REFERENCES documents(id)
      );
    `);

    // Entity extraction segments (v19)
    db.exec(`
      CREATE TABLE entity_extraction_segments (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        ocr_result_id TEXT NOT NULL REFERENCES ocr_results(id),
        segment_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        character_start INTEGER NOT NULL,
        character_end INTEGER NOT NULL,
        text_length INTEGER NOT NULL,
        overlap_previous INTEGER NOT NULL DEFAULT 0,
        overlap_next INTEGER NOT NULL DEFAULT 0,
        extraction_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (extraction_status IN ('pending', 'processing', 'complete', 'failed')),
        entity_count INTEGER DEFAULT 0,
        extracted_at TEXT,
        error_message TEXT,
        provenance_id TEXT REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(document_id, segment_index)
      );
    `);

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 19, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 19, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 19, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 19, NULL);`);
    db.exec(`CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE extractions_fts USING fts5(extraction_json, content='extractions', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`);
    db.exec(`CREATE VIRTUAL TABLE knowledge_nodes_fts USING fts5(canonical_name, content='knowledge_nodes', content_rowid='rowid');`);

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
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_insert AFTER INSERT ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END;`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_delete AFTER DELETE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); END;`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_update AFTER UPDATE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END;`);

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
    db.exec('CREATE INDEX idx_clusters_run_id ON clusters(run_id);');
    db.exec('CREATE INDEX idx_clusters_tag ON clusters(classification_tag);');
    db.exec('CREATE INDEX idx_clusters_created ON clusters(created_at);');
    db.exec('CREATE INDEX idx_doc_clusters_document ON document_clusters(document_id);');
    db.exec('CREATE INDEX idx_doc_clusters_cluster ON document_clusters(cluster_id);');
    db.exec('CREATE INDEX idx_doc_clusters_run ON document_clusters(run_id);');
    db.exec('CREATE INDEX idx_kn_entity_type ON knowledge_nodes(entity_type);');
    db.exec('CREATE INDEX idx_kn_normalized_name ON knowledge_nodes(normalized_name);');
    db.exec('CREATE INDEX idx_kn_document_count ON knowledge_nodes(document_count);');
    db.exec('CREATE INDEX idx_ke_source_node ON knowledge_edges(source_node_id);');
    db.exec('CREATE INDEX idx_ke_target_node ON knowledge_edges(target_node_id);');
    db.exec('CREATE INDEX idx_ke_relationship_type ON knowledge_edges(relationship_type);');
    db.exec('CREATE INDEX idx_nel_node_id ON node_entity_links(node_id);');
    db.exec('CREATE INDEX idx_nel_document_id ON node_entity_links(document_id);');
    db.exec('CREATE INDEX idx_knowledge_nodes_canonical_lower ON knowledge_nodes(canonical_name COLLATE NOCASE);');
    db.exec('CREATE INDEX idx_entity_mentions_chunk_id ON entity_mentions(chunk_id);');
    // v19 segment indexes
    db.exec('CREATE INDEX idx_segments_document ON entity_extraction_segments(document_id);');
    db.exec('CREATE INDEX idx_segments_status ON entity_extraction_segments(extraction_status);');
    db.exec('CREATE INDEX idx_segments_doc_status ON entity_extraction_segments(document_id, extraction_status);');
  }

  it.skipIf(!sqliteVecAvailable)('entity_embeddings table exists after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('entity_embeddings');
  });

  it.skipIf(!sqliteVecAvailable)('entity_embeddings has correct columns (v21 schema)', () => {
    createV19Schema();
    migrateToLatest(db);

    // After v21 migration, entity_embeddings is rebuilt with correct schema
    const columns = getTableColumns(db, 'entity_embeddings');
    expect(columns).toContain('id');
    expect(columns).toContain('node_id');
    expect(columns).toContain('original_text');
    expect(columns).toContain('original_text_length');
    expect(columns).toContain('entity_type');
    expect(columns).toContain('document_count');
    expect(columns).toContain('model_name');
    expect(columns).toContain('content_hash');
    expect(columns).toContain('created_at');
    expect(columns).toContain('provenance_id');
  });

  it.skipIf(!sqliteVecAvailable)('vec_entity_embeddings virtual table exists after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    expect(virtualTableExists(db, 'vec_entity_embeddings')).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('chunks has ocr_quality_score column after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'chunks');
    expect(columns).toContain('ocr_quality_score');
  });

  it.skipIf(!sqliteVecAvailable)('knowledge_edges has temporal columns after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'knowledge_edges');
    expect(columns).toContain('valid_from');
    expect(columns).toContain('valid_until');
    expect(columns).toContain('normalized_weight');
    expect(columns).toContain('contradiction_count');
  });

  it.skipIf(!sqliteVecAvailable)('knowledge_nodes has importance_score and resolution_type', () => {
    createV19Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'knowledge_nodes');
    expect(columns).toContain('importance_score');
    expect(columns).toContain('resolution_type');
  });

  it.skipIf(!sqliteVecAvailable)('entity_embeddings indexes exist after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_entity_embeddings_node_id');
    expect(indexes).toContain('idx_entity_embeddings_content_hash');
  });

  it.skipIf(!sqliteVecAvailable)('schema version is latest after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(22);
  });

  it.skipIf(!sqliteVecAvailable)('FK integrity clean after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('can insert temporal edge data after migration', () => {
    createV19Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    // Create two knowledge nodes
    db.prepare(`
      INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
        document_count, mention_count, avg_confidence, provenance_id, created_at, updated_at)
      VALUES ('kn-src-v20', 'person', 'Alice', 'alice', 1, 1, 0.9, 'prov-placeholder', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
        document_count, mention_count, avg_confidence, provenance_id, created_at, updated_at)
      VALUES ('kn-tgt-v20', 'organization', 'Acme Corp', 'acme corp', 1, 1, 0.85, 'prov-placeholder', ?, ?)
    `).run(now, now);

    // Insert edge with temporal bounds
    insertTestProvenance(db, 'prov-edge-v20', 'KNOWLEDGE_GRAPH', 'prov-edge-v20');

    expect(() => {
      db.prepare(`
        INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relationship_type,
          weight, evidence_count, document_ids, provenance_id, created_at,
          valid_from, valid_until, normalized_weight, contradiction_count)
        VALUES ('ke-v20', 'kn-src-v20', 'kn-tgt-v20', 'works_at', 1.5, 2, '["doc-1"]',
          'prov-edge-v20', ?, '2024-01-01', '2024-12-31', 0.75, 0)
      `).run(now);
    }).not.toThrow();

    const edge = db.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get('ke-v20') as Record<string, unknown>;
    expect(edge.valid_from).toBe('2024-01-01');
    expect(edge.valid_until).toBe('2024-12-31');
    expect(edge.normalized_weight).toBe(0.75);
    expect(edge.contradiction_count).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('existing data survives migration', () => {
    createV19Schema();

    const now = new Date().toISOString();
    insertTestProvenance(db, 'prov-surv20', 'DOCUMENT', 'prov-surv20');
    insertTestDocument(db, 'doc-surv20', 'prov-surv20', 'complete');

    // Insert a knowledge node before migration
    db.prepare(`
      INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
        document_count, mention_count, avg_confidence, provenance_id, created_at, updated_at)
      VALUES ('kn-surv20', 'location', 'New York', 'new york', 3, 7, 0.92, 'prov-placeholder', ?, ?)
    `).run(now, now);

    migrateToLatest(db);

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get('doc-surv20') as Record<string, unknown>;
    expect(doc).toBeDefined();
    expect(doc.status).toBe('complete');

    const node = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get('kn-surv20') as Record<string, unknown>;
    expect(node).toBeDefined();
    expect(node.canonical_name).toBe('New York');
    expect(node.document_count).toBe(3);
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running migration twice does not error', () => {
    createV19Schema();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(22);
  });
});

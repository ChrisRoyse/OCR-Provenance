/**
 * Migration v17 to v18 Tests
 *
 * Tests the v17->v18 migration which:
 * - Recreates entities table with expanded CHECK constraint
 *   (adds 'medication', 'diagnosis', 'medical_device' entity types)
 * - Recreates knowledge_nodes table with expanded CHECK constraint
 *   (same new entity types) and includes importance_score, resolution_type columns
 * - Recreates knowledge_nodes_fts FTS5 table and triggers
 * - Repopulates FTS from existing knowledge_nodes data
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

describe('Migration v17 to v18 (Medical Entity Types)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-mig-v18');
    const result = createTestDb(tmpDir);
    db = result.db;
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  /**
   * Create a minimal but valid v17 schema.
   * v17 = v16 + edge_count on knowledge_nodes, resolution_method on node_entity_links,
   *        expanded CHECK on knowledge_edges, canonical_lower index, chunk_id index on entity_mentions,
   *        knowledge_nodes_fts FTS5 table + triggers.
   *
   * Entities table CHECK constraint at v17 does NOT include medication/diagnosis/medical_device.
   */
  function createV17Schema(): void {
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
      INSERT INTO schema_version VALUES (1, 17, datetime('now'), datetime('now'));
    `);

    // Provenance (v16+: includes KNOWLEDGE_GRAPH)
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

    // Entities (v17 CHECK: does NOT include medication/diagnosis/medical_device)
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

    // Knowledge nodes (v17: has edge_count but NO importance_score, resolution_type)
    // CHECK constraint at v17 does NOT include medication/diagnosis/medical_device
    db.exec(`
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'other')),
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
        updated_at TEXT NOT NULL
      );
    `);

    // Knowledge edges (v17: expanded CHECK, has valid_from/valid_until/normalized_weight/contradiction_count)
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

    // Node entity links (v17: has resolution_method)
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

    // FTS tables
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE TABLE fts_index_metadata (id INTEGER PRIMARY KEY, last_rebuild_at TEXT, chunks_indexed INTEGER NOT NULL DEFAULT 0, tokenizer TEXT NOT NULL DEFAULT 'porter unicode61', schema_version INTEGER NOT NULL DEFAULT 17, content_hash TEXT);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (1, NULL, 0, 'porter unicode61', 17, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (2, NULL, 0, 'porter unicode61', 17, NULL);`);
    db.exec(`INSERT INTO fts_index_metadata VALUES (3, NULL, 0, 'porter unicode61', 17, NULL);`);
    db.exec(`CREATE VIRTUAL TABLE vlm_fts USING fts5(original_text, content='embeddings', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE extractions_fts USING fts5(extraction_json, content='extractions', content_rowid='rowid', tokenize='porter unicode61');`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding_id TEXT PRIMARY KEY, vector FLOAT[768]);`);

    // Knowledge nodes FTS (v17)
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
    // v17 FTS triggers for knowledge_nodes (using _insert/_delete/_update naming)
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_insert AFTER INSERT ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END;`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_delete AFTER DELETE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); END;`);
    db.exec(`CREATE TRIGGER knowledge_nodes_fts_update AFTER UPDATE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END;`);

    // Indexes (v17)
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
    // v17 indexes
    db.exec('CREATE INDEX idx_knowledge_nodes_canonical_lower ON knowledge_nodes(canonical_name COLLATE NOCASE);');
    db.exec('CREATE INDEX idx_entity_mentions_chunk_id ON entity_mentions(chunk_id);');
  }

  it.skipIf(!sqliteVecAvailable)('entities table accepts medication type after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();
    insertTestProvenance(db, 'prov-med-ent', 'ENTITY_EXTRACTION', 'prov-med-ent');
    insertTestDocument(db, 'doc-med', 'prov-med-ent', 'complete');

    expect(() => {
      db.prepare(`
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES ('ent-med-1', 'doc-med', 'medication', 'Aspirin 81mg', 'aspirin 81mg',
          0.95, 'prov-med-ent', ?)
      `).run(now);
    }).not.toThrow();

    const row = db.prepare('SELECT entity_type FROM entities WHERE id = ?').get('ent-med-1') as { entity_type: string };
    expect(row.entity_type).toBe('medication');
  });

  it.skipIf(!sqliteVecAvailable)('entities table accepts diagnosis type after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();
    insertTestProvenance(db, 'prov-diag-ent', 'ENTITY_EXTRACTION', 'prov-diag-ent');
    insertTestDocument(db, 'doc-diag', 'prov-diag-ent', 'complete');

    expect(() => {
      db.prepare(`
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES ('ent-diag-1', 'doc-diag', 'diagnosis', 'Type 2 Diabetes', 'type 2 diabetes',
          0.90, 'prov-diag-ent', ?)
      `).run(now);
    }).not.toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('entities table accepts medical_device type after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();
    insertTestProvenance(db, 'prov-dev-ent', 'ENTITY_EXTRACTION', 'prov-dev-ent');
    insertTestDocument(db, 'doc-dev', 'prov-dev-ent', 'complete');

    expect(() => {
      db.prepare(`
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES ('ent-dev-1', 'doc-dev', 'medical_device', 'Insulin Pump', 'insulin pump',
          0.85, 'prov-dev-ent', ?)
      `).run(now);
    }).not.toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('medication type NOT accepted before migration (v17 CHECK)', () => {
    createV17Schema();

    const now = new Date().toISOString();
    insertTestProvenance(db, 'prov-bad-med', 'ENTITY_EXTRACTION', 'prov-bad-med');
    insertTestDocument(db, 'doc-bad-med', 'prov-bad-med', 'complete');

    expect(() => {
      db.prepare(`
        INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
          confidence, provenance_id, created_at)
        VALUES ('ent-bad-med', 'doc-bad-med', 'medication', 'Aspirin', 'aspirin',
          0.95, 'prov-bad-med', ?)
      `).run(now);
    }).toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('knowledge_nodes table accepts medication type after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    expect(() => {
      db.prepare(`
        INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
          document_count, mention_count, avg_confidence, provenance_id, created_at, updated_at)
        VALUES ('kn-med', 'medication', 'Aspirin', 'aspirin', 1, 1, 0.95, 'prov-placeholder', ?, ?)
      `).run(now, now);
    }).not.toThrow();

    const row = db.prepare('SELECT entity_type FROM knowledge_nodes WHERE id = ?').get('kn-med') as { entity_type: string };
    expect(row.entity_type).toBe('medication');
  });

  it.skipIf(!sqliteVecAvailable)('knowledge_nodes table accepts diagnosis type after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const now = new Date().toISOString();

    expect(() => {
      db.prepare(`
        INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
          document_count, mention_count, avg_confidence, provenance_id, created_at, updated_at)
        VALUES ('kn-diag', 'diagnosis', 'Type 2 Diabetes', 'type 2 diabetes', 1, 1, 0.90, 'prov-placeholder', ?, ?)
      `).run(now, now);
    }).not.toThrow();
  });

  it.skipIf(!sqliteVecAvailable)('knowledge_nodes has importance_score and resolution_type after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const columns = getTableColumns(db, 'knowledge_nodes');
    expect(columns).toContain('importance_score');
    expect(columns).toContain('resolution_type');
  });

  it.skipIf(!sqliteVecAvailable)('knowledge_nodes_fts table exists after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const tables = getTableNames(db);
    expect(tables).toContain('knowledge_nodes_fts');
  });

  it.skipIf(!sqliteVecAvailable)('FTS triggers exist after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const triggers = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'knowledge_nodes_fts%'
    `).all() as Array<{ name: string }>;
    const triggerNames = triggers.map(t => t.name);

    // After v22 migration, triggers use _ai/_ad/_au naming
    expect(triggerNames).toContain('knowledge_nodes_fts_ai');
    expect(triggerNames).toContain('knowledge_nodes_fts_ad');
    expect(triggerNames).toContain('knowledge_nodes_fts_au');
  });

  it.skipIf(!sqliteVecAvailable)('schema version is latest after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(23);
  });

  it.skipIf(!sqliteVecAvailable)('FK integrity clean after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing entities during migration', () => {
    createV17Schema();

    const now = new Date().toISOString();
    insertTestProvenance(db, 'prov-surv', 'ENTITY_EXTRACTION', 'prov-surv');
    insertTestDocument(db, 'doc-surv', 'prov-surv', 'complete');

    db.prepare(`
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES ('ent-surv-1', 'doc-surv', 'person', 'John Smith', 'john smith',
        0.92, 'prov-surv', ?)
    `).run(now);

    migrateToLatest(db);

    const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get('ent-surv-1') as Record<string, unknown>;
    expect(entity).toBeDefined();
    expect(entity.entity_type).toBe('person');
    expect(entity.raw_text).toBe('John Smith');
    expect(entity.normalized_text).toBe('john smith');
    expect(entity.confidence).toBe(0.92);
  });

  it.skipIf(!sqliteVecAvailable)('preserves existing knowledge_nodes during migration', () => {
    createV17Schema();

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
        document_count, mention_count, edge_count, avg_confidence, provenance_id, created_at, updated_at)
      VALUES ('kn-surv', 'person', 'Jane Doe', 'jane doe', 2, 5, 3, 0.88, 'prov-placeholder', ?, ?)
    `).run(now, now);

    migrateToLatest(db);

    const node = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get('kn-surv') as Record<string, unknown>;
    expect(node).toBeDefined();
    expect(node.canonical_name).toBe('Jane Doe');
    expect(node.entity_type).toBe('person');
    expect(node.edge_count).toBe(3);
    expect(node.avg_confidence).toBe(0.88);
  });

  it.skipIf(!sqliteVecAvailable)('entities indexes recreated after migration', () => {
    createV17Schema();
    migrateToLatest(db);

    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_entities_document_id');
    expect(indexes).toContain('idx_entities_entity_type');
    expect(indexes).toContain('idx_entities_normalized_text');
  });

  it.skipIf(!sqliteVecAvailable)('idempotent - running migration twice does not error', () => {
    createV17Schema();
    migrateToLatest(db);
    expect(() => migrateToLatest(db)).not.toThrow();

    const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(23);
  });
});

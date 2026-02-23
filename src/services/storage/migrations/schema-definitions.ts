/**
 * SQL Schema Definitions for OCR Provenance MCP System
 *
 * Contains all table creation SQL, indexes, and database configuration.
 * These are constants used by the migration system.
 *
 * @module migrations/schema-definitions
 */

/** Current schema version */
export const SCHEMA_VERSION = 31;

/**
 * Database configuration pragmas for optimal performance and safety
 */
export const DATABASE_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA cache_size = -64000',
  'PRAGMA wal_autocheckpoint = 1000',
  'PRAGMA mmap_size = 268435456',
  'PRAGMA busy_timeout = 30000',
] as const;

/**
 * Schema version table - tracks migration state
 */
export const CREATE_SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

/**
 * Provenance table - central provenance tracking (self-referential FKs)
 * Every data transformation creates a provenance record.
 */
export const CREATE_PROVENANCE_TABLE = `
CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'COMPARISON', 'CLUSTERING')),
  created_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  source_file_created_at TEXT,
  source_file_modified_at TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'COMPARISON', 'CLUSTERING')),
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
)
`;

/**
 * Database metadata table - database info and statistics
 */
export const CREATE_DATABASE_METADATA_TABLE = `
CREATE TABLE IF NOT EXISTS database_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  database_name TEXT NOT NULL,
  database_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_modified_at TEXT NOT NULL,
  total_documents INTEGER NOT NULL DEFAULT 0,
  total_ocr_results INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  total_embeddings INTEGER NOT NULL DEFAULT 0
)
`;

/**
 * Documents table - source files with file hashes
 * Provenance depth: 0 (root of chain)
 */
export const CREATE_DOCUMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
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
)
`;

/**
 * OCR Results table - extracted text from Datalab OCR
 * Provenance depth: 1
 */
export const CREATE_OCR_RESULTS_TABLE = `
CREATE TABLE IF NOT EXISTS ocr_results (
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
)
`;

/**
 * Chunks table - text segments (2000 chars, 10% overlap)
 * Provenance depth: 2
 */
export const CREATE_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  ocr_result_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(trim(text)) > 0),
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
  ocr_quality_score REAL,
  heading_context TEXT,
  heading_level INTEGER,
  section_path TEXT,
  content_types TEXT,
  is_atomic INTEGER NOT NULL DEFAULT 0,
  chunking_strategy TEXT NOT NULL DEFAULT 'hybrid_section',
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id),
  FOREIGN KEY (provenance_id) REFERENCES provenance(id)
)
`;

/**
 * Embeddings table - vectors WITH original_text (denormalized)
 * Provenance depth: 3
 *
 * CRITICAL: This table is denormalized to include original_text
 * and source file info. Search results are self-contained per CP-002.
 */
export const CREATE_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT,
  image_id TEXT,
  extraction_id TEXT,
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
  FOREIGN KEY (extraction_id) REFERENCES extractions(id),
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (provenance_id) REFERENCES provenance(id),
  CHECK (chunk_id IS NOT NULL OR image_id IS NOT NULL OR extraction_id IS NOT NULL)
)
`;

/**
 * Vector embeddings virtual table using sqlite-vec
 * 768-dimensional float32 vectors for nomic-embed-text-v1.5
 */
export const CREATE_VEC_EMBEDDINGS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
  embedding_id TEXT PRIMARY KEY,
  vector FLOAT[768]
)
`;

/**
 * FTS5 full-text search index over chunks
 * Uses external content mode - no data duplication
 * Tokenizer: porter stemmer + unicode support
 */
export const CREATE_CHUNKS_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
)
`;

/**
 * Triggers to keep FTS5 in sync with chunks table
 * CRITICAL: These must be created in v4 migration
 */
export const CREATE_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF text ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END`,
] as const;

/**
 * FTS5 index metadata for audit trail
 * Note: v6 removes CHECK (id = 1) to allow id=2 row for VLM FTS metadata
 */
export const CREATE_FTS_INDEX_METADATA = `
CREATE TABLE IF NOT EXISTS fts_index_metadata (
  id INTEGER PRIMARY KEY,
  last_rebuild_at TEXT,
  chunks_indexed INTEGER NOT NULL DEFAULT 0,
  tokenizer TEXT NOT NULL DEFAULT 'porter unicode61',
  schema_version INTEGER NOT NULL DEFAULT 8,
  content_hash TEXT
)
`;

/**
 * FTS5 full-text search index over VLM description embeddings
 * Uses external content mode - reads original_text from embeddings table
 * Only indexes embeddings where image_id IS NOT NULL (VLM descriptions)
 * Tokenizer: porter stemmer + unicode support
 */
export const CREATE_VLM_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS vlm_fts USING fts5(
  original_text,
  content='embeddings',
  content_rowid='rowid',
  tokenize='porter unicode61'
)
`;

/**
 * Triggers to keep VLM FTS5 in sync with embeddings table
 * Only fire for embeddings with image_id IS NOT NULL (VLM description embeddings)
 *
 * NOTE (L-3): The UPDATE trigger only fires on original_text changes when
 * new.image_id IS NOT NULL. If image_id were set from non-null to null, the
 * stale FTS entry would remain. In practice image_id is immutable after INSERT,
 * so this is a theoretical gap only. The DELETE trigger covers row removal.
 */
export const CREATE_VLM_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS vlm_fts_ai AFTER INSERT ON embeddings
   WHEN new.image_id IS NOT NULL BEGIN
    INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS vlm_fts_ad AFTER DELETE ON embeddings
   WHEN old.image_id IS NOT NULL BEGIN
    INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS vlm_fts_au AFTER UPDATE OF original_text ON embeddings
   WHEN new.image_id IS NOT NULL BEGIN
    INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text);
    INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text);
  END`,
] as const;

/**
 * Images table - extracted images from documents for VLM analysis
 * Provenance depth: 2 (after OCR extraction)
 */
export const CREATE_IMAGES_TABLE = `
CREATE TABLE IF NOT EXISTS images (
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
  FOREIGN KEY (vlm_embedding_id) REFERENCES embeddings(id),
  FOREIGN KEY (provenance_id) REFERENCES provenance(id)
)
`;

/**
 * Extractions table - structured data extracted via page_schema
 * Provenance depth: 2 (after OCR_RESULT)
 */
export const CREATE_EXTRACTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ocr_result_id TEXT NOT NULL REFERENCES ocr_results(id) ON DELETE CASCADE,
  schema_json TEXT NOT NULL,
  extraction_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

/**
 * Form fills table - results from Datalab /fill API
 * Provenance depth: 1 (directly from DOCUMENT)
 */
export const CREATE_FORM_FILLS_TABLE = `
CREATE TABLE IF NOT EXISTS form_fills (
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
)
`;

/**
 * FTS5 full-text search index over extraction JSON content
 * Uses external content mode - reads extraction_json from extractions table
 * Tokenizer: porter stemmer + unicode support
 */
export const CREATE_EXTRACTIONS_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS extractions_fts USING fts5(
  extraction_json,
  content='extractions',
  content_rowid='rowid',
  tokenize='porter unicode61'
)
`;

/**
 * Triggers to keep extractions FTS5 in sync with extractions table
 */
export const CREATE_EXTRACTIONS_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS extractions_fts_ai AFTER INSERT ON extractions BEGIN
    INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json);
  END`,
  `CREATE TRIGGER IF NOT EXISTS extractions_fts_ad AFTER DELETE ON extractions BEGIN
    INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json);
  END`,
  `CREATE TRIGGER IF NOT EXISTS extractions_fts_au AFTER UPDATE OF extraction_json ON extractions BEGIN
    INSERT INTO extractions_fts(extractions_fts, rowid, extraction_json) VALUES('delete', old.rowid, old.extraction_json);
    INSERT INTO extractions_fts(rowid, extraction_json) VALUES (new.rowid, new.extraction_json);
  END`,
] as const;

/**
 * Uploaded files table - files uploaded to Datalab cloud storage
 * Tracks upload lifecycle: pending -> uploading -> confirming -> complete/failed
 */
export const CREATE_UPLOADED_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS uploaded_files (
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
)`;

/**
 * Comparisons table - document comparison results
 * Provenance depth: 2 (parallel to CHUNK, after OCR_RESULT)
 */
export const CREATE_COMPARISONS_TABLE = `
CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY NOT NULL,
  document_id_1 TEXT NOT NULL REFERENCES documents(id),
  document_id_2 TEXT NOT NULL REFERENCES documents(id),
  similarity_ratio REAL NOT NULL,
  text_diff_json TEXT NOT NULL,
  structural_diff_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processing_duration_ms INTEGER
)`;

/**
 * Clusters table - groups of semantically similar documents
 * Provenance depth: 2 (parallel to CHUNK, after OCR_RESULT)
 */
export const CREATE_CLUSTERS_TABLE = `
CREATE TABLE IF NOT EXISTS clusters (
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
  algorithm_params_json TEXT NOT NULL,
  silhouette_score REAL,
  content_hash TEXT NOT NULL,
  provenance_id TEXT NOT NULL UNIQUE REFERENCES provenance(id),
  created_at TEXT NOT NULL,
  processing_duration_ms INTEGER
)`;

/**
 * Document-cluster assignments - links documents to clusters within a run
 * UNIQUE(document_id, run_id) ensures one assignment per document per run
 * cluster_id is nullable for noise documents (HDBSCAN -1 labels)
 */
export const CREATE_DOCUMENT_CLUSTERS_TABLE = `
CREATE TABLE IF NOT EXISTS document_clusters (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  cluster_id TEXT REFERENCES clusters(id),
  run_id TEXT NOT NULL,
  similarity_to_centroid REAL NOT NULL,
  membership_probability REAL NOT NULL DEFAULT 1.0,
  is_noise INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL,
  UNIQUE(document_id, run_id)
)`;

/**
 * Saved searches table - persisted search results for revisiting
 * v28 addition, v30 adds last_executed_at and execution_count
 */
export const CREATE_SAVED_SEARCHES_TABLE = `
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  search_type TEXT NOT NULL CHECK (search_type IN ('bm25', 'semantic', 'hybrid')),
  search_params TEXT NOT NULL DEFAULT '{}',
  result_count INTEGER NOT NULL,
  result_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  last_executed_at TEXT,
  execution_count INTEGER DEFAULT 0
)
`;

/**
 * FTS5 full-text search index over document metadata
 * Indexes doc_title, doc_author, doc_subject for metadata search
 * Uses external content mode - reads from documents table
 * v30 addition
 */
export const CREATE_DOCUMENTS_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_title,
  doc_author,
  doc_subject,
  content='documents',
  content_rowid='rowid',
  tokenize='porter unicode61'
)
`;

/**
 * Triggers to keep documents FTS5 in sync with documents table
 * v30 addition
 */
export const CREATE_DOCUMENTS_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, doc_title, doc_author, doc_subject)
    VALUES (new.rowid, COALESCE(new.doc_title, ''), COALESCE(new.doc_author, ''), COALESCE(new.doc_subject, ''));
  END`,
  `CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, doc_title, doc_author, doc_subject)
    VALUES('delete', old.rowid, COALESCE(old.doc_title, ''), COALESCE(old.doc_author, ''), COALESCE(old.doc_subject, ''));
  END`,
  `CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE OF doc_title, doc_author, doc_subject ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, doc_title, doc_author, doc_subject)
    VALUES('delete', old.rowid, COALESCE(old.doc_title, ''), COALESCE(old.doc_author, ''), COALESCE(old.doc_subject, ''));
    INSERT INTO documents_fts(rowid, doc_title, doc_author, doc_subject)
    VALUES (new.rowid, COALESCE(new.doc_title, ''), COALESCE(new.doc_author, ''), COALESCE(new.doc_subject, ''));
  END`,
] as const;

/**
 * Tags table - user-defined annotations for cross-entity tagging
 * v29 addition
 */
export const CREATE_TAGS_TABLE = `
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Entity tags table - many-to-many relationship between tags and entities
 * v29 addition
 */
export const CREATE_ENTITY_TAGS_TABLE = `
CREATE TABLE IF NOT EXISTS entity_tags (
  id TEXT PRIMARY KEY NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('document', 'chunk', 'image', 'extraction', 'cluster')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tag_id, entity_id, entity_type)
)`;

/**
 * All required indexes for query performance
 */
export const CREATE_INDEXES = [
  // Documents indexes
  'CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path)',
  'CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash)',
  'CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)',

  // OCR Results indexes
  'CREATE INDEX IF NOT EXISTS idx_ocr_results_document_id ON ocr_results(document_id)',

  // Chunks indexes
  'CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)',
  'CREATE INDEX IF NOT EXISTS idx_chunks_ocr_result_id ON chunks(ocr_result_id)',
  'CREATE INDEX IF NOT EXISTS idx_chunks_embedding_status ON chunks(embedding_status)',

  // Embeddings indexes
  'CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_image_id ON embeddings(image_id)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_document_id ON embeddings(document_id)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_source_file ON embeddings(source_file_path)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_page ON embeddings(page_number)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_extraction_id ON embeddings(extraction_id)',

  // Images indexes
  'CREATE INDEX IF NOT EXISTS idx_images_document_id ON images(document_id)',
  'CREATE INDEX IF NOT EXISTS idx_images_ocr_result_id ON images(ocr_result_id)',
  'CREATE INDEX IF NOT EXISTS idx_images_page ON images(document_id, page_number)',
  'CREATE INDEX IF NOT EXISTS idx_images_vlm_status ON images(vlm_status)',
  'CREATE INDEX IF NOT EXISTS idx_images_content_hash ON images(content_hash)',
  "CREATE INDEX IF NOT EXISTS idx_images_pending ON images(vlm_status) WHERE vlm_status = 'pending'",
  'CREATE INDEX IF NOT EXISTS idx_images_provenance_id ON images(provenance_id)',

  // Extractions indexes
  'CREATE INDEX IF NOT EXISTS idx_extractions_document_id ON extractions(document_id)',

  // Form fills indexes
  'CREATE INDEX IF NOT EXISTS idx_form_fills_status ON form_fills(status)',

  // Documents metadata indexes
  'CREATE INDEX IF NOT EXISTS idx_documents_doc_title ON documents(doc_title)',
  'CREATE INDEX IF NOT EXISTS idx_documents_doc_author ON documents(doc_author)',
  'CREATE INDEX IF NOT EXISTS idx_documents_doc_subject ON documents(doc_subject)',

  // Provenance indexes
  'CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)',

  // Uploaded files indexes
  'CREATE INDEX IF NOT EXISTS idx_uploaded_files_file_hash ON uploaded_files(file_hash)',
  'CREATE INDEX IF NOT EXISTS idx_uploaded_files_status ON uploaded_files(upload_status)',
  'CREATE INDEX IF NOT EXISTS idx_uploaded_files_datalab_file_id ON uploaded_files(datalab_file_id)',

  // Comparison indexes
  'CREATE INDEX IF NOT EXISTS idx_comparisons_doc1 ON comparisons(document_id_1)',
  'CREATE INDEX IF NOT EXISTS idx_comparisons_doc2 ON comparisons(document_id_2)',
  'CREATE INDEX IF NOT EXISTS idx_comparisons_created ON comparisons(created_at)',

  // Cluster indexes
  'CREATE INDEX IF NOT EXISTS idx_clusters_run_id ON clusters(run_id)',
  'CREATE INDEX IF NOT EXISTS idx_clusters_tag ON clusters(classification_tag)',
  'CREATE INDEX IF NOT EXISTS idx_clusters_created ON clusters(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_doc_clusters_document ON document_clusters(document_id)',
  'CREATE INDEX IF NOT EXISTS idx_doc_clusters_cluster ON document_clusters(cluster_id)',
  'CREATE INDEX IF NOT EXISTS idx_doc_clusters_run ON document_clusters(run_id)',

  // Saved searches indexes
  'CREATE INDEX IF NOT EXISTS idx_saved_searches_name ON saved_searches(name)',
  'CREATE INDEX IF NOT EXISTS idx_saved_searches_search_type ON saved_searches(search_type)',
  'CREATE INDEX IF NOT EXISTS idx_saved_searches_created ON saved_searches(created_at DESC)',

  // Tags indexes
  'CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_id, entity_type)',
  'CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id)',

  // Chunk performance indexes (v30)
  'CREATE INDEX IF NOT EXISTS idx_chunks_section_path ON chunks(section_path)',
  'CREATE INDEX IF NOT EXISTS idx_chunks_heading_level ON chunks(heading_level)',
] as const;

/**
 * Table definitions for creating tables in dependency order
 */
export const TABLE_DEFINITIONS = [
  { name: 'provenance', sql: CREATE_PROVENANCE_TABLE },
  { name: 'database_metadata', sql: CREATE_DATABASE_METADATA_TABLE },
  { name: 'documents', sql: CREATE_DOCUMENTS_TABLE },
  { name: 'ocr_results', sql: CREATE_OCR_RESULTS_TABLE },
  { name: 'chunks', sql: CREATE_CHUNKS_TABLE },
  { name: 'embeddings', sql: CREATE_EMBEDDINGS_TABLE },
  { name: 'images', sql: CREATE_IMAGES_TABLE },
  { name: 'extractions', sql: CREATE_EXTRACTIONS_TABLE },
  { name: 'form_fills', sql: CREATE_FORM_FILLS_TABLE },
  { name: 'uploaded_files', sql: CREATE_UPLOADED_FILES_TABLE },
  { name: 'comparisons', sql: CREATE_COMPARISONS_TABLE },
  { name: 'clusters', sql: CREATE_CLUSTERS_TABLE },
  { name: 'document_clusters', sql: CREATE_DOCUMENT_CLUSTERS_TABLE },
  { name: 'saved_searches', sql: CREATE_SAVED_SEARCHES_TABLE },
  { name: 'tags', sql: CREATE_TAGS_TABLE },
  { name: 'entity_tags', sql: CREATE_ENTITY_TAGS_TABLE },
] as const;

/**
 * Required tables for schema verification
 */
export const REQUIRED_TABLES = [
  'schema_version',
  'provenance',
  'database_metadata',
  'documents',
  'ocr_results',
  'chunks',
  'embeddings',
  'vec_embeddings',
  'images',
  'chunks_fts',
  'fts_index_metadata',
  'vlm_fts',
  'extractions',
  'form_fills',
  'extractions_fts',
  'uploaded_files',
  'comparisons',
  'clusters',
  'document_clusters',
  'saved_searches',
  'tags',
  'entity_tags',
  'documents_fts',
] as const;

/**
 * Required indexes for schema verification
 */
export const REQUIRED_INDEXES = [
  'idx_documents_file_path',
  'idx_documents_file_hash',
  'idx_documents_status',
  'idx_ocr_results_document_id',
  'idx_chunks_document_id',
  'idx_chunks_ocr_result_id',
  'idx_chunks_embedding_status',
  'idx_embeddings_chunk_id',
  'idx_embeddings_image_id',
  'idx_embeddings_document_id',
  'idx_embeddings_source_file',
  'idx_embeddings_page',
  'idx_embeddings_extraction_id',
  'idx_images_document_id',
  'idx_images_ocr_result_id',
  'idx_images_page',
  'idx_images_vlm_status',
  'idx_images_pending',
  'idx_images_provenance_id',
  'idx_images_content_hash',
  'idx_provenance_source_id',
  'idx_provenance_type',
  'idx_provenance_root_document_id',
  'idx_provenance_parent_id',
  'idx_extractions_document_id',
  'idx_form_fills_status',
  'idx_documents_doc_title',
  'idx_documents_doc_author',
  'idx_documents_doc_subject',
  'idx_uploaded_files_file_hash',
  'idx_uploaded_files_status',
  'idx_uploaded_files_datalab_file_id',
  'idx_comparisons_doc1',
  'idx_comparisons_doc2',
  'idx_comparisons_created',
  'idx_clusters_run_id',
  'idx_clusters_tag',
  'idx_clusters_created',
  'idx_doc_clusters_document',
  'idx_doc_clusters_cluster',
  'idx_doc_clusters_run',
  'idx_saved_searches_name',
  'idx_saved_searches_search_type',
  'idx_saved_searches_created',
  'idx_entity_tags_entity',
  'idx_entity_tags_tag',
  'idx_chunks_section_path',
  'idx_chunks_heading_level',
] as const;

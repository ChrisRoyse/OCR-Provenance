/**
 * SQL Schema Definitions for OCR Provenance MCP System
 *
 * Contains all table creation SQL, indexes, and database configuration.
 * These are constants used by the migration system.
 *
 * @module migrations/schema-definitions
 */

/** Current schema version */
export const SCHEMA_VERSION = 7;

/**
 * Database configuration pragmas for optimal performance and safety
 */
export const DATABASE_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA cache_size = -64000',
  'PRAGMA wal_autocheckpoint = 1000',
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
  schema_version INTEGER NOT NULL DEFAULT 7,
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

  // Images indexes
  'CREATE INDEX IF NOT EXISTS idx_images_document_id ON images(document_id)',
  'CREATE INDEX IF NOT EXISTS idx_images_ocr_result_id ON images(ocr_result_id)',
  'CREATE INDEX IF NOT EXISTS idx_images_page ON images(document_id, page_number)',
  'CREATE INDEX IF NOT EXISTS idx_images_vlm_status ON images(vlm_status)',
  'CREATE INDEX IF NOT EXISTS idx_images_content_hash ON images(content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_images_pending ON images(vlm_status) WHERE vlm_status = \'pending\'',
  'CREATE INDEX IF NOT EXISTS idx_images_provenance_id ON images(provenance_id)',

  // Provenance indexes
  'CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)',
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
] as const;

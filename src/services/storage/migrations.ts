/**
 * Database Schema Migrations for OCR Provenance MCP System
 *
 * This module handles SQLite schema initialization and migrations.
 * Uses better-sqlite3 with sqlite-vec extension for vector storage.
 *
 * Security: All SQL uses parameterized queries via db.prepare()
 * Performance: WAL mode, proper indexes, foreign key constraints
 */

import type Database from 'better-sqlite3';
import { createRequire } from 'module';
import { SqliteVecModule } from './types.js';

// Create require function for CommonJS modules in ESM context
const require = createRequire(import.meta.url);

/** Current schema version */
const SCHEMA_VERSION = 1;

/**
 * Database configuration pragmas for optimal performance and safety
 */
const DATABASE_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA cache_size = -64000',
] as const;

/**
 * Schema version table - tracks migration state
 */
const CREATE_SCHEMA_VERSION_TABLE = `
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
const CREATE_PROVENANCE_TABLE = `
CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING')),
  created_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  source_file_created_at TEXT,
  source_file_modified_at TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'EMBEDDING')),
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
const CREATE_DATABASE_METADATA_TABLE = `
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
const CREATE_DOCUMENTS_TABLE = `
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
const CREATE_OCR_RESULTS_TABLE = `
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
const CREATE_CHUNKS_TABLE = `
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
const CREATE_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
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
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (provenance_id) REFERENCES provenance(id)
)
`;

/**
 * Vector embeddings virtual table using sqlite-vec
 * 768-dimensional float32 vectors for nomic-embed-text-v1.5
 */
const CREATE_VEC_EMBEDDINGS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
  embedding_id TEXT PRIMARY KEY,
  vector FLOAT[768]
)
`;

/**
 * All required indexes for query performance
 */
const CREATE_INDEXES = [
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
  'CREATE INDEX IF NOT EXISTS idx_embeddings_document_id ON embeddings(document_id)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_source_file ON embeddings(source_file_path)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_page ON embeddings(page_number)',

  // Provenance indexes
  'CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)',
  'CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)',
] as const;

/**
 * Error class for database migration failures
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly tableName?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Configure database pragmas for optimal performance and safety
 * @param db - Database instance
 */
function configurePragmas(db: Database.Database): void {
  for (const pragma of DATABASE_PRAGMAS) {
    try {
      db.exec(pragma);
    } catch (error) {
      throw new MigrationError(
        `Failed to set pragma: ${pragma}`,
        'pragma',
        undefined,
        error
      );
    }
  }
}

/**
 * Create schema version table and initialize if needed
 * @param db - Database instance
 */
function initializeSchemaVersion(db: Database.Database): void {
  try {
    db.exec(CREATE_SCHEMA_VERSION_TABLE);

    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO schema_version (id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(1, SCHEMA_VERSION, now, now);
  } catch (error) {
    throw new MigrationError(
      'Failed to initialize schema version table',
      'create_table',
      'schema_version',
      error
    );
  }
}

/**
 * Create all tables in dependency order
 * @param db - Database instance
 */
function createTables(db: Database.Database): void {
  const tables = [
    { name: 'provenance', sql: CREATE_PROVENANCE_TABLE },
    { name: 'database_metadata', sql: CREATE_DATABASE_METADATA_TABLE },
    { name: 'documents', sql: CREATE_DOCUMENTS_TABLE },
    { name: 'ocr_results', sql: CREATE_OCR_RESULTS_TABLE },
    { name: 'chunks', sql: CREATE_CHUNKS_TABLE },
    { name: 'embeddings', sql: CREATE_EMBEDDINGS_TABLE },
  ];

  for (const table of tables) {
    try {
      db.exec(table.sql);
    } catch (error) {
      throw new MigrationError(
        `Failed to create table: ${table.name}`,
        'create_table',
        table.name,
        error
      );
    }
  }
}

/**
 * Create sqlite-vec virtual table for vector storage
 * @param db - Database instance
 */
function createVecTable(db: Database.Database): void {
  try {
    db.exec(CREATE_VEC_EMBEDDINGS_TABLE);
  } catch (error) {
    throw new MigrationError(
      'Failed to create vec_embeddings virtual table. Ensure sqlite-vec extension is loaded.',
      'create_virtual_table',
      'vec_embeddings',
      error
    );
  }
}

/**
 * Create all required indexes
 * @param db - Database instance
 */
function createIndexes(db: Database.Database): void {
  for (const indexSql of CREATE_INDEXES) {
    try {
      db.exec(indexSql);
    } catch (error) {
      // Extract index name from SQL for error message
      const match = indexSql.match(/CREATE INDEX IF NOT EXISTS (\w+)/);
      const indexName = match ? match[1] : 'unknown';
      throw new MigrationError(
        `Failed to create index: ${indexName}`,
        'create_index',
        indexName,
        error
      );
    }
  }
}

/**
 * Initialize database metadata with default values
 * @param db - Database instance
 */
function initializeDatabaseMetadata(db: Database.Database): void {
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO database_metadata (
        id, database_name, database_version, created_at, last_modified_at,
        total_documents, total_ocr_results, total_chunks, total_embeddings
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(1, 'ocr-provenance-mcp', '1.0.0', now, now, 0, 0, 0, 0);
  } catch (error) {
    throw new MigrationError(
      'Failed to initialize database metadata',
      'insert',
      'database_metadata',
      error
    );
  }
}

/**
 * Check the current schema version of the database
 * @param db - Database instance
 * @returns Current schema version, or 0 if not initialized
 */
export function checkSchemaVersion(db: Database.Database): number {
  try {
    // Check if schema_version table exists
    const tableExists = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_version'
    `
      )
      .get();

    if (!tableExists) {
      return 0;
    }

    const row = db
      .prepare('SELECT version FROM schema_version WHERE id = ?')
      .get(1) as { version: number } | undefined;

    return row?.version ?? 0;
  } catch (error) {
    throw new MigrationError(
      'Failed to check schema version',
      'query',
      'schema_version',
      error
    );
  }
}

/**
 * Load the sqlite-vec extension
 * @param db - Database instance
 */
function loadSqliteVecExtension(db: Database.Database): void {
  try {
    // The sqlite-vec extension is typically loaded via the loadExtension method
    // The exact path depends on the installation
    // Common locations: node_modules/sqlite-vec/dist/vec0.so (Linux)
    //                   node_modules/sqlite-vec/dist/vec0.dylib (macOS)
    //                   node_modules/sqlite-vec/dist/vec0.dll (Windows)

    // First try to use the sqlite-vec npm package's built-in loader
     
    const sqliteVec = require('sqlite-vec') as SqliteVecModule;
    sqliteVec.load(db);
  } catch (error) {
    throw new MigrationError(
      'Failed to load sqlite-vec extension. Ensure sqlite-vec is installed: npm install sqlite-vec',
      'load_extension',
      'sqlite-vec',
      error
    );
  }
}

/**
 * Initialize the database with all tables, indexes, and configuration
 *
 * This function is idempotent - safe to call multiple times.
 * Creates tables only if they don't exist.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if any operation fails
 */
export function initializeDatabase(db: Database.Database): void {
  // Step 1: Configure pragmas
  configurePragmas(db);

  // Step 2: Load sqlite-vec extension (must be before virtual table creation)
  loadSqliteVecExtension(db);

  // Step 3: Initialize schema version tracking
  initializeSchemaVersion(db);

  // Step 4: Create tables in dependency order
  createTables(db);

  // Step 5: Create sqlite-vec virtual table
  createVecTable(db);

  // Step 6: Create indexes
  createIndexes(db);

  // Step 7: Initialize metadata
  initializeDatabaseMetadata(db);
}

/**
 * Migrate database to the latest schema version
 *
 * Checks current version and applies any necessary migrations.
 * Currently only supports initial schema (version 1).
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
export function migrateToLatest(db: Database.Database): void {
  const currentVersion = checkSchemaVersion(db);

  if (currentVersion === 0) {
    // Fresh database - initialize everything
    initializeDatabase(db);
    return;
  }

  if (currentVersion === SCHEMA_VERSION) {
    // Already at latest version
    return;
  }

  if (currentVersion > SCHEMA_VERSION) {
    throw new MigrationError(
      `Database schema version (${String(currentVersion)}) is newer than supported version (${String(SCHEMA_VERSION)}). ` +
        'Please update the application.',
      'version_check',
      undefined
    );
  }

  // Future migrations would be applied here
  // For now, we only have version 1

  // Update schema version after successful migration
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1
    `);
    stmt.run(SCHEMA_VERSION, now);
  } catch (error) {
    throw new MigrationError(
      'Failed to update schema version after migration',
      'update',
      'schema_version',
      error
    );
  }
}

/**
 * Get the current schema version constant
 * @returns The current schema version number
 */
export function getCurrentSchemaVersion(): number {
  return SCHEMA_VERSION;
}

/**
 * Verify all required tables exist
 * @param db - Database instance
 * @returns Object with verification results
 */
export function verifySchema(db: Database.Database): {
  valid: boolean;
  missingTables: string[];
  missingIndexes: string[];
} {
  const requiredTables = [
    'schema_version',
    'provenance',
    'database_metadata',
    'documents',
    'ocr_results',
    'chunks',
    'embeddings',
    'vec_embeddings',
  ];

  const requiredIndexes = [
    'idx_documents_file_path',
    'idx_documents_file_hash',
    'idx_documents_status',
    'idx_ocr_results_document_id',
    'idx_chunks_document_id',
    'idx_chunks_ocr_result_id',
    'idx_chunks_embedding_status',
    'idx_embeddings_chunk_id',
    'idx_embeddings_document_id',
    'idx_embeddings_source_file',
    'idx_embeddings_page',
    'idx_provenance_source_id',
    'idx_provenance_type',
    'idx_provenance_root_document_id',
    'idx_provenance_parent_id',
  ];

  const missingTables: string[] = [];
  const missingIndexes: string[] = [];

  // Check tables
  for (const tableName of requiredTables) {
    const exists = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE (type = 'table' OR type = 'virtual table') AND name = ?
    `
      )
      .get(tableName);

    if (!exists) {
      missingTables.push(tableName);
    }
  }

  // Check indexes
  for (const indexName of requiredIndexes) {
    const exists = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = ?
    `
      )
      .get(indexName);

    if (!exists) {
      missingIndexes.push(indexName);
    }
  }

  return {
    valid: missingTables.length === 0 && missingIndexes.length === 0,
    missingTables,
    missingIndexes,
  };
}

/**
 * Database Migration Operations
 *
 * Contains the main migration functions: initializeDatabase, migrateToLatest,
 * checkSchemaVersion, and getCurrentSchemaVersion.
 *
 * @module migrations/operations
 */

import type Database from 'better-sqlite3';
import { MigrationError } from './types.js';
import {
  SCHEMA_VERSION,
  CREATE_CHUNKS_FTS_TABLE,
  CREATE_FTS_TRIGGERS,
  CREATE_FTS_INDEX_METADATA,
  CREATE_VLM_FTS_TABLE,
  CREATE_VLM_FTS_TRIGGERS,
  CREATE_EXTRACTIONS_TABLE,
  CREATE_FORM_FILLS_TABLE,
  CREATE_EXTRACTIONS_FTS_TABLE,
  CREATE_EXTRACTIONS_FTS_TRIGGERS,
  CREATE_UPLOADED_FILES_TABLE,
  CREATE_COMPARISONS_TABLE,
  CREATE_CLUSTERS_TABLE,
  CREATE_DOCUMENT_CLUSTERS_TABLE,
} from './schema-definitions.js';

// ─── Legacy entity/KG table definitions (inlined for migration chain v12→v25) ───
// These tables were removed from schema-definitions.ts in v26 but the migration
// functions that originally created them (v12→v13, v14→v15, v17→v18, etc.) still
// reference these constants so that old databases can migrate through the full chain.
// The v25→v26 migration then drops all of them.

const CREATE_ENTITIES_TABLE = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other')),
  raw_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  metadata TEXT,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_ENTITY_MENTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS entity_mentions (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  chunk_id TEXT REFERENCES chunks(id),
  page_number INTEGER,
  character_start INTEGER,
  character_end INTEGER,
  context_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_KNOWLEDGE_NODES_TABLE = `
CREATE TABLE IF NOT EXISTS knowledge_nodes (
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
  resolution_type TEXT,
  FOREIGN KEY (provenance_id) REFERENCES provenance(id)
)
`;

const CREATE_KNOWLEDGE_EDGES_TABLE = `
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('co_mentioned', 'co_located', 'works_at', 'represents', 'located_in', 'filed_in', 'cites', 'references', 'party_to', 'related_to', 'precedes', 'occurred_at', 'treated_with', 'administered_via', 'managed_by', 'interacts_with', 'diagnosed_with', 'prescribed_by', 'admitted_to', 'supervised_by', 'filed_by', 'contraindicated_with')),
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
)
`;

const CREATE_NODE_ENTITY_LINKS_TABLE = `
CREATE TABLE IF NOT EXISTS node_entity_links (
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
)
`;

const CREATE_KNOWLEDGE_NODES_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_nodes_fts USING fts5(
  canonical_name,
  content='knowledge_nodes',
  content_rowid='rowid',
  tokenize='porter unicode61'
)
`;

const CREATE_KNOWLEDGE_NODES_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS knowledge_nodes_fts_ai AFTER INSERT ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS knowledge_nodes_fts_ad AFTER DELETE ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS knowledge_nodes_fts_au AFTER UPDATE OF canonical_name ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name);
    INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name);
  END`,
];

const CREATE_ENTITY_EXTRACTION_SEGMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS entity_extraction_segments (
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
)
`;

const CREATE_ENTITY_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS entity_embeddings (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  original_text TEXT NOT NULL,
  original_text_length INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  document_count INTEGER NOT NULL DEFAULT 1,
  model_name TEXT NOT NULL DEFAULT 'nomic-embed-text-v1.5',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  provenance_id TEXT REFERENCES provenance(id)
)
`;

const CREATE_VEC_ENTITY_EMBEDDINGS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_entity_embeddings USING vec0(
  entity_embedding_id TEXT PRIMARY KEY,
  vector FLOAT[768] distance_metric=cosine
)
`;

const CREATE_CORPUS_INTELLIGENCE_TABLE = `
CREATE TABLE IF NOT EXISTS corpus_intelligence (
  id TEXT PRIMARY KEY,
  database_name TEXT NOT NULL,
  corpus_summary TEXT NOT NULL,
  key_actors TEXT NOT NULL,
  themes TEXT NOT NULL,
  narrative_arcs TEXT,
  entity_count INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_DOCUMENT_NARRATIVES_TABLE = `
CREATE TABLE IF NOT EXISTS document_narratives (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
  narrative_text TEXT NOT NULL,
  entity_roster TEXT NOT NULL,
  corpus_context TEXT,
  synthesis_count INTEGER DEFAULT 0,
  model TEXT NOT NULL,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_ENTITY_ROLES_TABLE = `
CREATE TABLE IF NOT EXISTS entity_roles (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  role TEXT NOT NULL,
  theme TEXT,
  importance_rank INTEGER,
  context_summary TEXT,
  scope TEXT NOT NULL DEFAULT 'database',
  scope_id TEXT,
  model TEXT NOT NULL,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
import {
  configurePragmas,
  initializeSchemaVersion,
  createTables,
  createVecTable,
  createIndexes,
  createFTSTables,
  initializeDatabaseMetadata,
  loadSqliteVecExtension,
} from './schema-helpers.js';
import { computeFTSContentHash } from '../../search/bm25.js';

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

    const row = db.prepare('SELECT version FROM schema_version WHERE id = ?').get(1) as
      | { version: number }
      | undefined;

    return row?.version ?? 0;
  } catch (error) {
    throw new MigrationError('Failed to check schema version', 'query', 'schema_version', error);
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
 * Initialize the database with all tables, indexes, and configuration
 *
 * This function is idempotent - safe to call multiple times.
 * Creates tables only if they don't exist.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if any operation fails
 */
export function initializeDatabase(db: Database.Database): void {
  // Step 1: Configure pragmas (must be outside transaction)
  configurePragmas(db);

  // Step 2: Load sqlite-vec extension (must be before virtual table creation, outside transaction)
  loadSqliteVecExtension(db);

  // Steps 3-8 wrapped in a transaction so that if the process crashes mid-init,
  // the DB won't have a version stamp with missing tables (MIG-5 fix).
  // Schema version is stamped LAST so a crash before completion leaves version=0,
  // causing a clean re-init on restart.
  const initTransaction = db.transaction(() => {
    // Step 3: Create tables in dependency order
    createTables(db);

    // Step 4: Create sqlite-vec virtual table
    createVecTable(db);

    // Step 5: Create indexes
    createIndexes(db);

    // Step 6: Create FTS5 tables and triggers
    createFTSTables(db);

    // Step 7: Initialize metadata
    initializeDatabaseMetadata(db);

    // Step 8: Initialize schema version tracking (LAST - so crash before here means version=0)
    initializeSchemaVersion(db);
  });

  initTransaction();
}

/**
 * Migrate from schema version 1 to version 2
 *
 * Changes in v2:
 * - provenance.type: Added 'IMAGE' and 'VLM_DESCRIPTION' to CHECK constraint
 * - provenance.source_type: Added 'IMAGE_EXTRACTION' and 'VLM' to CHECK constraint
 *
 * Note: SQLite CHECK constraints cannot be modified directly. However, since SQLite
 * stores CHECK constraints as metadata and only validates at INSERT/UPDATE time,
 * existing data remains valid. For new inserts, we recreate the table with the
 * updated constraint.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV1ToV2(db: Database.Database): void {
  try {
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints.
    // We need to recreate the provenance table with the new constraints.
    // Foreign keys must be disabled during table recreation to avoid
    // constraint failures when dropping the old table (other tables reference it).

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create a new table with updated CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'EMBEDDING')),
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 2: Copy existing data to the new table
    db.exec(`
      INSERT INTO provenance_new
      SELECT * FROM provenance
    `);

    // Step 3: Drop the old table
    db.exec('DROP TABLE provenance');

    // Step 4: Rename the new table to the original name
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 5: Recreate indexes for the provenance table
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create images table (new in v2 - supports IMAGE provenance type)
    db.exec(`
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
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (ocr_result_id) REFERENCES ocr_results(id) ON DELETE CASCADE,
        FOREIGN KEY (vlm_embedding_id) REFERENCES embeddings(id),
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_document_id ON images(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_ocr_result_id ON images(ocr_result_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_page ON images(document_id, page_number)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_vlm_status ON images(vlm_status)');
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_images_pending ON images(vlm_status) WHERE vlm_status = 'pending'`
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_provenance_id ON images(provenance_id)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // L-15: Verify FK integrity after table recreation
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v1->v2 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    // Rollback on error
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate provenance table from v1 to v2: ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 2 to version 3
 *
 * Changes in v3:
 * - embeddings.chunk_id: Changed from NOT NULL to nullable
 * - embeddings.image_id: New column (nullable) for VLM description embeddings
 * - embeddings: Added CHECK constraint (chunk_id IS NOT NULL OR image_id IS NOT NULL)
 * - embeddings: Added FOREIGN KEY (image_id) REFERENCES images(id)
 *
 * This migration allows embeddings to reference either chunks (text embeddings)
 * or images (VLM description embeddings).
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV2ToV3(db: Database.Database): void {
  try {
    // Foreign keys must be disabled during table recreation
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create new embeddings table with updated schema
    db.exec(`
      CREATE TABLE embeddings_new (
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
    `);

    // Step 2: Copy existing data (image_id will be NULL for existing embeddings)
    db.exec(`
      INSERT INTO embeddings_new (
        id, chunk_id, image_id, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash, page_number, page_range,
        character_start, character_end, chunk_index, total_chunks, model_name,
        model_version, task_type, inference_mode, gpu_device, provenance_id,
        content_hash, created_at, generation_duration_ms
      )
      SELECT
        id, chunk_id, NULL, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash, page_number, page_range,
        character_start, character_end, chunk_index, total_chunks, model_name,
        model_version, task_type, inference_mode, gpu_device, provenance_id,
        content_hash, created_at, generation_duration_ms
      FROM embeddings
    `);

    // Step 3: Drop old table
    db.exec('DROP TABLE embeddings');

    // Step 4: Rename new table
    db.exec('ALTER TABLE embeddings_new RENAME TO embeddings');

    // Step 5: Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_image_id ON embeddings(image_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_document_id ON embeddings(document_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_embeddings_source_file ON embeddings(source_file_path)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_page ON embeddings(page_number)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // MIG-4: Verify FK integrity after table recreation
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v2->v3 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate embeddings table from v2 to v3: ${cause}`,
      'migrate',
      'embeddings',
      error
    );
  }
}

/**
 * Migrate from schema version 3 to version 4
 *
 * Changes in v4:
 * - chunks_fts: FTS5 virtual table for BM25 full-text search
 * - chunks_fts_ai/ad/au: Sync triggers to keep FTS5 in sync with chunks
 * - fts_index_metadata: Audit trail for FTS index rebuilds
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV3ToV4(db: Database.Database): void {
  try {
    db.exec('BEGIN TRANSACTION');

    // 1. Create FTS5 virtual table
    db.exec(CREATE_CHUNKS_FTS_TABLE);

    // 2. Create sync triggers
    for (const trigger of CREATE_FTS_TRIGGERS) {
      db.exec(trigger);
    }

    // 3. Create metadata table
    db.exec(CREATE_FTS_INDEX_METADATA);

    // 4. Populate FTS5 from existing chunks
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

    // 5. Count indexed chunks and store metadata
    const count = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
    const contentHash = computeFTSContentHash(db);

    db.prepare(
      `
      INSERT OR REPLACE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (1, ?, ?, 'porter unicode61', 4, ?)
    `
    ).run(new Date().toISOString(), count.cnt, contentHash);

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v3 to v4 (FTS5 setup): ${cause}`,
      'migrate',
      'chunks_fts',
      error
    );
  }
}

/**
 * Migrate from schema version 4 to version 5
 *
 * Changes in v5:
 * - images.block_type: Datalab block type (Figure, Picture, PageHeader, etc.)
 * - images.is_header_footer: Boolean flag for header/footer images
 * - images.content_hash: SHA-256 of image bytes for deduplication
 * - idx_images_content_hash: Index for fast dedup lookups
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV4ToV5(db: Database.Database): void {
  db.exec('PRAGMA foreign_keys = OFF');

  // Check existing columns for idempotency (safe on retry after partial failure)
  const columns = db.prepare('PRAGMA table_info(images)').all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  const transaction = db.transaction(() => {
    if (!columnNames.has('block_type')) {
      db.exec('ALTER TABLE images ADD COLUMN block_type TEXT');
    }
    if (!columnNames.has('is_header_footer')) {
      db.exec('ALTER TABLE images ADD COLUMN is_header_footer INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnNames.has('content_hash')) {
      db.exec('ALTER TABLE images ADD COLUMN content_hash TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_content_hash ON images(content_hash)');
  });

  try {
    transaction();
    db.exec('PRAGMA foreign_keys = ON');

    // L-14: FK integrity check for pattern consistency with other migrations.
    // ADD COLUMN can't violate FKs, but this ensures the table isn't corrupt.
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v4->v5 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    db.exec('PRAGMA foreign_keys = ON');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v4 to v5 (image filtering columns): ${cause}`,
      'migrate',
      'images',
      error
    );
  }
}

/**
 * Migrate from schema version 5 to version 6
 *
 * Changes in v6:
 * - vlm_fts: FTS5 virtual table for VLM description full-text search
 * - vlm_fts_ai/ad/au: Sync triggers on embeddings (where image_id IS NOT NULL)
 * - fts_index_metadata: Remove CHECK (id = 1) constraint to allow id=2 row for VLM FTS
 * - fts_index_metadata id=2: VLM FTS metadata row
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV5ToV6(db: Database.Database): void {
  try {
    // Check if DDL phase already completed (safe on retry after partial failure)
    const vlmFtsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'")
      .get();
    const newMetadataExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index_metadata'")
      .get();
    const oldBackupExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index_metadata_old'"
      )
      .get();

    if (!vlmFtsExists) {
      // DDL phase not yet completed -- run it

      // Only rename if the backup doesn't already exist from a previous interrupted run
      if (!oldBackupExists && newMetadataExists) {
        db.exec('ALTER TABLE fts_index_metadata RENAME TO fts_index_metadata_old');
      }

      // Create new metadata table (without CHECK (id = 1) constraint)
      db.exec(`
        CREATE TABLE IF NOT EXISTS fts_index_metadata (
          id INTEGER PRIMARY KEY,
          last_rebuild_at TEXT,
          chunks_indexed INTEGER NOT NULL DEFAULT 0,
          tokenizer TEXT NOT NULL DEFAULT 'porter unicode61',
          schema_version INTEGER NOT NULL DEFAULT 7,
          content_hash TEXT
        )
      `);

      // Create VLM FTS5 virtual table
      db.exec(CREATE_VLM_FTS_TABLE);

      // Create VLM FTS sync triggers
      for (const trigger of CREATE_VLM_FTS_TRIGGERS) {
        db.exec(trigger);
      }
    }

    // DML phase: always safe to retry (uses INSERT OR IGNORE, checks before DROP)
    db.exec('BEGIN TRANSACTION');
    try {
      // Copy data from old table if it still exists and new table needs it
      const oldStillExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index_metadata_old'"
        )
        .get();

      if (oldStillExists) {
        // Only copy if new table doesn't already have the data (id=1 row)
        const hasChunkMetadata = db.prepare('SELECT id FROM fts_index_metadata WHERE id = 1').get();

        if (!hasChunkMetadata) {
          db.exec('INSERT OR IGNORE INTO fts_index_metadata SELECT * FROM fts_index_metadata_old');
        }

        // Safe to drop backup now that data is in the new table
        db.exec('DROP TABLE fts_index_metadata_old');
      }

      // Insert VLM FTS metadata row (id=2)
      const now = new Date().toISOString();
      db.prepare(
        `
        INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
        VALUES (2, ?, 0, 'porter unicode61', 6, NULL)
      `
      ).run(now);

      // Populate vlm_fts from existing VLM embeddings
      const vlmCount = db
        .prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL')
        .get() as { cnt: number };

      if (vlmCount.cnt > 0) {
        // Only populate if not already done (check FTS row count)
        const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM vlm_fts').get() as { cnt: number };

        if (ftsCount.cnt === 0) {
          db.exec(`
            INSERT INTO vlm_fts(rowid, original_text)
            SELECT rowid, original_text FROM embeddings WHERE image_id IS NOT NULL
          `);
        }

        // Update VLM FTS metadata with count
        db.prepare(
          'UPDATE fts_index_metadata SET chunks_indexed = ?, last_rebuild_at = ? WHERE id = 2'
        ).run(vlmCount.cnt, now);
      }

      db.exec('COMMIT');
    } catch (dmlError) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        console.error(
          '[migrations] Rollback failed:',
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        );
      }
      throw dmlError;
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v5 to v6 (VLM FTS setup): ${cause}`,
      'migrate',
      'vlm_fts',
      error
    );
  }
}

/**
 * Migrate from schema version 6 to version 7
 *
 * Changes in v7:
 * - provenance.source_type: Added 'VLM_DEDUP' to CHECK constraint
 *   This allows VLM pipeline to record deduplicated image results with
 *   a distinct source_type for provenance tracking.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV6ToV7(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create new provenance table with VLM_DEDUP in source_type CHECK
    db.exec(`
      CREATE TABLE provenance_new (
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 2: Copy existing data
    db.exec(`
      INSERT INTO provenance_new
      SELECT * FROM provenance
    `);

    // Step 3: Drop old table
    db.exec('DROP TABLE provenance');

    // Step 4: Rename new table
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 5: Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // L-15: Verify FK integrity after table recreation
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v6->v7 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate provenance table from v6 to v7: ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 9 to version 10
 *
 * Changes in v10:
 * - embeddings.extraction_id: New column for extraction-sourced embeddings
 * - embeddings CHECK: Now allows extraction_id-only rows
 * - embeddings FK: extraction_id REFERENCES extractions(id)
 * - idx_embeddings_extraction_id: New index
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV9ToV10(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create new embeddings table with extraction_id + updated CHECK
    db.exec(`
      CREATE TABLE embeddings_new (
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
    `);

    // Step 2: Copy existing data (extraction_id = NULL for all existing embeddings)
    db.exec(`
      INSERT INTO embeddings_new (
        id, chunk_id, image_id, extraction_id, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash, page_number, page_range,
        character_start, character_end, chunk_index, total_chunks, model_name,
        model_version, task_type, inference_mode, gpu_device, provenance_id,
        content_hash, created_at, generation_duration_ms
      )
      SELECT
        id, chunk_id, image_id, NULL, document_id, original_text, original_text_length,
        source_file_path, source_file_name, source_file_hash, page_number, page_range,
        character_start, character_end, chunk_index, total_chunks, model_name,
        model_version, task_type, inference_mode, gpu_device, provenance_id,
        content_hash, created_at, generation_duration_ms
      FROM embeddings
    `);

    // Step 3: Drop old table
    db.exec('DROP TABLE embeddings');

    // Step 4: Rename new table
    db.exec('ALTER TABLE embeddings_new RENAME TO embeddings');

    // Step 5: Recreate all embeddings indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_image_id ON embeddings(image_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_extraction_id ON embeddings(extraction_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_document_id ON embeddings(document_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_embeddings_source_file ON embeddings(source_file_path)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_page ON embeddings(page_number)');

    // Step 6: Recreate VLM FTS triggers (they reference embeddings table which was recreated)
    // The triggers were lost when the old embeddings table was dropped.
    // Check if vlm_fts exists - if so, recreate its triggers
    const vlmFtsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'")
      .get();
    if (vlmFtsExists) {
      // Drop old triggers if they exist
      db.exec('DROP TRIGGER IF EXISTS vlm_fts_ai');
      db.exec('DROP TRIGGER IF EXISTS vlm_fts_ad');
      db.exec('DROP TRIGGER IF EXISTS vlm_fts_au');
      // Recreate
      db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ai AFTER INSERT ON embeddings
        WHEN new.image_id IS NOT NULL BEGIN
          INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text);
        END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_ad AFTER DELETE ON embeddings
        WHEN old.image_id IS NOT NULL BEGIN
          INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text);
        END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS vlm_fts_au AFTER UPDATE OF original_text ON embeddings
        WHEN new.image_id IS NOT NULL BEGIN
          INSERT INTO vlm_fts(vlm_fts, rowid, original_text) VALUES('delete', old.rowid, old.original_text);
          INSERT INTO vlm_fts(rowid, original_text) VALUES (new.rowid, new.original_text);
        END`);
    }

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v9->v10 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v9 to v10 (extraction embeddings): ${cause}`,
      'migrate',
      'embeddings',
      error
    );
  }
}

/**
 * Migrate from schema version 10 to version 11
 *
 * Changes in v11:
 * - ocr_results.json_blocks: JSON block hierarchy from Datalab
 * - ocr_results.extras_json: Extra metadata (cost_breakdown, Datalab metadata)
 *
 * Uses ALTER TABLE ADD COLUMN (nullable TEXT columns, no table recreation needed).
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV10ToV11(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');

    const columns = db.prepare('PRAGMA table_info(ocr_results)').all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));

    const transaction = db.transaction(() => {
      if (!names.has('json_blocks')) {
        db.exec('ALTER TABLE ocr_results ADD COLUMN json_blocks TEXT');
      }
      if (!names.has('extras_json')) {
        db.exec('ALTER TABLE ocr_results ADD COLUMN extras_json TEXT');
      }
    });
    transaction();

    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check for consistency with other migrations
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v10->v11 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    db.exec('PRAGMA foreign_keys = ON');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v10 to v11 (json_blocks, extras_json): ${cause}`,
      'migrate',
      'ocr_results',
      error
    );
  }
}

/**
 * Migrate database to the latest schema version
 *
 * Checks current version and applies any necessary migrations.
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

  // Helper to bump schema_version immediately after each successful migration step.
  // This ensures crash-safety: if the process dies between migrations, only the
  // remaining migrations re-run on restart (MIG-1 fix).
  const bumpVersion = (targetVersion: number): void => {
    try {
      db.prepare('UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1').run(
        targetVersion,
        new Date().toISOString()
      );
    } catch (error) {
      throw new MigrationError(
        `Failed to update schema version to ${String(targetVersion)} after migration`,
        'update',
        'schema_version',
        error
      );
    }
  };

  // Apply migrations incrementally, bumping version after each step
  if (currentVersion < 2) {
    migrateV1ToV2(db);
    bumpVersion(2);
  }

  if (currentVersion < 3) {
    migrateV2ToV3(db);
    bumpVersion(3);
  }

  if (currentVersion < 4) {
    migrateV3ToV4(db);
    bumpVersion(4);
  }

  if (currentVersion < 5) {
    migrateV4ToV5(db);
    bumpVersion(5);
  }

  if (currentVersion < 6) {
    migrateV5ToV6(db);
    bumpVersion(6);
  }

  if (currentVersion < 7) {
    migrateV6ToV7(db);
    bumpVersion(7);
  }

  if (currentVersion < 8) {
    migrateV7ToV8(db);
    bumpVersion(8);
  }

  if (currentVersion < 9) {
    migrateV8ToV9(db);
    bumpVersion(9);
  }

  if (currentVersion < 10) {
    migrateV9ToV10(db);
    bumpVersion(10);
  }

  if (currentVersion < 11) {
    migrateV10ToV11(db);
    bumpVersion(11);
  }

  if (currentVersion < 12) {
    migrateV11ToV12(db);
    bumpVersion(12);
  }

  if (currentVersion < 13) {
    migrateV12ToV13(db);
    bumpVersion(13);
  }

  if (currentVersion < 14) {
    migrateV13ToV14(db);
    bumpVersion(14);
  }

  if (currentVersion < 15) {
    migrateV14ToV15(db);
    bumpVersion(15);
  }

  if (currentVersion < 16) {
    migrateV15ToV16(db);
    bumpVersion(16);
  }

  if (currentVersion < 17) {
    migrateV16ToV17(db);
    bumpVersion(17);
  }

  if (currentVersion < 18) {
    migrateV17ToV18(db);
    bumpVersion(18);
  }

  if (currentVersion < 19) {
    migrateV18ToV19(db);
    bumpVersion(19);
  }

  if (currentVersion < 20) {
    migrateV19ToV20(db);
    bumpVersion(20);
  }

  if (currentVersion < 21) {
    migrateV20ToV21(db);
    bumpVersion(21);
  }

  if (currentVersion < 22) {
    migrateV21ToV22(db);
    bumpVersion(22);
  }

  if (currentVersion < 23) {
    migrateV22ToV23(db);
    bumpVersion(23);
  }

  if (currentVersion < 24) {
    migrateV23ToV24(db);
    bumpVersion(24);
  }

  if (currentVersion < 25) {
    migrateV24ToV25(db);
    bumpVersion(25);
  }

  if (currentVersion < 26) {
    migrateV25ToV26(db);
    bumpVersion(26);
  }
}

/**
 * Migrate from schema version 7 to version 8
 *
 * Changes in v8:
 * - extractions: New table for structured data extracted via page_schema
 * - form_fills: New table for Datalab /fill API results
 * - documents: Added doc_title, doc_author, doc_subject columns
 * - provenance.type: Added 'EXTRACTION', 'FORM_FILL' to CHECK constraint
 * - provenance.source_type: Added 'EXTRACTION', 'FORM_FILL' to CHECK constraint
 * - New indexes: idx_extractions_document_id, idx_form_fills_status, idx_documents_doc_title
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV7ToV8(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create new tables
    db.exec(CREATE_EXTRACTIONS_TABLE);
    db.exec(CREATE_FORM_FILLS_TABLE);

    // Step 2: Add new columns to documents table
    const columns = db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('doc_title')) {
      db.exec('ALTER TABLE documents ADD COLUMN doc_title TEXT');
    }
    if (!columnNames.has('doc_author')) {
      db.exec('ALTER TABLE documents ADD COLUMN doc_author TEXT');
    }
    if (!columnNames.has('doc_subject')) {
      db.exec('ALTER TABLE documents ADD COLUMN doc_subject TEXT');
    }

    // Step 3: Create new indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_extractions_document_id ON extractions(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_form_fills_status ON form_fills(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_documents_doc_title ON documents(doc_title)');

    // Step 4: Recreate provenance table with EXTRACTION and FORM_FILL in CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 5: Copy existing provenance data
    db.exec(`
      INSERT INTO provenance_new
      SELECT * FROM provenance
    `);

    // Step 6: Drop old provenance table
    db.exec('DROP TABLE provenance');

    // Step 7: Rename new table
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 8: Recreate provenance indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check after table recreation
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v7->v8 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v7 to v8 (extractions, form_fills, doc metadata): ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 8 to version 9
 *
 * Changes in v9:
 * - extractions_fts: FTS5 virtual table for extraction content full-text search
 * - extractions_fts_ai/ad/au: Sync triggers on extractions table
 * - fts_index_metadata id=3: Extraction FTS metadata row
 * - form_fills.cost_cents: Changed from INTEGER to REAL (fractional cents)
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV8ToV9(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create extractions FTS5 virtual table
    db.exec(CREATE_EXTRACTIONS_FTS_TABLE);

    // Step 2: Create extractions FTS sync triggers
    for (const trigger of CREATE_EXTRACTIONS_FTS_TRIGGERS) {
      db.exec(trigger);
    }

    // Step 3: Populate FTS from existing extractions
    db.exec("INSERT INTO extractions_fts(extractions_fts) VALUES('rebuild')");

    // Step 4: Add extraction FTS metadata row (id=3)
    const now = new Date().toISOString();
    const extractionCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as { cnt: number }
    ).cnt;
    db.prepare(
      `
      INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (3, ?, ?, 'porter unicode61', 9, NULL)
    `
    ).run(now, extractionCount);

    // Step 5: Recreate form_fills with cost_cents REAL (was INTEGER)
    db.exec(`
      CREATE TABLE form_fills_new (
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
    `);
    db.exec('INSERT INTO form_fills_new SELECT * FROM form_fills');
    db.exec('DROP TABLE form_fills');
    db.exec('ALTER TABLE form_fills_new RENAME TO form_fills');
    db.exec('CREATE INDEX IF NOT EXISTS idx_form_fills_status ON form_fills(status)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check after table recreation
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v8->v9 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v8 to v9 (extractions FTS, cost_cents REAL): ${cause}`,
      'migrate',
      'extractions_fts',
      error
    );
  }
}

/**
 * Migrate from schema version 11 to version 12
 *
 * Changes in v12:
 * - uploaded_files: New table for Datalab cloud file uploads
 * - documents.datalab_file_id: New column linking documents to uploaded files
 * - 3 new indexes: idx_uploaded_files_file_hash, idx_uploaded_files_status, idx_uploaded_files_datalab_file_id
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV11ToV12(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');

    const transaction = db.transaction(() => {
      // Create uploaded_files table
      db.exec(CREATE_UPLOADED_FILES_TABLE);

      // Create indexes
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_uploaded_files_file_hash ON uploaded_files(file_hash)'
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_uploaded_files_status ON uploaded_files(upload_status)'
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_uploaded_files_datalab_file_id ON uploaded_files(datalab_file_id)'
      );

      // Add datalab_file_id column to documents
      const columns = db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
      if (!columns.some((c) => c.name === 'datalab_file_id')) {
        db.exec('ALTER TABLE documents ADD COLUMN datalab_file_id TEXT');
      }
    });
    transaction();

    db.exec('PRAGMA foreign_keys = ON');

    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v11->v12 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    db.exec('PRAGMA foreign_keys = ON');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v11 to v12 (uploaded_files): ${cause}`,
      'migrate',
      'uploaded_files',
      error
    );
  }
}

/**
 * Migrate from schema version 12 to version 13
 *
 * Changes in v13:
 * - provenance.type: Added 'ENTITY_EXTRACTION' to CHECK constraint
 * - provenance.source_type: Added 'ENTITY_EXTRACTION' to CHECK constraint
 * - entities: New table for named entities extracted from documents
 * - entity_mentions: New table for entity occurrence tracking
 * - 4 new indexes: idx_entities_document_id, idx_entities_entity_type,
 *   idx_entities_normalized_text, idx_entity_mentions_entity_id
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV12ToV13(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Recreate provenance table with ENTITY_EXTRACTION in CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION')),
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 2: Copy existing data
    db.exec('INSERT INTO provenance_new SELECT * FROM provenance');

    // Step 3: Drop old table
    db.exec('DROP TABLE provenance');

    // Step 4: Rename new table
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 5: Recreate provenance indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create entities and entity_mentions tables
    db.exec(CREATE_ENTITIES_TABLE);
    db.exec(CREATE_ENTITY_MENTIONS_TABLE);

    // Step 7: Create indexes for new tables
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_document_id ON entities(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_entity_type ON entities(entity_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_normalized_text ON entities(normalized_text)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity_id ON entity_mentions(entity_id)'
    );

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v12->v13 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v12 to v13 (entity extraction): ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 13 to version 14
 *
 * Changes in v14:
 * - provenance.type: Added 'COMPARISON' to CHECK constraint
 * - provenance.source_type: Added 'COMPARISON' to CHECK constraint
 * - comparisons: New table for document comparison results
 * - 3 new indexes: idx_comparisons_doc1, idx_comparisons_doc2, idx_comparisons_created
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV13ToV14(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Recreate provenance table with COMPARISON in CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 2: Copy existing data
    db.exec('INSERT INTO provenance_new SELECT * FROM provenance');

    // Step 3: Drop old table
    db.exec('DROP TABLE provenance');

    // Step 4: Rename new table
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 5: Recreate provenance indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create comparisons table
    db.exec(CREATE_COMPARISONS_TABLE);

    // Step 7: Create indexes for comparisons table
    db.exec('CREATE INDEX IF NOT EXISTS idx_comparisons_doc1 ON comparisons(document_id_1)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comparisons_doc2 ON comparisons(document_id_2)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comparisons_created ON comparisons(created_at)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v13->v14 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v13 to v14 (document comparison): ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 15 to version 16
 *
 * Changes in v16:
 * - provenance.type: Added 'KNOWLEDGE_GRAPH' to CHECK constraint
 * - provenance.source_type: Added 'KNOWLEDGE_GRAPH' to CHECK constraint
 * - knowledge_nodes: New table for unified entities resolved across documents
 * - knowledge_edges: New table for relationships between knowledge nodes
 * - node_entity_links: New table linking knowledge nodes to source entity extractions
 * - 8 new indexes: idx_kn_entity_type, idx_kn_normalized_name, idx_kn_document_count,
 *   idx_ke_source_node, idx_ke_target_node, idx_ke_relationship_type,
 *   idx_nel_node_id, idx_nel_document_id
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV15ToV16(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Recreate provenance table with KNOWLEDGE_GRAPH in CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 2: Copy existing data
    db.exec('INSERT INTO provenance_new SELECT * FROM provenance');

    // Step 3: Drop old table
    db.exec('DROP TABLE provenance');

    // Step 4: Rename new table
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 5: Recreate provenance indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create knowledge graph tables
    db.exec(CREATE_KNOWLEDGE_NODES_TABLE);
    db.exec(CREATE_KNOWLEDGE_EDGES_TABLE);
    db.exec(CREATE_NODE_ENTITY_LINKS_TABLE);

    // Step 7: Create indexes for knowledge graph tables
    db.exec('CREATE INDEX IF NOT EXISTS idx_kn_entity_type ON knowledge_nodes(entity_type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_kn_normalized_name ON knowledge_nodes(normalized_name)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_kn_document_count ON knowledge_nodes(document_count DESC)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_ke_source_node ON knowledge_edges(source_node_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ke_target_node ON knowledge_edges(target_node_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ke_relationship_type ON knowledge_edges(relationship_type)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_nel_node_id ON node_entity_links(node_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nel_document_id ON node_entity_links(document_id)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v15->v16 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v15 to v16 (knowledge graph): ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 14 to version 15
 *
 * Changes in v15:
 * - provenance.type: Added 'CLUSTERING' to CHECK constraint
 * - provenance.source_type: Added 'CLUSTERING' to CHECK constraint
 * - clusters: New table for document clustering results
 * - document_clusters: New table for document-cluster assignments
 * - 6 new indexes: idx_clusters_run_id, idx_clusters_tag, idx_clusters_created,
 *   idx_doc_clusters_document, idx_doc_clusters_cluster, idx_doc_clusters_run
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV14ToV15(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Recreate provenance table with CLUSTERING in CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON', 'CLUSTERING')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON', 'CLUSTERING')),
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);

    // Step 2: Copy existing data
    db.exec('INSERT INTO provenance_new SELECT * FROM provenance');

    // Step 3: Drop old table
    db.exec('DROP TABLE provenance');

    // Step 4: Rename new table
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');

    // Step 5: Recreate provenance indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create clusters table
    db.exec(CREATE_CLUSTERS_TABLE);

    // Step 7: Create document_clusters table
    db.exec(CREATE_DOCUMENT_CLUSTERS_TABLE);

    // Step 8: Create indexes for clustering tables
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_run_id ON clusters(run_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_tag ON clusters(classification_tag)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_created ON clusters(created_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_doc_clusters_document ON document_clusters(document_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_doc_clusters_cluster ON document_clusters(cluster_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_doc_clusters_run ON document_clusters(run_id)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v14->v15 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v14 to v15 (document clustering): ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

/**
 * Migrate from schema version 16 to version 17
 *
 * Changes in v17 (knowledge graph optimization):
 * - knowledge_nodes.edge_count: New column tracking edge count per node
 * - node_entity_links.resolution_method: New column tracking how entity was resolved
 * - knowledge_edges: Expanded CHECK constraint with 'precedes', 'occurred_at' relationship types
 * - knowledge_nodes_fts: New FTS5 virtual table for knowledge node full-text search
 * - knowledge_nodes_fts_ai/ad/au: FTS5 sync triggers for knowledge_nodes
 * - idx_knowledge_nodes_canonical_lower: Case-insensitive index on canonical_name
 * - idx_entity_mentions_chunk_id: Index on entity_mentions.chunk_id for chunk-based lookups
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV16ToV17(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Add resolution_method column to node_entity_links (if not already present from fresh schema)
    const nelColumns = db.pragma('table_info(node_entity_links)') as Array<{ name: string }>;
    if (!nelColumns.some((c) => c.name === 'resolution_method')) {
      db.exec('ALTER TABLE node_entity_links ADD COLUMN resolution_method TEXT');
    }

    // Step 2: Add edge_count column to knowledge_nodes (if not already present from fresh schema)
    const knColumns = db.pragma('table_info(knowledge_nodes)') as Array<{ name: string }>;
    if (!knColumns.some((c) => c.name === 'edge_count')) {
      db.exec('ALTER TABLE knowledge_nodes ADD COLUMN edge_count INTEGER NOT NULL DEFAULT 0');
    }

    // Step 3: Recreate knowledge_edges with expanded CHECK constraint
    // Include v20 columns (valid_from, valid_until, normalized_weight, contradiction_count)
    // so that SELECT * works regardless of whether the source table was created fresh (with v20 cols)
    // or via earlier migrations (without them).
    const keColumns = db.pragma('table_info(knowledge_edges)') as Array<{ name: string }>;
    const hasV20Cols = keColumns.some((c) => c.name === 'valid_from');

    db.exec(`
      CREATE TABLE knowledge_edges_new (
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
      )
    `);

    // Step 4: Copy existing edges (use explicit columns if source lacks v20 columns)
    if (hasV20Cols) {
      db.exec('INSERT INTO knowledge_edges_new SELECT * FROM knowledge_edges');
    } else {
      db.exec(`INSERT INTO knowledge_edges_new (id, source_node_id, target_node_id, relationship_type, weight, evidence_count, document_ids, metadata, provenance_id, created_at)
        SELECT id, source_node_id, target_node_id, relationship_type, weight, evidence_count, document_ids, metadata, provenance_id, created_at FROM knowledge_edges`);
    }

    // Step 5: Drop old edges table
    db.exec('DROP TABLE knowledge_edges');

    // Step 6: Rename new table
    db.exec('ALTER TABLE knowledge_edges_new RENAME TO knowledge_edges');

    // Step 7: Recreate indexes on knowledge_edges (dropped with old table)
    db.exec('CREATE INDEX IF NOT EXISTS idx_ke_source_node ON knowledge_edges(source_node_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ke_target_node ON knowledge_edges(target_node_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ke_relationship_type ON knowledge_edges(relationship_type)'
    );

    // Step 8: Create new optimization indexes
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_canonical_lower ON knowledge_nodes(canonical_name COLLATE NOCASE)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_mentions_chunk_id ON entity_mentions(chunk_id)');

    // Step 9: Backfill edge_count from existing edges
    db.exec(`
      UPDATE knowledge_nodes SET edge_count = (
        SELECT COUNT(*) FROM knowledge_edges
        WHERE source_node_id = knowledge_nodes.id OR target_node_id = knowledge_nodes.id
      )
    `);

    // Step 10: Create knowledge_nodes_fts FTS5 table
    db.exec(CREATE_KNOWLEDGE_NODES_FTS_TABLE);

    // Step 11: Create FTS triggers
    for (const trigger of CREATE_KNOWLEDGE_NODES_FTS_TRIGGERS) {
      db.exec(trigger);
    }

    // Step 12: Populate FTS from existing knowledge_nodes
    const nodeCount = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as {
      cnt: number;
    };
    if (nodeCount.cnt > 0) {
      db.exec(`
        INSERT INTO knowledge_nodes_fts(rowid, canonical_name)
        SELECT rowid, canonical_name FROM knowledge_nodes
      `);
    }

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v16->v17 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v16 to v17 (knowledge graph optimization): ${cause}`,
      'migrate',
      'knowledge_edges',
      error
    );
  }
}

/**
 * Migrate from schema version 17 to version 18
 *
 * Changes in v18:
 * - entities.entity_type: Added 'medication', 'diagnosis' to CHECK constraint
 * - knowledge_nodes.entity_type: Added 'medication', 'diagnosis' to CHECK constraint
 *
 * SQLite CHECK constraints require table recreation to modify.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV17ToV18(db: Database.Database): void {
  const entityTypeCheck = `('person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other')`;

  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Recreate entities table with expanded CHECK constraint
    db.exec(`
      CREATE TABLE entities_new (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id),
        entity_type TEXT NOT NULL CHECK (entity_type IN ${entityTypeCheck}),
        raw_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.0,
        metadata TEXT,
        provenance_id TEXT NOT NULL REFERENCES provenance(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('INSERT INTO entities_new SELECT * FROM entities');
    db.exec('DROP TABLE entities');
    db.exec('ALTER TABLE entities_new RENAME TO entities');

    // Recreate entities indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_document_id ON entities(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_entity_type ON entities(entity_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_normalized_text ON entities(normalized_text)');

    // Step 2: Recreate knowledge_nodes table with expanded CHECK constraint
    // Include v20 columns (importance_score, resolution_type) so that SELECT * works
    // regardless of whether the source table was created fresh (with v20 cols) or via earlier migrations.
    const knColsV18 = db.pragma('table_info(knowledge_nodes)') as Array<{ name: string }>;
    const hasV20NodeCols = knColsV18.some((c) => c.name === 'importance_score');

    db.exec(`
      CREATE TABLE knowledge_nodes_new (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ${entityTypeCheck}),
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
        resolution_type TEXT,
        FOREIGN KEY (provenance_id) REFERENCES provenance(id)
      )
    `);
    if (hasV20NodeCols) {
      db.exec('INSERT INTO knowledge_nodes_new SELECT * FROM knowledge_nodes');
    } else {
      db.exec(`INSERT INTO knowledge_nodes_new (id, entity_type, canonical_name, normalized_name, aliases, document_count, mention_count, edge_count, avg_confidence, metadata, provenance_id, created_at, updated_at)
        SELECT id, entity_type, canonical_name, normalized_name, aliases, document_count, mention_count, edge_count, avg_confidence, metadata, provenance_id, created_at, updated_at FROM knowledge_nodes`);
    }

    // Drop FTS table and triggers before dropping knowledge_nodes (FTS references it)
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_insert');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_update');
    db.exec('DROP TABLE IF EXISTS knowledge_nodes_fts');

    db.exec('DROP TABLE knowledge_nodes');
    db.exec('ALTER TABLE knowledge_nodes_new RENAME TO knowledge_nodes');

    // Recreate knowledge_nodes indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_kn_entity_type ON knowledge_nodes(entity_type)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_kn_normalized_name ON knowledge_nodes(normalized_name)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_kn_document_count ON knowledge_nodes(document_count)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_canonical_lower ON knowledge_nodes(canonical_name COLLATE NOCASE)'
    );

    // Recreate FTS5 table and triggers
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_nodes_fts USING fts5(canonical_name, content='knowledge_nodes', content_rowid='rowid')`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS knowledge_nodes_fts_insert AFTER INSERT ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS knowledge_nodes_fts_delete AFTER DELETE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS knowledge_nodes_fts_update AFTER UPDATE ON knowledge_nodes BEGIN INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, canonical_name) VALUES ('delete', old.rowid, old.canonical_name); INSERT INTO knowledge_nodes_fts(rowid, canonical_name) VALUES (new.rowid, new.canonical_name); END`
    );

    // Repopulate FTS from existing data
    const nodeCount = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as {
      cnt: number;
    };
    if (nodeCount.cnt > 0) {
      db.exec(`
        INSERT INTO knowledge_nodes_fts(rowid, canonical_name)
        SELECT rowid, canonical_name FROM knowledge_nodes
      `);
    }

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v17->v18 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v17 to v18 (medical entity types): ${cause}`,
      'migrate',
      'entities',
      error
    );
  }
}

/**
 * Migrate from schema version 18 to version 19
 *
 * Changes in v19:
 * - entity_extraction_segments: New table for chunked entity extraction with provenance
 *   Stores 50K-character segments with 10% overlap for focused Gemini extraction.
 *   Each segment records its exact character_start/character_end in the OCR text
 *   and links to provenance for full traceability.
 * - 3 new indexes: idx_segments_document, idx_segments_status, idx_segments_doc_status
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV18ToV19(db: Database.Database): void {
  try {
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create entity_extraction_segments table
    db.exec(CREATE_ENTITY_EXTRACTION_SEGMENTS_TABLE);

    // Step 2: Create indexes
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_segments_document ON entity_extraction_segments(document_id)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_segments_status ON entity_extraction_segments(extraction_status)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_segments_doc_status ON entity_extraction_segments(document_id, extraction_status)'
    );

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v18 to v19 (entity extraction segments): ${cause}`,
      'migrate',
      'entity_extraction_segments',
      error
    );
  }
}

/**
 * Migrate from schema version 19 to version 20
 *
 * Changes in v20:
 * - knowledge_edges: Added valid_from, valid_until (TEXT) for temporal bounds
 * - knowledge_edges: Added normalized_weight (REAL DEFAULT 0) for weight normalization
 * - knowledge_edges: Added contradiction_count (INTEGER DEFAULT 0) for contradiction tracking
 * - knowledge_nodes: Added importance_score (REAL) for node ranking
 * - knowledge_nodes: Added resolution_type (TEXT) for entity resolution tracking
 * - entity_embeddings: New table for entity vector embeddings
 * - vec_entity_embeddings: New sqlite-vec virtual table for entity semantic search
 * - 3 new indexes: idx_entity_embeddings_entity_id, idx_entity_embeddings_node_id,
 *   idx_entity_embeddings_content_hash
 *
 * Note: knowledge_nodes.updated_at already exists from the v16 schema, so it is NOT added here.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV19ToV20(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');

    // Step 1: Add new columns to knowledge_edges
    const edgeCols = db.pragma('table_info(knowledge_edges)') as Array<{ name: string }>;
    const edgeColNames = new Set(edgeCols.map((c) => c.name));

    if (!edgeColNames.has('valid_from')) {
      db.exec('ALTER TABLE knowledge_edges ADD COLUMN valid_from TEXT');
    }
    if (!edgeColNames.has('valid_until')) {
      db.exec('ALTER TABLE knowledge_edges ADD COLUMN valid_until TEXT');
    }
    if (!edgeColNames.has('normalized_weight')) {
      db.exec('ALTER TABLE knowledge_edges ADD COLUMN normalized_weight REAL DEFAULT 0');
    }
    if (!edgeColNames.has('contradiction_count')) {
      db.exec('ALTER TABLE knowledge_edges ADD COLUMN contradiction_count INTEGER DEFAULT 0');
    }

    // Step 2: Add new columns to knowledge_nodes
    const nodeCols = db.pragma('table_info(knowledge_nodes)') as Array<{ name: string }>;
    const nodeColNames = new Set(nodeCols.map((c) => c.name));

    if (!nodeColNames.has('importance_score')) {
      db.exec('ALTER TABLE knowledge_nodes ADD COLUMN importance_score REAL');
    }
    if (!nodeColNames.has('resolution_type')) {
      db.exec('ALTER TABLE knowledge_nodes ADD COLUMN resolution_type TEXT');
    }

    // Step 3: Add ocr_quality_score to chunks
    const chunkCols = db.pragma('table_info(chunks)') as Array<{ name: string }>;
    const chunkColNames = new Set(chunkCols.map((c) => c.name));
    if (!chunkColNames.has('ocr_quality_score')) {
      db.exec('ALTER TABLE chunks ADD COLUMN ocr_quality_score REAL');
    }

    // Step 4: Create placeholder entity_embeddings table (v21 will recreate with correct schema)
    db.exec(`CREATE TABLE IF NOT EXISTS entity_embeddings (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      node_id TEXT REFERENCES knowledge_nodes(id),
      embedding_model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      provenance_id TEXT REFERENCES provenance(id)
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_embeddings_entity_id ON entity_embeddings(entity_id)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_embeddings_node_id ON entity_embeddings(node_id)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_embeddings_content_hash ON entity_embeddings(content_hash)'
    );

    // Step 5: Create placeholder vec_entity_embeddings virtual table (v21 will recreate with correct PK)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entity_embeddings USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[768] distance_metric=cosine
    )`);

    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v19->v20 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    db.exec('PRAGMA foreign_keys = ON');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v19 to v20 (entity embeddings, temporal edges, node scoring): ${cause}`,
      'migrate',
      'knowledge_edges',
      error
    );
  }
}

/**
 * Migrate from schema version 20 to version 21
 *
 * Changes in v21:
 * - Rebuild entity_embeddings table with correct columns:
 *   node_id, original_text, original_text_length, entity_type, document_count, model_name
 *   (v20 table had entity_id, embedding_model, dimensions which didn't match embed_entities code)
 * - Rebuild vec_entity_embeddings with entity_embedding_id PK (was id)
 */
function migrateV20ToV21(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');

    // Step 1: Drop and recreate entity_embeddings with correct schema
    // Safe because embed_entities never succeeded with the v20 schema
    // DROP TABLE removes the table's indexes automatically
    db.exec('DROP TABLE IF EXISTS entity_embeddings');

    db.exec(CREATE_ENTITY_EMBEDDINGS_TABLE);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_embeddings_node_id ON entity_embeddings(node_id)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_entity_embeddings_content_hash ON entity_embeddings(content_hash)'
    );

    // Step 2: Drop and recreate vec_entity_embeddings with correct PK column name
    db.exec('DROP TABLE IF EXISTS vec_entity_embeddings');
    db.exec(CREATE_VEC_ENTITY_EMBEDDINGS_TABLE);

    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v20->v21 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    db.exec('PRAGMA foreign_keys = ON');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v20 to v21 (entity embeddings schema fix): ${cause}`,
      'migrate',
      'entity_embeddings',
      error
    );
  }
}

/**
 * Migrate from schema version 21 to version 22
 *
 * Fixes FTS tokenizer and trigger inconsistencies (F-S3, F-S4, F-S5):
 * - F-S3: knowledge_nodes_fts was created WITHOUT `porter unicode61` tokenizer
 *   in v18 migration (fresh DB has it). Recreated with correct tokenizer.
 * - F-S4: v18 update trigger fires on ANY column update. Fixed to fire only
 *   on `canonical_name` changes (AFTER UPDATE OF canonical_name).
 * - F-S5: v18 triggers use `_insert/_delete/_update` naming. Fixed to use
 *   `_ai/_ad/_au` naming convention matching fresh schema definitions.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV21ToV22(db: Database.Database): void {
  try {
    db.exec('BEGIN TRANSACTION');

    // Step 1: Drop old FTS table and ALL trigger name variants
    // (covers both v18 naming and fresh-schema naming)
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_insert');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_update');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_ad');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_au');
    db.exec('DROP TABLE IF EXISTS knowledge_nodes_fts');

    // Step 2: Recreate FTS table with porter tokenizer (matching schema-definitions.ts)
    db.exec(CREATE_KNOWLEDGE_NODES_FTS_TABLE);

    // Step 3: Create triggers with correct _ai/_ad/_au naming and
    // AFTER UPDATE OF canonical_name scoping (matching schema-definitions.ts)
    for (const trigger of CREATE_KNOWLEDGE_NODES_FTS_TRIGGERS) {
      db.exec(trigger);
    }

    // Step 4: Repopulate FTS from existing knowledge_nodes data
    const nodeCount = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as {
      cnt: number;
    };
    if (nodeCount.cnt > 0) {
      db.exec(`
        INSERT INTO knowledge_nodes_fts(rowid, canonical_name)
        SELECT rowid, canonical_name FROM knowledge_nodes
      `);
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v21 to v22 (FTS tokenizer/trigger fix): ${cause}`,
      'migrate',
      'knowledge_nodes_fts',
      error
    );
  }
}

/**
 * Migrate from schema version 22 to version 23
 *
 * Changes in v23:
 * - Add 4 medical relationship types to knowledge_edges CHECK constraint:
 *   treated_with, administered_via, managed_by, interacts_with
 *
 * Strategy: Recreate knowledge_edges table with updated CHECK constraint,
 * copy all existing data, swap tables.
 *
 * @throws MigrationError if migration fails
 */
function migrateV22ToV23(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Check if knowledge_edges table exists (KG tables are only created in v15+)
    const tableExists = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='knowledge_edges'"
      )
      .get() as { cnt: number };

    if (tableExists.cnt === 0) {
      // No knowledge_edges table - nothing to migrate
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
      return;
    }

    // Step 1: Create new table with expanded CHECK constraint
    db.exec(`
      CREATE TABLE knowledge_edges_new (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN (
          'co_mentioned', 'co_located', 'works_at', 'represents',
          'located_in', 'filed_in', 'cites', 'references',
          'party_to', 'related_to', 'precedes', 'occurred_at',
          'treated_with', 'administered_via', 'managed_by', 'interacts_with'
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
      )
    `);

    // Step 2: Copy all existing data
    db.exec(`
      INSERT INTO knowledge_edges_new
      SELECT id, source_node_id, target_node_id, relationship_type,
             weight, evidence_count, document_ids, metadata,
             provenance_id, created_at, valid_from, valid_until,
             normalized_weight, contradiction_count
      FROM knowledge_edges
    `);

    // Step 3: Drop old table and rename
    db.exec('DROP TABLE knowledge_edges');
    db.exec('ALTER TABLE knowledge_edges_new RENAME TO knowledge_edges');

    // Step 4: Recreate indexes (matching schema-definitions.ts names)
    db.exec('CREATE INDEX IF NOT EXISTS idx_ke_source_node ON knowledge_edges(source_node_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ke_target_node ON knowledge_edges(target_node_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ke_relationship_type ON knowledge_edges(relationship_type)'
    );

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // FK integrity check
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v22->v23 migration: ${fkViolations.length} violation(s). ` +
          `First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error(
        '[migrations] Rollback failed:',
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v22 to v23 (medical relationship types): ${cause}`,
      'migrate',
      'knowledge_edges',
      error
    );
  }
}

/**
 * Migrate from schema version 23 to version 24
 *
 * Changes in v24:
 * - Add index on entity_mentions(document_id) to eliminate full table scans
 *   on queries that filter or join entity_mentions by document_id.
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV23ToV24(db: Database.Database): void {
  try {
    // entity_mentions table was created in v14 — skip index creation if table doesn't exist
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_mentions'")
      .get();
    if (tableExists) {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_entity_mentions_document_id ON entity_mentions(document_id)'
      );
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v23 to v24 (entity_mentions document_id index): ${cause}`,
      'migrate',
      'entity_mentions',
      error
    );
  }
}

/**
 * Migrate from schema version 24 to version 25
 *
 * Changes in v25 (AI Knowledge Synthesis):
 * - corpus_intelligence: New table for corpus-level AI summaries
 * - document_narratives: New table for document-level AI narratives
 * - entity_roles: New table for AI-determined entity roles
 * - knowledge_edges: 6 new relationship types added to CHECK constraint
 * - provenance: CORPUS_INTELLIGENCE added to type and source_type CHECK constraints
 * - 5 new indexes for the new tables
 *
 * @param db - Database instance from better-sqlite3
 * @throws MigrationError if migration fails
 */
function migrateV24ToV25(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Create 3 new tables
    db.exec(CREATE_CORPUS_INTELLIGENCE_TABLE);
    db.exec(CREATE_DOCUMENT_NARRATIVES_TABLE);
    db.exec(CREATE_ENTITY_ROLES_TABLE);

    // Step 2: Create 6 new indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_intelligence_database ON corpus_intelligence(database_name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_narratives_document ON document_narratives(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_roles_node ON entity_roles(node_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_roles_theme ON entity_roles(theme)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_roles_role ON entity_roles(role)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_roles_scope ON entity_roles(scope, scope_id)');

    // Step 3: Expand knowledge_edges CHECK constraint with 6 new relationship types
    const edgesTableExists = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='knowledge_edges'").get() as { cnt: number };

    if (edgesTableExists.cnt > 0) {
      db.exec(`
        CREATE TABLE knowledge_edges_new (
          id TEXT PRIMARY KEY,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          relationship_type TEXT NOT NULL CHECK (relationship_type IN (
            'co_mentioned', 'co_located', 'works_at', 'represents',
            'located_in', 'filed_in', 'cites', 'references',
            'party_to', 'related_to', 'precedes', 'occurred_at',
            'treated_with', 'administered_via', 'managed_by', 'interacts_with',
            'diagnosed_with', 'prescribed_by', 'admitted_to', 'supervised_by', 'filed_by', 'contraindicated_with'
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
        )
      `);

      db.exec(`
        INSERT INTO knowledge_edges_new
        SELECT id, source_node_id, target_node_id, relationship_type,
               weight, evidence_count, document_ids, metadata,
               provenance_id, created_at, valid_from, valid_until,
               normalized_weight, contradiction_count
        FROM knowledge_edges
      `);

      db.exec('DROP TABLE knowledge_edges');
      db.exec('ALTER TABLE knowledge_edges_new RENAME TO knowledge_edges');

      db.exec('CREATE INDEX IF NOT EXISTS idx_ke_source_node ON knowledge_edges(source_node_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_ke_target_node ON knowledge_edges(target_node_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_ke_relationship_type ON knowledge_edges(relationship_type)');
    }

    // Step 4: Add CORPUS_INTELLIGENCE to provenance type and source_type CHECK constraints
    db.exec(`
      CREATE TABLE provenance_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON', 'CLUSTERING', 'KNOWLEDGE_GRAPH', 'CORPUS_INTELLIGENCE')),
        created_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        source_file_created_at TEXT,
        source_file_modified_at TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('FILE', 'OCR', 'CHUNKING', 'IMAGE_EXTRACTION', 'VLM', 'VLM_DEDUP', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'ENTITY_EXTRACTION', 'COMPARISON', 'CLUSTERING', 'KNOWLEDGE_GRAPH', 'CORPUS_INTELLIGENCE')),
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);
    db.exec('INSERT INTO provenance_new SELECT * FROM provenance');
    db.exec('DROP TABLE provenance');
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `Foreign key integrity check failed after v24->v25 migration: ${fkViolations.length} violation(s). First: ${JSON.stringify(fkViolations[0])}`
      );
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (rollbackErr) {
      console.error('[migrations] Rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v24 to v25 (AI Knowledge Synthesis tables): ${cause}`,
      'migrate',
      'corpus_intelligence',
      error
    );
  }
}

/**
 * Migrate from schema version 25 to version 26
 *
 * BREAKING CHANGE: Removes all entity extraction and knowledge graph tables.
 * These features are being removed entirely - no backwards compatibility.
 *
 * Drops:
 * - entities, entity_mentions, knowledge_nodes, knowledge_edges
 * - node_entity_links, entity_extraction_segments
 * - entity_embeddings, vec_entity_embeddings
 * - corpus_intelligence, document_narratives, entity_roles
 * - knowledge_nodes_fts (FTS5 virtual table)
 * - All associated triggers and indexes
 * - Recreates provenance table without ENTITY_EXTRACTION/KNOWLEDGE_GRAPH/CORPUS_INTELLIGENCE
 * - Recreates comparisons table without entity_diff_json column
 */
function migrateV25ToV26(db: Database.Database): void {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN TRANSACTION');

    // Step 1: Drop entity/KG FTS triggers (must be before table drops)
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_ad');
    db.exec('DROP TRIGGER IF EXISTS knowledge_nodes_fts_au');

    // Step 2: Drop entity/KG indexes (IF EXISTS for safety)
    const entityKgIndexes = [
      'idx_entities_document_id', 'idx_entities_entity_type', 'idx_entities_normalized_text',
      'idx_entity_mentions_entity_id', 'idx_entity_mentions_document_id', 'idx_entity_mentions_chunk_id',
      'idx_kn_entity_type', 'idx_kn_normalized_name', 'idx_kn_document_count',
      'idx_ke_source_node', 'idx_ke_target_node', 'idx_ke_relationship_type',
      'idx_nel_node_id', 'idx_nel_document_id',
      'idx_knowledge_nodes_canonical_lower',
      'idx_segments_document', 'idx_segments_status', 'idx_segments_doc_status',
      'idx_entity_embeddings_node_id', 'idx_entity_embeddings_content_hash',
      'idx_corpus_intelligence_database',
      'idx_document_narratives_document',
      'idx_entity_roles_node', 'idx_entity_roles_theme', 'idx_entity_roles_role', 'idx_entity_roles_scope',
    ];
    for (const idx of entityKgIndexes) {
      db.exec(`DROP INDEX IF EXISTS ${idx}`);
    }

    // Step 3: Drop entity/KG tables in FK-safe order
    // Virtual tables first (no FK dependencies)
    db.exec('DROP TABLE IF EXISTS vec_entity_embeddings');
    db.exec('DROP TABLE IF EXISTS knowledge_nodes_fts');
    // Tables with outgoing FKs first
    db.exec('DROP TABLE IF EXISTS entity_roles');
    db.exec('DROP TABLE IF EXISTS document_narratives');
    db.exec('DROP TABLE IF EXISTS corpus_intelligence');
    db.exec('DROP TABLE IF EXISTS entity_embeddings');
    db.exec('DROP TABLE IF EXISTS entity_extraction_segments');
    db.exec('DROP TABLE IF EXISTS node_entity_links');
    db.exec('DROP TABLE IF EXISTS knowledge_edges');
    db.exec('DROP TABLE IF EXISTS entity_mentions');
    db.exec('DROP TABLE IF EXISTS entities');
    db.exec('DROP TABLE IF EXISTS knowledge_nodes');

    // Step 4: Recreate provenance table without entity/KG types
    db.exec(`
      CREATE TABLE provenance_new (
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
        FOREIGN KEY (source_id) REFERENCES provenance_new(id),
        FOREIGN KEY (parent_id) REFERENCES provenance_new(id)
      )
    `);
    // Only copy rows with valid types (discard entity/KG provenance records)
    db.exec(`
      INSERT INTO provenance_new SELECT * FROM provenance
      WHERE type IN ('DOCUMENT', 'OCR_RESULT', 'CHUNK', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING', 'EXTRACTION', 'FORM_FILL', 'COMPARISON', 'CLUSTERING')
    `);
    db.exec('DROP TABLE provenance');
    db.exec('ALTER TABLE provenance_new RENAME TO provenance');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_source_id ON provenance(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_type ON provenance(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 5: Recreate comparisons table without entity_diff_json column
    db.exec(`
      CREATE TABLE comparisons_new (
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
      )
    `);
    db.exec(`
      INSERT INTO comparisons_new
      SELECT id, document_id_1, document_id_2, similarity_ratio,
             text_diff_json, structural_diff_json,
             summary, content_hash, provenance_id, created_at, processing_duration_ms
      FROM comparisons
    `);
    db.exec('DROP TABLE comparisons');
    db.exec('ALTER TABLE comparisons_new RENAME TO comparisons');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comparisons_doc1 ON comparisons(document_id_1)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comparisons_doc2 ON comparisons(document_id_2)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comparisons_created ON comparisons(created_at)');

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');

    // Verify FK integrity
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      console.error(`[Migration v25->v26] FK violations detected: ${JSON.stringify(fkViolations.slice(0, 5))}`);
      throw new Error(
        `Foreign key integrity check failed after v25->v26 migration: ${fkViolations.length} violation(s)`
      );
    }

    console.error('[Migration] v25 -> v26: Removed entity extraction and knowledge graph tables');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* rollback best-effort */ }
    db.exec('PRAGMA foreign_keys = ON');
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v25 to v26 (entity/KG removal): ${cause}`,
      'migrate',
      'entity_kg_removal',
      error
    );
  }
}

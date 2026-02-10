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
  CREATE_ENTITIES_TABLE,
  CREATE_ENTITY_MENTIONS_TABLE,
  CREATE_COMPARISONS_TABLE,
  CREATE_CLUSTERS_TABLE,
  CREATE_DOCUMENT_CLUSTERS_TABLE,
} from './schema-definitions.js';
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
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
    db.exec(`CREATE INDEX IF NOT EXISTS idx_images_pending ON images(vlm_status) WHERE vlm_status = 'pending'`);
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
    } catch {
      // Ignore rollback errors
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_source_file ON embeddings(source_file_path)');
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
    } catch {
      // Ignore rollback errors
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

    db.prepare(`
      INSERT OR REPLACE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (1, ?, ?, 'porter unicode61', 4, ?)
    `).run(new Date().toISOString(), count.cnt, contentHash);

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors
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
  const columnNames = new Set(columns.map(c => c.name));

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
    const vlmFtsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'"
    ).get();
    const newMetadataExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index_metadata'"
    ).get();
    const oldBackupExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index_metadata_old'"
    ).get();

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
      const oldStillExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index_metadata_old'"
      ).get();

      if (oldStillExists) {
        // Only copy if new table doesn't already have the data (id=1 row)
        const hasChunkMetadata = db.prepare(
          'SELECT id FROM fts_index_metadata WHERE id = 1'
        ).get();

        if (!hasChunkMetadata) {
          db.exec('INSERT OR IGNORE INTO fts_index_metadata SELECT * FROM fts_index_metadata_old');
        }

        // Safe to drop backup now that data is in the new table
        db.exec('DROP TABLE fts_index_metadata_old');
      }

      // Insert VLM FTS metadata row (id=2)
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
        VALUES (2, ?, 0, 'porter unicode61', 6, NULL)
      `).run(now);

      // Populate vlm_fts from existing VLM embeddings
      const vlmCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM embeddings WHERE image_id IS NOT NULL'
      ).get() as { cnt: number };

      if (vlmCount.cnt > 0) {
        // Only populate if not already done (check FTS row count)
        const ftsCount = db.prepare(
          "SELECT COUNT(*) as cnt FROM vlm_fts"
        ).get() as { cnt: number };

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
      } catch {
        // Ignore rollback errors
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
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
    } catch {
      // Ignore rollback errors
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_source_file ON embeddings(source_file_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_page ON embeddings(page_number)');

    // Step 6: Recreate VLM FTS triggers (they reference embeddings table which was recreated)
    // The triggers were lost when the old embeddings table was dropped.
    // Check if vlm_fts exists - if so, recreate its triggers
    const vlmFtsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vlm_fts'"
    ).get();
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
    } catch {
      // Ignore rollback errors
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
    const names = new Set(columns.map(c => c.name));

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
      db.prepare('UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1')
        .run(targetVersion, new Date().toISOString());
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
    const columnNames = new Set(columns.map(c => c.name));

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
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
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
    } catch {
      // Ignore rollback errors
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
    const extractionCount = (db.prepare('SELECT COUNT(*) as cnt FROM extractions').get() as { cnt: number }).cnt;
    db.prepare(`
      INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (3, ?, ?, 'porter unicode61', 9, NULL)
    `).run(now, extractionCount);

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
    } catch {
      // Ignore rollback errors
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_uploaded_files_file_hash ON uploaded_files(file_hash)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_uploaded_files_status ON uploaded_files(upload_status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_uploaded_files_datalab_file_id ON uploaded_files(datalab_file_id)');

      // Add datalab_file_id column to documents
      const columns = db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
      if (!columns.some(c => c.name === 'datalab_file_id')) {
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create entities and entity_mentions tables
    db.exec(CREATE_ENTITIES_TABLE);
    db.exec(CREATE_ENTITY_MENTIONS_TABLE);

    // Step 7: Create indexes for new tables
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_document_id ON entities(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_entity_type ON entities(entity_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entities_normalized_text ON entities(normalized_text)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity_id ON entity_mentions(entity_id)');

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
    } catch { /* ignore rollback errors */ }
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
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
    } catch { /* ignore rollback errors */ }
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_root_document_id ON provenance(root_document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provenance_parent_id ON provenance(parent_id)');

    // Step 6: Create clusters table
    db.exec(CREATE_CLUSTERS_TABLE);

    // Step 7: Create document_clusters table
    db.exec(CREATE_DOCUMENT_CLUSTERS_TABLE);

    // Step 8: Create indexes for clustering tables
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_run_id ON clusters(run_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_tag ON clusters(classification_tag)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_created ON clusters(created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_doc_clusters_document ON document_clusters(document_id)');
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
    } catch { /* ignore rollback errors */ }
    const cause = error instanceof Error ? error.message : String(error);
    throw new MigrationError(
      `Failed to migrate from v14 to v15 (document clustering): ${cause}`,
      'migrate',
      'provenance',
      error
    );
  }
}

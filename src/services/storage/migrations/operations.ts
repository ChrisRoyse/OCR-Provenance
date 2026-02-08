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
}

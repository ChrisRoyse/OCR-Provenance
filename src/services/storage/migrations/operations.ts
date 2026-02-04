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
import { SCHEMA_VERSION } from './schema-definitions.js';
import {
  configurePragmas,
  initializeSchemaVersion,
  createTables,
  createVecTable,
  createIndexes,
  initializeDatabaseMetadata,
  loadSqliteVecExtension,
} from './schema-helpers.js';

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
    // This is done in a transaction to ensure atomicity.

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

    db.exec('COMMIT');
  } catch (error) {
    // Rollback on error
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors
    }
    throw new MigrationError(
      'Failed to migrate provenance table from v1 to v2',
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

  // Apply migrations incrementally
  if (currentVersion < 2) {
    migrateV1ToV2(db);
  }

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

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

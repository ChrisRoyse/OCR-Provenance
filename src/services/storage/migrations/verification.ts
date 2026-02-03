/**
 * Schema Verification Functions
 *
 * Contains functions to verify database schema integrity.
 *
 * @module migrations/verification
 */

import type Database from 'better-sqlite3';
import { REQUIRED_TABLES, REQUIRED_INDEXES } from './schema-definitions.js';

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
  const missingTables: string[] = [];
  const missingIndexes: string[] = [];

  // Check tables
  for (const tableName of REQUIRED_TABLES) {
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
  for (const indexName of REQUIRED_INDEXES) {
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

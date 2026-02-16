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
 * Required triggers for FTS sync (chunks_fts and vlm_fts)
 */
const REQUIRED_TRIGGERS = [
  'chunks_fts_ai',
  'chunks_fts_ad',
  'chunks_fts_au',
  'vlm_fts_ai',
  'vlm_fts_ad',
  'vlm_fts_au',
] as const;

/**
 * Verify all required tables, indexes, and triggers exist
 * @param db - Database instance
 * @returns Object with verification results
 */
export function verifySchema(db: Database.Database): {
  valid: boolean;
  missingTables: string[];
  missingIndexes: string[];
  missingTriggers: string[];
} {
  const missingTables: string[] = [];
  const missingIndexes: string[] = [];
  const missingTriggers: string[] = [];

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

  // Check triggers (FTS sync triggers are critical for search correctness)
  for (const triggerName of REQUIRED_TRIGGERS) {
    const exists = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `
      )
      .get(triggerName);

    if (!exists) {
      missingTriggers.push(triggerName);
    }
  }

  return {
    valid:
      missingTables.length === 0 && missingIndexes.length === 0 && missingTriggers.length === 0,
    missingTables,
    missingIndexes,
    missingTriggers,
  };
}

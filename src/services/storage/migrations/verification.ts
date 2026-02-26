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
 * Required triggers for FTS sync (chunks_fts, vlm_fts, extractions_fts, and documents_fts)
 */
const REQUIRED_TRIGGERS = [
  'chunks_fts_ai',
  'chunks_fts_ad',
  'chunks_fts_au',
  'vlm_fts_ai',
  'vlm_fts_ad',
  'vlm_fts_au',
  'extractions_fts_ai',
  'extractions_fts_ad',
  'extractions_fts_au',
  'documents_fts_ai',
  'documents_fts_ad',
  'documents_fts_au',
] as const;

/**
 * Verify all required tables, indexes, and triggers exist
 * @param db - Database instance
 * @returns Object with verification results
 */
// Critical columns that MUST exist (not all columns, just the ones most likely to be missing from partial migrations)
const REQUIRED_COLUMNS: Record<string, string[]> = {
  documents: ['id', 'file_path', 'file_hash', 'file_size', 'file_type', 'created_at'],
  chunks: ['id', 'ocr_result_id', 'text', 'chunk_index', 'page_number', 'character_start', 'character_end'],
  embeddings: ['id', 'chunk_id', 'model_name', 'original_text'],
  provenance: ['id', 'parent_id', 'source_id', 'type', 'content_hash', 'chain_hash'],
  ocr_results: ['id', 'document_id', 'extracted_text', 'json_blocks'],
  images: ['id', 'ocr_result_id', 'page_number', 'block_type'],
  saved_searches: ['id', 'name', 'query', 'search_type'],
  workflow_states: ['id', 'document_id', 'state', 'created_at'],
  obligations: ['id', 'document_id', 'obligation_type', 'status', 'metadata_json'],
  playbooks: ['id', 'name', 'clauses_json'],
};

export function verifySchema(db: Database.Database): {
  valid: boolean;
  missingTables: string[];
  missingIndexes: string[];
  missingTriggers: string[];
  missingColumns: string[];
} {
  const missingTables: string[] = [];
  const missingIndexes: string[] = [];
  const missingTriggers: string[] = [];
  const missingColumns: string[] = [];

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

  // Verify columns for critical tables (only tables that actually exist in the DB)
  for (const [table, requiredCols] of Object.entries(REQUIRED_COLUMNS)) {
    // Check if the table actually exists in the database before checking columns
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE (type = 'table' OR type = 'virtual table') AND name = ?`
      )
      .get(table);
    if (!tableExists) {
      continue; // Table doesn't exist - either already reported as missing table, or not in REQUIRED_TABLES
    }
    try {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map((c) => c.name));
      for (const col of requiredCols) {
        if (!columnNames.has(col)) {
          missingColumns.push(`Table "${table}" is missing required column: ${col}`);
        }
      }
    } catch (error) {
      missingColumns.push(
        `Failed to check columns for table "${table}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    valid:
      missingTables.length === 0 &&
      missingIndexes.length === 0 &&
      missingTriggers.length === 0 &&
      missingColumns.length === 0,
    missingTables,
    missingIndexes,
    missingTriggers,
    missingColumns,
  };
}

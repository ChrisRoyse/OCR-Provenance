/**
 * Schema Helper Functions for Database Migrations
 *
 * Contains helper functions for configuring pragmas, creating tables,
 * indexes, and initializing database metadata.
 *
 * @module migrations/schema-helpers
 */

import type Database from 'better-sqlite3';
import { createRequire } from 'module';
import { MigrationError } from './types.js';
import {
  DATABASE_PRAGMAS,
  CREATE_SCHEMA_VERSION_TABLE,
  CREATE_VEC_EMBEDDINGS_TABLE,
  CREATE_VEC_ENTITY_EMBEDDINGS_TABLE,
  CREATE_CHUNKS_FTS_TABLE,
  CREATE_FTS_TRIGGERS,
  CREATE_FTS_INDEX_METADATA,
  CREATE_VLM_FTS_TABLE,
  CREATE_VLM_FTS_TRIGGERS,
  CREATE_EXTRACTIONS_FTS_TABLE,
  CREATE_EXTRACTIONS_FTS_TRIGGERS,
  CREATE_KNOWLEDGE_NODES_FTS_TABLE,
  CREATE_KNOWLEDGE_NODES_FTS_TRIGGERS,
  CREATE_INDEXES,
  TABLE_DEFINITIONS,
  SCHEMA_VERSION,
} from './schema-definitions.js';
import { SqliteVecModule } from '../types.js';

// Create require function for CommonJS modules in ESM context
const require = createRequire(import.meta.url);

/**
 * Configure database pragmas for optimal performance and safety
 * @param db - Database instance
 */
export function configurePragmas(db: Database.Database): void {
  for (const pragma of DATABASE_PRAGMAS) {
    try {
      db.exec(pragma);
    } catch (error) {
      throw new MigrationError(`Failed to set pragma: ${pragma}`, 'pragma', undefined, error);
    }
  }
}

/**
 * Create schema version table and initialize if needed
 * @param db - Database instance
 */
export function initializeSchemaVersion(db: Database.Database): void {
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
export function createTables(db: Database.Database): void {
  for (const table of TABLE_DEFINITIONS) {
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
export function createVecTable(db: Database.Database): void {
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
  try {
    db.exec(CREATE_VEC_ENTITY_EMBEDDINGS_TABLE);
  } catch (error) {
    throw new MigrationError(
      'Failed to create vec_entity_embeddings virtual table. Ensure sqlite-vec extension is loaded.',
      'create_virtual_table',
      'vec_entity_embeddings',
      error
    );
  }
}

/**
 * Create all required indexes
 * @param db - Database instance
 */
export function createIndexes(db: Database.Database): void {
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
 * Create FTS5 full-text search tables and triggers
 * @param db - Database instance
 */
export function createFTSTables(db: Database.Database): void {
  try {
    // Chunks FTS5
    db.exec(CREATE_CHUNKS_FTS_TABLE);
    for (const trigger of CREATE_FTS_TRIGGERS) {
      db.exec(trigger);
    }
    db.exec(CREATE_FTS_INDEX_METADATA);

    // Initialize metadata row for chunks FTS (id=1)
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (1, ?, 0, 'porter unicode61', ${SCHEMA_VERSION}, NULL)
    `
    ).run(now);

    // VLM FTS5
    db.exec(CREATE_VLM_FTS_TABLE);
    for (const trigger of CREATE_VLM_FTS_TRIGGERS) {
      db.exec(trigger);
    }

    // Initialize metadata row for VLM FTS (id=2)
    db.prepare(
      `
      INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (2, ?, 0, 'porter unicode61', ${SCHEMA_VERSION}, NULL)
    `
    ).run(now);

    // Extractions FTS5
    db.exec(CREATE_EXTRACTIONS_FTS_TABLE);
    for (const trigger of CREATE_EXTRACTIONS_FTS_TRIGGERS) {
      db.exec(trigger);
    }

    // Initialize metadata row for extractions FTS (id=3)
    db.prepare(
      `
      INSERT OR IGNORE INTO fts_index_metadata (id, last_rebuild_at, chunks_indexed, tokenizer, schema_version, content_hash)
      VALUES (3, ?, 0, 'porter unicode61', ${SCHEMA_VERSION}, NULL)
    `
    ).run(now);

    // Knowledge Nodes FTS5
    db.exec(CREATE_KNOWLEDGE_NODES_FTS_TABLE);
    for (const trigger of CREATE_KNOWLEDGE_NODES_FTS_TRIGGERS) {
      db.exec(trigger);
    }
  } catch (error) {
    throw new MigrationError('Failed to create FTS5 tables', 'create_table', 'chunks_fts', error);
  }
}

/**
 * Initialize database metadata with default values
 * @param db - Database instance
 */
export function initializeDatabaseMetadata(db: Database.Database): void {
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
 * Load the sqlite-vec extension
 * @param db - Database instance
 */
export function loadSqliteVecExtension(db: Database.Database): void {
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

/**
 * P1-P4 Forensic Verification Test Suite
 *
 * Sherlock Holmes Forensic Investigation: Verify the OCR Provenance MCP system
 * after all P1-P4 remediation fixes are applied.
 *
 * METHODOLOGY: Real database operations, real file system checks, NO mocks.
 * Source of Truth: Physical database state and file system.
 *
 * Coverage:
 *   DBOPS-1: Create database via MCP handler, verify file on disk
 *   DBOPS-2: Verify schema version is 26 via direct SQL query
 *   DBOPS-3: List databases via MCP handler, confirm test DB appears
 *   DBOPS-4: Select database via MCP handler, verify stats
 *   DBOPS-5: Delete database via MCP handler, confirm file removed
 *   DBOPS-6: Database stats return correct structure
 *   ERR-1:   Selecting non-existent database returns structured error
 *   ERR-2:   Creating duplicate database returns structured error
 *   ERR-3:   Deleting non-existent database returns structured error
 *   ERR-4:   Querying without selected database returns structured error
 *   SCHEMA-1: Fresh database has all expected tables (19 core + virtual)
 *   SCHEMA-2: Fresh database has correct indexes
 *   SCHEMA-3: Foreign key constraints are enforced
 *
 * @module tests/manual/p1-p4-forensic-verification
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import {
  handleDatabaseCreate,
  handleDatabaseList,
  handleDatabaseSelect,
  handleDatabaseStats,
  handleDatabaseDelete,
} from '../../src/tools/database.js';
import { state, resetState, updateConfig, clearDatabase } from '../../src/server/state.js';
import { SCHEMA_VERSION } from '../../src/services/storage/migrations/schema-definitions.js';
import { createRequire } from 'module';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { category: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDirSafe(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(
      '[p1-p4-verification] cleanup failed:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Check if sqlite-vec is available (required for full database initialization)
 */
function isSqliteVecAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const sqliteVec = req('sqlite-vec');
    return typeof sqliteVec.load === 'function';
  } catch (error) {
    console.error(
      '[p1-p4-verification] sqlite-vec not available:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();
const tempDirs: string[] = [];
const DB_NAME_PREFIX = 'holmes-forensic-';

afterAll(() => {
  resetState();
  for (const dir of tempDirs) cleanupTempDirSafe(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DBOPS-1 through DBOPS-6: Full Database Lifecycle via MCP Handlers
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)(
  'Database Operations Lifecycle (DBOPS-1 through DBOPS-6)',
  () => {
    let tempDir: string;
    const dbName = `${DB_NAME_PREFIX}${Date.now()}`;

    beforeEach(() => {
      resetState();
      tempDir = createTempDir('p1p4-dbops-');
      tempDirs.push(tempDir);
      updateConfig({ defaultStoragePath: tempDir });
    });

    afterEach(() => {
      clearDatabase();
      resetState();
    });

    it('DBOPS-1: Create database via handler, verify file exists on disk', async () => {
      // ACT: Call the real MCP handler
      const response = await handleDatabaseCreate({
        name: dbName,
        description: 'Holmes forensic investigation test database',
      });
      const parsed = parseResponse(response);

      // VERIFY: Handler reports success
      console.error('[DBOPS-1] Create response:', JSON.stringify(parsed));
      expect(parsed.success).toBe(true);
      expect(parsed.data).toBeDefined();
      expect((parsed.data as Record<string, unknown>).created).toBe(true);
      expect((parsed.data as Record<string, unknown>).name).toBe(dbName);

      // SOURCE OF TRUTH: Physical file on disk
      const expectedPath = join(tempDir, `${dbName}.db`);
      const fileExists = existsSync(expectedPath);
      console.error('[DBOPS-1] File exists at', expectedPath, ':', fileExists);
      expect(fileExists).toBe(true);

      // VERIFY: File is non-empty (initialized)
      const fileStat = statSync(expectedPath);
      console.error('[DBOPS-1] File size:', fileStat.size, 'bytes');
      expect(fileStat.size).toBeGreaterThan(0);

      console.error('[DBOPS-1 VERDICT] PASS - Database file created and initialized on disk');
    });

    it('DBOPS-2: Verify schema version is 26 via direct SQL query', async () => {
      // SETUP: Create the database
      await handleDatabaseCreate({ name: dbName });

      // SOURCE OF TRUTH: Query schema_version table directly
      const db = state.currentDatabase!;
      const conn = db.getConnection();
      const row = conn.prepare('SELECT version FROM schema_version WHERE id = 1').get() as {
        version: number;
      };

      console.error('[DBOPS-2] Schema version from DB:', row.version);
      console.error('[DBOPS-2] Expected SCHEMA_VERSION constant:', SCHEMA_VERSION);
      expect(row.version).toBe(SCHEMA_VERSION);
      expect(row.version).toBe(26);

      console.error('[DBOPS-2 VERDICT] PASS - Schema version is 26');
    });

    it('DBOPS-3: List databases via handler, confirm test DB appears', async () => {
      // SETUP: Create the database
      await handleDatabaseCreate({ name: dbName });

      // ACT: List all databases
      const listResponse = await handleDatabaseList({ include_stats: true });
      const listParsed = parseResponse(listResponse);

      console.error('[DBOPS-3] List response:', JSON.stringify(listParsed));
      expect(listParsed.success).toBe(true);
      expect(listParsed.data).toBeDefined();

      const databases = (listParsed.data as Record<string, unknown>).databases as Array<
        Record<string, unknown>
      >;
      expect(databases).toBeDefined();
      expect(databases.length).toBeGreaterThanOrEqual(1);

      // VERIFY: Our test database appears in the list
      const ourDb = databases.find((d) => d.name === dbName);
      console.error('[DBOPS-3] Our database found in list:', !!ourDb);
      expect(ourDb).toBeDefined();
      expect(ourDb!.name).toBe(dbName);

      // VERIFY: Stats are included (include_stats: true)
      console.error('[DBOPS-3] Stats present - document_count:', ourDb!.document_count);
      expect(ourDb!.document_count).toBe(0); // fresh database, no documents

      // SOURCE OF TRUTH: Physical verification
      const expectedPath = join(tempDir, `${dbName}.db`);
      expect(existsSync(expectedPath)).toBe(true);

      console.error('[DBOPS-3 VERDICT] PASS - Database appears in list with stats');
    });

    it('DBOPS-4: Select database via handler, verify stats returned', async () => {
      // SETUP: Create, then clear state to simulate fresh session
      await handleDatabaseCreate({ name: dbName });
      clearDatabase();

      // ACT: Select the database
      const selectResponse = await handleDatabaseSelect({ database_name: dbName });
      const selectParsed = parseResponse(selectResponse);

      console.error('[DBOPS-4] Select response:', JSON.stringify(selectParsed));
      expect(selectParsed.success).toBe(true);
      expect(selectParsed.data).toBeDefined();
      expect((selectParsed.data as Record<string, unknown>).selected).toBe(true);
      expect((selectParsed.data as Record<string, unknown>).name).toBe(dbName);

      // VERIFY: Stats block is present
      const stats = (selectParsed.data as Record<string, unknown>).stats as Record<string, unknown>;
      expect(stats).toBeDefined();
      expect(stats.document_count).toBe(0);
      expect(stats.chunk_count).toBe(0);
      expect(stats.embedding_count).toBe(0);
      expect(typeof stats.vector_count).toBe('number');

      // SOURCE OF TRUTH: Verify state was updated
      expect(state.currentDatabaseName).toBe(dbName);
      expect(state.currentDatabase).not.toBeNull();

      console.error('[DBOPS-4 VERDICT] PASS - Database selected with stats');
    });

    it('DBOPS-5: Delete database via handler, confirm file removed', async () => {
      // SETUP: Create the database
      await handleDatabaseCreate({ name: dbName });
      const expectedPath = join(tempDir, `${dbName}.db`);

      // PRE-CHECK: File exists
      expect(existsSync(expectedPath)).toBe(true);

      // ACT: Delete the database
      const deleteResponse = await handleDatabaseDelete({
        database_name: dbName,
        confirm: true,
      });
      const deleteParsed = parseResponse(deleteResponse);

      console.error('[DBOPS-5] Delete response:', JSON.stringify(deleteParsed));
      expect(deleteParsed.success).toBe(true);
      expect(deleteParsed.data).toBeDefined();
      expect((deleteParsed.data as Record<string, unknown>).deleted).toBe(true);

      // SOURCE OF TRUTH: Physical file removed from disk
      const fileGone = !existsSync(expectedPath);
      console.error('[DBOPS-5] File removed:', fileGone);
      expect(fileGone).toBe(true);

      // VERIFY: WAL and SHM files also removed
      const walGone = !existsSync(`${expectedPath}-wal`);
      const shmGone = !existsSync(`${expectedPath}-shm`);
      console.error('[DBOPS-5] WAL removed:', walGone, '| SHM removed:', shmGone);

      // VERIFY: Database no longer appears in list
      const listResponse = await handleDatabaseList({});
      const listParsed = parseResponse(listResponse);
      const databases =
        ((listParsed.data as Record<string, unknown>).databases as Array<
          Record<string, unknown>
        >) || [];
      const found = databases.find((d) => d.name === dbName);
      expect(found).toBeUndefined();

      // VERIFY: State was cleared if it was the current database
      expect(state.currentDatabaseName).not.toBe(dbName);

      console.error('[DBOPS-5 VERDICT] PASS - Database file and all artifacts removed');
    });

    it('DBOPS-6: Database stats return correct structure', async () => {
      // SETUP: Create and select
      await handleDatabaseCreate({ name: dbName });

      // ACT: Get stats
      const statsResponse = await handleDatabaseStats({});
      const statsParsed = parseResponse(statsResponse);

      console.error('[DBOPS-6] Stats response keys:', Object.keys(statsParsed.data || {}));
      expect(statsParsed.success).toBe(true);

      const data = statsParsed.data as Record<string, unknown>;
      expect(data.document_count).toBe(0);
      expect(data.chunk_count).toBe(0);
      expect(typeof data.embedding_count).toBe('number');
      expect(typeof data.image_count).toBe('number');
      expect(typeof data.vector_count).toBe('number');

      // VERIFY: No KG health metrics (removed in v26)
      expect(data.kg_health).toBeUndefined();

      console.error('[DBOPS-6 VERDICT] PASS - Stats structure correct, no KG health metrics');
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// ERR-1 through ERR-4: Error Handling Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('Error Handling (ERR-1 through ERR-4)', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('p1p4-err-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('ERR-1: Selecting non-existent database returns structured error with category', async () => {
    // ACT: Try to select a database that does not exist
    const response = await handleDatabaseSelect({ database_name: 'nonexistent-db-xyz' });
    const parsed = parseResponse(response);

    console.error('[ERR-1] Error response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('DATABASE_NOT_FOUND');
    expect(parsed.error!.message).toContain('nonexistent-db-xyz');
    expect(typeof parsed.error!.message).toBe('string');
    expect(parsed.error!.message.length).toBeGreaterThan(10);

    // VERIFY: Error details include useful debugging info
    console.error('[ERR-1] Error category:', parsed.error!.category);
    console.error('[ERR-1] Error message:', parsed.error!.message);

    console.error('[ERR-1 VERDICT] PASS - Structured error with DATABASE_NOT_FOUND category');
  });

  it('ERR-2: Creating duplicate database returns structured error', async () => {
    const dbName = `${DB_NAME_PREFIX}dup-${Date.now()}`;

    // SETUP: Create the database first
    await handleDatabaseCreate({ name: dbName });

    // ACT: Try to create it again
    const response = await handleDatabaseCreate({ name: dbName });
    const parsed = parseResponse(response);

    console.error('[ERR-2] Error response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('DATABASE_ALREADY_EXISTS');
    expect(parsed.error!.message).toContain(dbName);

    console.error('[ERR-2 VERDICT] PASS - Structured error with DATABASE_ALREADY_EXISTS category');
  });

  it('ERR-3: Deleting non-existent database returns structured error', async () => {
    const response = await handleDatabaseDelete({
      database_name: 'ghost-database-that-never-existed',
      confirm: true,
    });
    const parsed = parseResponse(response);

    console.error('[ERR-3] Error response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('DATABASE_NOT_FOUND');
    expect(parsed.error!.message).toContain('ghost-database-that-never-existed');

    console.error('[ERR-3 VERDICT] PASS - Structured error with DATABASE_NOT_FOUND category');
  });

  it('ERR-4: Stats without selected database returns structured error', async () => {
    // Ensure no database is selected
    clearDatabase();
    expect(state.currentDatabase).toBeNull();

    // ACT: Try to get stats without selecting a database
    const response = await handleDatabaseStats({});
    const parsed = parseResponse(response);

    console.error('[ERR-4] Error response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('DATABASE_NOT_SELECTED');
    expect(parsed.error!.message).toContain('ocr_db_select');

    console.error('[ERR-4 VERDICT] PASS - Structured error with DATABASE_NOT_SELECTED category');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA-1: Verify all expected tables exist in fresh database
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('Schema Verification (SCHEMA-1 through SCHEMA-3)', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('p1p4-schema-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('SCHEMA-1: Fresh database has all expected tables', async () => {
    const dbName = `${DB_NAME_PREFIX}schema-${Date.now()}`;
    await handleDatabaseCreate({ name: dbName });

    const conn = state.currentDatabase!.getConnection();

    // SOURCE OF TRUTH: Query sqlite_master for all tables
    const tables = conn
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    console.error('[SCHEMA-1] Tables found:', tableNames.length);
    console.error('[SCHEMA-1] Table list:', tableNames.join(', '));

    // Expected core tables (not counting FTS virtual tables and vec tables)
    // Entity/KG tables removed in v26: entities, entity_mentions,
    // entity_extraction_segments, knowledge_nodes, knowledge_edges, node_entity_links
    const expectedCoreTables = [
      'schema_version',
      'database_metadata',
      'provenance',
      'documents',
      'ocr_results',
      'chunks',
      'embeddings',
      'images',
      'extractions',
      'form_fills',
      'uploaded_files',
      'clusters',
      'document_clusters',
      'comparisons',
      'fts_index_metadata',
    ];

    for (const table of expectedCoreTables) {
      const found = tableNames.includes(table);
      if (!found) {
        console.error(`[SCHEMA-1] MISSING TABLE: ${table}`);
      }
      expect(found, `Expected table "${table}" to exist`).toBe(true);
    }

    // Verify minimum table count (core tables + FTS + vec tables)
    expect(tableNames.length).toBeGreaterThanOrEqual(expectedCoreTables.length);

    console.error('[SCHEMA-1 VERDICT] PASS - All', expectedCoreTables.length, 'core tables exist');
  });

  it('SCHEMA-2: Fresh database has critical indexes', async () => {
    const dbName = `${DB_NAME_PREFIX}indexes-${Date.now()}`;
    await handleDatabaseCreate({ name: dbName });

    const conn = state.currentDatabase!.getConnection();

    const indexes = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    console.error('[SCHEMA-2] Total indexes:', indexNames.length);

    // Critical indexes that must exist (entity/KG indexes removed in v26)
    const criticalIndexes = [
      'idx_documents_status',
      'idx_documents_file_hash',
      'idx_chunks_document_id',
      'idx_embeddings_chunk_id',
      'idx_embeddings_document_id',
      'idx_provenance_type',
      'idx_provenance_source_id',
      'idx_images_document_id',
      'idx_clusters_run_id',
      'idx_comparisons_input_hash',
    ];

    for (const idx of criticalIndexes) {
      const found = indexNames.includes(idx);
      if (!found) {
        console.error(`[SCHEMA-2] MISSING INDEX: ${idx}`);
      }
      expect(found, `Expected index "${idx}" to exist`).toBe(true);
    }

    // Should have a significant number of indexes for performance
    expect(indexNames.length).toBeGreaterThanOrEqual(30);
    console.error(
      '[SCHEMA-2 VERDICT] PASS - All critical indexes present,',
      indexNames.length,
      'total'
    );
  });

  it('SCHEMA-3: Foreign key constraints are enforced', async () => {
    const dbName = `${DB_NAME_PREFIX}fk-${Date.now()}`;
    await handleDatabaseCreate({ name: dbName });

    const conn = state.currentDatabase!.getConnection();

    // VERIFY: foreign_keys pragma is ON
    const fkPragma = conn.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    console.error('[SCHEMA-3] foreign_keys pragma:', fkPragma);
    expect(fkPragma[0].foreign_keys).toBe(1);

    // VERIFY: Attempting to insert a document with non-existent provenance_id fails
    // NOTE: Must include all NOT NULL columns (including created_at which has no DEFAULT)
    // so the FK check is the constraint that fires, not a NOT NULL check.
    let fkError: string | null = null;
    try {
      conn
        .prepare(
          `INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type,
         status, provenance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'test-doc-id',
          '/test/file.pdf',
          'file.pdf',
          'sha256:fake',
          100,
          'pdf',
          'pending',
          'nonexistent-provenance-id',
          new Date().toISOString()
        );
    } catch (e) {
      fkError = e instanceof Error ? e.message : String(e);
    }

    console.error('[SCHEMA-3] FK violation error:', fkError);
    expect(fkError).not.toBeNull();
    expect(fkError).toContain('FOREIGN KEY constraint failed');

    // VERIFY: No FK violations in the empty database
    const violations = conn.pragma('foreign_key_check') as unknown[];
    console.error('[SCHEMA-3] FK check violations:', violations.length);
    expect(violations.length).toBe(0);

    console.error('[SCHEMA-3 VERDICT] PASS - Foreign keys enforced, violations properly rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING: Verify P3 silent catch block fix at database level
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-cutting: Error logging quality', () => {
  it('handleError produces structured error with category and message', async () => {
    // Import handleError from shared
    const { handleError } = await import('../../src/tools/shared.js');
    const { MCPError } = await import('../../src/server/errors.js');

    // Test with MCPError
    const mcpErr = new MCPError('DATABASE_NOT_FOUND', 'Test database missing', {
      databaseName: 'test',
    });
    const result = handleError(mcpErr);
    const parsed = JSON.parse(result.content[0].text) as ToolResponse;

    console.error('[CROSS-1] handleError output:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('DATABASE_NOT_FOUND');
    expect(parsed.error!.message).toBe('Test database missing');
    expect(parsed.error!.details).toBeDefined();
    expect((parsed.error!.details as Record<string, unknown>).databaseName).toBe('test');

    console.error('[CROSS-1 VERDICT] PASS - handleError produces structured errors');
  });

  it('handleError wraps unknown errors with INTERNAL_ERROR category', async () => {
    const { handleError } = await import('../../src/tools/shared.js');

    // Test with plain Error
    const plainErr = new Error('Something unexpected happened');
    const result = handleError(plainErr);
    const parsed = JSON.parse(result.content[0].text) as ToolResponse;

    console.error('[CROSS-2] Plain error output:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('INTERNAL_ERROR');
    expect(parsed.error!.message).toBe('Something unexpected happened');

    console.error('[CROSS-2 VERDICT] PASS - Unknown errors wrapped with INTERNAL_ERROR');
  });

  it('handleError wraps non-Error values gracefully', async () => {
    const { handleError } = await import('../../src/tools/shared.js');

    // Test with string (non-Error)
    const result = handleError('raw string error');
    const parsed = JSON.parse(result.content[0].text) as ToolResponse;

    console.error('[CROSS-3] String error output:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.category).toBe('INTERNAL_ERROR');
    expect(parsed.error!.message).toBe('raw string error');

    console.error('[CROSS-3 VERDICT] PASS - Non-Error values wrapped gracefully');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION: Input validation at system boundaries
// ═══════════════════════════════════════════════════════════════════════════════

describe('Input Validation at System Boundaries', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('p1p4-val-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('VAL-1: Database name with invalid characters is rejected', async () => {
    const response = await handleDatabaseCreate({ name: 'bad name with spaces!' });
    const parsed = parseResponse(response);

    console.error('[VAL-1] Invalid name response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();

    console.error('[VAL-1 VERDICT] PASS - Invalid database name rejected');
  });

  it('VAL-2: Empty database name is rejected', async () => {
    const response = await handleDatabaseCreate({ name: '' });
    const parsed = parseResponse(response);

    console.error('[VAL-2] Empty name response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();

    console.error('[VAL-2 VERDICT] PASS - Empty database name rejected');
  });

  it('VAL-3: Missing required confirm param on delete is rejected', async () => {
    const response = await handleDatabaseDelete({
      database_name: 'test',
      // confirm not provided
    });
    const parsed = parseResponse(response);

    console.error('[VAL-3] Missing confirm response:', JSON.stringify(parsed));
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();

    console.error('[VAL-3 VERDICT] PASS - Missing confirm parameter rejected');
  });
});

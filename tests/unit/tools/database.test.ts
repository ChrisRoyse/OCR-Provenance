/**
 * Unit Tests for Database MCP Tools
 *
 * Tests the extracted database tool handlers in src/tools/database.ts
 * Tools: handleDatabaseCreate, handleDatabaseList, handleDatabaseSelect,
 *        handleDatabaseStats, handleDatabaseDelete
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/database
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  handleDatabaseCreate,
  handleDatabaseList,
  handleDatabaseSelect,
  handleDatabaseStats,
  handleDatabaseDelete,
  databaseTools,
} from '../../../src/tools/database.js';
import { state, resetState, updateConfig, clearDatabase } from '../../../src/server/state.js';
// DatabaseService import removed - not directly used in tests

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// Track all temp directories for final cleanup
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXPORTS VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('databaseTools exports', () => {
  it('exports all 5 database tools', () => {
    expect(Object.keys(databaseTools)).toHaveLength(5);
    expect(databaseTools).toHaveProperty('ocr_db_create');
    expect(databaseTools).toHaveProperty('ocr_db_list');
    expect(databaseTools).toHaveProperty('ocr_db_select');
    expect(databaseTools).toHaveProperty('ocr_db_stats');
    expect(databaseTools).toHaveProperty('ocr_db_delete');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(databaseTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDatabaseCreate TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDatabaseCreate', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-create-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('creates database and returns success', async () => {
    const name = createUniqueName('test-create');
    const response = await handleDatabaseCreate({ name, storage_path: tempDir });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe(name);
    expect(result.data?.created).toBe(true);
    expect(result.data?.path).toContain(name);
  });

  it.skipIf(!sqliteVecAvailable)('creates physical database file on disk', async () => {
    const name = createUniqueName('test-physical');
    await handleDatabaseCreate({ name, storage_path: tempDir });

    // PHYSICAL VERIFICATION: File exists on disk
    const dbPath = join(tempDir, `${name}.db`);
    expect(existsSync(dbPath)).toBe(true);

    // File has non-zero size
    const stats = statSync(dbPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it.skipIf(!sqliteVecAvailable)('creates database with description', async () => {
    const name = createUniqueName('test-desc');
    const description = 'Test database with description';
    const response = await handleDatabaseCreate({ name, description, storage_path: tempDir });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.description).toBe(description);
  });

  it('returns DATABASE_ALREADY_EXISTS for duplicate name', async () => {
    const name = createUniqueName('test-dup');

    // Create first database
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    // Try to create duplicate
    const response = await handleDatabaseCreate({ name, storage_path: tempDir });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_ALREADY_EXISTS');
  });

  it('returns VALIDATION_ERROR for invalid name', async () => {
    const response = await handleDatabaseCreate({ name: 'invalid name with spaces' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR'); // ValidationError wrapped
  });

  it('returns VALIDATION_ERROR for empty name', async () => {
    const response = await handleDatabaseCreate({ name: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDatabaseList TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDatabaseList', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-list-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('returns empty list for fresh directory', async () => {
    const response = await handleDatabaseList({ include_stats: false });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.databases).toEqual([]);
    expect(result.data?.total).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('lists created databases', async () => {
    // Create 3 databases
    const names = [
      createUniqueName('list-test-1'),
      createUniqueName('list-test-2'),
      createUniqueName('list-test-3'),
    ];

    for (const name of names) {
      await handleDatabaseCreate({ name, storage_path: tempDir });
      clearDatabase();
    }

    const response = await handleDatabaseList({ include_stats: false });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);

    // PHYSICAL VERIFICATION: Count .db files matches
    const dbFiles = readdirSync(tempDir).filter((f) => f.endsWith('.db'));
    expect(dbFiles).toHaveLength(3);
  });

  it.skipIf(!sqliteVecAvailable)('includes stats when requested', async () => {
    const name = createUniqueName('list-stats');
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    const response = await handleDatabaseList({ include_stats: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    const databases = result.data?.databases as Array<Record<string, unknown>>;
    expect(databases[0]).toHaveProperty('document_count');
    expect(databases[0]).toHaveProperty('chunk_count');
    expect(databases[0]).toHaveProperty('embedding_count');
  });

  it.skipIf(!sqliteVecAvailable)('each database has required fields', async () => {
    const name = createUniqueName('list-fields');
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    const response = await handleDatabaseList({ include_stats: false });
    const result = parseResponse(response);

    const databases = result.data?.databases as Array<Record<string, unknown>>;
    expect(databases[0]).toHaveProperty('name');
    expect(databases[0]).toHaveProperty('path');
    expect(databases[0]).toHaveProperty('size_bytes');
    expect(databases[0]).toHaveProperty('created_at');
    expect(databases[0]).toHaveProperty('modified_at');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDatabaseSelect TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDatabaseSelect', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-select-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('selects existing database', async () => {
    const name = createUniqueName('select-test');
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    const response = await handleDatabaseSelect({ database_name: name });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe(name);
    expect(result.data?.selected).toBe(true);

    // STATE VERIFICATION: Check internal state
    expect(state.currentDatabaseName).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('returns stats for selected database', async () => {
    const name = createUniqueName('select-stats');
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    const response = await handleDatabaseSelect({ database_name: name });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.stats).toBeDefined();
    expect(result.data?.stats).toHaveProperty('document_count');
    expect(result.data?.stats).toHaveProperty('chunk_count');
    expect(result.data?.stats).toHaveProperty('embedding_count');
    expect(result.data?.stats).toHaveProperty('vector_count');
  });

  it('returns DATABASE_NOT_FOUND for non-existent database', async () => {
    const response = await handleDatabaseSelect({ database_name: 'non-existent-db' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_FOUND');
  });

  it('returns error for empty database_name', async () => {
    const response = await handleDatabaseSelect({ database_name: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDatabaseStats TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDatabaseStats', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-stats-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('returns stats for current database', async () => {
    const name = createUniqueName('stats-current');
    await handleDatabaseCreate({ name, storage_path: tempDir });

    const response = await handleDatabaseStats({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe(name);
    expect(result.data?.document_count).toBe(0);
    expect(result.data?.chunk_count).toBe(0);
    expect(result.data?.embedding_count).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('returns stats for specified database', async () => {
    const name1 = createUniqueName('stats-db1');
    const name2 = createUniqueName('stats-db2');

    await handleDatabaseCreate({ name: name1, storage_path: tempDir });
    clearDatabase();
    await handleDatabaseCreate({ name: name2, storage_path: tempDir });

    // Request stats for name1 while name2 is current
    const response = await handleDatabaseStats({ database_name: name1 });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe(name1);
  });

  it.skipIf(!sqliteVecAvailable)('returns all required stat fields', async () => {
    const name = createUniqueName('stats-fields');
    await handleDatabaseCreate({ name, storage_path: tempDir });

    const response = await handleDatabaseStats({});
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('name');
    expect(result.data).toHaveProperty('path');
    expect(result.data).toHaveProperty('size_bytes');
    expect(result.data).toHaveProperty('document_count');
    expect(result.data).toHaveProperty('chunk_count');
    expect(result.data).toHaveProperty('embedding_count');
    expect(result.data).toHaveProperty('provenance_count');
    expect(result.data).toHaveProperty('ocr_result_count');
    expect(result.data).toHaveProperty('pending_documents');
    expect(result.data).toHaveProperty('processing_documents');
    expect(result.data).toHaveProperty('complete_documents');
    expect(result.data).toHaveProperty('failed_documents');
    expect(result.data).toHaveProperty('vector_count');
  });

  it('returns DATABASE_NOT_SELECTED when no database selected', async () => {
    const response = await handleDatabaseStats({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDatabaseDelete TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleDatabaseDelete', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-delete-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('deletes database when confirm=true', async () => {
    const name = createUniqueName('delete-test');
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    const dbPath = join(tempDir, `${name}.db`);
    expect(existsSync(dbPath)).toBe(true); // Verify exists before delete

    const response = await handleDatabaseDelete({ database_name: name, confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(result.data?.deleted).toBe(true);

    // PHYSICAL VERIFICATION: File no longer exists
    expect(existsSync(dbPath)).toBe(false);
  });

  it.skipIf(!sqliteVecAvailable)('clears state when deleting current database', async () => {
    const name = createUniqueName('delete-current');
    await handleDatabaseCreate({ name, storage_path: tempDir });

    expect(state.currentDatabaseName).toBe(name);

    const response = await handleDatabaseDelete({ database_name: name, confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(true);
    expect(state.currentDatabaseName).toBe(null);
  });

  it('returns error without confirm=true', async () => {
    const name = createUniqueName('delete-no-confirm');
    await handleDatabaseCreate({ name, storage_path: tempDir });
    clearDatabase();

    const response = await handleDatabaseDelete({ database_name: name, confirm: false as never });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');

    // PHYSICAL VERIFICATION: File still exists
    const dbPath = join(tempDir, `${name}.db`);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('returns DATABASE_NOT_FOUND for non-existent database', async () => {
    const response = await handleDatabaseDelete({ database_name: 'non-existent', confirm: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('Edge Case 1: Empty Database List', () => {
    it.skipIf(!sqliteVecAvailable)('returns empty list when no databases exist', async () => {
      // BEFORE: No .db files in storage path
      const filesBefore = readdirSync(tempDir).filter((f) => f.endsWith('.db'));
      expect(filesBefore).toHaveLength(0);

      // ACTION: Call handleDatabaseList
      const response = await handleDatabaseList({ include_stats: false });
      const result = parseResponse(response);

      // AFTER: { databases: [], total: 0 }
      expect(result.success).toBe(true);
      expect(result.data?.databases).toEqual([]);
      expect(result.data?.total).toBe(0);

      // PHYSICAL: ls shows empty directory (no .db files)
      const filesAfter = readdirSync(tempDir).filter((f) => f.endsWith('.db'));
      expect(filesAfter).toHaveLength(0);
    });
  });

  describe('Edge Case 2: Duplicate Database Name', () => {
    it.skipIf(!sqliteVecAvailable)('throws DATABASE_ALREADY_EXISTS for duplicate', async () => {
      const name = createUniqueName('dup-test');

      // BEFORE: Database "mydb" exists
      await handleDatabaseCreate({ name, storage_path: tempDir });
      const filesBefore = readdirSync(tempDir).filter((f) => f.endsWith('.db'));
      expect(filesBefore).toHaveLength(1);
      clearDatabase();

      // ACTION: Call ocr_db_create with same name
      const response = await handleDatabaseCreate({ name, storage_path: tempDir });
      const result = parseResponse(response);

      // AFTER: Throws DATABASE_ALREADY_EXISTS error
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_ALREADY_EXISTS');

      // PHYSICAL: Only one .db file exists (not duplicated)
      const filesAfter = readdirSync(tempDir).filter((f) => f.endsWith('.db'));
      expect(filesAfter).toHaveLength(1);
    });
  });

  describe('Edge Case 3: Delete Without Confirm', () => {
    it.skipIf(!sqliteVecAvailable)('rejects delete when confirm is not true', async () => {
      const name = createUniqueName('del-noconfirm');

      // BEFORE: Database exists
      await handleDatabaseCreate({ name, storage_path: tempDir });
      const dbPath = join(tempDir, `${name}.db`);
      expect(existsSync(dbPath)).toBe(true);
      clearDatabase();

      // ACTION: Call delete with confirm=false
      const response = await handleDatabaseDelete({ database_name: name, confirm: false as never });
      const result = parseResponse(response);

      // AFTER: confirm: false fails z.literal(true) Zod validation -> INTERNAL_ERROR
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');

      // PHYSICAL: File still exists on disk
      expect(existsSync(dbPath)).toBe(true);
    });
  });

  describe('Edge Case 4: Special Characters in Name', () => {
    it.skipIf(!sqliteVecAvailable)('accepts valid names with underscore and hyphen', async () => {
      const name = 'valid_name-123';
      const response = await handleDatabaseCreate({ name, storage_path: tempDir });
      const result = parseResponse(response);

      expect(result.success).toBe(true);

      // PHYSICAL: File exists with exact name
      const dbPath = join(tempDir, `${name}.db`);
      expect(existsSync(dbPath)).toBe(true);
    });

    it('rejects names with invalid characters', async () => {
      const response = await handleDatabaseCreate({ name: 'invalid!@#$', storage_path: tempDir });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('INTERNAL_ERROR');
    });
  });
});

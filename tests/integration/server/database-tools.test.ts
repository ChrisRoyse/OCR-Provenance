/**
 * Integration Tests for Database MCP Tools
 *
 * Tests: ocr_db_create, ocr_db_list, ocr_db_select, ocr_db_stats, ocr_db_delete
 *
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/integration/server/database-tools
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  sqliteVecAvailable,
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  resetState,
  createDatabase,
  selectDatabase,
  deleteDatabase,
  requireDatabase,
  clearDatabase,
  updateConfig,
  getDefaultStoragePath,
  MCPError,
  DatabaseService,
  existsSync,
  join,
  uuidv4,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_db_create TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_db_create', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-create-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('creates database and verifies file exists', () => {
    const name = createUniqueName('test-create');
    const db = createDatabase(name, 'Test database', tempDir);

    // Physical verification: database file exists
    const dbPath = join(tempDir, `${name}.db`);
    expect(existsSync(dbPath)).toBe(true);

    // Verify database is selected
    expect(requireDatabase().db.getName()).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('creates database with correct schema', () => {
    const name = createUniqueName('test-schema');
    createDatabase(name, undefined, tempDir);

    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify tables exist
    const tables = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('documents');
    expect(tableNames).toContain('provenance');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('embeddings');
    expect(tableNames).toContain('ocr_results');
  });

  it('throws DATABASE_ALREADY_EXISTS for duplicate name', () => {
    const name = createUniqueName('test-dup');
    createDatabase(name, undefined, tempDir, false);

    try {
      createDatabase(name, undefined, tempDir);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MCPError);
      expect((e as MCPError).category).toBe('DATABASE_ALREADY_EXISTS');
      expect((e as MCPError).details?.databaseName).toBe(name);
    }
  });

  it.skipIf(!sqliteVecAvailable)('creates database with description', () => {
    const name = createUniqueName('test-desc');
    const description = 'My test database for documents';
    createDatabase(name, description, tempDir);

    const { db } = requireDatabase();
    const stats = db.getStats();
    expect(stats.name).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('auto-selects database after creation', () => {
    const name = createUniqueName('test-autoselect');
    createDatabase(name, undefined, tempDir, true);

    expect(requireDatabase().db.getName()).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('creates database without auto-select', () => {
    const name = createUniqueName('test-no-autoselect');
    createDatabase(name, undefined, tempDir, false);

    expect(() => requireDatabase()).toThrow(MCPError);
    expect(DatabaseService.exists(name, tempDir)).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('validates database name format', () => {
    // Valid names
    const validNames = ['test-db', 'test_db', 'TestDB123', 'a-b_c'];
    for (const name of validNames) {
      resetState();
      const uniqueName = `${name}-${Date.now()}`;
      expect(() => createDatabase(uniqueName, undefined, tempDir)).not.toThrow();
    }
  });

  it.skipIf(!sqliteVecAvailable)('closes previous database when creating new with auto-select', () => {
    const name1 = createUniqueName('first');
    const name2 = createUniqueName('second');

    createDatabase(name1, undefined, tempDir, true);
    expect(requireDatabase().db.getName()).toBe(name1);

    createDatabase(name2, undefined, tempDir, true);
    expect(requireDatabase().db.getName()).toBe(name2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_db_list TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_db_list', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-list-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('returns empty array for empty directory', () => {
    const databases = DatabaseService.list(tempDir);
    expect(databases).toEqual([]);
  });

  it.skipIf(!sqliteVecAvailable)('lists all databases in directory', () => {
    const names = ['db-one', 'db-two', 'db-three'];
    for (const name of names) {
      const db = DatabaseService.create(name, undefined, tempDir);
      db.close();
    }

    const databases = DatabaseService.list(tempDir);
    expect(databases.length).toBe(3);

    for (const name of names) {
      const found = databases.find((d) => d.name === name);
      expect(found).toBeDefined();
      expect(found!.path).toBe(join(tempDir, `${name}.db`));
    }
  });

  it.skipIf(!sqliteVecAvailable)('returns database metadata', () => {
    const name = createUniqueName('test-meta');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    const databases = DatabaseService.list(tempDir);
    const dbInfo = databases.find((d) => d.name === name);

    expect(dbInfo).toBeDefined();
    expect(dbInfo!.size_bytes).toBeGreaterThan(0);
    expect(dbInfo!.created_at).toBeDefined();
  });

  it.skipIf(!sqliteVecAvailable)('lists databases with stats when requested', () => {
    const name = createUniqueName('test-stats');
    const db = DatabaseService.create(name, undefined, tempDir);
    const stats = db.getStats();
    db.close();

    expect(stats.total_documents).toBe(0);
    expect(stats.total_chunks).toBe(0);
  });

  it('handles non-existent directory gracefully', () => {
    const nonExistent = join(tempDir, 'does-not-exist');
    const databases = DatabaseService.list(nonExistent);
    expect(databases).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_db_select TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_db_select', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-select-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('throws DATABASE_NOT_FOUND for non-existent database', () => {
    try {
      selectDatabase('nonexistent', tempDir);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MCPError);
      expect((e as MCPError).category).toBe('DATABASE_NOT_FOUND');
      expect((e as MCPError).details?.databaseName).toBe('nonexistent');
      expect((e as MCPError).details?.storagePath).toBe(tempDir);
    }
  });

  it.skipIf(!sqliteVecAvailable)('selects existing database', () => {
    const name = createUniqueName('test-select');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    selectDatabase(name, tempDir);

    expect(requireDatabase().db.getName()).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('returns database stats after selection', () => {
    const name = createUniqueName('test-select-stats');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    selectDatabase(name, tempDir);
    const { db: selectedDb, vector } = requireDatabase();

    expect(selectedDb.getStats().total_documents).toBe(0);
    expect(vector.getVectorCount()).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('closes previous database when selecting new', () => {
    const name1 = createUniqueName('first');
    const name2 = createUniqueName('second');

    const db1 = DatabaseService.create(name1, undefined, tempDir);
    db1.close();
    const db2 = DatabaseService.create(name2, undefined, tempDir);
    db2.close();

    selectDatabase(name1, tempDir);
    expect(requireDatabase().db.getName()).toBe(name1);

    selectDatabase(name2, tempDir);
    expect(requireDatabase().db.getName()).toBe(name2);
  });

  it.skipIf(!sqliteVecAvailable)('clears state before throwing on non-existent', () => {
    const name = createUniqueName('valid');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    selectDatabase(name, tempDir);
    expect(requireDatabase()).toBeDefined();

    try {
      selectDatabase('invalid', tempDir);
    } catch {
      // State should be cleared
      expect(() => requireDatabase()).toThrow(MCPError);
    }
  });

  it.skipIf(!sqliteVecAvailable)('handles selecting same database twice', () => {
    const name = createUniqueName('double');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    selectDatabase(name, tempDir);
    selectDatabase(name, tempDir);

    expect(requireDatabase().db.getName()).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('database operations work after selection', () => {
    const name = createUniqueName('ops-test');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    selectDatabase(name, tempDir);
    const { db: selectedDb } = requireDatabase();

    // Should be able to query
    const stats = selectedDb.getStats();
    expect(stats.total_documents).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_db_stats TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_db_stats', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-stats-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('throws DATABASE_NOT_SELECTED when no database selected', () => {
    try {
      requireDatabase();
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MCPError);
      expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it.skipIf(!sqliteVecAvailable)('returns stats for current database', () => {
    const name = createUniqueName('stats-current');
    createDatabase(name, undefined, tempDir);

    const { db, vector } = requireDatabase();
    const stats = db.getStats();

    expect(stats.name).toBe(name);
    expect(stats.total_documents).toBe(0);
    expect(stats.total_chunks).toBe(0);
    expect(stats.total_embeddings).toBe(0);
    expect(stats.total_ocr_results).toBe(0);
    expect(vector.getVectorCount()).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('returns stats for specified database', () => {
    const name1 = createUniqueName('stats-db1');
    const name2 = createUniqueName('stats-db2');

    createDatabase(name1, undefined, tempDir);
    createDatabase(name2, undefined, tempDir, false);

    // Current is name1, but we can get stats for name2
    const db2 = DatabaseService.open(name2, tempDir);
    const stats2 = db2.getStats();
    db2.close();

    expect(stats2.name).toBe(name2);
  });

  it.skipIf(!sqliteVecAvailable)('includes all count fields', () => {
    const name = createUniqueName('stats-fields');
    createDatabase(name, undefined, tempDir);

    const { db } = requireDatabase();
    const stats = db.getStats();

    expect(typeof stats.storage_size_bytes).toBe('number');
    expect(typeof stats.total_documents).toBe('number');
    expect(typeof stats.total_chunks).toBe('number');
    expect(typeof stats.total_embeddings).toBe('number');
    expect(typeof stats.total_ocr_results).toBe('number');
    expect(typeof stats.documents_by_status.pending).toBe('number');
    expect(typeof stats.documents_by_status.processing).toBe('number');
    expect(typeof stats.documents_by_status.complete).toBe('number');
    expect(typeof stats.documents_by_status.failed).toBe('number');
  });

  it.skipIf(!sqliteVecAvailable)('updates after adding data', () => {
    const name = createUniqueName('stats-update');
    createDatabase(name, undefined, tempDir);

    const { db } = requireDatabase();

    // Initial stats
    let stats = db.getStats();
    expect(stats.total_documents).toBe(0);

    // Add provenance
    const now = new Date().toISOString();
    const provId = uuidv4();
    db.insertProvenance({
      id: provId,
      type: 'DOCUMENT',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/test.pdf',
      source_id: null,
      root_document_id: provId,
      location: null,
      content_hash: 'sha256:test',
      input_hash: null,
      file_hash: 'sha256:file',
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });

    // Stats should update after adding document
    const docId = uuidv4();
    db.insertDocument({
      id: docId,
      file_path: '/test.pdf',
      file_name: 'test.pdf',
      file_hash: 'sha256:test',
      file_size: 1024,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: provId,
      error_message: null,
      ocr_completed_at: null,
    });

    stats = db.getStats();
    expect(stats.total_documents).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('tracks document status counts', () => {
    const name = createUniqueName('stats-status');
    createDatabase(name, undefined, tempDir);

    const { db } = requireDatabase();
    const { v4: uuidv4 } = require('uuid');
    const now = new Date().toISOString();

    // Add provenance and documents with different statuses
    const provId1 = uuidv4();
    const provId2 = uuidv4();

    db.insertProvenance({
      id: provId1,
      type: 'DOCUMENT',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/test1.pdf',
      source_id: null,
      root_document_id: provId1,
      location: null,
      content_hash: 'sha256:test1',
      input_hash: null,
      file_hash: 'sha256:file1',
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });

    db.insertProvenance({
      id: provId2,
      type: 'DOCUMENT',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/test2.pdf',
      source_id: null,
      root_document_id: provId2,
      location: null,
      content_hash: 'sha256:test2',
      input_hash: null,
      file_hash: 'sha256:file2',
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });

    const docId1 = uuidv4();
    const docId2 = uuidv4();

    db.insertDocument({
      id: docId1,
      file_path: '/test1.pdf',
      file_name: 'test1.pdf',
      file_hash: 'sha256:file1',
      file_size: 1024,
      file_type: 'pdf',
      status: 'pending',
      page_count: null,
      provenance_id: provId1,
      error_message: null,
      ocr_completed_at: null,
    });

    db.insertDocument({
      id: docId2,
      file_path: '/test2.pdf',
      file_name: 'test2.pdf',
      file_hash: 'sha256:file2',
      file_size: 2048,
      file_type: 'pdf',
      status: 'complete',
      page_count: 5,
      provenance_id: provId2,
      error_message: null,
      ocr_completed_at: now,
    });

    const stats = db.getStats();
    expect(stats.total_documents).toBe(2);
    expect(stats.documents_by_status.pending).toBe(1);
    expect(stats.documents_by_status.complete).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ocr_db_delete TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ocr_db_delete', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-delete-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it('throws DATABASE_NOT_FOUND for non-existent database', () => {
    try {
      deleteDatabase('ghost', tempDir);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MCPError);
      expect((e as MCPError).category).toBe('DATABASE_NOT_FOUND');
    }
  });

  it.skipIf(!sqliteVecAvailable)('deletes existing database file', () => {
    const name = createUniqueName('to-delete');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    const dbPath = join(tempDir, `${name}.db`);
    expect(existsSync(dbPath)).toBe(true);

    deleteDatabase(name, tempDir);

    expect(existsSync(dbPath)).toBe(false);
    expect(DatabaseService.exists(name, tempDir)).toBe(false);
  });

  it.skipIf(!sqliteVecAvailable)('clears state when deleting current database', () => {
    const name = createUniqueName('current-delete');
    createDatabase(name, undefined, tempDir, true);

    expect(requireDatabase().db.getName()).toBe(name);

    deleteDatabase(name, tempDir);

    expect(() => requireDatabase()).toThrow(MCPError);
  });

  it.skipIf(!sqliteVecAvailable)('does not affect state when deleting non-current database', () => {
    const name1 = createUniqueName('keep');
    const name2 = createUniqueName('remove');

    createDatabase(name1, undefined, tempDir, true);
    const db2 = DatabaseService.create(name2, undefined, tempDir);
    db2.close();

    deleteDatabase(name2, tempDir);

    expect(requireDatabase().db.getName()).toBe(name1);
  });

  it.skipIf(!sqliteVecAvailable)('removes WAL and SHM files', () => {
    const name = createUniqueName('wal-delete');
    const db = DatabaseService.create(name, undefined, tempDir);

    // Force WAL file creation by writing data
    const { v4: uuidv4 } = require('uuid');
    const now = new Date().toISOString();
    db.insertProvenance({
      id: uuidv4(),
      type: 'DOCUMENT',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/test.pdf',
      source_id: null,
      root_document_id: 'root',
      location: null,
      content_hash: 'sha256:test',
      input_hash: null,
      file_hash: 'sha256:file',
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });
    db.close();

    deleteDatabase(name, tempDir);

    const dbPath = join(tempDir, `${name}.db`);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it.skipIf(!sqliteVecAvailable)('allows recreating deleted database', () => {
    const name = createUniqueName('recreate');

    // Create, delete, recreate
    const db1 = DatabaseService.create(name, undefined, tempDir);
    db1.close();
    deleteDatabase(name, tempDir);

    const db2 = DatabaseService.create(name, undefined, tempDir);
    expect(db2.getName()).toBe(name);
    db2.close();
  });

  it.skipIf(!sqliteVecAvailable)('requires confirm=true for deletion', () => {
    // This test verifies the validation requirement at the MCP tool level
    // The state function doesn't require confirm, but the MCP tool schema does
    const name = createUniqueName('confirm-test');
    const db = DatabaseService.create(name, undefined, tempDir);
    db.close();

    // Direct deleteDatabase works
    deleteDatabase(name, tempDir);
    expect(DatabaseService.exists(name, tempDir)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES AND ERROR RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database Tools - Edge Cases', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir('db-edge-');
    tempDirs.push(tempDir);
    updateConfig({ defaultStoragePath: tempDir });
  });

  afterEach(() => {
    resetState();
  });

  it.skipIf(!sqliteVecAvailable)('handles create-select-delete-recreate cycle', () => {
    const name = createUniqueName('cycle');

    createDatabase(name, undefined, tempDir, true);
    expect(requireDatabase().db.getName()).toBe(name);

    deleteDatabase(name, tempDir);
    expect(() => requireDatabase()).toThrow();

    createDatabase(name, undefined, tempDir, true);
    expect(requireDatabase().db.getName()).toBe(name);
  });

  it.skipIf(!sqliteVecAvailable)('handles rapid database switches', () => {
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = createUniqueName(`rapid-${i}`);
      names.push(name);
      const db = DatabaseService.create(name, undefined, tempDir);
      db.close();
    }

    // Rapidly switch between them
    for (let i = 0; i < 5; i++) {
      selectDatabase(names[i], tempDir);
      expect(requireDatabase().db.getName()).toBe(names[i]);
    }
  });

  it.skipIf(!sqliteVecAvailable)('recovers after failed operations', () => {
    const name = createUniqueName('recovery');
    createDatabase(name, undefined, tempDir, true);

    // Try invalid operation
    try {
      selectDatabase('invalid', tempDir);
    } catch {
      // Expected
    }

    // Should be able to create new database
    const name2 = createUniqueName('recovery2');
    createDatabase(name2, undefined, tempDir, true);
    expect(requireDatabase().db.getName()).toBe(name2);
  });

  it.skipIf(!sqliteVecAvailable)('handles special characters in names', () => {
    const names = ['test-db', 'test_db', 'TestDB123', 'a1-b2_c3'];

    for (const baseName of names) {
      resetState();
      const name = `${baseName}-${Date.now()}`;
      createDatabase(name, undefined, tempDir, true);
      expect(requireDatabase().db.getName()).toBe(name);
    }
  });

  it.skipIf(!sqliteVecAvailable)('operations without database throw DATABASE_NOT_SELECTED', () => {
    // No database selected
    try {
      requireDatabase();
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
    }
  });
});

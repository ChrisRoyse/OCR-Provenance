/**
 * Unit tests for MCP Server State Management
 *
 * Tests server state, database selection, configuration management.
 * Uses REAL DatabaseService instances with temporary databases - NO MOCKS.
 *
 * FAIL FAST: All state access throws immediately if preconditions not met.
 *
 * @module tests/unit/server/state
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  state,
  requireDatabase,
  hasDatabase,
  getCurrentDatabaseName,
  selectDatabase,
  createDatabase,
  deleteDatabase,
  clearDatabase,
  getConfig,
  updateConfig,
  resetConfig,
  getDefaultStoragePath,
  resetState,
} from '../../../src/server/state.js';
import { MCPError } from '../../../src/server/errors.js';
import { DatabaseService } from '../../../src/services/storage/database/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create unique temp directory for each test to ensure isolation
 */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-state-test-'));
}

/**
 * Clean up temp directory
 */
function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors in tests
  }
}

// Track all temp directories for final cleanup
const tempDirs: string[] = [];

afterAll(() => {
  // Clean up any remaining temp directories
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Server State', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  describe('state object', () => {
    it('should initialize with null database', () => {
      expect(state.currentDatabase).toBe(null);
      expect(state.currentDatabaseName).toBe(null);
    });

    it('should have default config', () => {
      expect(state.config).toBeDefined();
      expect(state.config.defaultOCRMode).toBe('balanced');
      expect(state.config.maxConcurrent).toBe(3);
      expect(state.config.embeddingBatchSize).toBe(32);
    });
  });

  describe('hasDatabase', () => {
    it('should return false when no database selected', () => {
      expect(hasDatabase()).toBe(false);
    });

    it('should return true when database is selected', () => {
      createDatabase('test-has-db', undefined, tempDir, true);

      expect(hasDatabase()).toBe(true);
    });
  });

  describe('getCurrentDatabaseName', () => {
    it('should return null when no database selected', () => {
      expect(getCurrentDatabaseName()).toBe(null);
    });

    it('should return database name when selected', () => {
      createDatabase('my-database', undefined, tempDir, true);

      expect(getCurrentDatabaseName()).toBe('my-database');
    });
  });

  describe('requireDatabase', () => {
    it('should throw DATABASE_NOT_SELECTED when no database', () => {
      expect(() => requireDatabase()).toThrow(MCPError);

      try {
        requireDatabase();
      } catch (e) {
        expect(e).toBeInstanceOf(MCPError);
        expect((e as MCPError).category).toBe('DATABASE_NOT_SELECTED');
        expect((e as MCPError).message).toContain('No database selected');
      }
    });

    it('should return database services when database is selected', () => {
      createDatabase('require-db-test', undefined, tempDir, true);

      const services = requireDatabase();

      expect(services.db).toBeDefined();
      expect(services.vector).toBeDefined();
      expect(services.db.getName()).toBe('require-db-test');
    });

    it('should return VectorService connected to same database', () => {
      createDatabase('vector-test', undefined, tempDir, true);

      const services = requireDatabase();

      // VectorService should be able to query the database
      expect(services.vector).toBeDefined();
      expect(services.vector.getVectorCount()).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SELECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('selectDatabase', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should throw DATABASE_NOT_FOUND for non-existent database', () => {
    expect(() => selectDatabase('nonexistent', tempDir)).toThrow(MCPError);

    try {
      selectDatabase('nonexistent', tempDir);
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_NOT_FOUND');
      expect((e as MCPError).message).toContain('nonexistent');
      expect((e as MCPError).details?.databaseName).toBe('nonexistent');
      expect((e as MCPError).details?.storagePath).toBe(tempDir);
    }
  });

  it('should select existing database', () => {
    // Create database first (without auto-select)
    const db = DatabaseService.create('select-test', undefined, tempDir);
    db.close();

    selectDatabase('select-test', tempDir);

    expect(hasDatabase()).toBe(true);
    expect(getCurrentDatabaseName()).toBe('select-test');
  });

  it('should close previous database when selecting new one', () => {
    // Create two databases
    const db1 = DatabaseService.create('db-one', undefined, tempDir);
    db1.close();
    const db2 = DatabaseService.create('db-two', undefined, tempDir);
    db2.close();

    selectDatabase('db-one', tempDir);
    expect(getCurrentDatabaseName()).toBe('db-one');

    selectDatabase('db-two', tempDir);
    expect(getCurrentDatabaseName()).toBe('db-two');
  });

  it('should clear state before throwing on non-existent', () => {
    // First select a valid database
    const db = DatabaseService.create('valid-db', undefined, tempDir);
    db.close();
    selectDatabase('valid-db', tempDir);

    // Now try to select non-existent - should clear state first
    try {
      selectDatabase('does-not-exist', tempDir);
    } catch {
      // State should be cleared
      expect(hasDatabase()).toBe(false);
      expect(getCurrentDatabaseName()).toBe(null);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE CREATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('createDatabase', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should create new database and auto-select', () => {
    const db = createDatabase('new-db', 'Test description', tempDir, true);

    expect(db).toBeDefined();
    expect(hasDatabase()).toBe(true);
    expect(getCurrentDatabaseName()).toBe('new-db');
  });

  it('should create database without auto-select', () => {
    const db = createDatabase('no-select-db', undefined, tempDir, false);

    expect(db).toBeDefined();
    expect(hasDatabase()).toBe(false);
    expect(getCurrentDatabaseName()).toBe(null);

    // Verify database file was created
    expect(DatabaseService.exists('no-select-db', tempDir)).toBe(true);
  });

  it('should throw DATABASE_ALREADY_EXISTS for duplicate name', () => {
    createDatabase('duplicate', undefined, tempDir, false);

    expect(() => createDatabase('duplicate', undefined, tempDir, false)).toThrow(MCPError);

    try {
      createDatabase('duplicate', undefined, tempDir);
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_ALREADY_EXISTS');
      expect((e as MCPError).details?.databaseName).toBe('duplicate');
    }
  });

  it('should close previous database when auto-selecting new', () => {
    createDatabase('first-db', undefined, tempDir, true);
    expect(getCurrentDatabaseName()).toBe('first-db');

    createDatabase('second-db', undefined, tempDir, true);
    expect(getCurrentDatabaseName()).toBe('second-db');
  });

  it('should default to auto-select true', () => {
    createDatabase('auto-select-default', undefined, tempDir);

    expect(hasDatabase()).toBe(true);
    expect(getCurrentDatabaseName()).toBe('auto-select-default');
  });

  it('should create database with description', () => {
    const db = createDatabase('with-desc', 'My test database', tempDir, true);

    const stats = db.getStats();
    expect(stats.name).toBe('with-desc');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE DELETION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('deleteDatabase', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should throw DATABASE_NOT_FOUND for non-existent database', () => {
    expect(() => deleteDatabase('ghost', tempDir)).toThrow(MCPError);

    try {
      deleteDatabase('ghost', tempDir);
    } catch (e) {
      expect((e as MCPError).category).toBe('DATABASE_NOT_FOUND');
    }
  });

  it('should delete existing database', () => {
    const db = DatabaseService.create('to-delete', undefined, tempDir);
    db.close();

    expect(DatabaseService.exists('to-delete', tempDir)).toBe(true);

    deleteDatabase('to-delete', tempDir);

    expect(DatabaseService.exists('to-delete', tempDir)).toBe(false);
  });

  it('should clear state when deleting current database', () => {
    createDatabase('current-to-delete', undefined, tempDir, true);
    expect(getCurrentDatabaseName()).toBe('current-to-delete');

    deleteDatabase('current-to-delete', tempDir);

    expect(hasDatabase()).toBe(false);
    expect(getCurrentDatabaseName()).toBe(null);
  });

  it('should not affect state when deleting non-current database', () => {
    createDatabase('keep-selected', undefined, tempDir, true);
    const otherDb = DatabaseService.create('to-remove', undefined, tempDir);
    otherDb.close();

    deleteDatabase('to-remove', tempDir);

    expect(getCurrentDatabaseName()).toBe('keep-selected');
    expect(hasDatabase()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEAR DATABASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('clearDatabase', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should do nothing when no database selected', () => {
    expect(() => clearDatabase()).not.toThrow();
    expect(hasDatabase()).toBe(false);
  });

  it('should clear current database selection', () => {
    createDatabase('to-clear', undefined, tempDir, true);
    expect(hasDatabase()).toBe(true);

    clearDatabase();

    expect(hasDatabase()).toBe(false);
    expect(getCurrentDatabaseName()).toBe(null);
  });

  it('should close database connection', () => {
    createDatabase('close-test', undefined, tempDir, true);
    const { db: _db } = requireDatabase();

    clearDatabase();

    // After clearing, requireDatabase should throw
    expect(() => requireDatabase()).toThrow(MCPError);
  });

  it('should be idempotent', () => {
    createDatabase('idempotent', undefined, tempDir, true);

    clearDatabase();
    clearDatabase();
    clearDatabase();

    expect(hasDatabase()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Configuration', () => {
  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
  });

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const config = getConfig();

      expect(config.defaultOCRMode).toBe('balanced');
      expect(config.maxConcurrent).toBe(3);
      expect(config.embeddingBatchSize).toBe(32);
    });

    it('should return a copy, not the original', () => {
      const config1 = getConfig();
      config1.maxConcurrent = 999;

      const config2 = getConfig();
      expect(config2.maxConcurrent).toBe(3);
    });
  });

  describe('updateConfig', () => {
    it('should update single field', () => {
      updateConfig({ maxConcurrent: 10 });

      const config = getConfig();
      expect(config.maxConcurrent).toBe(10);
      expect(config.defaultOCRMode).toBe('balanced'); // Unchanged
    });

    it('should update multiple fields', () => {
      updateConfig({
        maxConcurrent: 5,
        embeddingBatchSize: 64,
        defaultOCRMode: 'accurate',
      });

      const config = getConfig();
      expect(config.maxConcurrent).toBe(5);
      expect(config.embeddingBatchSize).toBe(64);
      expect(config.defaultOCRMode).toBe('accurate');
    });

    it('should handle empty update', () => {
      const before = getConfig();
      updateConfig({});
      const after = getConfig();

      expect(after).toEqual(before);
    });

    it('should overwrite previous updates', () => {
      updateConfig({ maxConcurrent: 10 });
      updateConfig({ maxConcurrent: 20 });

      expect(getConfig().maxConcurrent).toBe(20);
    });
  });

  describe('resetConfig', () => {
    it('should reset to default values', () => {
      updateConfig({
        maxConcurrent: 100,
        embeddingBatchSize: 256,
        defaultOCRMode: 'fast',
      });

      resetConfig();

      const config = getConfig();
      expect(config.maxConcurrent).toBe(3);
      expect(config.embeddingBatchSize).toBe(32);
      expect(config.defaultOCRMode).toBe('balanced');
    });
  });

  describe('getDefaultStoragePath', () => {
    it('should return configured storage path', () => {
      const path = getDefaultStoragePath();

      expect(path).toBeDefined();
      expect(typeof path).toBe('string');
      expect(path.length).toBeGreaterThan(0);
    });

    it('should reflect updates', () => {
      const original = getDefaultStoragePath();
      updateConfig({ defaultStoragePath: '/custom/path' });

      expect(getDefaultStoragePath()).toBe('/custom/path');

      // Reset
      updateConfig({ defaultStoragePath: original });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESET STATE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('resetState', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should clear database and reset config', () => {
    createDatabase('reset-test', undefined, tempDir, true);
    updateConfig({ maxConcurrent: 50 });

    resetState();

    expect(hasDatabase()).toBe(false);
    expect(getConfig().maxConcurrent).toBe(3);
  });

  it('should be safe to call multiple times', () => {
    resetState();
    resetState();
    resetState();

    expect(hasDatabase()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES AND CONCURRENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should handle database name with allowed special characters', () => {
    const names = ['test-db', 'test_db', 'TestDB123', 'a-b_c-d'];

    for (const name of names) {
      resetState();
      cleanupTempDir(tempDir);
      tempDir = createTempDir();
      tempDirs.push(tempDir);

      createDatabase(name, undefined, tempDir, true);
      expect(getCurrentDatabaseName()).toBe(name);
    }
  });

  it('should handle rapid database switches', () => {
    // Create multiple databases
    for (let i = 0; i < 5; i++) {
      const db = DatabaseService.create(`rapid-${i}`, undefined, tempDir);
      db.close();
    }

    // Rapidly switch between them
    for (let i = 0; i < 5; i++) {
      selectDatabase(`rapid-${i}`, tempDir);
      expect(getCurrentDatabaseName()).toBe(`rapid-${i}`);
    }
  });

  it('should handle create-select-delete cycle', () => {
    createDatabase('cycle-db', undefined, tempDir, true);
    expect(hasDatabase()).toBe(true);

    deleteDatabase('cycle-db', tempDir);
    expect(hasDatabase()).toBe(false);

    // Should be able to create again
    createDatabase('cycle-db', undefined, tempDir, true);
    expect(hasDatabase()).toBe(true);
  });

  it('should handle selecting same database twice', () => {
    const db = DatabaseService.create('double-select', undefined, tempDir);
    db.close();

    selectDatabase('double-select', tempDir);
    selectDatabase('double-select', tempDir);

    expect(getCurrentDatabaseName()).toBe('double-select');
  });

  it('should maintain state isolation across operations', () => {
    createDatabase('state-iso-1', undefined, tempDir, true);
    const { db: db1 } = requireDatabase();

    // Insert a provenance record into first database with correct schema
    const now = new Date().toISOString();
    const provId = db1.insertProvenance({
      id: 'prov-test',
      type: 'DOCUMENT' as import('../../../src/models/provenance.js').ProvenanceType,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/test/file.pdf',
      source_id: null,
      root_document_id: 'doc-1',
      location: null,
      content_hash: 'sha256:abcd1234',
      input_hash: null,
      file_hash: 'sha256:file1234',
      processor: 'test',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: null,
    });

    expect(provId).toBe('prov-test');

    // Create and switch to second database
    const db2 = DatabaseService.create('state-iso-2', undefined, tempDir);
    db2.close();
    selectDatabase('state-iso-2', tempDir);

    // Second database should be empty
    const { db: selectedDb } = requireDatabase();
    const prov = selectedDb.getProvenance('prov-test');
    expect(prov).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR RECOVERY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Error Recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    resetState();
    tempDir = createTempDir();
    tempDirs.push(tempDir);
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('should recover after failed select', () => {
    createDatabase('valid', undefined, tempDir, true);
    expect(hasDatabase()).toBe(true);

    try {
      selectDatabase('invalid', tempDir);
    } catch {
      // Expected
    }

    // Should be able to select valid database again
    createDatabase('another-valid', undefined, tempDir, false);
    selectDatabase('another-valid', tempDir);
    expect(hasDatabase()).toBe(true);
  });

  it('should recover after failed create', () => {
    createDatabase('exists', undefined, tempDir, false);

    try {
      createDatabase('exists', undefined, tempDir);
    } catch {
      // Expected
    }

    // Should be able to create different database
    createDatabase('new-one', undefined, tempDir, true);
    expect(getCurrentDatabaseName()).toBe('new-one');
  });
});

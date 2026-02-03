/**
 * Database Lifecycle Tests
 *
 * Tests for database creation, opening, listing, deletion, and existence checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { statSync } from 'fs';
import { platform } from 'os';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  DatabaseService,
  existsSync,
  join,
} from './helpers.js';
import { DatabaseError, DatabaseErrorCode } from '../../../src/services/storage/database.js';

describe('DatabaseService - Lifecycle', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = createTestDir('db-lifecycle-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  describe('create()', () => {
    it.skipIf(!sqliteVecAvailable)('creates new database with schema', () => {
      const name = `test-create-${String(Date.now())}`;
      const dbService = DatabaseService.create(name, undefined, testDir);

      try {
        // Verify database file exists
        const dbPath = join(testDir, `${name}.db`);
        expect(existsSync(dbPath)).toBe(true);

        // Verify via raw connection that tables exist
        const rawDb = dbService.getConnection();
        const tables = rawDb
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>;
        const tableNames = tables.map((t) => t.name);

        expect(tableNames).toContain('documents');
        expect(tableNames).toContain('provenance');
        expect(tableNames).toContain('chunks');
        expect(tableNames).toContain('embeddings');
        expect(tableNames).toContain('ocr_results');
        expect(tableNames).toContain('database_metadata');
      } finally {
        dbService.close();
      }
    });

    it.skipIf(!sqliteVecAvailable)('creates storage directory if not exists', () => {
      const newStorageDir = join(testDir, `new-storage-${String(Date.now())}`);
      expect(existsSync(newStorageDir)).toBe(false);

      const name = `test-create-dir-${String(Date.now())}`;
      const dbService = DatabaseService.create(name, undefined, newStorageDir);

      try {
        expect(existsSync(newStorageDir)).toBe(true);
        expect(existsSync(join(newStorageDir, `${name}.db`))).toBe(true);
      } finally {
        dbService.close();
      }
    });

    it('throws DATABASE_ALREADY_EXISTS if exists', () => {
      const name = `test-exists-${String(Date.now())}`;

      // Create first database
      const dbService = DatabaseService.create(name, undefined, testDir);
      dbService.close();

      // Try to create again - should throw
      expect(() => {
        DatabaseService.create(name, undefined, testDir);
      }).toThrow(DatabaseError);

      try {
        DatabaseService.create(name, undefined, testDir);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DATABASE_ALREADY_EXISTS);
      }
    });

    it.skipIf(!sqliteVecAvailable || platform() === 'win32')(
      'sets file permissions to 0o600 (Unix only)',
      () => {
        const name = `test-perms-${String(Date.now())}`;
        const dbService = DatabaseService.create(name, undefined, testDir);

        try {
          const dbPath = join(testDir, `${name}.db`);
          const stats = statSync(dbPath);
          // Check if owner-only read/write (0o600 = 384 decimal)
          // The mode includes the file type bits, so we mask with 0o777
          const permissions = stats.mode & 0o777;
          expect(permissions).toBe(0o600);
        } finally {
          dbService.close();
        }
      }
    );
  });

  describe('open()', () => {
    it.skipIf(!sqliteVecAvailable)('opens existing database', () => {
      const name = `test-open-${String(Date.now())}`;

      // Create and close
      const dbService1 = DatabaseService.create(name, undefined, testDir);
      dbService1.close();

      // Re-open
      const dbService2 = DatabaseService.open(name, testDir);
      try {
        expect(dbService2.getName()).toBe(name);
      } finally {
        dbService2.close();
      }
    });

    it('throws DATABASE_NOT_FOUND if not exists', () => {
      expect(() => {
        DatabaseService.open('nonexistent-db-12345', testDir);
      }).toThrow(DatabaseError);

      try {
        DatabaseService.open('nonexistent-db-12345', testDir);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DATABASE_NOT_FOUND);
      }
    });

    it.skipIf(!sqliteVecAvailable)('verifies schema version', () => {
      const name = `test-schema-${String(Date.now())}`;

      // Create database
      const dbService1 = DatabaseService.create(name, undefined, testDir);
      dbService1.close();

      // Open should verify schema
      const dbService2 = DatabaseService.open(name, testDir);
      try {
        // If we get here, schema was verified successfully
        expect(dbService2).toBeDefined();
      } finally {
        dbService2.close();
      }
    });
  });

  describe('list()', () => {
    it.skipIf(!sqliteVecAvailable)('returns all databases with metadata', () => {
      const listDir = join(testDir, `list-test-${String(Date.now())}`);

      // Create multiple databases
      const names = ['db-one', 'db-two', 'db-three'];
      for (const name of names) {
        const dbService = DatabaseService.create(name, undefined, listDir);
        dbService.close();
      }

      // List databases
      const databases = DatabaseService.list(listDir);

      expect(databases.length).toBe(3);
      for (const name of names) {
        const found = databases.find((db) => db.name === name);
        expect(found).toBeDefined();
        expect(found!.path).toBe(join(listDir, `${name}.db`));
        expect(found!.size_bytes).toBeGreaterThan(0);
        expect(found!.created_at).toBeDefined();
      }
    });

    it('returns empty array if no databases', () => {
      const emptyDir = join(testDir, `empty-${String(Date.now())}`);
      const databases = DatabaseService.list(emptyDir);
      expect(databases).toEqual([]);
    });
  });

  describe('delete()', () => {
    it.skipIf(!sqliteVecAvailable)('removes database file', () => {
      const name = `test-delete-${String(Date.now())}`;
      const dbPath = join(testDir, `${name}.db`);

      // Create database
      const dbService = DatabaseService.create(name, undefined, testDir);
      dbService.close();

      expect(existsSync(dbPath)).toBe(true);

      // Delete
      DatabaseService.delete(name, testDir);

      expect(existsSync(dbPath)).toBe(false);
    });

    it('throws DATABASE_NOT_FOUND if not exists', () => {
      expect(() => {
        DatabaseService.delete('nonexistent-db-67890', testDir);
      }).toThrow(DatabaseError);

      try {
        DatabaseService.delete('nonexistent-db-67890', testDir);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe(DatabaseErrorCode.DATABASE_NOT_FOUND);
      }
    });

    it.skipIf(!sqliteVecAvailable)('removes WAL and SHM files', () => {
      const name = `test-delete-wal-${String(Date.now())}`;
      const dbPath = join(testDir, `${name}.db`);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;

      // Create database
      const dbService = DatabaseService.create(name, undefined, testDir);

      // Force WAL file creation by writing data
      const prov = createTestProvenance();
      dbService.insertProvenance(prov);
      dbService.close();

      // Delete should clean up all files
      DatabaseService.delete(name, testDir);

      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);
    });
  });

  describe('exists()', () => {
    it.skipIf(!sqliteVecAvailable)('returns true if database exists', () => {
      const name = `test-exists-check-${String(Date.now())}`;

      // Create database
      const dbService = DatabaseService.create(name, undefined, testDir);
      dbService.close();

      expect(DatabaseService.exists(name, testDir)).toBe(true);
    });

    it('returns false if database does not exist', () => {
      expect(DatabaseService.exists('definitely-not-existing-db', testDir)).toBe(false);
    });
  });
});

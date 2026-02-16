/**
 * Transaction Tests
 *
 * Tests for database transaction support including commit and rollback.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
} from './helpers.js';

describe('DatabaseService - Transactions', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  beforeAll(() => {
    testDir = createTestDir('db-txn-');
  });

  afterAll(() => {
    cleanupTestDir(testDir);
  });

  beforeEach(() => {
    dbService = createFreshDatabase(testDir, 'test-txn');
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
  });

  describe('transaction()', () => {
    it.skipIf(!sqliteVecAvailable)('commits on success', () => {
      const prov1 = createTestProvenance();
      const prov2 = createTestProvenance();

      dbService!.transaction(() => {
        dbService!.insertProvenance(prov1);
        dbService!.insertProvenance(prov2);
      });

      // Both should exist
      expect(dbService!.getProvenance(prov1.id)).not.toBeNull();
      expect(dbService!.getProvenance(prov2.id)).not.toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('rolls back on error', () => {
      const prov1 = createTestProvenance();
      const prov2 = createTestProvenance({ id: prov1.id }); // Duplicate ID

      try {
        dbService!.transaction(() => {
          dbService!.insertProvenance(prov1);
          dbService!.insertProvenance(prov2); // This will fail due to duplicate ID
        });
      } catch {
        // Expected
      }

      // Neither should exist due to rollback
      expect(dbService!.getProvenance(prov1.id)).toBeNull();
    });

    it.skipIf(!sqliteVecAvailable)('returns result from function', () => {
      const prov = createTestProvenance();

      const result = dbService!.transaction(() => {
        dbService!.insertProvenance(prov);
        return 'success';
      });

      expect(result).toBe('success');
    });
  });
});

/**
 * Error Handling Tests for Database Migrations
 *
 * Tests MigrationError class and error scenarios.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestDir, cleanupTestDir, createTestDb, closeDb, TestContext } from './helpers.js';
import { checkSchemaVersion, MigrationError } from '../../../src/services/storage/migrations.js';

describe('Error Handling', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-error-handling');
  });

  afterAll(() => {
    cleanupTestDir(ctx.testDir);
  });

  beforeEach(() => {
    const { db, dbPath } = createTestDb(ctx.testDir);
    ctx.db = db;
    ctx.dbPath = dbPath;
  });

  afterEach(() => {
    closeDb(ctx.db);
    ctx.db = undefined;
  });

  it('should throw MigrationError with correct properties', () => {
    // Try to check schema version on a closed database
    ctx.db!.close();

    try {
      checkSchemaVersion(ctx.db);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      const migrationError = error as MigrationError;
      expect(migrationError.operation).toBeDefined();
      expect(migrationError.message).toBeTruthy();
    }
  });

  it('should have descriptive error messages', () => {
    ctx.db!.close();

    try {
      checkSchemaVersion(ctx.db);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as Error).message.length).toBeGreaterThan(10);
    }
  });

  it('should include cause in MigrationError', () => {
    const cause = new Error('Original error');
    const migrationError = new MigrationError('Test error', 'test_operation', 'test_table', cause);

    expect(migrationError.cause).toBe(cause);
    expect(migrationError.operation).toBe('test_operation');
    expect(migrationError.tableName).toBe('test_table');
  });

  it('MigrationError should have correct name property', () => {
    const error = new MigrationError('Test', 'test_op');
    expect(error.name).toBe('MigrationError');
  });

  it('MigrationError should be instance of Error', () => {
    const error = new MigrationError('Test', 'test_op');
    expect(error).toBeInstanceOf(Error);
  });
});

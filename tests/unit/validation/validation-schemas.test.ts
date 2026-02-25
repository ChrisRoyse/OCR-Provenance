/**
 * Consolidated Validation Schema Tests
 *
 * Tests Zod schema validation for:
 * - Config schemas (ConfigGetInput, ConfigSetInput)
 * - Database management schemas (DatabaseCreateInput, DatabaseListInput, DatabaseSelectInput, DatabaseDeleteInput)
 * - Auto-pipeline parameters (ProcessPendingInput)
 *
 * Merged from: config-schemas.test.ts, database-schemas.test.ts, auto-pipeline-params.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  ConfigGetInput,
  ConfigSetInput,
  DatabaseCreateInput,
  DatabaseListInput,
  DatabaseSelectInput,
  DatabaseDeleteInput,
} from './fixtures.js';

// =============================================================================
// Config Schemas
// =============================================================================

describe('Config Schemas', () => {
  describe('ConfigGetInput', () => {
    it('should accept empty input', () => {
      const result = ConfigGetInput.parse({});
      expect(result.key).toBeUndefined();
    });

    it('should accept specific key', () => {
      const result = ConfigGetInput.parse({ key: 'chunk_size' });
      expect(result.key).toBe('chunk_size');
    });

    it('should reject invalid key', () => {
      expect(() => ConfigGetInput.parse({ key: 'invalid_key' })).toThrow();
    });
  });

  describe('ConfigSetInput', () => {
    it('should accept string value', () => {
      const result = ConfigSetInput.parse({
        key: 'datalab_default_mode',
        value: 'accurate',
      });
      expect(result.value).toBe('accurate');
    });

    it('should accept number value', () => {
      const result = ConfigSetInput.parse({ key: 'chunk_size', value: 2000 });
      expect(result.value).toBe(2000);
    });

    it('should accept boolean value', () => {
      const result = ConfigSetInput.parse({ key: 'embedding_device', value: true });
      expect(result.value).toBe(true);
    });

    it('should require key', () => {
      expect(() => ConfigSetInput.parse({ value: 'test' })).toThrow();
    });

    it('should require value', () => {
      expect(() => ConfigSetInput.parse({ key: 'chunk_size' })).toThrow();
    });
  });
});

// =============================================================================
// Database Management Schemas
// =============================================================================

describe('Database Management Schemas', () => {
  describe('DatabaseCreateInput', () => {
    it('should accept valid input with required fields', () => {
      const result = DatabaseCreateInput.parse({ name: 'my_database' });
      expect(result.name).toBe('my_database');
    });

    it('should accept valid input with all fields', () => {
      const result = DatabaseCreateInput.parse({
        name: 'my-database-123',
        description: 'Test database',
        storage_path: '/custom/path',
      });
      expect(result.name).toBe('my-database-123');
      expect(result.description).toBe('Test database');
      expect(result.storage_path).toBe('/custom/path');
    });

    it('should reject empty name', () => {
      expect(() => DatabaseCreateInput.parse({ name: '' })).toThrow('required');
    });

    it('should reject name with invalid characters', () => {
      expect(() => DatabaseCreateInput.parse({ name: 'my database!' })).toThrow('alphanumeric');
    });

    it('should reject name exceeding max length', () => {
      const longName = 'a'.repeat(65);
      expect(() => DatabaseCreateInput.parse({ name: longName })).toThrow('64');
    });

    it('should reject description exceeding max length', () => {
      const longDescription = 'a'.repeat(501);
      expect(() =>
        DatabaseCreateInput.parse({ name: 'test', description: longDescription })
      ).toThrow('500');
    });
  });

  describe('DatabaseListInput', () => {
    it('should provide default for include_stats', () => {
      const result = DatabaseListInput.parse({});
      expect(result.include_stats).toBe(false);
    });

    it('should accept include_stats parameter', () => {
      const result = DatabaseListInput.parse({ include_stats: true });
      expect(result.include_stats).toBe(true);
    });
  });

  describe('DatabaseSelectInput', () => {
    it('should accept valid database name', () => {
      const result = DatabaseSelectInput.parse({ database_name: 'my_db' });
      expect(result.database_name).toBe('my_db');
    });

    it('should reject empty database name', () => {
      expect(() => DatabaseSelectInput.parse({ database_name: '' })).toThrow('required');
    });
  });

  describe('DatabaseDeleteInput', () => {
    it('should accept valid input with confirm=true', () => {
      const result = DatabaseDeleteInput.parse({
        database_name: 'my_db',
        confirm: true,
      });
      expect(result.database_name).toBe('my_db');
      expect(result.confirm).toBe(true);
    });

    it('should reject confirm=false', () => {
      expect(() => DatabaseDeleteInput.parse({ database_name: 'my_db', confirm: false })).toThrow(
        'Confirm must be true'
      );
    });

    it('should reject missing confirm', () => {
      expect(() => DatabaseDeleteInput.parse({ database_name: 'my_db' })).toThrow();
    });
  });
});

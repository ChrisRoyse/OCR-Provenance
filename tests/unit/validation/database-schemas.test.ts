/**
 * Unit Tests for Database Management Schemas
 *
 * Tests DatabaseCreateInput, DatabaseListInput, DatabaseSelectInput, DatabaseDeleteInput
 */

import { describe, it, expect } from 'vitest';
import {
  DatabaseCreateInput,
  DatabaseListInput,
  DatabaseSelectInput,
  DatabaseDeleteInput,
} from './fixtures.js';

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

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
  ProcessPendingInput,
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

// =============================================================================
// Auto-Pipeline Parameters (ProcessPendingInput)
// =============================================================================

describe('ProcessPendingInput auto-pipeline parameters', () => {
  describe('auto_extract_entities', () => {
    it('defaults to false', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.auto_extract_entities).toBe(false);
    });

    it('accepts true', () => {
      const result = ProcessPendingInput.parse({ auto_extract_entities: true });
      expect(result.auto_extract_entities).toBe(true);
    });

    it('accepts false', () => {
      const result = ProcessPendingInput.parse({ auto_extract_entities: false });
      expect(result.auto_extract_entities).toBe(false);
    });

    it('rejects non-boolean value', () => {
      expect(() =>
        ProcessPendingInput.parse({ auto_extract_entities: 'yes' })
      ).toThrow();
    });
  });

  describe('auto_build_kg', () => {
    it('defaults to false', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.auto_build_kg).toBe(false);
    });

    it('accepts true', () => {
      const result = ProcessPendingInput.parse({ auto_build_kg: true, auto_extract_entities: true });
      expect(result.auto_build_kg).toBe(true);
    });

    it('accepts false', () => {
      const result = ProcessPendingInput.parse({ auto_build_kg: false });
      expect(result.auto_build_kg).toBe(false);
    });

    it('rejects non-boolean value', () => {
      expect(() =>
        ProcessPendingInput.parse({ auto_build_kg: 'yes' })
      ).toThrow();
    });
  });

  describe('combined auto-pipeline parameters', () => {
    it('both default to false when no params given', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.auto_extract_entities).toBe(false);
      expect(result.auto_build_kg).toBe(false);
    });

    it('auto_extract_entities alone is valid', () => {
      const result = ProcessPendingInput.parse({ auto_extract_entities: true });
      expect(result.auto_extract_entities).toBe(true);
      expect(result.auto_build_kg).toBe(false);
    });

    it('both enabled parses successfully at schema level', () => {
      const result = ProcessPendingInput.parse({
        auto_extract_entities: true,
        auto_build_kg: true,
      });
      expect(result.auto_extract_entities).toBe(true);
      expect(result.auto_build_kg).toBe(true);
    });

    it('auto_build_kg=true with auto_extract_entities=false parses at schema level', () => {
      const result = ProcessPendingInput.parse({
        auto_extract_entities: false,
        auto_build_kg: true,
      });
      expect(result.auto_extract_entities).toBe(false);
      expect(result.auto_build_kg).toBe(true);
    });

    it('combined with other ProcessPendingInput params', () => {
      const result = ProcessPendingInput.parse({
        max_concurrent: 5,
        ocr_mode: 'accurate',
        auto_extract_entities: true,
        auto_build_kg: true,
        chunking_strategy: 'page_aware',
      });
      expect(result.max_concurrent).toBe(5);
      expect(result.ocr_mode).toBe('accurate');
      expect(result.auto_extract_entities).toBe(true);
      expect(result.auto_build_kg).toBe(true);
      expect(result.chunking_strategy).toBe('page_aware');
    });
  });

  describe('runtime validation logic', () => {
    it('auto_build_kg requires auto_extract_entities (mirrors handler check)', () => {
      const input = ProcessPendingInput.parse({
        auto_build_kg: true,
        auto_extract_entities: false,
      });

      const shouldError = input.auto_build_kg && !input.auto_extract_entities;
      expect(shouldError).toBe(true);
    });

    it('auto_build_kg with auto_extract_entities does not trigger error', () => {
      const input = ProcessPendingInput.parse({
        auto_build_kg: true,
        auto_extract_entities: true,
      });

      const shouldError = input.auto_build_kg && !input.auto_extract_entities;
      expect(shouldError).toBe(false);
    });

    it('auto_extract_entities requires GEMINI_API_KEY (mirrors handler check)', () => {
      const input = ProcessPendingInput.parse({ auto_extract_entities: true });

      const hasApiKey = !!process.env.GEMINI_API_KEY;
      const shouldError = input.auto_extract_entities && !hasApiKey;

      expect(typeof shouldError).toBe('boolean');
      if (!hasApiKey) {
        expect(shouldError).toBe(true);
      } else {
        expect(shouldError).toBe(false);
      }
    });
  });
});

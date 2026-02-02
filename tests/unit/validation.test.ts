/**
 * Unit Tests for Validation Schemas
 *
 * Tests all Zod validation schemas to ensure:
 * - Valid inputs are accepted
 * - Invalid inputs are rejected
 * - Error messages are descriptive
 * - Type inference works correctly
 */

import { describe, it, expect } from 'vitest';
import {
  // Helper functions
  validateInput,
  safeValidateInput,
  ValidationError,

  // Enums
  OCRMode,
  MatchType,
  ProcessingStatus,
  ItemType,
  ConfigKey,

  // Database schemas
  DatabaseCreateInput,
  DatabaseListInput,
  DatabaseSelectInput,
  DatabaseDeleteInput,

  // Ingestion schemas
  IngestDirectoryInput,
  IngestFilesInput,
  ProcessPendingInput,
  OCRStatusInput,
  DEFAULT_FILE_TYPES,

  // Search schemas
  SearchSemanticInput,
  SearchTextInput,
  SearchHybridInput,

  // Document management schemas
  DocumentListInput,
  DocumentGetInput,
  DocumentDeleteInput,

  // Provenance schemas
  ProvenanceGetInput,
  ProvenanceVerifyInput,
  ProvenanceExportInput,

  // Config schemas
  ConfigGetInput,
  ConfigSetInput,
} from '../../src/utils/validation.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateInput', () => {
  it('should return validated data for valid input', () => {
    const input = { name: 'test_db' };
    const result = validateInput(DatabaseCreateInput, input);
    expect(result.name).toBe('test_db');
  });

  it('should throw ValidationError for invalid input', () => {
    const input = { name: '' };
    expect(() => validateInput(DatabaseCreateInput, input)).toThrow(ValidationError);
  });

  it('should include field path in error message', () => {
    const input = { name: '' };
    expect(() => validateInput(DatabaseCreateInput, input)).toThrow('name:');
  });
});

describe('safeValidateInput', () => {
  it('should return success: true for valid input', () => {
    const input = { name: 'test_db' };
    const result = safeValidateInput(DatabaseCreateInput, input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('test_db');
    }
  });

  it('should return success: false for invalid input', () => {
    const input = { name: '' };
    const result = safeValidateInput(DatabaseCreateInput, input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENUM TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Enums', () => {
  describe('OCRMode', () => {
    it('should accept valid modes', () => {
      expect(OCRMode.parse('fast')).toBe('fast');
      expect(OCRMode.parse('balanced')).toBe('balanced');
      expect(OCRMode.parse('accurate')).toBe('accurate');
    });

    it('should reject invalid modes', () => {
      expect(() => OCRMode.parse('invalid')).toThrow();
    });
  });

  describe('MatchType', () => {
    it('should accept valid match types', () => {
      expect(MatchType.parse('exact')).toBe('exact');
      expect(MatchType.parse('fuzzy')).toBe('fuzzy');
      expect(MatchType.parse('regex')).toBe('regex');
    });
  });

  describe('ProcessingStatus', () => {
    it('should accept valid statuses', () => {
      expect(ProcessingStatus.parse('pending')).toBe('pending');
      expect(ProcessingStatus.parse('processing')).toBe('processing');
      expect(ProcessingStatus.parse('complete')).toBe('complete');
      expect(ProcessingStatus.parse('failed')).toBe('failed');
    });
  });

  describe('ItemType', () => {
    it('should accept valid item types', () => {
      expect(ItemType.parse('document')).toBe('document');
      expect(ItemType.parse('ocr_result')).toBe('ocr_result');
      expect(ItemType.parse('chunk')).toBe('chunk');
      expect(ItemType.parse('embedding')).toBe('embedding');
      expect(ItemType.parse('auto')).toBe('auto');
    });
  });

  describe('ConfigKey', () => {
    it('should accept valid config keys', () => {
      expect(ConfigKey.parse('datalab_default_mode')).toBe('datalab_default_mode');
      expect(ConfigKey.parse('chunk_size')).toBe('chunk_size');
      expect(ConfigKey.parse('log_level')).toBe('log_level');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE MANAGEMENT SCHEMA TESTS
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT INGESTION SCHEMA TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Document Ingestion Schemas', () => {
  describe('IngestDirectoryInput', () => {
    it('should accept valid directory path', () => {
      const result = IngestDirectoryInput.parse({
        directory_path: '/home/user/docs',
      });
      expect(result.directory_path).toBe('/home/user/docs');
    });

    it('should provide defaults', () => {
      const result = IngestDirectoryInput.parse({
        directory_path: '/home/user/docs',
      });
      expect(result.recursive).toBe(true);
      expect(result.ocr_mode).toBe('balanced');
      expect(result.auto_process).toBe(false);
      expect(result.file_types).toEqual(DEFAULT_FILE_TYPES);
    });

    it('should reject empty directory path', () => {
      expect(() => IngestDirectoryInput.parse({ directory_path: '' })).toThrow('required');
    });

    it('should accept custom file types', () => {
      const result = IngestDirectoryInput.parse({
        directory_path: '/docs',
        file_types: ['pdf', 'docx'],
      });
      expect(result.file_types).toEqual(['pdf', 'docx']);
    });
  });

  describe('IngestFilesInput', () => {
    it('should accept valid file paths', () => {
      const result = IngestFilesInput.parse({
        file_paths: ['/home/user/doc.pdf', '/home/user/image.png'],
      });
      expect(result.file_paths).toHaveLength(2);
    });

    it('should reject empty file_paths array', () => {
      expect(() => IngestFilesInput.parse({ file_paths: [] })).toThrow('At least one');
    });

    it('should reject array with empty strings', () => {
      expect(() => IngestFilesInput.parse({ file_paths: [''] })).toThrow('empty');
    });
  });

  describe('ProcessPendingInput', () => {
    it('should provide defaults', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.max_concurrent).toBe(3);
    });

    it('should accept valid max_concurrent', () => {
      const result = ProcessPendingInput.parse({ max_concurrent: 5 });
      expect(result.max_concurrent).toBe(5);
    });

    it('should reject max_concurrent below 1', () => {
      expect(() => ProcessPendingInput.parse({ max_concurrent: 0 })).toThrow();
    });

    it('should reject max_concurrent above 10', () => {
      expect(() => ProcessPendingInput.parse({ max_concurrent: 11 })).toThrow();
    });
  });

  describe('OCRStatusInput', () => {
    it('should provide defaults', () => {
      const result = OCRStatusInput.parse({});
      expect(result.status_filter).toBe('all');
    });

    it('should accept valid status filter', () => {
      const result = OCRStatusInput.parse({ status_filter: 'pending' });
      expect(result.status_filter).toBe('pending');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH SCHEMA TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Search Schemas', () => {
  describe('SearchSemanticInput', () => {
    it('should accept valid query', () => {
      const result = SearchSemanticInput.parse({ query: 'contract termination' });
      expect(result.query).toBe('contract termination');
    });

    it('should provide defaults', () => {
      const result = SearchSemanticInput.parse({ query: 'test' });
      expect(result.limit).toBe(10);
      expect(result.similarity_threshold).toBe(0.7);
      expect(result.include_provenance).toBe(false);
    });

    it('should reject empty query', () => {
      expect(() => SearchSemanticInput.parse({ query: '' })).toThrow('required');
    });

    it('should reject query exceeding max length', () => {
      const longQuery = 'a'.repeat(1001);
      expect(() => SearchSemanticInput.parse({ query: longQuery })).toThrow('1000');
    });

    it('should accept similarity threshold between 0 and 1', () => {
      const result = SearchSemanticInput.parse({
        query: 'test',
        similarity_threshold: 0.5,
      });
      expect(result.similarity_threshold).toBe(0.5);
    });

    it('should reject similarity threshold above 1', () => {
      expect(() =>
        SearchSemanticInput.parse({ query: 'test', similarity_threshold: 1.5 })
      ).toThrow();
    });

    it('should accept document_filter', () => {
      const result = SearchSemanticInput.parse({
        query: 'test',
        document_filter: ['doc1', 'doc2'],
      });
      expect(result.document_filter).toEqual(['doc1', 'doc2']);
    });
  });

  describe('SearchTextInput', () => {
    it('should accept valid input', () => {
      const result = SearchTextInput.parse({ query: 'termination clause' });
      expect(result.query).toBe('termination clause');
      expect(result.match_type).toBe('fuzzy');
    });

    it('should accept different match types', () => {
      expect(SearchTextInput.parse({ query: 'test', match_type: 'exact' }).match_type).toBe(
        'exact'
      );
      expect(SearchTextInput.parse({ query: 'test', match_type: 'regex' }).match_type).toBe(
        'regex'
      );
    });
  });

  describe('SearchHybridInput', () => {
    it('should accept valid input with default weights', () => {
      const result = SearchHybridInput.parse({ query: 'test' });
      expect(result.semantic_weight).toBe(0.7);
      expect(result.keyword_weight).toBe(0.3);
    });

    it('should accept custom weights that sum to 1', () => {
      const result = SearchHybridInput.parse({
        query: 'test',
        semantic_weight: 0.5,
        keyword_weight: 0.5,
      });
      expect(result.semantic_weight).toBe(0.5);
      expect(result.keyword_weight).toBe(0.5);
    });

    it('should reject weights that do not sum to 1', () => {
      expect(() =>
        SearchHybridInput.parse({
          query: 'test',
          semantic_weight: 0.5,
          keyword_weight: 0.3,
        })
      ).toThrow('sum to 1.0');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT MANAGEMENT SCHEMA TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Document Management Schemas', () => {
  describe('DocumentListInput', () => {
    it('should provide defaults', () => {
      const result = DocumentListInput.parse({});
      expect(result.sort_by).toBe('created_at');
      expect(result.sort_order).toBe('desc');
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should accept valid status filter', () => {
      const result = DocumentListInput.parse({ status_filter: 'complete' });
      expect(result.status_filter).toBe('complete');
    });

    it('should reject invalid sort_by', () => {
      expect(() => DocumentListInput.parse({ sort_by: 'invalid' })).toThrow();
    });

    it('should reject limit above maximum', () => {
      expect(() => DocumentListInput.parse({ limit: 1001 })).toThrow();
    });

    it('should reject negative offset', () => {
      expect(() => DocumentListInput.parse({ offset: -1 })).toThrow();
    });
  });

  describe('DocumentGetInput', () => {
    it('should accept valid UUID', () => {
      const result = DocumentGetInput.parse({
        document_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.document_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should reject invalid UUID', () => {
      expect(() => DocumentGetInput.parse({ document_id: 'invalid-id' })).toThrow(
        'Invalid document ID'
      );
    });

    it('should provide defaults', () => {
      const result = DocumentGetInput.parse({
        document_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.include_text).toBe(false);
      expect(result.include_chunks).toBe(false);
      expect(result.include_full_provenance).toBe(false);
    });
  });

  describe('DocumentDeleteInput', () => {
    it('should accept valid input', () => {
      const result = DocumentDeleteInput.parse({
        document_id: '550e8400-e29b-41d4-a716-446655440000',
        confirm: true,
      });
      expect(result.confirm).toBe(true);
    });

    it('should reject invalid UUID', () => {
      expect(() => DocumentDeleteInput.parse({ document_id: 'invalid', confirm: true })).toThrow(
        'Invalid document ID'
      );
    });

    it('should reject confirm=false', () => {
      expect(() =>
        DocumentDeleteInput.parse({
          document_id: '550e8400-e29b-41d4-a716-446655440000',
          confirm: false,
        })
      ).toThrow('Confirm must be true');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE SCHEMA TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provenance Schemas', () => {
  describe('ProvenanceGetInput', () => {
    it('should accept valid input', () => {
      const result = ProvenanceGetInput.parse({ item_id: 'prov_abc123' });
      expect(result.item_id).toBe('prov_abc123');
    });

    it('should provide defaults', () => {
      const result = ProvenanceGetInput.parse({ item_id: 'prov_abc123' });
      expect(result.item_type).toBe('auto');
      expect(result.format).toBe('chain');
    });

    it('should reject empty item_id', () => {
      expect(() => ProvenanceGetInput.parse({ item_id: '' })).toThrow('required');
    });

    it('should accept different formats', () => {
      expect(ProvenanceGetInput.parse({ item_id: 'test', format: 'tree' }).format).toBe('tree');
      expect(ProvenanceGetInput.parse({ item_id: 'test', format: 'flat' }).format).toBe('flat');
    });
  });

  describe('ProvenanceVerifyInput', () => {
    it('should accept valid input', () => {
      const result = ProvenanceVerifyInput.parse({ item_id: 'prov_abc123' });
      expect(result.item_id).toBe('prov_abc123');
      expect(result.verify_content).toBe(true);
      expect(result.verify_chain).toBe(true);
    });

    it('should allow disabling verification options', () => {
      const result = ProvenanceVerifyInput.parse({
        item_id: 'prov_abc123',
        verify_content: false,
        verify_chain: false,
      });
      expect(result.verify_content).toBe(false);
      expect(result.verify_chain).toBe(false);
    });
  });

  describe('ProvenanceExportInput', () => {
    it('should accept valid document scope with document_id', () => {
      const result = ProvenanceExportInput.parse({
        scope: 'document',
        document_id: 'doc_123',
      });
      expect(result.scope).toBe('document');
      expect(result.document_id).toBe('doc_123');
    });

    it('should reject document scope without document_id', () => {
      expect(() => ProvenanceExportInput.parse({ scope: 'document' })).toThrow(
        'document_id is required'
      );
    });

    it('should accept database scope without document_id', () => {
      const result = ProvenanceExportInput.parse({ scope: 'database' });
      expect(result.scope).toBe('database');
    });

    it('should accept all scope without document_id', () => {
      const result = ProvenanceExportInput.parse({ scope: 'all' });
      expect(result.scope).toBe('all');
    });

    it('should provide default format', () => {
      const result = ProvenanceExportInput.parse({ scope: 'all' });
      expect(result.format).toBe('json');
    });

    it('should accept different export formats', () => {
      expect(ProvenanceExportInput.parse({ scope: 'all', format: 'csv' }).format).toBe('csv');
      expect(ProvenanceExportInput.parse({ scope: 'all', format: 'w3c-prov' }).format).toBe(
        'w3c-prov'
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG SCHEMA TESTS
// ═══════════════════════════════════════════════════════════════════════════════

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
      const result = ConfigSetInput.parse({ key: 'log_level', value: true });
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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE INFERENCE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Type Inference', () => {
  it('should infer correct types from schemas', () => {
    // These tests verify TypeScript type inference at compile time
    // If they compile, the types are correct

    const dbCreate: { name: string; description?: string; storage_path?: string } =
      DatabaseCreateInput.parse({ name: 'test' });
    expect(dbCreate.name).toBe('test');

    const search: { query: string; limit: number } = SearchSemanticInput.parse({
      query: 'test',
    });
    expect(search.limit).toBe(10);

    const provExport: { scope: 'document' | 'database' | 'all' } = ProvenanceExportInput.parse({
      scope: 'all',
    });
    expect(provExport.scope).toBe('all');
  });
});

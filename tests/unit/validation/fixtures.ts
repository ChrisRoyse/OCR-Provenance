/**
 * Shared fixtures and imports for validation tests
 */

// Re-export all validation utilities for tests
export {
  // Helper functions
  validateInput,
  ValidationError,

  // Enums
  OCRMode,
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
  SearchInput,
  SearchHybridInput,
  FTSManageInput,

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
} from '../../../src/utils/validation.js';

// Test constants
export const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
export const INVALID_UUID = 'invalid-id';

// Valid database names
export const VALID_DB_NAMES = ['my_database', 'my-database-123', 'test_db'];
export const INVALID_DB_NAMES = ['', 'my database!', 'a'.repeat(65)];

// Valid directory paths
export const VALID_DIRECTORY_PATHS = ['/home/user/docs', '/docs', '/var/data'];

// Valid file paths
export const VALID_FILE_PATHS = ['/home/user/doc.pdf', '/home/user/image.png'];

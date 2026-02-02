/**
 * Utility Functions Barrel Export
 *
 * @module utils
 */

// Hash utilities for provenance integrity verification
export {
  computeHash,
  hashFile,
  verifyHash,
  verifyFileHash,
  isValidHashFormat,
  extractHashHex,
  compareHashes,
  computeCompositeHash,
  verifyHashDetailed,
  HASH_PREFIX,
  HASH_HEX_LENGTH,
  HASH_TOTAL_LENGTH,
  HASH_PATTERN,
} from './hash.js';

export type { HashVerificationResult } from './hash.js';

// File system utilities with path sanitization
export {
  sanitizePath,
  getFileExtension,
  getMimeType,
  getFileMetadata,
  scanDirectory,
  isAllowedFileType,
  ensureDirectory,
  fileExists,
  directoryExists,
  readFileBuffer,
  readFileText,
  PathTraversalError,
} from './files.js';

// Validation utilities for MCP tool inputs
export {
  // Helper functions
  validateInput,
  safeValidateInput,
  ValidationError,

  // Shared enums
  OCRMode,
  MatchType,
  ProcessingStatus,
  ItemType,
  ProvenanceFormat,
  ExportFormat,
  ExportScope,
  ConfigKey,
  SortOrder,
  DocumentSortField,

  // Database management schemas
  DatabaseCreateInput,
  DatabaseListInput,
  DatabaseSelectInput,
  DatabaseStatsInput,
  DatabaseDeleteInput,

  // Document ingestion schemas
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
} from './validation.js';

// Re-export types from validation
export type {
  OCRMode as OCRModeType,
  MatchType as MatchTypeValue,
  ProcessingStatus as ProcessingStatusType,
  ItemType as ItemTypeValue,
  ProvenanceFormat as ProvenanceFormatType,
  ExportFormat as ExportFormatType,
  ExportScope as ExportScopeType,
  ConfigKey as ConfigKeyType,
  SortOrder as SortOrderType,
  DocumentSortField as DocumentSortFieldType,
  DatabaseCreateInput as DatabaseCreateInputType,
  DatabaseListInput as DatabaseListInputType,
  DatabaseSelectInput as DatabaseSelectInputType,
  DatabaseStatsInput as DatabaseStatsInputType,
  DatabaseDeleteInput as DatabaseDeleteInputType,
  IngestDirectoryInput as IngestDirectoryInputType,
  IngestFilesInput as IngestFilesInputType,
  ProcessPendingInput as ProcessPendingInputType,
  OCRStatusInput as OCRStatusInputType,
  SearchSemanticInput as SearchSemanticInputType,
  SearchTextInput as SearchTextInputType,
  SearchHybridInput as SearchHybridInputType,
  DocumentListInput as DocumentListInputType,
  DocumentGetInput as DocumentGetInputType,
  DocumentDeleteInput as DocumentDeleteInputType,
  ProvenanceGetInput as ProvenanceGetInputType,
  ProvenanceVerifyInput as ProvenanceVerifyInputType,
  ProvenanceExportInput as ProvenanceExportInputType,
  ConfigGetInput as ConfigGetInputType,
  ConfigSetInput as ConfigSetInputType,
} from './validation.js';

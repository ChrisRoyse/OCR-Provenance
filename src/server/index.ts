/**
 * MCP Server Module Exports
 *
 * Re-exports all server components for external use.
 *
 * @module server
 */

// Error handling
export {
  MCPError,
  formatErrorResponse,
  validationError,
  databaseNotSelectedError,
  databaseNotFoundError,
  databaseAlreadyExistsError,
  documentNotFoundError,
  provenanceNotFoundError,
  pathNotFoundError,
  pathNotDirectoryError,
  internalError,
  type ErrorCategory,
  type ErrorResponse,
} from './errors.js';

// Type definitions
export {
  type ToolResult,
  type ToolResultSuccess,
  type ToolResultFailure,
  type ToolError,
  type ServerConfig,
  type ServerState,
  type OCRMode,
  successResult,
  failureResult,
  // Database results
  type DatabaseCreateResult,
  type DatabaseListItem,
  type DatabaseSelectResult,
  type DatabaseStatsResult,
  type DatabaseDeleteResult,
  // Document results
  type DocumentListItem,
  type DocumentListResult,
  type DocumentGetResult,
  type DocumentDeleteResult,
  type ChunkInfo,
  type ProvenanceInfo,
  // Search results
  type SemanticSearchItem,
  type SemanticSearchResult,
  // Ingestion results
  type IngestFileItem,
  type IngestDirectoryResult,
  type IngestFilesResult,
  // Provenance results
  type ProvenanceGetResult,
  type ProvenanceVerifyResult,
  type VerificationStep,
  type ProvenanceExportResult,
  // OCR results
  type OCRStatusItem,
  type OCRStatusResult,
  type ProcessPendingResult,
} from './types.js';

// State management
export {
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
  type DatabaseServices,
} from './state.js';

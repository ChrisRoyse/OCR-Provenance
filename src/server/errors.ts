/**
 * MCP Server Error Handling
 *
 * FAIL FAST: All errors throw immediately with descriptive context.
 * NO graceful degradation, NO fallbacks.
 *
 * @module server/errors
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Error categories for MCP tool errors
 * Each category maps to specific failure modes for debugging
 */
export type ErrorCategory =
  // Validation errors
  | 'VALIDATION_ERROR'

  // Database errors
  | 'DATABASE_NOT_FOUND'
  | 'DATABASE_NOT_SELECTED'
  | 'DATABASE_ALREADY_EXISTS'

  // Document errors
  | 'DOCUMENT_NOT_FOUND'

  // Provenance errors
  | 'PROVENANCE_NOT_FOUND'
  | 'PROVENANCE_CHAIN_BROKEN'
  | 'INTEGRITY_VERIFICATION_FAILED'

  // OCR errors
  | 'OCR_API_ERROR'
  | 'OCR_RATE_LIMIT'
  | 'OCR_TIMEOUT'

  // Embedding/GPU errors
  | 'GPU_NOT_AVAILABLE'
  | 'EMBEDDING_FAILED'

  // VLM/Gemini errors
  | 'VLM_API_ERROR'
  | 'VLM_RATE_LIMIT'

  // Image errors
  | 'IMAGE_EXTRACTION_FAILED'

  // Form fill errors
  | 'FORM_FILL_API_ERROR'

  // Clustering errors
  | 'CLUSTERING_ERROR'

  // GPU errors
  | 'GPU_OUT_OF_MEMORY'
  | 'EMBEDDING_MODEL_ERROR'

  // File system errors
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'PERMISSION_DENIED'

  // Internal errors
  | 'INTERNAL_ERROR';

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR NAME TO CATEGORY MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Valid ErrorCategory values for runtime checking (OCRError has its own category field)
 */
const VALID_CATEGORIES = new Set<string>([
  'VALIDATION_ERROR', 'DATABASE_NOT_FOUND', 'DATABASE_NOT_SELECTED',
  'DATABASE_ALREADY_EXISTS', 'DOCUMENT_NOT_FOUND', 'PROVENANCE_NOT_FOUND',
  'PROVENANCE_CHAIN_BROKEN', 'INTEGRITY_VERIFICATION_FAILED',
  'OCR_API_ERROR', 'OCR_RATE_LIMIT', 'OCR_TIMEOUT',
  'GPU_NOT_AVAILABLE', 'GPU_OUT_OF_MEMORY', 'EMBEDDING_FAILED', 'EMBEDDING_MODEL_ERROR',
  'VLM_API_ERROR', 'VLM_RATE_LIMIT',
  'IMAGE_EXTRACTION_FAILED', 'FORM_FILL_API_ERROR', 'CLUSTERING_ERROR',
  'PATH_NOT_FOUND', 'PATH_NOT_DIRECTORY', 'PERMISSION_DENIED',
  'INTERNAL_ERROR',
]);

/**
 * Check if a string is a valid ErrorCategory
 */
function isValidCategory(value: string): boolean {
  return VALID_CATEGORIES.has(value);
}

/**
 * Map custom error class names to MCPError categories.
 * CS-ERR-001: Every custom error gets its appropriate category so clients
 * can programmatically distinguish rate limits from GPU failures from DB locks.
 *
 * OCRError and its subclasses are handled specially in fromUnknown() because
 * they carry their own .category field with more specific information
 * (e.g., OCR_RATE_LIMIT, OCR_TIMEOUT, FORM_FILL_API_ERROR).
 */
const ERROR_NAME_TO_CATEGORY: Record<string, ErrorCategory> = {
  // Validation
  ValidationError: 'VALIDATION_ERROR',

  // Database / Storage
  DatabaseError: 'DATABASE_NOT_FOUND',
  VectorError: 'INTERNAL_ERROR',
  MigrationError: 'INTERNAL_ERROR',

  // OCR (default category; subclasses use their own .category field)
  OCRError: 'OCR_API_ERROR',
  OCRAPIError: 'OCR_API_ERROR',
  OCRRateLimitError: 'OCR_RATE_LIMIT',
  OCRTimeoutError: 'OCR_TIMEOUT',
  OCRFileError: 'OCR_API_ERROR',
  OCRAuthenticationError: 'OCR_API_ERROR',

  // Embedding / GPU
  EmbeddingError: 'EMBEDDING_FAILED',

  // Provenance
  ProvenanceError: 'PROVENANCE_CHAIN_BROKEN',
  VerifierError: 'INTEGRITY_VERIFICATION_FAILED',
  ExporterError: 'INTERNAL_ERROR',

  // Gemini / VLM
  CircuitBreakerOpenError: 'VLM_API_ERROR',

  // Clustering
  ClusteringError: 'CLUSTERING_ERROR',
};

/**
 * OCR error class names that carry their own `.category` field.
 * Used in fromUnknown() to prefer the error's category over the default mapping.
 */
const OCR_ERROR_NAMES = new Set([
  'OCRError', 'OCRAPIError', 'OCRRateLimitError',
  'OCRTimeoutError', 'OCRFileError', 'OCRAuthenticationError',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// MCP ERROR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MCPError - Structured error class for all MCP tool failures
 *
 * FAIL FAST: Thrown immediately when any error condition is detected.
 * Provides category, message, and optional details for debugging.
 */
export class MCPError extends Error {
  public readonly category: ErrorCategory;
  public readonly details?: Record<string, unknown>;

  constructor(category: ErrorCategory, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MCPError';
    this.category = category;
    this.details = details;

    // Preserve stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MCPError);
    }
  }

  /**
   * Create error from unknown caught value
   * FAIL FAST: Always produces a typed error
   */
  static fromUnknown(error: unknown, defaultCategory: ErrorCategory = 'INTERNAL_ERROR'): MCPError {
    if (error instanceof MCPError) {
      return error;
    }

    if (error instanceof Error) {
      // Map custom error class names to their appropriate MCPError categories.
      // CS-ERR-001: Every custom error class maps to a specific category so
      // clients can programmatically distinguish failure modes.
      const category = ERROR_NAME_TO_CATEGORY[error.name] ?? defaultCategory;

      // For OCRError subclasses, preserve the more specific category from the error itself
      const ocrCategory = (error as { category?: string }).category;
      const resolvedCategory =
        OCR_ERROR_NAMES.has(error.name) && ocrCategory && isValidCategory(ocrCategory)
          ? (ocrCategory as ErrorCategory)
          : category;

      return new MCPError(resolvedCategory, error.message, {
        originalName: error.name,
        stack: error.stack,
      });
    }

    return new MCPError(defaultCategory, String(error), {
      originalValue: error,
    });
  }

  /**
   * Convert to JSON for logging/serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      message: this.message,
      details: this.details,
      stack: this.stack,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR RESPONSE FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format MCPError for tool response
 * ALWAYS includes category, message, and details
 */
export function formatErrorResponse(error: MCPError): {
  success: false;
  error: {
    category: ErrorCategory;
    message: string;
    details?: Record<string, unknown>;
  };
} {
  return {
    success: false,
    error: {
      category: error.category,
      message: error.message,
      details: error.details,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR FACTORY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create validation error
 */
export function validationError(message: string, details?: Record<string, unknown>): MCPError {
  return new MCPError('VALIDATION_ERROR', message, details);
}

/**
 * Create database not selected error
 */
export function databaseNotSelectedError(): MCPError {
  return new MCPError('DATABASE_NOT_SELECTED', 'No database selected. Use ocr_db_list to see available databases, then ocr_db_select to choose one.');
}

/**
 * Create database not found error
 */
export function databaseNotFoundError(name: string, storagePath?: string): MCPError {
  return new MCPError('DATABASE_NOT_FOUND', `Database "${name}" not found`, {
    databaseName: name,
    storagePath,
  });
}

/**
 * Create database already exists error
 */
export function databaseAlreadyExistsError(name: string): MCPError {
  return new MCPError('DATABASE_ALREADY_EXISTS', `Database "${name}" already exists`, {
    databaseName: name,
  });
}

/**
 * Create document not found error
 */
export function documentNotFoundError(documentId: string): MCPError {
  return new MCPError('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}. Use ocr_document_list to browse available documents.`, {
    documentId,
  });
}

/**
 * Create provenance not found error
 */
export function provenanceNotFoundError(itemId: string): MCPError {
  return new MCPError('PROVENANCE_NOT_FOUND', `Provenance for "${itemId}" not found`, {
    itemId,
  });
}

/**
 * Create path not found error
 */
export function pathNotFoundError(path: string): MCPError {
  return new MCPError('PATH_NOT_FOUND', `Path does not exist: ${path}`, {
    path,
  });
}

/**
 * Create path not directory error
 */
export function pathNotDirectoryError(path: string): MCPError {
  return new MCPError('PATH_NOT_DIRECTORY', `Path is not a directory: ${path}`, {
    path,
  });
}

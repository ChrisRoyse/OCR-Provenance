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

  // File system errors
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'PERMISSION_DENIED'

  // Internal errors
  | 'INTERNAL_ERROR';

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

  constructor(
    category: ErrorCategory,
    message: string,
    details?: Record<string, unknown>
  ) {
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
      return new MCPError(defaultCategory, error.message, {
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
 * Tool result structure for error responses
 */
export interface ErrorResponse {
  success: false;
  error: {
    category: ErrorCategory;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Format MCPError for tool response
 * ALWAYS includes category, message, and details
 */
export function formatErrorResponse(error: MCPError): ErrorResponse {
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
  return new MCPError(
    'DATABASE_NOT_SELECTED',
    'No database selected. Use ocr_db_select first.'
  );
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
  return new MCPError('DOCUMENT_NOT_FOUND', `Document "${documentId}" not found`, {
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

/**
 * Create internal error
 */
export function internalError(message: string, details?: Record<string, unknown>): MCPError {
  return new MCPError('INTERNAL_ERROR', message, details);
}

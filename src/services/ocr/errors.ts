/**
 * OCR Error Classes
 *
 * FAIL-FAST: These errors propagate immediately, no fallbacks.
 * Must match Python error categories in python/ocr_worker.py lines 34-94.
 */

export type OCRErrorCategory =
  | 'OCR_API_ERROR'
  | 'OCR_SERVER_ERROR'
  | 'OCR_RATE_LIMIT'
  | 'OCR_TIMEOUT'
  | 'OCR_FILE_ERROR'
  | 'OCR_AUTHENTICATION_ERROR'
  | 'FORM_FILL_API_ERROR'
  | 'FORM_FILL_SERVER_ERROR'
  | 'FORM_FILL_FILE_ERROR'
  | 'FORM_FILL_TIMEOUT';

export class OCRError extends Error {
  constructor(
    message: string,
    public readonly category: OCRErrorCategory,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'OCRError';
  }
}

export class OCRAPIError extends OCRError {
  constructor(
    message: string,
    public readonly statusCode: number,
    requestId?: string
  ) {
    super(message, statusCode >= 500 ? 'OCR_SERVER_ERROR' : 'OCR_API_ERROR', requestId);
    this.name = 'OCRAPIError';
  }
}

export class OCRRateLimitError extends OCRError {
  constructor(
    message: string = 'Rate limit exceeded',
    public readonly retryAfter: number = 60
  ) {
    super(message, 'OCR_RATE_LIMIT');
    this.name = 'OCRRateLimitError';
  }
}

export class OCRTimeoutError extends OCRError {
  constructor(message: string, requestId?: string) {
    super(message, 'OCR_TIMEOUT', requestId);
    this.name = 'OCRTimeoutError';
  }
}

export class OCRFileError extends OCRError {
  constructor(message: string, public readonly filePath: string) {
    super(message, 'OCR_FILE_ERROR');
    this.name = 'OCRFileError';
  }
}

export class OCRAuthenticationError extends OCRError {
  constructor(message: string, public readonly statusCode: number) {
    super(message, 'OCR_AUTHENTICATION_ERROR');
    this.name = 'OCRAuthenticationError';
  }
}

/**
 * Map Python error JSON to TypeScript error class
 * FAIL-FAST: Unknown categories throw OCRError
 */
export function mapPythonError(
  category: string,
  message: string,
  details: Record<string, unknown>
): OCRError {
  switch (category) {
    case 'OCR_API_ERROR':
    case 'OCR_SERVER_ERROR':
      return new OCRAPIError(message, (details.status_code as number) ?? 500, details.request_id as string);
    case 'OCR_RATE_LIMIT':
      return new OCRRateLimitError(message, (details.retry_after as number) ?? 60);
    case 'OCR_TIMEOUT':
      return new OCRTimeoutError(message, details.request_id as string);
    case 'OCR_FILE_ERROR':
      return new OCRFileError(message, (details.file_path as string) ?? 'unknown');
    case 'OCR_AUTHENTICATION_ERROR':
      return new OCRAuthenticationError(message, (details.status_code as number) ?? 401);
    default:
      throw new OCRError(`Unknown error category: ${category}. Message: ${message}`, 'OCR_API_ERROR');
  }
}

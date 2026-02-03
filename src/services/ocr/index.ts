/**
 * OCR Module Exports
 */

export { DatalabClient, type DatalabClientConfig } from './datalab.js';
export { OCRProcessor, type ProcessorConfig, type ProcessResult, type BatchResult } from './processor.js';
export {
  OCRError,
  OCRAPIError,
  OCRRateLimitError,
  OCRTimeoutError,
  OCRFileError,
  OCRAuthenticationError,
  mapPythonError,
  type OCRErrorCategory,
} from './errors.js';

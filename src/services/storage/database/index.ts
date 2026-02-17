/**
 * Database Module - Public API
 *
 * Re-exports all public types, classes, and functions from the database module.
 * This file serves as the facade for backwards compatibility.
 */

// Re-export MigrationError from migrations for convenience
export { MigrationError } from '../migrations.js';

// Export types and error handling
export type {
  DatabaseInfo,
  DatabaseStats,
  ListDocumentsOptions,
  ListImagesOptions,
} from './types.js';
export { DatabaseErrorCode, DatabaseError } from './types.js';

// Export the main service class
export { DatabaseService } from './service.js';

// Export image operations
export {
  insertImage,
  insertImageBatch,
  getImage,
  getImagesByDocument,
  getImagesByOCRResult,
  getPendingImages,
  listImages,
  setImageProcessing,
  updateImageVLMResult,
  setImageVLMFailed,
  updateImageContext,
  getImageStats,
  deleteImage,
  deleteImagesByDocument,
  countImagesByDocument,
  resetFailedImages,
} from './image-operations.js';

// Export converters
export { rowToImage } from './converters.js';


/**
 * Unit Tests for Validation Schemas - Re-export Facade
 *
 * This file has been modularized. All tests are now located in:
 * - ./validation/helpers.test.ts - validateInput, safeValidateInput tests
 * - ./validation/enums.test.ts - Enum tests (OCRMode, ProcessingStatus, etc.)
 * - ./validation/database-schemas.test.ts - Database management schemas
 * - ./validation/ingestion-schemas.test.ts - Document ingestion schemas
 * - ./validation/search-schemas.test.ts - Search schemas
 * - ./validation/documents-schemas.test.ts - Document management schemas
 * - ./validation/provenance-schemas.test.ts - Provenance schemas
 * - ./validation/config-schemas.test.ts - Config schemas
 * - ./validation/type-inference.test.ts - Type inference tests
 *
 * Shared fixtures and imports are in:
 * - ./validation/fixtures.ts
 *
 * Run all validation tests with:
 *   npm test -- --run tests/unit/validation/
 *
 * This facade file re-exports the test modules for backwards compatibility.
 */

// Re-export all test modules to ensure they're discovered by the test runner
export * from './validation/helpers.test.js';
export * from './validation/enums.test.js';
export * from './validation/database-schemas.test.js';
export * from './validation/ingestion-schemas.test.js';
export * from './validation/search-schemas.test.js';
export * from './validation/documents-schemas.test.js';
export * from './validation/provenance-schemas.test.js';
export * from './validation/config-schemas.test.js';
export * from './validation/type-inference.test.js';

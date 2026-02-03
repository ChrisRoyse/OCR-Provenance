/**
 * Shared test helpers for MCP Server Integration Tests
 *
 * Provides helper functions, fixtures, and utilities used across all server integration tests.
 * NO MOCK DATA - Uses real DatabaseService instances with temp databases.
 *
 * @module tests/integration/server/helpers
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../../src/services/storage/database/index.js';
import { VectorService } from '../../../src/services/storage/vector.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';
import {
  state,
  resetState,
  createDatabase,
  selectDatabase,
  deleteDatabase,
  requireDatabase,
  clearDatabase,
  getDefaultStoragePath,
  updateConfig,
} from '../../../src/server/state.js';
import { MCPError, ErrorCategory } from '../../../src/server/errors.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helper to check if sqlite-vec extension is available
 */
export function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

export const sqliteVecAvailable = isSqliteVecAvailable();

if (!sqliteVecAvailable) {
  console.warn(
    'WARNING: sqlite-vec extension not available. Server integration tests requiring vectors will be skipped.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DIRECTORY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a temporary directory for tests
 */
export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Clean up a temporary directory
 */
export function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors in tests
  }
}

/**
 * Create a unique database name
 */
export function createUniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create test provenance record with default values
 */
export function createTestProvenance(overrides: Record<string, unknown> = {}) {
  const id = uuidv4();
  const now = new Date().toISOString();
  return {
    id,
    type: ProvenanceType.DOCUMENT,
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE' as const,
    source_path: '/test/file.pdf',
    source_id: null,
    root_document_id: id,
    location: null,
    content_hash: computeHash('test content ' + id),
    input_hash: null,
    file_hash: computeHash('test file ' + id),
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: { test: true },
    processing_duration_ms: 100,
    processing_quality_score: 0.95,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
    ...overrides,
  };
}

/**
 * Create test document with default values
 */
export function createTestDocument(provenanceId: string, overrides: Record<string, unknown> = {}) {
  const id = uuidv4();
  return {
    id,
    file_path: `/test/document-${id}.pdf`,
    file_name: `document-${id}.pdf`,
    file_hash: computeHash('test file hash ' + id),
    file_size: 1024,
    file_type: 'pdf',
    status: 'pending' as const,
    page_count: null,
    provenance_id: provenanceId,
    modified_at: null,
    ocr_completed_at: null,
    error_message: null,
    ...overrides,
  };
}

/**
 * Create test OCR result with default values
 */
export function createTestOCRResult(
  documentId: string,
  provenanceId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = uuidv4();
  const now = new Date().toISOString();
  return {
    id,
    provenance_id: provenanceId,
    document_id: documentId,
    extracted_text: 'This is the extracted text from the document.',
    text_length: 46,
    datalab_request_id: `req-${id}`,
    datalab_mode: 'balanced' as const,
    parse_quality_score: 4.5,
    page_count: 3,
    cost_cents: 5,
    content_hash: computeHash('extracted text ' + id),
    processing_started_at: now,
    processing_completed_at: now,
    processing_duration_ms: 2500,
    ...overrides,
  };
}

/**
 * Create test chunk with default values
 */
export function createTestChunk(
  documentId: string,
  ocrResultId: string,
  provenanceId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = uuidv4();
  return {
    id,
    document_id: documentId,
    ocr_result_id: ocrResultId,
    text: 'This is the chunk text content.',
    text_hash: computeHash('chunk text ' + id),
    chunk_index: 0,
    character_start: 0,
    character_end: 31,
    page_number: 1,
    page_range: null,
    overlap_previous: 0,
    overlap_next: 0,
    provenance_id: provenanceId,
    ...overrides,
  };
}

/**
 * Create test embedding with default values
 */
export function createTestEmbedding(
  chunkId: string,
  documentId: string,
  provenanceId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = uuidv4();
  return {
    id,
    chunk_id: chunkId,
    document_id: documentId,
    original_text: 'This is the chunk text content.',
    original_text_length: 31,
    source_file_path: '/test/document.pdf',
    source_file_name: 'document.pdf',
    source_file_hash: computeHash('source file'),
    page_number: 1,
    page_range: null,
    character_start: 0,
    character_end: 31,
    chunk_index: 0,
    total_chunks: 1,
    model_name: 'nomic-embed-text-v1.5',
    model_version: '1.5.0',
    task_type: 'search_document' as const,
    inference_mode: 'local' as const,
    gpu_device: 'cuda:0',
    provenance_id: provenanceId,
    content_hash: computeHash('embedding content ' + id),
    generation_duration_ms: 50,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST FIXTURE CREATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a test directory with sample files for ingestion tests
 */
export function createTestFilesDirectory(baseDir: string): string {
  const filesDir = join(baseDir, 'test-files');
  mkdirSync(filesDir, { recursive: true });

  // Create sample files
  writeFileSync(join(filesDir, 'sample1.pdf'), 'PDF content 1');
  writeFileSync(join(filesDir, 'sample2.pdf'), 'PDF content 2');
  writeFileSync(join(filesDir, 'image.png'), 'PNG content');
  writeFileSync(join(filesDir, 'doc.docx'), 'DOCX content');
  writeFileSync(join(filesDir, 'ignored.txt'), 'TXT content - should be ignored');

  // Create subdirectory
  const subDir = join(filesDir, 'subdir');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'nested.pdf'), 'Nested PDF content');

  return filesDir;
}

/**
 * Create a single test file
 */
export function createTestFile(dir: string, name: string, content: string = 'test content'): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE CONTEXT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set up a fresh database for testing with state management
 */
export function setupTestDatabase(tempDir: string, name?: string): string {
  const dbName = name || createUniqueName('test-db');
  updateConfig({ defaultStoragePath: tempDir });
  createDatabase(dbName, undefined, tempDir, true);
  return dbName;
}

/**
 * Create a complete document with provenance for testing
 */
export function createCompleteDocument(
  db: DatabaseService,
  options: { withOCR?: boolean; withChunks?: boolean } = {}
): { documentId: string; provenanceId: string } {
  const prov = createTestProvenance();
  db.insertProvenance(prov);

  const doc = createTestDocument(prov.id);
  db.insertDocument(doc);

  if (options.withOCR) {
    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: prov.id,
      root_document_id: prov.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);

    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    if (options.withChunks) {
      const chunkProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: prov.root_document_id,
        chain_depth: 2,
      });
      db.insertProvenance(chunkProv);

      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
      db.insertChunk(chunk);
    }

    // Update document status to complete
    db.updateDocumentStatus(doc.id, 'complete');
  }

  return { documentId: doc.id, provenanceId: prov.id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSERTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse MCP tool response and extract data
 */
export function parseResponse<T = unknown>(response: { content: Array<{ type: string; text: string }> }): {
  success: boolean;
  data?: T;
  error?: { category: ErrorCategory; message: string; details?: Record<string, unknown> };
} {
  const text = response.content[0].text;
  return JSON.parse(text);
}

/**
 * Assert MCPError has expected category
 */
export function expectMCPError(error: unknown, expectedCategory: ErrorCategory): void {
  if (!(error instanceof MCPError)) {
    throw new Error(`Expected MCPError, got ${error?.constructor?.name || typeof error}`);
  }
  if (error.category !== expectedCategory) {
    throw new Error(`Expected error category ${expectedCategory}, got ${error.category}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS FOR CONVENIENCE
// ═══════════════════════════════════════════════════════════════════════════════

export {
  state,
  resetState,
  createDatabase,
  selectDatabase,
  deleteDatabase,
  requireDatabase,
  clearDatabase,
  getDefaultStoragePath,
  updateConfig,
  MCPError,
  DatabaseService,
  VectorService,
  ProvenanceType,
  computeHash,
  existsSync,
  join,
  uuidv4,
};

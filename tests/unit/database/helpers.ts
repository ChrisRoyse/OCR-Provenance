/**
 * Shared test helpers for DatabaseService tests
 *
 * Provides helper functions, fixtures, and utilities used across all database test modules.
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../../src/services/storage/database.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';

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
    'WARNING: sqlite-vec extension not available. Database tests requiring vectors will be skipped.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create test provenance record with default values
 */
export function createTestProvenance(overrides: Record<string, unknown> = {}) {
  const id = uuidv4();
  return {
    id,
    type: ProvenanceType.DOCUMENT,
    created_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    source_file_created_at: new Date().toISOString(),
    source_file_modified_at: new Date().toISOString(),
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
    chain_path: null,
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
    image_id: null,
    extraction_id: null,
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
// TEST DIRECTORY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a temporary directory for database tests
 */
export function createTestDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Clean up a temporary directory
 */
export function cleanupTestDir(testDir: string): void {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a unique database name
 */
export function createUniqueDatabaseName(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CONTEXT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Context for tests that need a database instance
 */
export interface DatabaseTestContext {
  testDir: string;
  dbService: DatabaseService | undefined;
}

/**
 * Create a fresh database for a test
 */
export function createFreshDatabase(testDir: string, prefix: string): DatabaseService | undefined {
  if (!sqliteVecAvailable) {
    return undefined;
  }
  const name = createUniqueDatabaseName(prefix);
  return DatabaseService.create(name, undefined, testDir);
}

/**
 * Safely close a database service
 */
export function safeCloseDatabase(dbService: DatabaseService | undefined): void {
  if (dbService) {
    try {
      dbService.close();
    } catch {
      // Ignore close errors
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS FOR CONVENIENCE
// ═══════════════════════════════════════════════════════════════════════════════

export { DatabaseService, ProvenanceType, computeHash, existsSync, join, uuidv4 };

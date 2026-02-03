/**
 * Task 15: MCP Server Framework - Full State Verification
 *
 * Manual verification tests that validate:
 * 1. Server module exports work correctly
 * 2. Database operations through state management
 * 3. Error handling with proper categories
 * 4. Physical verification of database state
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Server imports
import {
  MCPError,
  formatErrorResponse,
  validationError,
  databaseNotSelectedError,
  databaseNotFoundError,
  databaseAlreadyExistsError,
  documentNotFoundError,
  provenanceNotFoundError,
  type ErrorCategory,
} from '../../src/server/errors.js';

import {
  successResult,
  failureResult,
  type ToolResult,
} from '../../src/server/types.js';

import {
  state,
  requireDatabase,
  hasDatabase,
  getCurrentDatabaseName,
  selectDatabase,
  createDatabase,
  deleteDatabase,
  clearDatabase,
  getConfig,
  resetState,
} from '../../src/server/state.js';

// Database imports
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { VectorService } from '../../src/services/storage/vector.js';

describe('Task 15 Full State Verification', () => {
  const testDir = join(tmpdir(), `task15-verify-${Date.now()}`);
  const testDbName = `task15-test-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    console.log('\n================================================================================');
    console.log('TASK 15: MCP SERVER FRAMEWORK - FULL STATE VERIFICATION');
    console.log('================================================================================');
    console.log('[SETUP] Test directory:', testDir);
  });

  afterAll(() => {
    resetState();
    // Cleanup databases
    try {
      if (DatabaseService.exists(testDbName)) {
        DatabaseService.delete(testDbName);
      }
    } catch { /* ignore */ }
    // Cleanup test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    console.log('================================================================================');
    console.log('CLEANUP COMPLETE');
    console.log('================================================================================\n');
  });

  it('VERIFICATION: Server exports are correct', () => {
    console.log('\n--- VERIFICATION: Server exports ---');

    // Check MCPError class
    expect(MCPError).toBeDefined();
    const error = new MCPError('VALIDATION_ERROR', 'test message', { key: 'value' });
    expect(error.category).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('test message');
    expect(error.details).toEqual({ key: 'value' });
    console.log('[EXPORT] MCPError class works correctly');

    // Check error factories
    expect(validationError).toBeTypeOf('function');
    expect(databaseNotSelectedError).toBeTypeOf('function');
    expect(databaseNotFoundError).toBeTypeOf('function');
    expect(databaseAlreadyExistsError).toBeTypeOf('function');
    expect(documentNotFoundError).toBeTypeOf('function');
    expect(provenanceNotFoundError).toBeTypeOf('function');
    console.log('[EXPORT] All error factory functions exported');

    // Check type helpers
    expect(successResult).toBeTypeOf('function');
    expect(failureResult).toBeTypeOf('function');
    console.log('[EXPORT] Type helper functions exported');

    // Check state management
    expect(state).toBeDefined();
    expect(requireDatabase).toBeTypeOf('function');
    expect(hasDatabase).toBeTypeOf('function');
    expect(selectDatabase).toBeTypeOf('function');
    expect(createDatabase).toBeTypeOf('function');
    expect(deleteDatabase).toBeTypeOf('function');
    expect(clearDatabase).toBeTypeOf('function');
    console.log('[EXPORT] State management functions exported');

    console.log('VERIFICATION: Server exports PASSED');
  });

  it('VERIFICATION: Error categories are complete', () => {
    console.log('\n--- VERIFICATION: Error categories ---');

    const categories: ErrorCategory[] = [
      'VALIDATION_ERROR',
      'DATABASE_NOT_FOUND',
      'DATABASE_NOT_SELECTED',
      'DATABASE_ALREADY_EXISTS',
      'DOCUMENT_NOT_FOUND',
      'PROVENANCE_NOT_FOUND',
      'PROVENANCE_CHAIN_BROKEN',
      'INTEGRITY_VERIFICATION_FAILED',
      'OCR_API_ERROR',
      'OCR_RATE_LIMIT',
      'OCR_TIMEOUT',
      'GPU_NOT_AVAILABLE',
      'EMBEDDING_FAILED',
      'PATH_NOT_FOUND',
      'PATH_NOT_DIRECTORY',
      'PERMISSION_DENIED',
      'INTERNAL_ERROR',
    ];

    for (const cat of categories) {
      const err = new MCPError(cat, 'test');
      expect(err.category).toBe(cat);
      console.log(`[CATEGORY] ${cat} - OK`);
    }

    console.log('VERIFICATION: All 17 error categories work');
  });

  it('HAPPY PATH: Database creation through state management', () => {
    console.log('\n--- HAPPY PATH: Database creation ---');

    // Ensure clean state
    resetState();
    expect(hasDatabase()).toBe(false);
    console.log('[STATE] Initial state: no database selected');

    // Create database through state
    const db = createDatabase(testDbName);
    expect(db).toBeDefined();
    console.log('[CREATE] Database created:', testDbName);

    // Verify state was updated
    expect(hasDatabase()).toBe(true);
    expect(getCurrentDatabaseName()).toBe(testDbName);
    console.log('[STATE] State updated: database selected');

    // Physical verification - database file exists
    const dbPath = db.getPath();
    expect(existsSync(dbPath)).toBe(true);
    console.log('[PHYSICAL] Database file exists:', dbPath);

    // Get stats to verify database is functional
    const { db: currentDb, vector } = requireDatabase();
    const stats = currentDb.getStats();
    expect(stats.total_documents).toBe(0);
    expect(stats.total_chunks).toBe(0);
    console.log('[STATS] Initial stats - documents: 0, chunks: 0');

    console.log('HAPPY PATH: Database creation PASSED');
  });

  it('HAPPY PATH: Insert document and verify provenance', () => {
    console.log('\n--- HAPPY PATH: Document with provenance ---');

    const { db } = requireDatabase();
    const docId = crypto.randomUUID();
    const provId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert provenance first (FK constraint)
    db.insertProvenance({
      id: provId,
      type: 'DOCUMENT',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FILE',
      source_path: '/test/manual-verify.pdf',
      source_id: null,
      root_document_id: provId,
      location: null,
      content_hash: 'sha256:abcd1234',
      input_hash: null,
      file_hash: 'sha256:abcd1234',
      processor: 'manual-test',
      processor_version: '1.0.0',
      processing_params: { test: true },
      processing_duration_ms: 100,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: '[]',
      chain_depth: 0,
      chain_path: '["DOCUMENT"]',
    });
    console.log('[INSERT] Provenance inserted:', provId);

    // Insert document
    db.insertDocument({
      id: docId,
      file_path: '/test/manual-verify.pdf',
      file_name: 'manual-verify.pdf',
      file_hash: 'sha256:abcd1234',
      file_size: 2048,
      file_type: 'pdf',
      status: 'complete',
      page_count: 3,
      provenance_id: provId,
      error_message: null,
      ocr_completed_at: now,
    });
    console.log('[INSERT] Document inserted:', docId);

    // PHYSICAL VERIFICATION: Query document back
    const doc = db.getDocument(docId);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(docId);
    expect(doc!.file_name).toBe('manual-verify.pdf');
    expect(doc!.status).toBe('complete');
    console.log('[VERIFY] Document retrieved - ID matches:', doc!.id === docId);
    console.log('[VERIFY] Document retrieved - Name:', doc!.file_name);
    console.log('[VERIFY] Document retrieved - Status:', doc!.status);

    // PHYSICAL VERIFICATION: Query provenance back
    const prov = db.getProvenance(provId);
    expect(prov).not.toBeNull();
    expect(prov!.type).toBe('DOCUMENT');
    expect(prov!.chain_depth).toBe(0);
    console.log('[VERIFY] Provenance retrieved - Type:', prov!.type);
    console.log('[VERIFY] Provenance retrieved - Chain depth:', prov!.chain_depth);

    // PHYSICAL VERIFICATION: Provenance chain
    const chain = db.getProvenanceChain(provId);
    expect(chain.length).toBe(1);
    expect(chain[0].id).toBe(provId);
    console.log('[VERIFY] Provenance chain length:', chain.length);

    // Verify stats updated
    const stats = db.getStats();
    expect(stats.total_documents).toBe(1);
    console.log('[STATS] Document count after insert:', stats.total_documents);

    console.log('HAPPY PATH: Document with provenance PASSED');
  });

  it('EDGE CASE: requireDatabase throws when not selected', () => {
    console.log('\n--- EDGE CASE: requireDatabase without selection ---');

    // Clear database
    clearDatabase();
    expect(hasDatabase()).toBe(false);
    console.log('[STATE] Database cleared');

    // FAIL FAST: Should throw immediately
    let errorThrown = false;
    let errorCategory = '';
    try {
      requireDatabase();
    } catch (error) {
      if (error instanceof MCPError) {
        errorThrown = true;
        errorCategory = error.category;
      }
    }

    expect(errorThrown).toBe(true);
    expect(errorCategory).toBe('DATABASE_NOT_SELECTED');
    console.log('[ERROR] MCPError thrown:', errorThrown);
    console.log('[ERROR] Category:', errorCategory);

    // Re-select for subsequent tests
    selectDatabase(testDbName);
    console.log('[STATE] Database re-selected');

    console.log('EDGE CASE: requireDatabase without selection PASSED');
  });

  it('EDGE CASE: Create duplicate database throws', () => {
    console.log('\n--- EDGE CASE: Duplicate database creation ---');

    let errorThrown = false;
    let errorCategory = '';

    try {
      createDatabase(testDbName); // Already exists
    } catch (error) {
      if (error instanceof MCPError) {
        errorThrown = true;
        errorCategory = error.category;
      }
    }

    expect(errorThrown).toBe(true);
    expect(errorCategory).toBe('DATABASE_ALREADY_EXISTS');
    console.log('[ERROR] MCPError thrown:', errorThrown);
    console.log('[ERROR] Category:', errorCategory);

    console.log('EDGE CASE: Duplicate database creation PASSED');
  });

  it('EDGE CASE: Select non-existent database throws', () => {
    console.log('\n--- EDGE CASE: Select non-existent database ---');

    const fakeName = 'nonexistent-db-' + Date.now();
    let errorThrown = false;
    let errorCategory = '';

    try {
      selectDatabase(fakeName);
    } catch (error) {
      if (error instanceof MCPError) {
        errorThrown = true;
        errorCategory = error.category;
      }
    }

    expect(errorThrown).toBe(true);
    expect(errorCategory).toBe('DATABASE_NOT_FOUND');
    console.log('[ERROR] MCPError thrown:', errorThrown);
    console.log('[ERROR] Category:', errorCategory);

    // Re-select valid database
    selectDatabase(testDbName);

    console.log('EDGE CASE: Select non-existent database PASSED');
  });

  it('VALIDATION: ToolResult helpers work correctly', () => {
    console.log('\n--- VALIDATION: ToolResult helpers ---');

    // successResult
    const success = successResult({ foo: 'bar', count: 42 });
    expect(success.success).toBe(true);
    expect(success.data).toEqual({ foo: 'bar', count: 42 });
    console.log('[SUCCESS] successResult creates correct structure');

    // failureResult
    const failure = failureResult('VALIDATION_ERROR', 'Invalid input', { field: 'name' });
    expect(failure.success).toBe(false);
    expect(failure.error.category).toBe('VALIDATION_ERROR');
    expect(failure.error.message).toBe('Invalid input');
    expect(failure.error.details).toEqual({ field: 'name' });
    console.log('[FAILURE] failureResult creates correct structure');

    // formatErrorResponse
    const error = new MCPError('DATABASE_NOT_FOUND', 'Not found', { name: 'test' });
    const response = formatErrorResponse(error);
    expect(response.success).toBe(false);
    expect(response.error.category).toBe('DATABASE_NOT_FOUND');
    console.log('[FORMAT] formatErrorResponse creates correct structure');

    console.log('VALIDATION: ToolResult helpers PASSED');
  });

  it('VALIDATION: VectorService integrates with database', () => {
    console.log('\n--- VALIDATION: VectorService integration ---');

    const { db, vector } = requireDatabase();

    // Verify VectorService was created
    expect(vector).toBeDefined();
    console.log('[CREATE] VectorService created');

    // Get initial count
    const count = vector.getVectorCount();
    expect(count).toBe(0); // No vectors yet
    console.log('[COUNT] Initial vector count:', count);

    console.log('VALIDATION: VectorService integration PASSED');
  });

  it('CLEANUP: Database deletion', () => {
    console.log('\n--- CLEANUP: Database deletion ---');

    // Verify database exists
    expect(DatabaseService.exists(testDbName)).toBe(true);
    console.log('[EXISTS] Database exists before delete');

    // Delete through state
    deleteDatabase(testDbName);
    console.log('[DELETE] deleteDatabase called');

    // Verify state cleared
    expect(hasDatabase()).toBe(false);
    expect(getCurrentDatabaseName()).toBeNull();
    console.log('[STATE] State cleared after delete');

    // Physical verification - file no longer exists
    expect(DatabaseService.exists(testDbName)).toBe(false);
    console.log('[PHYSICAL] Database no longer exists');

    console.log('CLEANUP: Database deletion PASSED');
  });
});

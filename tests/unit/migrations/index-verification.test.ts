/**
 * Index Verification Tests for Database Migrations
 *
 * Tests that all required indexes are created during database initialization.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
  getIndexNames,
  TestContext,
} from './helpers.js';
import { initializeDatabase } from '../../../src/services/storage/migrations.js';

describe('Index Verification', () => {
  const ctx: TestContext = {
    testDir: '',
    db: undefined,
    dbPath: '',
  };

  beforeAll(() => {
    ctx.testDir = createTestDir('migrations-index-verification');
  });

  afterAll(() => {
    cleanupTestDir(ctx.testDir);
  });

  beforeEach(() => {
    const { db, dbPath } = createTestDb(ctx.testDir);
    ctx.db = db;
    ctx.dbPath = dbPath;
  });

  afterEach(() => {
    closeDb(ctx.db);
    ctx.db = undefined;
  });

  const expectedIndexes = [
    'idx_documents_file_path',
    'idx_documents_file_hash',
    'idx_documents_status',
    'idx_ocr_results_document_id',
    'idx_chunks_document_id',
    'idx_chunks_ocr_result_id',
    'idx_chunks_embedding_status',
    'idx_embeddings_chunk_id',
    'idx_embeddings_image_id',
    'idx_embeddings_document_id',
    'idx_embeddings_source_file',
    'idx_embeddings_page',
    'idx_images_document_id',
    'idx_images_ocr_result_id',
    'idx_images_vlm_status',
    'idx_images_page',
    'idx_images_pending',
    'idx_images_provenance_id',
    'idx_images_content_hash',
    'idx_provenance_source_id',
    'idx_provenance_type',
    'idx_provenance_root_document_id',
    'idx_provenance_parent_id',
  ];

  it.skipIf(!sqliteVecAvailable)('should create all 23 required indexes', () => {
    initializeDatabase(ctx.db);
    const indexes = getIndexNames(ctx.db!);

    for (const index of expectedIndexes) {
      expect(indexes).toContain(index);
    }
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_documents_file_path index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_documents_file_path');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_documents_file_hash index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_documents_file_hash');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_documents_status index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_documents_status');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_ocr_results_document_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_ocr_results_document_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_chunks_document_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_chunks_document_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_chunks_ocr_result_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_chunks_ocr_result_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_chunks_embedding_status index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_chunks_embedding_status');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_chunk_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_embeddings_chunk_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_document_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_embeddings_document_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_source_file index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_embeddings_source_file');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_embeddings_page index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_embeddings_page');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_provenance_source_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_provenance_source_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_provenance_type index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_provenance_type');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_provenance_root_document_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_provenance_root_document_id');
  });

  it.skipIf(!sqliteVecAvailable)('should have idx_provenance_parent_id index', () => {
    initializeDatabase(ctx.db);
    expect(getIndexNames(ctx.db!)).toContain('idx_provenance_parent_id');
  });
});

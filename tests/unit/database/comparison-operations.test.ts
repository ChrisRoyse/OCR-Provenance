/**
 * Comparison Operations Tests
 *
 * Tests CRUD operations for the comparisons table via the standalone
 * functions in comparison-operations.ts. Uses REAL databases
 * (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createFreshDatabase,
  safeCloseDatabase,
  DatabaseService,
  ProvenanceType,
  computeHash,
  uuidv4,
} from './helpers.js';
import {
  insertComparison,
  getComparison,
  listComparisons,
} from '../../../src/services/storage/database/comparison-operations.js';
import type { Comparison } from '../../../src/models/comparison.js';

describe('Comparison Operations', () => {
  let testDir: string;
  let dbService: DatabaseService | undefined;

  // IDs stored after setup
  let docId1: string;
  let docId2: string;
  let docProvId1: string;
  let docProvId2: string;

  beforeEach(() => {
    testDir = createTestDir('db-comp-ops-');
    dbService = createFreshDatabase(testDir, 'test-comp');
    if (!dbService) return;

    // Create two complete document chains for comparison tests

    // Document 1
    const prov1 = createTestProvenance();
    docProvId1 = prov1.id;
    dbService.insertProvenance(prov1);
    const doc1 = createTestDocument(prov1.id, { status: 'complete' });
    docId1 = doc1.id;
    dbService.insertDocument(doc1);

    const ocrProvId1 = uuidv4();
    dbService.insertProvenance({
      id: ocrProvId1,
      type: ProvenanceType.OCR_RESULT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'OCR' as const,
      source_path: null,
      source_id: prov1.id,
      root_document_id: prov1.id,
      location: null,
      content_hash: computeHash('ocr-' + ocrProvId1),
      input_hash: null,
      file_hash: null,
      processor: 'datalab-marker',
      processor_version: '1.0.0',
      processing_params: { mode: 'balanced' },
      processing_duration_ms: 1000,
      processing_quality_score: 4.5,
      parent_id: prov1.id,
      parent_ids: JSON.stringify([prov1.id]),
      chain_depth: 1,
      chain_path: null,
    });
    const ocr1 = createTestOCRResult(doc1.id, ocrProvId1);
    dbService.insertOCRResult(ocr1);

    // Document 2
    const prov2 = createTestProvenance();
    docProvId2 = prov2.id;
    dbService.insertProvenance(prov2);
    const doc2 = createTestDocument(prov2.id, { status: 'complete' });
    docId2 = doc2.id;
    dbService.insertDocument(doc2);

    const ocrProvId2 = uuidv4();
    dbService.insertProvenance({
      id: ocrProvId2,
      type: ProvenanceType.OCR_RESULT,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'OCR' as const,
      source_path: null,
      source_id: prov2.id,
      root_document_id: prov2.id,
      location: null,
      content_hash: computeHash('ocr-' + ocrProvId2),
      input_hash: null,
      file_hash: null,
      processor: 'datalab-marker',
      processor_version: '1.0.0',
      processing_params: { mode: 'balanced' },
      processing_duration_ms: 1200,
      processing_quality_score: 4.2,
      parent_id: prov2.id,
      parent_ids: JSON.stringify([prov2.id]),
      chain_depth: 1,
      chain_path: null,
    });
    const ocr2 = createTestOCRResult(doc2.id, ocrProvId2);
    dbService.insertOCRResult(ocr2);
  });

  afterEach(() => {
    safeCloseDatabase(dbService);
    cleanupTestDir(testDir);
  });

  /**
   * Helper: create a COMPARISON provenance record via DatabaseService
   */
  function createComparisonProvenance(rootDocProvId: string): string {
    const provId = uuidv4();
    dbService!.insertProvenance({
      id: provId,
      type: ProvenanceType.COMPARISON,
      created_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'COMPARISON' as const,
      source_path: null,
      source_id: rootDocProvId,
      root_document_id: rootDocProvId,
      location: null,
      content_hash: computeHash('comparison-' + provId),
      input_hash: null,
      file_hash: null,
      processor: 'document-comparison',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 200,
      processing_quality_score: null,
      parent_id: rootDocProvId,
      parent_ids: JSON.stringify([rootDocProvId]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'COMPARISON']),
    });
    return provId;
  }

  /**
   * Helper: build a Comparison object for insertion
   */
  function buildComparison(overrides: Partial<Comparison> = {}): Comparison {
    const id = uuidv4();
    const provId = createComparisonProvenance(docProvId1);
    const now = new Date().toISOString();
    return {
      id,
      document_id_1: docId1,
      document_id_2: docId2,
      similarity_ratio: 0.85,
      text_diff_json: JSON.stringify({
        operations: [{ type: 'equal', text: 'hello', doc1_offset: 0, doc2_offset: 0, line_count: 1 }],
        total_operations: 1,
        truncated: false,
        insertions: 0,
        deletions: 0,
        unchanged: 1,
        similarity_ratio: 0.85,
        doc1_length: 100,
        doc2_length: 100,
      }),
      structural_diff_json: JSON.stringify({
        doc1_page_count: 5,
        doc2_page_count: 5,
        doc1_chunk_count: 3,
        doc2_chunk_count: 4,
        doc1_text_length: 5000,
        doc2_text_length: 5200,
        doc1_quality_score: 4.5,
        doc2_quality_score: 4.2,
        doc1_ocr_mode: 'balanced',
        doc2_ocr_mode: 'balanced',
      }),
      entity_diff_json: JSON.stringify({
        doc1_total_entities: 10,
        doc2_total_entities: 12,
        by_type: {},
      }),
      summary: 'Documents are 85% similar. Same page count (5). Text length differs by 200 chars.',
      content_hash: computeHash('comparison-content-' + id),
      provenance_id: provId,
      created_at: now,
      processing_duration_ms: 250,
      ...overrides,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INSERT
  // ═══════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('insert comparison - row exists in DB', () => {
    const comp = buildComparison();
    const db = dbService!.getConnection();

    const returnedId = insertComparison(db, comp);
    expect(returnedId).toBe(comp.id);

    // Verify by direct SELECT
    const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(comp.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.document_id_1).toBe(docId1);
    expect(row.document_id_2).toBe(docId2);
    expect(row.similarity_ratio).toBe(0.85);
    expect(row.summary).toContain('85% similar');
  });

  it.skipIf(!sqliteVecAvailable)('insert FK violation (bad document_id_1) - throws', () => {
    const comp = buildComparison({ document_id_1: 'nonexistent-doc' });
    const db = dbService!.getConnection();

    expect(() => insertComparison(db, comp)).toThrow(/Foreign key violation/);

    // Verify row was NOT inserted
    const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(comp.id);
    expect(row).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET
  // ═══════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('get by ID - returns full Comparison object', () => {
    const comp = buildComparison();
    const db = dbService!.getConnection();
    insertComparison(db, comp);

    const result = getComparison(db, comp.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(comp.id);
    expect(result!.document_id_1).toBe(comp.document_id_1);
    expect(result!.document_id_2).toBe(comp.document_id_2);
    expect(result!.similarity_ratio).toBe(0.85);
    expect(result!.text_diff_json).toBe(comp.text_diff_json);
    expect(result!.structural_diff_json).toBe(comp.structural_diff_json);
    expect(result!.entity_diff_json).toBe(comp.entity_diff_json);
    expect(result!.summary).toBe(comp.summary);
    expect(result!.content_hash).toBe(comp.content_hash);
    expect(result!.provenance_id).toBe(comp.provenance_id);
    expect(result!.processing_duration_ms).toBe(250);
  });

  it.skipIf(!sqliteVecAvailable)('get non-existent - returns null', () => {
    const db = dbService!.getConnection();
    const result = getComparison(db, 'nonexistent-id');
    expect(result).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST
  // ═══════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('list all - returns all, ordered by created_at DESC', () => {
    const db = dbService!.getConnection();

    // Insert two comparisons with distinct created_at to verify ordering
    const comp1 = buildComparison({ created_at: '2026-01-01T00:00:00.000Z' });
    insertComparison(db, comp1);

    const comp2 = buildComparison({ created_at: '2026-02-01T00:00:00.000Z' });
    insertComparison(db, comp2);

    const results = listComparisons(db);
    expect(results.length).toBe(2);
    // Most recent first (comp2 then comp1)
    expect(results[0].id).toBe(comp2.id);
    expect(results[1].id).toBe(comp1.id);
  });

  it.skipIf(!sqliteVecAvailable)('list by document_id (as doc1) - returns matching', () => {
    const db = dbService!.getConnection();

    // Create a third document to use as an unrelated doc
    const prov3 = createTestProvenance();
    dbService!.insertProvenance(prov3);
    const doc3 = createTestDocument(prov3.id, { status: 'complete' });
    dbService!.insertDocument(doc3);

    // Comparison between doc1 and doc2
    const comp1 = buildComparison();
    insertComparison(db, comp1);

    // Comparison between doc3 and doc2 (doc1 NOT involved)
    const compProv2 = createComparisonProvenance(prov3.id);
    const comp2: Comparison = {
      id: uuidv4(),
      document_id_1: doc3.id,
      document_id_2: docId2,
      similarity_ratio: 0.5,
      text_diff_json: '{}',
      structural_diff_json: '{}',
      entity_diff_json: '{}',
      summary: 'Different docs',
      content_hash: computeHash('comp2-hash'),
      provenance_id: compProv2,
      created_at: new Date().toISOString(),
      processing_duration_ms: 100,
    };
    insertComparison(db, comp2);

    // Filter by doc1 -- should only find comp1 (doc1 is document_id_1)
    const results = listComparisons(db, { document_id: docId1 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(comp1.id);
  });

  it.skipIf(!sqliteVecAvailable)('list by document_id (as doc2) - returns matching', () => {
    const db = dbService!.getConnection();

    // Create a third document
    const prov3 = createTestProvenance();
    dbService!.insertProvenance(prov3);
    const doc3 = createTestDocument(prov3.id, { status: 'complete' });
    dbService!.insertDocument(doc3);

    // Comparison between doc3 and doc1 (doc1 is document_id_2)
    const compProv = createComparisonProvenance(prov3.id);
    const comp: Comparison = {
      id: uuidv4(),
      document_id_1: doc3.id,
      document_id_2: docId1,
      similarity_ratio: 0.7,
      text_diff_json: '{}',
      structural_diff_json: '{}',
      entity_diff_json: '{}',
      summary: 'Somewhat similar',
      content_hash: computeHash('comp-doc2-test'),
      provenance_id: compProv,
      created_at: new Date().toISOString(),
      processing_duration_ms: 150,
    };
    insertComparison(db, comp);

    // Filter by doc1 -- should find it even though doc1 is document_id_2
    const results = listComparisons(db, { document_id: docId1 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(comp.id);
  });

  it.skipIf(!sqliteVecAvailable)('list with pagination (limit=1) - returns 1 result', () => {
    const db = dbService!.getConnection();

    const comp1 = buildComparison({ created_at: '2026-01-01T00:00:00.000Z' });
    insertComparison(db, comp1);

    const comp2 = buildComparison({ created_at: '2026-02-01T00:00:00.000Z' });
    insertComparison(db, comp2);

    const page1 = listComparisons(db, { limit: 1 });
    expect(page1.length).toBe(1);
    // Most recent first
    expect(page1[0].id).toBe(comp2.id);

    const page2 = listComparisons(db, { limit: 1, offset: 1 });
    expect(page2.length).toBe(1);
    expect(page2[0].id).toBe(comp1.id);
  });

  it.skipIf(!sqliteVecAvailable)('list empty - returns empty array', () => {
    const db = dbService!.getConnection();

    const results = listComparisons(db);
    expect(results).toEqual([]);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // JSON ROUND-TRIP
  // ═══════════════════════════════════════════════════════════════════════════

  it.skipIf(!sqliteVecAvailable)('JSON round-trip - text_diff_json stored and retrieved identically', () => {
    const db = dbService!.getConnection();

    const complexTextDiff = {
      operations: [
        { type: 'equal', text: 'Line 1\nLine 2\n', doc1_offset: 0, doc2_offset: 0, line_count: 2 },
        { type: 'delete', text: 'Removed line\n', doc1_offset: 14, doc2_offset: 14, line_count: 1 },
        { type: 'insert', text: 'Added line\n', doc1_offset: 27, doc2_offset: 14, line_count: 1 },
        { type: 'equal', text: 'Line 4\n', doc1_offset: 27, doc2_offset: 25, line_count: 1 },
      ],
      total_operations: 4,
      truncated: false,
      insertions: 1,
      deletions: 1,
      unchanged: 2,
      similarity_ratio: 0.75,
      doc1_length: 34,
      doc2_length: 32,
    };

    const complexStructDiff = {
      doc1_page_count: 10,
      doc2_page_count: 12,
      doc1_chunk_count: 15,
      doc2_chunk_count: 18,
      doc1_text_length: 15000,
      doc2_text_length: 18500,
      doc1_quality_score: 4.8,
      doc2_quality_score: 3.9,
      doc1_ocr_mode: 'accurate',
      doc2_ocr_mode: 'balanced',
    };

    const complexEntityDiff = {
      doc1_total_entities: 25,
      doc2_total_entities: 30,
      by_type: {
        person: { doc1_count: 5, doc2_count: 7, common: ['John Doe'], doc1_only: ['Jane Smith'], doc2_only: ['Bob Jones', 'Alice Brown'] },
        organization: { doc1_count: 3, doc2_count: 3, common: ['Acme Corp', 'BigCo'], doc1_only: ['SmallCo'], doc2_only: ['MediumCo'] },
      },
    };

    const comp = buildComparison({
      text_diff_json: JSON.stringify(complexTextDiff),
      structural_diff_json: JSON.stringify(complexStructDiff),
      entity_diff_json: JSON.stringify(complexEntityDiff),
    });
    insertComparison(db, comp);

    const result = getComparison(db, comp.id);
    expect(result).not.toBeNull();

    // Parse and verify deep equality
    const retrievedTextDiff = JSON.parse(result!.text_diff_json);
    expect(retrievedTextDiff).toEqual(complexTextDiff);

    const retrievedStructDiff = JSON.parse(result!.structural_diff_json);
    expect(retrievedStructDiff).toEqual(complexStructDiff);

    const retrievedEntityDiff = JSON.parse(result!.entity_diff_json);
    expect(retrievedEntityDiff).toEqual(complexEntityDiff);

    // Verify the entity diff contains the specific nested arrays
    expect(retrievedEntityDiff.by_type.person.common).toEqual(['John Doe']);
    expect(retrievedEntityDiff.by_type.person.doc2_only).toEqual(['Bob Jones', 'Alice Brown']);
  });
});

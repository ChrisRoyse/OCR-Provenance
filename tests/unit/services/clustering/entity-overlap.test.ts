/**
 * Entity Overlap Matrix Tests (OPT-5)
 *
 * Tests computeEntityOverlapMatrix() in clustering-service.ts with REAL databases.
 * Verifies KG-powered clustering entity overlap computation, including:
 *   - Correct pairwise overlap from shared KG nodes
 *   - Error when no KG data exists
 *   - Self-overlap = 1.0
 *   - Symmetric matrix
 *
 * NO mocks. Uses real SQLite databases.
 *
 * @module tests/unit/services/clustering/entity-overlap
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { computeEntityOverlapMatrix } from '../../../../src/services/clustering/clustering-service.js';
import { DatabaseService } from '../../../../src/services/storage/database/index.js';
import { computeHash } from '../../../../src/utils/hash.js';
import type Database from 'better-sqlite3';

// =============================================================================
// SQLITE-VEC AVAILABILITY CHECK
// =============================================================================

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// =============================================================================
// HELPERS
// =============================================================================

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});

/**
 * Insert a complete document chain: provenance + document
 */
function insertDocumentChain(
  db: DatabaseService,
  fileName: string,
  filePath: string,
): { docId: string; docProvId: string } {
  const docId = uuidv4();
  const docProvId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(filePath);

  db.insertProvenance({
    id: docProvId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: filePath,
    source_id: null,
    root_document_id: docProvId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  db.insertDocument({
    id: docId,
    file_path: filePath,
    file_name: fileName,
    file_hash: fileHash,
    file_size: 1024,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  return { docId, docProvId };
}

/**
 * Create a KG provenance record
 */
function createKGProvenance(db: DatabaseService, rootProvId: string): string {
  const provId = uuidv4();
  const now = new Date().toISOString();
  db.insertProvenance({
    id: provId,
    type: 'KNOWLEDGE_GRAPH',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'KNOWLEDGE_GRAPH',
    source_path: null,
    source_id: rootProvId,
    root_document_id: rootProvId,
    location: null,
    content_hash: computeHash(`kg-${provId}`),
    input_hash: null,
    file_hash: null,
    processor: 'knowledge-graph-builder',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 50,
    processing_quality_score: null,
    parent_id: rootProvId,
    parent_ids: JSON.stringify([rootProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
  });
  return provId;
}

/**
 * Create a KG node and link it to a document
 */
function createKGNodeForDoc(
  conn: Database.Database,
  provId: string,
  docId: string,
  canonicalName: string,
  entityType: string,
): string {
  const nodeId = uuidv4();
  const now = new Date().toISOString();

  conn.prepare(`
    INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
      aliases, document_count, mention_count, edge_count, avg_confidence, metadata,
      provenance_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nodeId, entityType, canonicalName, canonicalName.toLowerCase(),
    null, 1, 1, 0, 0.9, null, provId, now, now);

  // Create a dummy entity to link through
  const entityId = uuidv4();
  conn.prepare(`
    INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
      confidence, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entityId, docId, entityType, canonicalName, canonicalName.toLowerCase(), 0.9, provId, now);

  // Link entity to KG node
  conn.prepare(`
    INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), nodeId, entityId, docId, 1.0, 'exact', now);

  return nodeId;
}

// =============================================================================
// TESTS
// =============================================================================

describe('computeEntityOverlapMatrix', () => {
  let tempDir: string;
  let dbService: DatabaseService;
  let conn: Database.Database;

  beforeEach(() => {
    tempDir = createTempDir('entity-overlap-');
    tempDirs.push(tempDir);
    const dbName = `overlap-test-${Date.now()}`;
    dbService = DatabaseService.create(dbName, undefined, tempDir);
    conn = dbService.getConnection();
  });

  afterEach(() => {
    dbService?.close();
  });

  it.skipIf(!sqliteVecAvailable)('throws when no KG data exists for any document', () => {
    const doc1 = insertDocumentChain(dbService, 'a.pdf', '/test/a.pdf');
    const doc2 = insertDocumentChain(dbService, 'b.pdf', '/test/b.pdf');

    expect(() => computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId])).toThrow(
      'entity_weight > 0 but no knowledge graph data found'
    );
  });

  it.skipIf(!sqliteVecAvailable)('self-overlap is always 1.0', () => {
    const doc1 = insertDocumentChain(dbService, 'self.pdf', '/test/self.pdf');
    const doc2 = insertDocumentChain(dbService, 'other.pdf', '/test/other.pdf');
    const kgProvId = createKGProvenance(dbService, doc1.docProvId);

    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alice', 'person');
    createKGNodeForDoc(conn, kgProvId, doc2.docId, 'Bob', 'person');

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    expect(matrix[0][0]).toBe(1.0);
    expect(matrix[1][1]).toBe(1.0);
  });

  it.skipIf(!sqliteVecAvailable)('matrix is symmetric', () => {
    const doc1 = insertDocumentChain(dbService, 'sym1.pdf', '/test/sym1.pdf');
    const doc2 = insertDocumentChain(dbService, 'sym2.pdf', '/test/sym2.pdf');
    const kgProvId = createKGProvenance(dbService, doc1.docProvId);

    // Shared node between doc1 and doc2
    const sharedNodeId = createKGNodeForDoc(conn, kgProvId, doc1.docId, 'SharedCorp', 'organization');
    // Also link doc2 to the shared node
    const entityId2 = uuidv4();
    const now = new Date().toISOString();
    conn.prepare(`
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId2, doc2.docId, 'organization', 'SharedCorp', 'sharedcorp', 0.9, kgProvId, now);
    conn.prepare(`
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), sharedNodeId, entityId2, doc2.docId, 1.0, 'exact', now);

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    expect(matrix[0][1]).toBe(matrix[1][0]);
  });

  it.skipIf(!sqliteVecAvailable)('no shared nodes yields 0 overlap', () => {
    const doc1 = insertDocumentChain(dbService, 'no-share1.pdf', '/test/no-share1.pdf');
    const doc2 = insertDocumentChain(dbService, 'no-share2.pdf', '/test/no-share2.pdf');
    const kgProvId = createKGProvenance(dbService, doc1.docProvId);

    // Separate nodes for each document
    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alice', 'person');
    createKGNodeForDoc(conn, kgProvId, doc2.docId, 'Bob', 'person');

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    expect(matrix[0][1]).toBe(0);
    expect(matrix[1][0]).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('shared node yields correct overlap ratio', () => {
    const doc1 = insertDocumentChain(dbService, 'ratio1.pdf', '/test/ratio1.pdf');
    const doc2 = insertDocumentChain(dbService, 'ratio2.pdf', '/test/ratio2.pdf');
    const kgProvId = createKGProvenance(dbService, doc1.docProvId);
    const now = new Date().toISOString();

    // doc1: 2 nodes (Alice, SharedCorp)
    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alice', 'person');
    const sharedNodeId = createKGNodeForDoc(conn, kgProvId, doc1.docId, 'SharedCorp', 'organization');

    // doc2: 1 node (SharedCorp - shared with doc1)
    const entityId2 = uuidv4();
    conn.prepare(`
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId2, doc2.docId, 'organization', 'SharedCorp', 'sharedcorp', 0.9, kgProvId, now);
    conn.prepare(`
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), sharedNodeId, entityId2, doc2.docId, 1.0, 'exact', now);

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId]);

    // |shared| = 1, max(|doc1_nodes|, |doc2_nodes|) = max(2, 1) = 2
    // overlap = 1 / 2 = 0.5
    expect(matrix[0][1]).toBe(0.5);
    expect(matrix[1][0]).toBe(0.5);
  });

  it.skipIf(!sqliteVecAvailable)('3x3 matrix for three documents', () => {
    const doc1 = insertDocumentChain(dbService, 'd1.pdf', '/test/d1.pdf');
    const doc2 = insertDocumentChain(dbService, 'd2.pdf', '/test/d2.pdf');
    const doc3 = insertDocumentChain(dbService, 'd3.pdf', '/test/d3.pdf');
    const kgProvId = createKGProvenance(dbService, doc1.docProvId);

    // Each document gets a unique node
    createKGNodeForDoc(conn, kgProvId, doc1.docId, 'Alpha', 'person');
    createKGNodeForDoc(conn, kgProvId, doc2.docId, 'Beta', 'person');
    createKGNodeForDoc(conn, kgProvId, doc3.docId, 'Gamma', 'person');

    const matrix = computeEntityOverlapMatrix(conn, [doc1.docId, doc2.docId, doc3.docId]);

    // 3x3 matrix
    expect(matrix.length).toBe(3);
    expect(matrix[0].length).toBe(3);
    expect(matrix[1].length).toBe(3);
    expect(matrix[2].length).toBe(3);

    // Diagonal is 1
    expect(matrix[0][0]).toBe(1.0);
    expect(matrix[1][1]).toBe(1.0);
    expect(matrix[2][2]).toBe(1.0);

    // Off-diagonal is 0 (no shared nodes)
    expect(matrix[0][1]).toBe(0);
    expect(matrix[0][2]).toBe(0);
    expect(matrix[1][2]).toBe(0);
  });
});

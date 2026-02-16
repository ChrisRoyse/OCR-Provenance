/**
 * KG Snapshot Archival Tests (OPT-11)
 *
 * Tests archiveKGSubgraphForDocument() in document-operations.ts with REAL databases.
 * Verifies:
 *   - Returns {archived: false} when no KG data exists
 *   - Writes JSON archive file with nodes, edges, links, entities
 *   - Archive file is valid JSON with expected structure
 *   - Correct counts returned
 *
 * NO mocks. Uses real SQLite databases and real filesystem.
 *
 * @module tests/unit/services/storage/kg-archive
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { archiveKGSubgraphForDocument } from '../../../../src/services/storage/database/document-operations.js';
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

function insertDocumentChain(
  db: DatabaseService,
  fileName: string,
  filePath: string
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

function createKGProvenanceAndData(
  db: DatabaseService,
  conn: Database.Database,
  docId: string,
  rootProvId: string
): { kgProvId: string; nodeIds: string[]; edgeIds: string[]; entityIds: string[] } {
  const kgProvId = uuidv4();
  const now = new Date().toISOString();

  db.insertProvenance({
    id: kgProvId,
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
    content_hash: computeHash(`kg-${kgProvId}`),
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

  // Create entity extraction provenance
  const entProvId = uuidv4();
  db.insertProvenance({
    id: entProvId,
    type: 'ENTITY_EXTRACTION',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION',
    source_path: null,
    source_id: rootProvId,
    root_document_id: rootProvId,
    location: null,
    content_hash: computeHash(`ent-${entProvId}`),
    input_hash: null,
    file_hash: null,
    processor: 'entity-extractor',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 50,
    processing_quality_score: null,
    parent_id: rootProvId,
    parent_ids: JSON.stringify([rootProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });

  // Insert entities
  const entityIds: string[] = [];
  const entities = [
    { raw: 'John Smith', normalized: 'john smith', type: 'person' },
    { raw: 'Acme Corp', normalized: 'acme corp', type: 'organization' },
  ];

  for (const ent of entities) {
    const entityId = uuidv4();
    entityIds.push(entityId);
    conn
      .prepare(
        `
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(entityId, docId, ent.type, ent.raw, ent.normalized, 0.9, entProvId, now);
  }

  // Insert KG nodes
  const nodeIds: string[] = [];
  for (let i = 0; i < entities.length; i++) {
    const nodeId = uuidv4();
    nodeIds.push(nodeId);
    conn
      .prepare(
        `
      INSERT INTO knowledge_nodes (id, entity_type, canonical_name, normalized_name,
        aliases, document_count, mention_count, edge_count, avg_confidence, metadata,
        provenance_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        nodeId,
        entities[i].type,
        entities[i].raw,
        entities[i].normalized,
        null,
        1,
        1,
        0,
        0.9,
        null,
        kgProvId,
        now,
        now
      );

    // Link entity to node
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), nodeId, entityIds[i], docId, 1.0, 'exact', now);
  }

  // Insert KG edge
  const edgeIds: string[] = [];
  const edgeId = uuidv4();
  edgeIds.push(edgeId);
  conn
    .prepare(
      `
    INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relationship_type,
      weight, evidence_count, document_ids, metadata, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      edgeId,
      nodeIds[0],
      nodeIds[1],
      'works_at',
      1.0,
      1,
      JSON.stringify([docId]),
      null,
      kgProvId,
      now
    );

  // Update edge counts
  conn
    .prepare('UPDATE knowledge_nodes SET edge_count = 1 WHERE id IN (?, ?)')
    .run(nodeIds[0], nodeIds[1]);

  return { kgProvId, nodeIds, edgeIds, entityIds };
}

// =============================================================================
// TESTS
// =============================================================================

describe('archiveKGSubgraphForDocument', () => {
  let tempDir: string;
  let archiveDir: string;
  let dbService: DatabaseService;
  let conn: Database.Database;

  beforeEach(() => {
    tempDir = createTempDir('kg-archive-');
    tempDirs.push(tempDir);
    archiveDir = join(tempDir, 'archives');
    const dbName = `archive-test-${Date.now()}`;
    dbService = DatabaseService.create(dbName, undefined, tempDir);
    conn = dbService.getConnection();
  });

  afterEach(() => {
    dbService?.close();
  });

  it.skipIf(!sqliteVecAvailable)('returns archived=false when no KG data', () => {
    const doc = insertDocumentChain(dbService, 'no-kg.pdf', '/test/no-kg.pdf');

    const result = archiveKGSubgraphForDocument(conn, doc.docId, archiveDir);

    expect(result.archived).toBe(false);
    expect(result.archive_path).toBeNull();
    expect(result.nodes_archived).toBe(0);
    expect(result.edges_archived).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('archives KG data and writes valid JSON file', () => {
    const doc = insertDocumentChain(dbService, 'with-kg.pdf', '/test/with-kg.pdf');
    createKGProvenanceAndData(dbService, conn, doc.docId, doc.docProvId);

    const result = archiveKGSubgraphForDocument(conn, doc.docId, archiveDir);

    expect(result.archived).toBe(true);
    expect(result.archive_path).not.toBeNull();
    expect(result.nodes_archived).toBe(2);
    expect(result.edges_archived).toBe(1);

    // Verify file exists and is valid JSON
    expect(existsSync(result.archive_path!)).toBe(true);
    const content = readFileSync(result.archive_path!, 'utf-8');
    const archive = JSON.parse(content);

    expect(archive.archive_type).toBe('kg_snapshot');
    expect(archive.document_id).toBe(doc.docId);
    expect(archive.archived_at).toBeDefined();
  });

  it.skipIf(!sqliteVecAvailable)('archive JSON contains nodes, edges, links, entities', () => {
    const doc = insertDocumentChain(dbService, 'full-archive.pdf', '/test/full-archive.pdf');
    const { nodeIds, edgeIds, entityIds } = createKGProvenanceAndData(
      dbService,
      conn,
      doc.docId,
      doc.docProvId
    );

    const result = archiveKGSubgraphForDocument(conn, doc.docId, archiveDir);
    const archive = JSON.parse(readFileSync(result.archive_path!, 'utf-8'));

    // Verify nodes
    expect(archive.nodes).toBeDefined();
    expect(Array.isArray(archive.nodes)).toBe(true);
    expect(archive.nodes.length).toBe(2);
    const archivedNodeIds = archive.nodes.map((n: { id: string }) => n.id);
    for (const nodeId of nodeIds) {
      expect(archivedNodeIds).toContain(nodeId);
    }

    // Verify edges
    expect(archive.edges).toBeDefined();
    expect(Array.isArray(archive.edges)).toBe(true);
    expect(archive.edges.length).toBe(1);
    expect(archive.edges[0].id).toBe(edgeIds[0]);
    expect(archive.edges[0].relationship_type).toBe('works_at');

    // Verify node_entity_links
    expect(archive.node_entity_links).toBeDefined();
    expect(Array.isArray(archive.node_entity_links)).toBe(true);
    expect(archive.node_entity_links.length).toBe(2);

    // Verify entities
    expect(archive.entities).toBeDefined();
    expect(Array.isArray(archive.entities)).toBe(true);
    expect(archive.entities.length).toBe(2);
    const archivedEntityIds = archive.entities.map((e: { id: string }) => e.id);
    for (const entityId of entityIds) {
      expect(archivedEntityIds).toContain(entityId);
    }
  });

  it.skipIf(!sqliteVecAvailable)('archive file path contains document ID and timestamp', () => {
    const doc = insertDocumentChain(dbService, 'path-check.pdf', '/test/path-check.pdf');
    createKGProvenanceAndData(dbService, conn, doc.docId, doc.docProvId);

    const result = archiveKGSubgraphForDocument(conn, doc.docId, archiveDir);

    expect(result.archive_path).not.toBeNull();
    expect(result.archive_path!).toContain('kg-archive-');
    expect(result.archive_path!).toContain(doc.docId);
    expect(result.archive_path!).toContain(archiveDir);
    expect(result.archive_path!).toMatch(/\.json$/);
  });

  it.skipIf(!sqliteVecAvailable)('creates archive directory if it does not exist', () => {
    const doc = insertDocumentChain(dbService, 'mkdir.pdf', '/test/mkdir.pdf');
    createKGProvenanceAndData(dbService, conn, doc.docId, doc.docProvId);

    const nestedArchiveDir = join(archiveDir, 'deep', 'nested');
    expect(existsSync(nestedArchiveDir)).toBe(false);

    const result = archiveKGSubgraphForDocument(conn, doc.docId, nestedArchiveDir);

    expect(result.archived).toBe(true);
    expect(existsSync(nestedArchiveDir)).toBe(true);
    expect(existsSync(result.archive_path!)).toBe(true);
  });

  it.skipIf(!sqliteVecAvailable)('returns archived=false for nonexistent document', () => {
    const result = archiveKGSubgraphForDocument(conn, 'nonexistent-doc-id', archiveDir);

    expect(result.archived).toBe(false);
    expect(result.nodes_archived).toBe(0);
    expect(result.edges_archived).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)('archive nodes contain all expected fields', () => {
    const doc = insertDocumentChain(dbService, 'fields.pdf', '/test/fields.pdf');
    createKGProvenanceAndData(dbService, conn, doc.docId, doc.docProvId);

    const result = archiveKGSubgraphForDocument(conn, doc.docId, archiveDir);
    const archive = JSON.parse(readFileSync(result.archive_path!, 'utf-8'));
    const node = archive.nodes[0];

    // Verify knowledge_node fields are present
    expect(node).toHaveProperty('id');
    expect(node).toHaveProperty('entity_type');
    expect(node).toHaveProperty('canonical_name');
    expect(node).toHaveProperty('normalized_name');
    expect(node).toHaveProperty('document_count');
    expect(node).toHaveProperty('mention_count');
    expect(node).toHaveProperty('edge_count');
    expect(node).toHaveProperty('avg_confidence');
    expect(node).toHaveProperty('provenance_id');
    expect(node).toHaveProperty('created_at');
    expect(node).toHaveProperty('updated_at');
  });
});

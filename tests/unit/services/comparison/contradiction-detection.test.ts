/**
 * KG Contradiction Detection Tests
 *
 * Tests detectKGContradictions() in diff-service.ts with REAL databases.
 * Sets up knowledge graph nodes, edges, and entities to verify contradiction
 * detection across documents.
 *
 * NO mocks. Uses real SQLite databases.
 *
 * @module tests/unit/services/comparison/contradiction-detection
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { detectKGContradictions } from '../../../../src/services/comparison/diff-service.js';
import { DatabaseService } from '../../../../src/services/storage/database/index.js';
import { computeHash } from '../../../../src/utils/hash.js';
import type { Entity } from '../../../../src/models/entity.js';
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

/**
 * Insert entities for a document and return Entity objects
 */
function insertEntitiesForDoc(
  conn: Database.Database,
  docId: string,
  provId: string,
  entities: Array<{ raw_text: string; normalized_text: string; entity_type: string }>
): Entity[] {
  const now = new Date().toISOString();
  const result: Entity[] = [];

  for (const ent of entities) {
    const entityId = uuidv4();
    conn
      .prepare(
        `
      INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text,
        confidence, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(entityId, docId, ent.entity_type, ent.raw_text, ent.normalized_text, 0.9, provId, now);

    result.push({
      id: entityId,
      document_id: docId,
      entity_type: ent.entity_type as Entity['entity_type'],
      raw_text: ent.raw_text,
      normalized_text: ent.normalized_text,
      confidence: 0.9,
      metadata: null,
      provenance_id: provId,
      created_at: now,
    });
  }

  return result;
}

/**
 * Create entity extraction provenance
 */
function createEntityProvenance(db: DatabaseService, docProvId: string, docId: string): string {
  const provId = uuidv4();
  const now = new Date().toISOString();
  db.insertProvenance({
    id: provId,
    type: 'ENTITY_EXTRACTION',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(`entities-${docId}`),
    input_hash: null,
    file_hash: null,
    processor: 'entity-extractor',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: 100,
    processing_quality_score: null,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 2,
    chain_path: '["DOCUMENT", "OCR_RESULT", "ENTITY_EXTRACTION"]',
  });
  return provId;
}

/**
 * Create KG node, link it to an entity, and return the node ID
 */
function createKGNode(
  conn: Database.Database,
  provId: string,
  entityId: string,
  docId: string,
  canonicalName: string,
  entityType: string
): string {
  const nodeId = uuidv4();
  const now = new Date().toISOString();

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
      entityType,
      canonicalName,
      canonicalName.toLowerCase(),
      null,
      1,
      1,
      0,
      0.9,
      null,
      provId,
      now,
      now
    );

  // Link entity to KG node
  conn
    .prepare(
      `
    INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(uuidv4(), nodeId, entityId, docId, 1.0, 'exact', now);

  return nodeId;
}

/**
 * Create a KG edge between two nodes
 */
function createKGEdge(
  conn: Database.Database,
  provId: string,
  sourceNodeId: string,
  targetNodeId: string,
  relationshipType: string,
  documentIds: string[]
): string {
  const edgeId = uuidv4();
  const now = new Date().toISOString();

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
      sourceNodeId,
      targetNodeId,
      relationshipType,
      1.0,
      1,
      JSON.stringify(documentIds),
      null,
      provId,
      now
    );

  // Update edge_count on nodes
  conn
    .prepare('UPDATE knowledge_nodes SET edge_count = edge_count + 1 WHERE id = ?')
    .run(sourceNodeId);
  conn
    .prepare('UPDATE knowledge_nodes SET edge_count = edge_count + 1 WHERE id = ?')
    .run(targetNodeId);

  return edgeId;
}

// =============================================================================
// TESTS
// =============================================================================

describe('detectKGContradictions', () => {
  let tempDir: string;
  let dbService: DatabaseService;
  let conn: Database.Database;

  beforeEach(() => {
    tempDir = createTempDir('contradiction-test-');
    tempDirs.push(tempDir);
    const dbName = `contra-test-${Date.now()}`;
    dbService = DatabaseService.create(dbName, tempDir);
    conn = dbService.getConnection();
  });

  afterEach(() => {
    dbService?.close();
  });

  it('empty entities -> empty contradictions', () => {
    const result = detectKGContradictions(conn, [], []);

    expect(result.contradictions).toEqual([]);
    expect(result.entities_checked).toBe(0);
    expect(result.kg_edges_analyzed).toBe(0);
  });

  it('entities without KG nodes -> empty contradictions', () => {
    const doc1 = insertDocumentChain(dbService, 'doc1.pdf', '/test/doc1.pdf');
    const doc2 = insertDocumentChain(dbService, 'doc2.pdf', '/test/doc2.pdf');
    const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
    const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

    const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
    ]);
    const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
    ]);

    const result = detectKGContradictions(conn, entities1, entities2);

    expect(result.contradictions).toEqual([]);
    expect(result.entities_checked).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)(
    'HIGH: same entity, same relationship type, different targets',
    () => {
      // Setup: John Smith works_at Acme Corp (from doc1) and works_at Beta Inc (from doc2)
      const doc1 = insertDocumentChain(dbService, 'contract-v1.pdf', '/test/contract-v1.pdf');
      const doc2 = insertDocumentChain(dbService, 'contract-v2.pdf', '/test/contract-v2.pdf');
      const kgProvId = uuidv4();
      const now = new Date().toISOString();
      dbService.insertProvenance({
        id: kgProvId,
        type: 'KNOWLEDGE_GRAPH',
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'KNOWLEDGE_GRAPH',
        source_path: null,
        source_id: doc1.docProvId,
        root_document_id: doc1.docProvId,
        location: null,
        content_hash: computeHash('kg-test'),
        input_hash: null,
        file_hash: null,
        processor: 'knowledge-graph-builder',
        processor_version: '1.0.0',
        processing_params: {},
        processing_duration_ms: 50,
        processing_quality_score: null,
        parent_id: doc1.docProvId,
        parent_ids: JSON.stringify([doc1.docProvId]),
        chain_depth: 2,
        chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
      });

      const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
      const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

      const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
        { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
        { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
      ]);
      const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
        { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
        { raw_text: 'Beta Inc', normalized_text: 'beta inc', entity_type: 'organization' },
      ]);

      // Create KG nodes - John Smith shared between docs
      const johnNode = createKGNode(
        conn,
        kgProvId,
        entities1[0].id,
        doc1.docId,
        'John Smith',
        'person'
      );
      // Also link doc2's John Smith to the same node
      conn
        .prepare(
          `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
        )
        .run(uuidv4(), johnNode, entities2[0].id, doc2.docId, 1.0, 'exact', now);
      conn.prepare('UPDATE knowledge_nodes SET document_count = 2 WHERE id = ?').run(johnNode);

      const acmeNode = createKGNode(
        conn,
        kgProvId,
        entities1[1].id,
        doc1.docId,
        'Acme Corp',
        'organization'
      );
      const betaNode = createKGNode(
        conn,
        kgProvId,
        entities2[1].id,
        doc2.docId,
        'Beta Inc',
        'organization'
      );

      // Create edges: John works_at Acme (from doc1), John works_at Beta (from doc2)
      createKGEdge(conn, kgProvId, johnNode, acmeNode, 'works_at', [doc1.docId]);
      createKGEdge(conn, kgProvId, johnNode, betaNode, 'works_at', [doc2.docId]);

      const result = detectKGContradictions(conn, entities1, entities2);

      expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
      const highContradictions = result.contradictions.filter((c) => c.severity === 'high');
      expect(highContradictions.length).toBeGreaterThanOrEqual(1);

      const contradiction = highContradictions[0];
      expect(contradiction.entity_name).toBe('John Smith');
      expect(contradiction.entity_type).toBe('person');
      expect(contradiction.relationship_type).toBe('works_at');
      expect(contradiction.doc1_related).toBe('Acme Corp');
      expect(contradiction.doc2_related).toBe('Beta Inc');
      expect(contradiction.severity).toBe('high');
    }
  );

  it.skipIf(!sqliteVecAvailable)('no contradiction when same entity has same target', () => {
    // Both docs say John works_at Acme - no contradiction
    const doc1 = insertDocumentChain(dbService, 'doc-a.pdf', '/test/doc-a.pdf');
    const doc2 = insertDocumentChain(dbService, 'doc-b.pdf', '/test/doc-b.pdf');
    const kgProvId = uuidv4();
    const now = new Date().toISOString();
    dbService.insertProvenance({
      id: kgProvId,
      type: 'KNOWLEDGE_GRAPH',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'KNOWLEDGE_GRAPH',
      source_path: null,
      source_id: doc1.docProvId,
      root_document_id: doc1.docProvId,
      location: null,
      content_hash: computeHash('kg-agree'),
      input_hash: null,
      file_hash: null,
      processor: 'knowledge-graph-builder',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 50,
      processing_quality_score: null,
      parent_id: doc1.docProvId,
      parent_ids: JSON.stringify([doc1.docProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
    });

    const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
    const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

    const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
    ]);
    const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
    ]);

    // Create shared KG nodes
    const johnNode = createKGNode(
      conn,
      kgProvId,
      entities1[0].id,
      doc1.docId,
      'John Smith',
      'person'
    );
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), johnNode, entities2[0].id, doc2.docId, 1.0, 'exact', now);
    conn.prepare('UPDATE knowledge_nodes SET document_count = 2 WHERE id = ?').run(johnNode);

    const acmeNode = createKGNode(
      conn,
      kgProvId,
      entities1[1].id,
      doc1.docId,
      'Acme Corp',
      'organization'
    );
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), acmeNode, entities2[1].id, doc2.docId, 1.0, 'exact', now);
    conn.prepare('UPDATE knowledge_nodes SET document_count = 2 WHERE id = ?').run(acmeNode);

    // Both docs evidence same edge: John works_at Acme
    createKGEdge(conn, kgProvId, johnNode, acmeNode, 'works_at', [doc1.docId, doc2.docId]);

    const result = detectKGContradictions(conn, entities1, entities2);

    const highContradictions = result.contradictions.filter((c) => c.severity === 'high');
    expect(highContradictions.length).toBe(0);
  });

  it.skipIf(!sqliteVecAvailable)(
    'LOW: entity in one doc has semantic relationships absent in other',
    () => {
      const doc1 = insertDocumentChain(dbService, 'full.pdf', '/test/full.pdf');
      const doc2 = insertDocumentChain(dbService, 'sparse.pdf', '/test/sparse.pdf');
      const kgProvId = uuidv4();
      const now = new Date().toISOString();
      dbService.insertProvenance({
        id: kgProvId,
        type: 'KNOWLEDGE_GRAPH',
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'KNOWLEDGE_GRAPH',
        source_path: null,
        source_id: doc1.docProvId,
        root_document_id: doc1.docProvId,
        location: null,
        content_hash: computeHash('kg-low'),
        input_hash: null,
        file_hash: null,
        processor: 'knowledge-graph-builder',
        processor_version: '1.0.0',
        processing_params: {},
        processing_duration_ms: 50,
        processing_quality_score: null,
        parent_id: doc1.docProvId,
        parent_ids: JSON.stringify([doc1.docProvId]),
        chain_depth: 2,
        chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
      });

      const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
      const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

      // Doc1 has John + Acme; Doc2 has only Bob (different entity, no overlap)
      const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
        { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
        { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
      ]);
      const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
        { raw_text: 'Bob Jones', normalized_text: 'bob jones', entity_type: 'person' },
      ]);

      const johnNode = createKGNode(
        conn,
        kgProvId,
        entities1[0].id,
        doc1.docId,
        'John Smith',
        'person'
      );
      const acmeNode = createKGNode(
        conn,
        kgProvId,
        entities1[1].id,
        doc1.docId,
        'Acme Corp',
        'organization'
      );
      createKGNode(conn, kgProvId, entities2[0].id, doc2.docId, 'Bob Jones', 'person');

      // John works_at Acme (only from doc1)
      createKGEdge(conn, kgProvId, johnNode, acmeNode, 'works_at', [doc1.docId]);

      const result = detectKGContradictions(conn, entities1, entities2);

      // Should have low severity contradiction: John has relationships in doc1 but not in doc2
      const lowContradictions = result.contradictions.filter((c) => c.severity === 'low');
      expect(lowContradictions.length).toBeGreaterThanOrEqual(1);
      expect(lowContradictions[0].entity_name).toBe('John Smith');
      expect(lowContradictions[0].kg_source).toBe('doc1');
    }
  );

  it.skipIf(!sqliteVecAvailable)(
    'co_mentioned edges are excluded from contradiction detection',
    () => {
      const doc1 = insertDocumentChain(dbService, 'co1.pdf', '/test/co1.pdf');
      const doc2 = insertDocumentChain(dbService, 'co2.pdf', '/test/co2.pdf');
      const kgProvId = uuidv4();
      const now = new Date().toISOString();
      dbService.insertProvenance({
        id: kgProvId,
        type: 'KNOWLEDGE_GRAPH',
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'KNOWLEDGE_GRAPH',
        source_path: null,
        source_id: doc1.docProvId,
        root_document_id: doc1.docProvId,
        location: null,
        content_hash: computeHash('kg-co'),
        input_hash: null,
        file_hash: null,
        processor: 'knowledge-graph-builder',
        processor_version: '1.0.0',
        processing_params: {},
        processing_duration_ms: 50,
        processing_quality_score: null,
        parent_id: doc1.docProvId,
        parent_ids: JSON.stringify([doc1.docProvId]),
        chain_depth: 2,
        chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
      });

      const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
      const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

      const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
        { raw_text: 'Alice', normalized_text: 'alice', entity_type: 'person' },
        { raw_text: 'Bob', normalized_text: 'bob', entity_type: 'person' },
      ]);
      const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
        { raw_text: 'Charlie', normalized_text: 'charlie', entity_type: 'person' },
      ]);

      const aliceNode = createKGNode(
        conn,
        kgProvId,
        entities1[0].id,
        doc1.docId,
        'Alice',
        'person'
      );
      const bobNode = createKGNode(conn, kgProvId, entities1[1].id, doc1.docId, 'Bob', 'person');
      createKGNode(conn, kgProvId, entities2[0].id, doc2.docId, 'Charlie', 'person');

      // Only co_mentioned edges (not semantic) - should produce NO contradictions
      createKGEdge(conn, kgProvId, aliceNode, bobNode, 'co_mentioned', [doc1.docId]);

      const result = detectKGContradictions(conn, entities1, entities2);

      // co_mentioned edges should be filtered out
      expect(result.contradictions.length).toBe(0);
    }
  );

  it.skipIf(!sqliteVecAvailable)('contradictions are sorted by severity (high first)', () => {
    const doc1 = insertDocumentChain(dbService, 'sort1.pdf', '/test/sort1.pdf');
    const doc2 = insertDocumentChain(dbService, 'sort2.pdf', '/test/sort2.pdf');
    const kgProvId = uuidv4();
    const now = new Date().toISOString();
    dbService.insertProvenance({
      id: kgProvId,
      type: 'KNOWLEDGE_GRAPH',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'KNOWLEDGE_GRAPH',
      source_path: null,
      source_id: doc1.docProvId,
      root_document_id: doc1.docProvId,
      location: null,
      content_hash: computeHash('kg-sort'),
      input_hash: null,
      file_hash: null,
      processor: 'knowledge-graph-builder',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 50,
      processing_quality_score: null,
      parent_id: doc1.docProvId,
      parent_ids: JSON.stringify([doc1.docProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
    });

    const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
    const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

    // Setup: John works_at Acme (doc1) and works_at Beta (doc2) -> HIGH
    // Also: Bob exists only in doc1 with represents -> LOW
    const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
      { raw_text: 'Bob Jones', normalized_text: 'bob jones', entity_type: 'person' },
      { raw_text: 'XYZ Inc', normalized_text: 'xyz inc', entity_type: 'organization' },
    ]);
    const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Beta Inc', normalized_text: 'beta inc', entity_type: 'organization' },
    ]);

    const johnNode = createKGNode(
      conn,
      kgProvId,
      entities1[0].id,
      doc1.docId,
      'John Smith',
      'person'
    );
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), johnNode, entities2[0].id, doc2.docId, 1.0, 'exact', now);
    conn.prepare('UPDATE knowledge_nodes SET document_count = 2 WHERE id = ?').run(johnNode);

    const acmeNode = createKGNode(
      conn,
      kgProvId,
      entities1[1].id,
      doc1.docId,
      'Acme Corp',
      'organization'
    );
    const betaNode = createKGNode(
      conn,
      kgProvId,
      entities2[1].id,
      doc2.docId,
      'Beta Inc',
      'organization'
    );
    const bobNode = createKGNode(
      conn,
      kgProvId,
      entities1[2].id,
      doc1.docId,
      'Bob Jones',
      'person'
    );
    const xyzNode = createKGNode(
      conn,
      kgProvId,
      entities1[3].id,
      doc1.docId,
      'XYZ Inc',
      'organization'
    );

    createKGEdge(conn, kgProvId, johnNode, acmeNode, 'works_at', [doc1.docId]);
    createKGEdge(conn, kgProvId, johnNode, betaNode, 'works_at', [doc2.docId]);
    createKGEdge(conn, kgProvId, bobNode, xyzNode, 'represents', [doc1.docId]);

    const result = detectKGContradictions(conn, entities1, entities2);

    expect(result.contradictions.length).toBeGreaterThanOrEqual(2);

    // Verify sorting: high severity first
    const severities = result.contradictions.map((c) => c.severity);
    const highIdx = severities.indexOf('high');
    const lowIdx = severities.indexOf('low');
    if (highIdx !== -1 && lowIdx !== -1) {
      expect(highIdx).toBeLessThan(lowIdx);
    }
  });

  it.skipIf(!sqliteVecAvailable)('contradictions are deduplicated', () => {
    const doc1 = insertDocumentChain(dbService, 'dedup1.pdf', '/test/dedup1.pdf');
    const doc2 = insertDocumentChain(dbService, 'dedup2.pdf', '/test/dedup2.pdf');
    const kgProvId = uuidv4();
    const now = new Date().toISOString();
    dbService.insertProvenance({
      id: kgProvId,
      type: 'KNOWLEDGE_GRAPH',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'KNOWLEDGE_GRAPH',
      source_path: null,
      source_id: doc1.docProvId,
      root_document_id: doc1.docProvId,
      location: null,
      content_hash: computeHash('kg-dedup'),
      input_hash: null,
      file_hash: null,
      processor: 'knowledge-graph-builder',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 50,
      processing_quality_score: null,
      parent_id: doc1.docProvId,
      parent_ids: JSON.stringify([doc1.docProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
    });

    const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
    const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

    // Two entities with same normalized_text in doc1 (e.g., "J. Smith" and "John Smith" both map to same KG node)
    const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
      { raw_text: 'J. Smith', normalized_text: 'j. smith', entity_type: 'person' },
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Acme Corp', normalized_text: 'acme corp', entity_type: 'organization' },
    ]);
    const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
      { raw_text: 'John Smith', normalized_text: 'john smith', entity_type: 'person' },
      { raw_text: 'Beta Inc', normalized_text: 'beta inc', entity_type: 'organization' },
    ]);

    // Both doc1 entities link to same KG node
    const johnNode = createKGNode(
      conn,
      kgProvId,
      entities1[0].id,
      doc1.docId,
      'John Smith',
      'person'
    );
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), johnNode, entities1[1].id, doc1.docId, 1.0, 'fuzzy', now);
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), johnNode, entities2[0].id, doc2.docId, 1.0, 'exact', now);
    conn.prepare('UPDATE knowledge_nodes SET document_count = 2 WHERE id = ?').run(johnNode);

    const acmeNode = createKGNode(
      conn,
      kgProvId,
      entities1[2].id,
      doc1.docId,
      'Acme Corp',
      'organization'
    );
    const betaNode = createKGNode(
      conn,
      kgProvId,
      entities2[1].id,
      doc2.docId,
      'Beta Inc',
      'organization'
    );

    createKGEdge(conn, kgProvId, johnNode, acmeNode, 'works_at', [doc1.docId]);
    createKGEdge(conn, kgProvId, johnNode, betaNode, 'works_at', [doc2.docId]);

    const result = detectKGContradictions(conn, entities1, entities2);

    // Should deduplicate: even though two entities in doc1 map to same KG node,
    // we should get only one contradiction, not two
    const highContradictions = result.contradictions.filter((c) => c.severity === 'high');
    expect(highContradictions.length).toBe(1);
  });

  it.skipIf(!sqliteVecAvailable)('entities_checked and kg_edges_analyzed are populated', () => {
    const doc1 = insertDocumentChain(dbService, 'stats1.pdf', '/test/stats1.pdf');
    const doc2 = insertDocumentChain(dbService, 'stats2.pdf', '/test/stats2.pdf');
    const kgProvId = uuidv4();
    const now = new Date().toISOString();
    dbService.insertProvenance({
      id: kgProvId,
      type: 'KNOWLEDGE_GRAPH',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'KNOWLEDGE_GRAPH',
      source_path: null,
      source_id: doc1.docProvId,
      root_document_id: doc1.docProvId,
      location: null,
      content_hash: computeHash('kg-stats'),
      input_hash: null,
      file_hash: null,
      processor: 'knowledge-graph-builder',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 50,
      processing_quality_score: null,
      parent_id: doc1.docProvId,
      parent_ids: JSON.stringify([doc1.docProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "KNOWLEDGE_GRAPH"]',
    });

    const prov1 = createEntityProvenance(dbService, doc1.docProvId, doc1.docId);
    const prov2 = createEntityProvenance(dbService, doc2.docProvId, doc2.docId);

    const entities1 = insertEntitiesForDoc(conn, doc1.docId, prov1, [
      { raw_text: 'Alice', normalized_text: 'alice', entity_type: 'person' },
      { raw_text: 'Org1', normalized_text: 'org1', entity_type: 'organization' },
    ]);
    const entities2 = insertEntitiesForDoc(conn, doc2.docId, prov2, [
      { raw_text: 'Alice', normalized_text: 'alice', entity_type: 'person' },
      { raw_text: 'Org2', normalized_text: 'org2', entity_type: 'organization' },
    ]);

    const aliceNode = createKGNode(conn, kgProvId, entities1[0].id, doc1.docId, 'Alice', 'person');
    conn
      .prepare(
        `
      INSERT INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(uuidv4(), aliceNode, entities2[0].id, doc2.docId, 1.0, 'exact', now);
    conn.prepare('UPDATE knowledge_nodes SET document_count = 2 WHERE id = ?').run(aliceNode);

    const org1Node = createKGNode(
      conn,
      kgProvId,
      entities1[1].id,
      doc1.docId,
      'Org1',
      'organization'
    );
    const org2Node = createKGNode(
      conn,
      kgProvId,
      entities2[1].id,
      doc2.docId,
      'Org2',
      'organization'
    );

    createKGEdge(conn, kgProvId, aliceNode, org1Node, 'works_at', [doc1.docId]);
    createKGEdge(conn, kgProvId, aliceNode, org2Node, 'works_at', [doc2.docId]);

    const result = detectKGContradictions(conn, entities1, entities2);

    expect(result.entities_checked).toBeGreaterThan(0);
    expect(result.kg_edges_analyzed).toBeGreaterThan(0);
  });
});

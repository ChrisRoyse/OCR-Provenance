/**
 * Entity Analysis Operations Tests
 *
 * Tests entity CRUD operations, entity mention CRUD, cascade delete,
 * entity_type CHECK constraints, and LIKE query performance.
 *
 * Uses REAL databases (better-sqlite3 temp files), NO mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isSqliteVecAvailable,
  createTestDir,
  cleanupTestDir,
  createTestDb,
  closeDb,
} from '../migrations/helpers.js';
import { migrateToLatest } from '../../../src/services/storage/migrations/operations.js';
import {
  insertEntity,
  insertEntityMention,
  getEntitiesByDocument,
  getEntityMentions,
  searchEntities,
  deleteEntitiesByDocument,
} from '../../../src/services/storage/database/entity-operations.js';
import type { Entity, EntityMention } from '../../../src/models/entity.js';

const sqliteVecAvailable = isSqliteVecAvailable();

describe('Entity Operations', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = createTestDir('ocr-entity-ops');
    const result = createTestDb(tmpDir);
    db = result.db;

    if (!sqliteVecAvailable) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Initialize fresh v13 schema
    migrateToLatest(db);

    // Insert test provenance + document
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-doc-1', 'DOCUMENT', ?, ?, 'FILE', 'prov-doc-1', 'sha256:aaa', 'test', '1.0', '{}', '[]', 0)
    `).run(now, now);
    db.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES ('doc-1', '/test/contract.pdf', 'contract.pdf', 'sha256:doc1', 2048, 'pdf', 'complete', 'prov-doc-1', ?)
    `).run(now);

    // Second document for cross-document queries
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-doc-2', 'DOCUMENT', ?, ?, 'FILE', 'prov-doc-2', 'sha256:bbb', 'test', '1.0', '{}', '[]', 0)
    `).run(now, now);
    db.prepare(`
      INSERT INTO documents (id, file_path, file_name, file_hash, file_size, file_type, status, provenance_id, created_at)
      VALUES ('doc-2', '/test/brief.pdf', 'brief.pdf', 'sha256:doc2', 3072, 'pdf', 'complete', 'prov-doc-2', ?)
    `).run(now);

    // Entity extraction provenance
    db.prepare(`
      INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
        content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
      VALUES ('prov-entity-ext-1', 'ENTITY_EXTRACTION', ?, ?, 'ENTITY_EXTRACTION', 'prov-doc-1',
        'sha256:entities', 'gemini', '1.0', '{}', '["prov-doc-1"]', 2)
    `).run(now, now);
  });

  afterEach(() => {
    closeDb(db);
    cleanupTestDir(tmpDir);
  });

  describe('insertEntity', () => {
    it.skipIf(!sqliteVecAvailable)('inserts an entity record', () => {
      const entity: Entity = {
        id: 'ent-1',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'John Smith',
        normalized_text: 'john smith',
        confidence: 0.95,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: new Date().toISOString(),
      };

      const id = insertEntity(db, entity);
      expect(id).toBe('ent-1');

      const row = db.prepare('SELECT * FROM entities WHERE id = ?').get('ent-1') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.entity_type).toBe('person');
      expect(row.raw_text).toBe('John Smith');
      expect(row.normalized_text).toBe('john smith');
      expect(row.confidence).toBe(0.95);
    });

    it.skipIf(!sqliteVecAvailable)('rejects invalid entity_type', () => {
      const entity = {
        id: 'ent-bad',
        document_id: 'doc-1',
        entity_type: 'invalid_type',
        raw_text: 'test',
        normalized_text: 'test',
        confidence: 0.5,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: new Date().toISOString(),
      } as unknown as Entity;

      expect(() => insertEntity(db, entity)).toThrow();
    });

    it.skipIf(!sqliteVecAvailable)('stores metadata as JSON', () => {
      const meta = JSON.stringify({ source_page: 5, nearby_context: 'paragraph 3' });
      const entity: Entity = {
        id: 'ent-meta',
        document_id: 'doc-1',
        entity_type: 'location',
        raw_text: 'New York',
        normalized_text: 'new york',
        confidence: 0.88,
        metadata: meta,
        provenance_id: 'prov-entity-ext-1',
        created_at: new Date().toISOString(),
      };

      insertEntity(db, entity);
      const row = db.prepare('SELECT metadata FROM entities WHERE id = ?').get('ent-meta') as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual({ source_page: 5, nearby_context: 'paragraph 3' });
    });
  });

  describe('insertEntityMention', () => {
    it.skipIf(!sqliteVecAvailable)('inserts a mention record', () => {
      // First insert entity
      insertEntity(db, {
        id: 'ent-m1',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Jane Doe',
        normalized_text: 'jane doe',
        confidence: 0.9,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: new Date().toISOString(),
      });

      const mention: EntityMention = {
        id: 'men-1',
        entity_id: 'ent-m1',
        document_id: 'doc-1',
        chunk_id: null,
        page_number: 2,
        character_start: 100,
        character_end: 108,
        context_text: 'Jane Doe signed the agreement on...',
        created_at: new Date().toISOString(),
      };

      const id = insertEntityMention(db, mention);
      expect(id).toBe('men-1');

      const row = db.prepare('SELECT * FROM entity_mentions WHERE id = ?').get('men-1') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.page_number).toBe(2);
      expect(row.character_start).toBe(100);
      expect(row.context_text).toBe('Jane Doe signed the agreement on...');
    });

    it.skipIf(!sqliteVecAvailable)('rejects mention with non-existent entity_id', () => {
      const mention: EntityMention = {
        id: 'men-bad',
        entity_id: 'non-existent-entity',
        document_id: 'doc-1',
        chunk_id: null,
        page_number: 1,
        character_start: null,
        character_end: null,
        context_text: null,
        created_at: new Date().toISOString(),
      };

      expect(() => insertEntityMention(db, mention)).toThrow();
    });
  });

  describe('getEntitiesByDocument', () => {
    it.skipIf(!sqliteVecAvailable)('returns entities for a document ordered by type and name', () => {
      const now = new Date().toISOString();

      insertEntity(db, {
        id: 'ent-a',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Bob',
        normalized_text: 'bob',
        confidence: 0.8,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });
      insertEntity(db, {
        id: 'ent-b',
        document_id: 'doc-1',
        entity_type: 'organization',
        raw_text: 'Acme',
        normalized_text: 'acme',
        confidence: 0.9,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });
      insertEntity(db, {
        id: 'ent-c',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Alice',
        normalized_text: 'alice',
        confidence: 0.85,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });

      const entities = getEntitiesByDocument(db, 'doc-1');
      expect(entities.length).toBe(3);
      // Ordered by entity_type then normalized_text
      expect(entities[0].entity_type).toBe('organization');
      expect(entities[1].normalized_text).toBe('alice');
      expect(entities[2].normalized_text).toBe('bob');
    });

    it.skipIf(!sqliteVecAvailable)('returns empty for document with no entities', () => {
      const entities = getEntitiesByDocument(db, 'doc-2');
      expect(entities).toEqual([]);
    });
  });

  describe('getEntityMentions', () => {
    it.skipIf(!sqliteVecAvailable)('returns mentions ordered by page then position', () => {
      const now = new Date().toISOString();
      insertEntity(db, {
        id: 'ent-mm',
        document_id: 'doc-1',
        entity_type: 'amount',
        raw_text: '$50,000',
        normalized_text: '50000',
        confidence: 0.95,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });

      insertEntityMention(db, {
        id: 'men-p3',
        entity_id: 'ent-mm',
        document_id: 'doc-1',
        chunk_id: null,
        page_number: 3,
        character_start: 200,
        character_end: 207,
        context_text: 'total of $50,000',
        created_at: now,
      });
      insertEntityMention(db, {
        id: 'men-p1',
        entity_id: 'ent-mm',
        document_id: 'doc-1',
        chunk_id: null,
        page_number: 1,
        character_start: 50,
        character_end: 57,
        context_text: 'amount of $50,000',
        created_at: now,
      });

      const mentions = getEntityMentions(db, 'ent-mm');
      expect(mentions.length).toBe(2);
      expect(mentions[0].page_number).toBe(1);
      expect(mentions[1].page_number).toBe(3);
    });
  });

  describe('searchEntities', () => {
    it.skipIf(!sqliteVecAvailable)('searches by normalized text with LIKE', () => {
      const now = new Date().toISOString();
      insertEntity(db, {
        id: 'ent-s1',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'John Smith',
        normalized_text: 'john smith',
        confidence: 0.9,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });
      insertEntity(db, {
        id: 'ent-s2',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Sarah Johnson',
        normalized_text: 'sarah johnson',
        confidence: 0.85,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });

      const results = searchEntities(db, 'smith');
      expect(results.length).toBe(1);
      expect(results[0].raw_text).toBe('John Smith');
    });

    it.skipIf(!sqliteVecAvailable)('filters by entity type', () => {
      const now = new Date().toISOString();
      insertEntity(db, {
        id: 'ent-ft1',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Test Person',
        normalized_text: 'test person',
        confidence: 0.9,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });
      insertEntity(db, {
        id: 'ent-ft2',
        document_id: 'doc-1',
        entity_type: 'organization',
        raw_text: 'Test Corp',
        normalized_text: 'test corp',
        confidence: 0.85,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });

      const results = searchEntities(db, 'test', { entityType: 'organization' });
      expect(results.length).toBe(1);
      expect(results[0].entity_type).toBe('organization');
    });

    it.skipIf(!sqliteVecAvailable)('filters by document IDs', () => {
      const now = new Date().toISOString();

      // Entity extraction provenance for doc-2
      db.prepare(`
        INSERT INTO provenance (id, type, created_at, processed_at, source_type, root_document_id,
          content_hash, processor, processor_version, processing_params, parent_ids, chain_depth)
        VALUES ('prov-entity-ext-2', 'ENTITY_EXTRACTION', ?, ?, 'ENTITY_EXTRACTION', 'prov-doc-2',
          'sha256:ent2', 'gemini', '1.0', '{}', '["prov-doc-2"]', 2)
      `).run(now, now);

      insertEntity(db, {
        id: 'ent-df1',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Alpha Person',
        normalized_text: 'alpha person',
        confidence: 0.9,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });
      insertEntity(db, {
        id: 'ent-df2',
        document_id: 'doc-2',
        entity_type: 'person',
        raw_text: 'Beta Person',
        normalized_text: 'beta person',
        confidence: 0.85,
        metadata: null,
        provenance_id: 'prov-entity-ext-2',
        created_at: now,
      });

      const results = searchEntities(db, 'person', { documentFilter: ['doc-2'] });
      expect(results.length).toBe(1);
      expect(results[0].document_id).toBe('doc-2');
    });

    it.skipIf(!sqliteVecAvailable)('respects limit', () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        insertEntity(db, {
          id: `ent-lim-${i}`,
          document_id: 'doc-1',
          entity_type: 'other',
          raw_text: `Item ${i}`,
          normalized_text: `item ${i}`,
          confidence: 0.5 + i * 0.05,
          metadata: null,
          provenance_id: 'prov-entity-ext-1',
          created_at: now,
        });
      }

      const results = searchEntities(db, 'item', { limit: 3 });
      expect(results.length).toBe(3);
    });
  });

  describe('deleteEntitiesByDocument', () => {
    it.skipIf(!sqliteVecAvailable)('deletes entities and cascades to mentions', () => {
      const now = new Date().toISOString();
      insertEntity(db, {
        id: 'ent-del-1',
        document_id: 'doc-1',
        entity_type: 'person',
        raw_text: 'Delete Me',
        normalized_text: 'delete me',
        confidence: 0.9,
        metadata: null,
        provenance_id: 'prov-entity-ext-1',
        created_at: now,
      });
      insertEntityMention(db, {
        id: 'men-del-1',
        entity_id: 'ent-del-1',
        document_id: 'doc-1',
        chunk_id: null,
        page_number: 1,
        character_start: 0,
        character_end: 9,
        context_text: 'Delete Me appeared in...',
        created_at: now,
      });
      insertEntityMention(db, {
        id: 'men-del-2',
        entity_id: 'ent-del-1',
        document_id: 'doc-1',
        chunk_id: null,
        page_number: 5,
        character_start: 100,
        character_end: 109,
        context_text: 'Delete Me again',
        created_at: now,
      });

      const deleted = deleteEntitiesByDocument(db, 'doc-1');
      expect(deleted).toBe(1);

      // Verify entities are gone
      const entities = getEntitiesByDocument(db, 'doc-1');
      expect(entities.length).toBe(0);

      // Verify mentions are gone
      const mentions = db.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE document_id = ?').get('doc-1') as { cnt: number };
      expect(mentions.cnt).toBe(0);
    });

    it.skipIf(!sqliteVecAvailable)('returns 0 when no entities exist', () => {
      const deleted = deleteEntitiesByDocument(db, 'doc-2');
      expect(deleted).toBe(0);
    });
  });

  describe('all entity types', () => {
    it.skipIf(!sqliteVecAvailable)('accepts all valid entity types', () => {
      const now = new Date().toISOString();
      // TS-06: Include v18 entity types (medication, diagnosis, medical_device)
      const types = ['person', 'organization', 'date', 'amount', 'case_number', 'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other'];

      for (let i = 0; i < types.length; i++) {
        expect(() => {
          insertEntity(db, {
            id: `ent-type-${i}`,
            document_id: 'doc-1',
            entity_type: types[i] as Entity['entity_type'],
            raw_text: `Test ${types[i]}`,
            normalized_text: `test ${types[i]}`,
            confidence: 0.8,
            metadata: null,
            provenance_id: 'prov-entity-ext-1',
            created_at: now,
          });
        }).not.toThrow();
      }

      const entities = getEntitiesByDocument(db, 'doc-1');
      expect(entities.length).toBe(types.length);
    });
  });
});

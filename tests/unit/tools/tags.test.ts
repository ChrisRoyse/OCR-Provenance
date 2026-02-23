/**
 * Tests for Cross-Entity Tagging Tools (Phase 9)
 *
 * Tests all 6 tag tools with real database instances.
 * NO MOCK DATA - uses real DatabaseService with temp databases.
 *
 * @module tests/unit/tools/tags
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
} from '../../integration/server/helpers.js';
import {
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
} from '../../../src/server/state.js';
import { tagTools } from '../../../src/tools/tags.js';
import { ProvenanceType } from '../../../src/models/provenance.js';
import { computeHash } from '../../../src/utils/hash.js';
import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseResponse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Create a complete document with OCR result, chunk, and image for testing entity types
 */
function createTestEntities(db: ReturnType<typeof requireDatabase>['db']) {
  // Document
  const docProv = createTestProvenance();
  const docProvId = db.insertProvenance(docProv);
  const doc = createTestDocument(docProvId);
  const docId = db.insertDocument(doc);

  // OCR result
  const ocrProv = createTestProvenance({
    type: ProvenanceType.OCR_RESULT,
    chain_depth: 1,
    parent_id: docProvId,
    root_document_id: docProv.root_document_id,
  });
  const ocrProvId = db.insertProvenance(ocrProv);
  const ocr = createTestOCRResult(docId, ocrProvId);
  const ocrId = db.insertOCRResult(ocr);

  // Chunk
  const chunkProv = createTestProvenance({
    type: ProvenanceType.CHUNK,
    chain_depth: 2,
    parent_id: ocrProvId,
    root_document_id: docProv.root_document_id,
  });
  const chunkProvId = db.insertProvenance(chunkProv);
  const chunk = createTestChunk(docId, ocrId, chunkProvId);
  const chunkId = db.insertChunk(chunk);

  // Image
  const imgProv = createTestProvenance({
    type: ProvenanceType.IMAGE,
    chain_depth: 2,
    parent_id: ocrProvId,
    root_document_id: docProv.root_document_id,
  });
  const imgProvId = db.insertProvenance(imgProv);
  const imageId = uuidv4();
  const conn = db.getConnection();
  conn
    .prepare(
      `INSERT INTO images (id, document_id, ocr_result_id, page_number, bbox_x, bbox_y, bbox_width, bbox_height,
       image_index, format, width, height, vlm_status, provenance_id, created_at)
       VALUES (?, ?, ?, 1, 0, 0, 100, 100, 0, 'png', 200, 200, 'pending', ?, ?)`
    )
    .run(imageId, docId, ocrId, imgProvId, new Date().toISOString());

  // Extraction
  const extProv = createTestProvenance({
    type: ProvenanceType.EXTRACTION,
    chain_depth: 2,
    parent_id: ocrProvId,
    root_document_id: docProv.root_document_id,
  });
  const extProvId = db.insertProvenance(extProv);
  const extractionId = uuidv4();
  conn
    .prepare(
      `INSERT INTO extractions (id, document_id, ocr_result_id, schema_json, extraction_json,
       content_hash, provenance_id, created_at)
       VALUES (?, ?, ?, '{}', '{"key": "value"}', ?, ?, ?)`
    )
    .run(extractionId, docId, ocrId, computeHash('extraction-' + extractionId), extProvId, new Date().toISOString());

  // Cluster
  const clusterProv = createTestProvenance({
    type: ProvenanceType.CLUSTERING,
    chain_depth: 2,
    parent_id: docProvId,
    root_document_id: docProv.root_document_id,
  });
  const clusterProvId = db.insertProvenance(clusterProv);
  const clusterId = uuidv4();
  const runId = uuidv4();
  conn
    .prepare(
      `INSERT INTO clusters (id, run_id, cluster_index, algorithm, algorithm_params_json,
       document_count, top_terms_json, content_hash, provenance_id, created_at)
       VALUES (?, ?, 0, 'hdbscan', '{}', 1, '[]', ?, ?, ?)`
    )
    .run(clusterId, runId, computeHash('cluster-' + clusterId), clusterProvId, new Date().toISOString());

  return { docId, chunkId, imageId, extractionId, clusterId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 9: Cross-Entity Tagging Tools', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-tags');

  beforeAll(() => {
    tempDir = createTempDir('test-tags-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
  });

  afterAll(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_create
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_create', () => {
    it('should create a tag with all fields', async () => {
      const result = await tagTools.ocr_tag_create.handler({
        name: 'important',
        description: 'Marks important documents',
        color: '#ff0000',
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.tag.name).toBe('important');
      expect(parsed.data.tag.description).toBe('Marks important documents');
      expect(parsed.data.tag.color).toBe('#ff0000');
      expect(parsed.data.tag.id).toBeDefined();
      expect(parsed.data.tag.created_at).toBeDefined();

      // Verify in database
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const row = conn.prepare('SELECT * FROM tags WHERE name = ?').get('important') as Record<
        string,
        unknown
      >;
      expect(row).toBeDefined();
      expect(row.name).toBe('important');
      expect(row.description).toBe('Marks important documents');
    });

    it('should create a tag with only required name', async () => {
      const result = await tagTools.ocr_tag_create.handler({
        name: 'review-needed',
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.tag.name).toBe('review-needed');
      expect(parsed.data.tag.description).toBeNull();
      expect(parsed.data.tag.color).toBeNull();
    });

    it('should error on duplicate tag name', async () => {
      const result = await tagTools.ocr_tag_create.handler({
        name: 'important',
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('already exists');
    });

    it('should error with database not selected', async () => {
      resetState();
      const result = await tagTools.ocr_tag_create.handler({ name: 'test' });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_list
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_list', () => {
    it('should list all tags with usage counts', async () => {
      const result = await tagTools.ocr_tag_list.handler({});
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.tags.length).toBeGreaterThanOrEqual(2);
      expect(parsed.data.total).toBeGreaterThanOrEqual(2);

      // Both tags created earlier should be present
      const names = parsed.data.tags.map((t: { name: string }) => t.name);
      expect(names).toContain('important');
      expect(names).toContain('review-needed');

      // usage_count should be 0 since no tags are applied yet
      for (const tag of parsed.data.tags) {
        expect(tag.usage_count).toBeDefined();
      }
    });

    it('should error with database not selected', async () => {
      resetState();
      const result = await tagTools.ocr_tag_list.handler({});
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_apply
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_apply', () => {
    let entities: ReturnType<typeof createTestEntities>;

    beforeAll(() => {
      const { db } = requireDatabase();
      entities = createTestEntities(db);
    });

    it('should apply tag to a document', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.tag_name).toBe('important');
      expect(parsed.data.entity_id).toBe(entities.docId);
      expect(parsed.data.entity_type).toBe('document');
      expect(parsed.data.entity_tag_id).toBeDefined();
      expect(parsed.data.tag_id).toBeDefined();

      // Verify in database
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const row = conn
        .prepare('SELECT * FROM entity_tags WHERE entity_id = ? AND entity_type = ?')
        .get(entities.docId, 'document') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.entity_type).toBe('document');
    });

    it('should apply tag to a chunk', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.chunkId,
        entity_type: 'chunk',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.entity_type).toBe('chunk');
    });

    it('should apply tag to an image', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.imageId,
        entity_type: 'image',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.entity_type).toBe('image');
    });

    it('should apply tag to an extraction', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.extractionId,
        entity_type: 'extraction',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.entity_type).toBe('extraction');
    });

    it('should apply tag to a cluster', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.clusterId,
        entity_type: 'cluster',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.entity_type).toBe('cluster');
    });

    it('should apply a different tag to the same entity', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'review-needed',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.tag_name).toBe('review-needed');
    });

    it('should error for non-existent tag', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'nonexistent-tag',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('Tag not found');
    });

    it('should error for non-existent entity', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: 'nonexistent-id',
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('not found');
    });

    it('should error for duplicate tag application', async () => {
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('already applied');
    });

    it('should error with database not selected', async () => {
      resetState();
      const result = await tagTools.ocr_tag_apply.handler({
        tag_name: 'important',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_list (with usage counts after applying)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_list (after applying tags)', () => {
    it('should show correct usage counts', async () => {
      const result = await tagTools.ocr_tag_list.handler({});
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);

      const importantTag = parsed.data.tags.find(
        (t: { name: string }) => t.name === 'important'
      );
      expect(importantTag).toBeDefined();
      // 'important' was applied to document, chunk, image, extraction, cluster = 5
      expect(importantTag.usage_count).toBe(5);

      const reviewTag = parsed.data.tags.find(
        (t: { name: string }) => t.name === 'review-needed'
      );
      expect(reviewTag).toBeDefined();
      // 'review-needed' was applied to document = 1
      expect(reviewTag.usage_count).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_remove
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_remove', () => {
    let entities: ReturnType<typeof createTestEntities>;

    beforeAll(() => {
      const { db } = requireDatabase();
      entities = createTestEntities(db);

      // Apply a tag to remove later
      db.applyTag(
        db.getTagByName('important')!.id,
        entities.docId,
        'document'
      );
    });

    it('should remove a tag from an entity', async () => {
      const result = await tagTools.ocr_tag_remove.handler({
        tag_name: 'important',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.removed).toBe(true);
      expect(parsed.data.tag_name).toBe('important');
      expect(parsed.data.entity_id).toBe(entities.docId);

      // Verify in database - row should be gone
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const row = conn
        .prepare(
          'SELECT * FROM entity_tags WHERE entity_id = ? AND entity_type = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)'
        )
        .get(entities.docId, 'document', 'important');
      expect(row).toBeUndefined();
    });

    it('should error when tag is not applied', async () => {
      const result = await tagTools.ocr_tag_remove.handler({
        tag_name: 'important',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('not applied');
    });

    it('should error for non-existent tag name', async () => {
      const result = await tagTools.ocr_tag_remove.handler({
        tag_name: 'nonexistent',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('Tag not found');
    });

    it('should error with database not selected', async () => {
      resetState();
      const result = await tagTools.ocr_tag_remove.handler({
        tag_name: 'important',
        entity_id: entities.docId,
        entity_type: 'document',
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_search
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_search', () => {
    let searchEntities: ReturnType<typeof createTestEntities>;

    beforeAll(() => {
      const { db } = requireDatabase();
      searchEntities = createTestEntities(db);

      // Create tags for search testing
      let tagA = db.getTagByName('search-tag-a');
      if (!tagA) {
        tagA = db.createTag({ name: 'search-tag-a' });
      }
      let tagB = db.getTagByName('search-tag-b');
      if (!tagB) {
        tagB = db.createTag({ name: 'search-tag-b' });
      }
      let tagC = db.getTagByName('search-tag-c');
      if (!tagC) {
        tagC = db.createTag({ name: 'search-tag-c' });
      }

      // docId: tag-a, tag-b
      db.applyTag(tagA.id, searchEntities.docId, 'document');
      db.applyTag(tagB.id, searchEntities.docId, 'document');

      // chunkId: tag-a only
      db.applyTag(tagA.id, searchEntities.chunkId, 'chunk');

      // imageId: tag-b only
      db.applyTag(tagB.id, searchEntities.imageId, 'image');

      // extractionId: tag-a, tag-b, tag-c
      db.applyTag(tagA.id, searchEntities.extractionId, 'extraction');
      db.applyTag(tagB.id, searchEntities.extractionId, 'extraction');
      db.applyTag(tagC.id, searchEntities.extractionId, 'extraction');
    });

    it('should find entities with a single tag (ANY match)', async () => {
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['search-tag-a'],
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.results.length).toBeGreaterThanOrEqual(3);

      // Should include doc, chunk, extraction (all have tag-a)
      const entityIds = parsed.data.results.map(
        (r: { entity_id: string }) => r.entity_id
      );
      expect(entityIds).toContain(searchEntities.docId);
      expect(entityIds).toContain(searchEntities.chunkId);
      expect(entityIds).toContain(searchEntities.extractionId);
    });

    it('should find entities with multiple tags (ANY match)', async () => {
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['search-tag-a', 'search-tag-b'],
        match_all: false,
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      // doc (a,b), chunk (a), image (b), extraction (a,b,c)
      expect(parsed.data.results.length).toBeGreaterThanOrEqual(4);
    });

    it('should find entities with ALL tags (match_all=true)', async () => {
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['search-tag-a', 'search-tag-b'],
        match_all: true,
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      // Only doc and extraction have both tag-a AND tag-b
      const entityIds = parsed.data.results.map(
        (r: { entity_id: string }) => r.entity_id
      );
      expect(entityIds).toContain(searchEntities.docId);
      expect(entityIds).toContain(searchEntities.extractionId);
      // chunk only has tag-a, image only has tag-b
      expect(entityIds).not.toContain(searchEntities.chunkId);
      expect(entityIds).not.toContain(searchEntities.imageId);
    });

    it('should filter by entity_type', async () => {
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['search-tag-a'],
        entity_type: 'document',
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      for (const r of parsed.data.results) {
        expect(r.entity_type).toBe('document');
      }
    });

    it('should return empty results for non-matching tags', async () => {
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['nonexistent-tag-xyz'],
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.results).toEqual([]);
      expect(parsed.data.total).toBe(0);
    });

    it('should return query info in response', async () => {
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['search-tag-a'],
        entity_type: 'chunk',
        match_all: true,
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.query.tags).toEqual(['search-tag-a']);
      expect(parsed.data.query.entity_type).toBe('chunk');
      expect(parsed.data.query.match_all).toBe(true);
    });

    it('should error with database not selected', async () => {
      resetState();
      const result = await tagTools.ocr_tag_search.handler({
        tags: ['search-tag-a'],
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ocr_tag_delete
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ocr_tag_delete', () => {
    it('should delete a tag and cascade to entity_tags', async () => {
      // Create a fresh tag and apply it
      const { db } = requireDatabase();
      const entities = createTestEntities(db);
      const tag = db.createTag({ name: 'to-delete-' + Date.now() });
      db.applyTag(tag.id, entities.docId, 'document');
      db.applyTag(tag.id, entities.chunkId, 'chunk');

      // Verify 2 associations exist
      const conn = db.getConnection();
      const beforeCount = (
        conn
          .prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE tag_id = ?')
          .get(tag.id) as { cnt: number }
      ).cnt;
      expect(beforeCount).toBe(2);

      const result = await tagTools.ocr_tag_delete.handler({
        tag_name: tag.name,
        confirm: true,
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.deleted).toBe(true);
      expect(parsed.data.tag_name).toBe(tag.name);
      expect(parsed.data.associations_removed).toBe(2);

      // Verify tag is gone
      const tagRow = conn.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);
      expect(tagRow).toBeUndefined();

      // Verify entity_tags are gone (CASCADE)
      const afterCount = (
        conn
          .prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE tag_id = ?')
          .get(tag.id) as { cnt: number }
      ).cnt;
      expect(afterCount).toBe(0);
    });

    it('should error for non-existent tag', async () => {
      const result = await tagTools.ocr_tag_delete.handler({
        tag_name: 'nonexistent-tag-xyz',
        confirm: true,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain('Tag not found');
    });

    it('should delete a tag with no associations', async () => {
      const { db } = requireDatabase();
      const tag = db.createTag({ name: 'lonely-tag-' + Date.now() });

      const result = await tagTools.ocr_tag_delete.handler({
        tag_name: tag.name,
        confirm: true,
      });
      const parsed = parseResponse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.data.associations_removed).toBe(0);
    });

    it('should error with database not selected', async () => {
      resetState();
      const result = await tagTools.ocr_tag_delete.handler({
        tag_name: 'important',
        confirm: true,
      });
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.category).toBe('DATABASE_NOT_SELECTED');
      selectDatabase(dbName, tempDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Schema v29 migration verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Schema v29 verification', () => {
    it('should have tags and entity_tags tables', () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();

      const tables = conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tags', 'entity_tags')"
        )
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('tags');
      expect(tableNames).toContain('entity_tags');
    });

    it('should have correct indexes on entity_tags', () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();

      const indexes = conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entity_tags'"
        )
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_entity_tags_entity');
      expect(indexNames).toContain('idx_entity_tags_tag');
    });

    it('should have schema version 31', () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const row = conn.prepare('SELECT version FROM schema_version WHERE id = 1').get() as {
        version: number;
      };
      expect(row.version).toBe(31);
    });

    it('should enforce entity_type CHECK constraint', () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();

      expect(() => {
        conn
          .prepare(
            `INSERT INTO entity_tags (id, tag_id, entity_id, entity_type, created_at)
             VALUES ('test-id', 'fake-tag', 'fake-entity', 'invalid_type', datetime('now'))`
          )
          .run();
      }).toThrow();
    });

    it('should enforce tags.name UNIQUE constraint', () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();

      const uniqueName = 'unique-test-' + Date.now();
      conn
        .prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, datetime(\'now\'))')
        .run(uuidv4(), uniqueName);

      expect(() => {
        conn
          .prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, datetime(\'now\'))')
          .run(uuidv4(), uniqueName);
      }).toThrow();
    });

    it('should enforce entity_tags UNIQUE(tag_id, entity_id, entity_type)', () => {
      const { db } = requireDatabase();
      const conn = db.getConnection();
      const tagId = uuidv4();
      const entityId = uuidv4();

      // Insert tag first (FK constraint)
      conn
        .prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, datetime(\'now\'))')
        .run(tagId, 'unique-et-test-' + Date.now());

      conn
        .prepare(
          `INSERT INTO entity_tags (id, tag_id, entity_id, entity_type, created_at)
           VALUES (?, ?, ?, 'document', datetime('now'))`
        )
        .run(uuidv4(), tagId, entityId);

      expect(() => {
        conn
          .prepare(
            `INSERT INTO entity_tags (id, tag_id, entity_id, entity_type, created_at)
             VALUES (?, ?, ?, 'document', datetime('now'))`
          )
          .run(uuidv4(), tagId, entityId);
      }).toThrow();
    });
  });
});

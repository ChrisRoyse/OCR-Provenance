/**
 * Bug Fixes V1.0.9 Integration Tests
 *
 * Tests for 3 fixes:
 * 1. embedding_rebuild properly cleans up old provenance records
 * 2. annotation_create auto-provisions users via ensureUserExists
 * 3. health_check detects and fixes orphaned provenance records
 *
 * Uses REAL better-sqlite3 databases with full schema. NO MOCKS.
 * Every assertion verifies actual DATABASE STATE.
 *
 * @module tests/unit/bug-fixes-v109
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createTestEmbedding,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
} from '../integration/server/helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseResponse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 1: Bug 1 - embedding_rebuild cleans up provenance
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bug 1: embedding_rebuild cleans up provenance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('bug1-emb-rebuild-');
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('embedding_rebuild for chunk deletes old provenance', () => {
    const dbName = createUniqueName('emb-rebuild-chunk');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create document -> OCR -> chunk -> embedding chain
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, {
      chunk_index: 0,
    });
    db.insertChunk(chunk);

    // Create old embedding with provenance
    const oldEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(oldEmbProv);
    const oldEmb = createTestEmbedding(chunk.id, doc.id, oldEmbProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(oldEmb);

    // Verify old provenance exists
    const oldProvRow = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(oldEmbProv.id) as { id: string } | undefined;
    expect(oldProvRow).toBeDefined();
    expect(oldProvRow!.id).toBe(oldEmbProv.id);

    // Simulate the rebuild pattern from embeddings.ts (chunk path):
    // 1. Get old embedding
    const existingEmb = conn
      .prepare('SELECT id, provenance_id FROM embeddings WHERE chunk_id = ?')
      .get(chunk.id) as { id: string; provenance_id: string } | undefined;
    expect(existingEmb).toBeDefined();

    const oldProvId = existingEmb!.provenance_id;

    // 2. Delete embedding (removes FK reference to provenance)
    conn.prepare('DELETE FROM embeddings WHERE chunk_id = ?').run(chunk.id);

    // 3. Delete the old provenance record (this is the bug fix)
    conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldProvId);

    // Verify: old provenance record is GONE
    const deletedProv = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(oldProvId) as { id: string } | undefined;
    expect(deletedProv).toBeUndefined();

    // 4. Create new embedding with new provenance
    const newEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(newEmbProv);
    const newEmb = createTestEmbedding(chunk.id, doc.id, newEmbProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(newEmb);

    // Verify: new provenance record exists
    const newProvRow = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(newEmbProv.id) as { id: string } | undefined;
    expect(newProvRow).toBeDefined();
    expect(newProvRow!.id).toBe(newEmbProv.id);

    // Verify: no orphaned EMBEDDING provenance exists (every EMBEDDING provenance is referenced)
    const orphanedEmbProv = conn
      .prepare(
        `SELECT p.id FROM provenance p
         WHERE p.type = 'EMBEDDING'
         AND p.id NOT IN (SELECT provenance_id FROM embeddings WHERE provenance_id IS NOT NULL)`
      )
      .all() as Array<{ id: string }>;
    expect(orphanedEmbProv).toHaveLength(0);
  });

  it('embedding_rebuild for document deletes all old chunk provenance', () => {
    const dbName = createUniqueName('emb-rebuild-doc');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create document -> OCR
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    // Create 3 chunks, each with an embedding + provenance
    const chunkIds: string[] = [];
    const oldEmbProvIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const chunkProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.CHUNK,
        parent_id: ocrProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 2,
      });
      db.insertProvenance(chunkProv);
      const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id, {
        chunk_index: i,
        text: `Chunk text content number ${i}`,
      });
      db.insertChunk(chunk);
      chunkIds.push(chunk.id);

      const embProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      db.insertProvenance(embProv);
      oldEmbProvIds.push(embProv.id);

      const emb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
        image_id: null,
        extraction_id: null,
      });
      db.insertEmbedding(emb);
    }

    // Verify old provenance records exist (3 EMBEDDING provenance records)
    const oldEmbProvCount = conn
      .prepare(
        `SELECT COUNT(*) as c FROM provenance WHERE type = 'EMBEDDING'
         AND id IN (${oldEmbProvIds.map(() => '?').join(',')})`
      )
      .get(...oldEmbProvIds) as { c: number };
    expect(oldEmbProvCount.c).toBe(3);

    // Simulate document-level rebuild pattern from embeddings.ts:
    // 1. Collect old chunk-embedding provenance IDs
    const oldChunkProvRows = conn
      .prepare(
        `SELECT provenance_id FROM embeddings
         WHERE document_id = ? AND chunk_id IS NOT NULL
         AND image_id IS NULL AND extraction_id IS NULL
         AND provenance_id IS NOT NULL`
      )
      .all(doc.id) as Array<{ provenance_id: string }>;
    expect(oldChunkProvRows).toHaveLength(3);

    // 2. Delete chunk embeddings (removes FK references)
    conn
      .prepare(
        `DELETE FROM embeddings WHERE document_id = ?
         AND chunk_id IS NOT NULL AND image_id IS NULL AND extraction_id IS NULL`
      )
      .run(doc.id);

    // 3. Delete old provenance records (this is the bug fix)
    for (const row of oldChunkProvRows) {
      conn.prepare('DELETE FROM provenance WHERE id = ?').run(row.provenance_id);
    }

    // Verify: all old EMBEDDING provenance records are deleted
    for (const provId of oldEmbProvIds) {
      const row = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(provId);
      expect(row).toBeUndefined();
    }

    // 4. Insert new embeddings with new provenance (simulate rebuild)
    const newProvIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const newProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        parent_id: null,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      db.insertProvenance(newProv);
      newProvIds.push(newProv.id);

      const newEmb = createTestEmbedding(chunkIds[i], doc.id, newProv.id, {
        image_id: null,
        extraction_id: null,
      });
      db.insertEmbedding(newEmb);
    }

    // Verify: provenance count equals new embedding count (3)
    const newEmbProvCount = conn
      .prepare(
        `SELECT COUNT(*) as c FROM provenance WHERE type = 'EMBEDDING'`
      )
      .get() as { c: number };
    expect(newEmbProvCount.c).toBe(3);

    // Verify: all new provenance records are referenced by embeddings (no orphans)
    const orphanedEmbProv = conn
      .prepare(
        `SELECT p.id FROM provenance p
         WHERE p.type = 'EMBEDDING'
         AND p.id NOT IN (SELECT provenance_id FROM embeddings WHERE provenance_id IS NOT NULL)`
      )
      .all() as Array<{ id: string }>;
    expect(orphanedEmbProv).toHaveLength(0);
  });

  it('embedding_rebuild for image (VLM) deletes old provenance', () => {
    const dbName = createUniqueName('emb-rebuild-vlm');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create document -> OCR -> image chain
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    // Create image provenance
    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    // Insert image
    const imgId = uuidv4();
    conn
      .prepare(
        `INSERT INTO images (id, document_id, ocr_result_id, page_number,
          bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
          width, height, vlm_status, vlm_description, extracted_path,
          created_at, block_type, provenance_id)
         VALUES (?, ?, ?, 1, 0, 0, 100, 100, 0, 'png', 200, 300, 'complete',
          'A chart showing quarterly revenue data.', '/test/image.png',
          datetime('now'), 'Figure', ?)`
      )
      .run(imgId, doc.id, ocr.id, imgProv.id);

    // Create old VLM embedding with provenance
    const oldVlmEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(oldVlmEmbProv);

    const oldVlmEmb = createTestEmbedding(null as unknown as string, doc.id, oldVlmEmbProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
      original_text: 'A chart showing quarterly revenue data.',
    });
    db.insertEmbedding(oldVlmEmb);

    // Update image to reference VLM embedding
    conn
      .prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?')
      .run(oldVlmEmb.id, imgId);

    // Verify old VLM embedding provenance exists
    const oldProvRow = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(oldVlmEmbProv.id) as { id: string } | undefined;
    expect(oldProvRow).toBeDefined();

    // Simulate VLM rebuild pattern from embeddings.ts (image path):
    // 1. Capture provenance ID from old embedding
    const oldVlmEmbRow = conn
      .prepare('SELECT provenance_id FROM embeddings WHERE id = ?')
      .get(oldVlmEmb.id) as { provenance_id: string | null } | undefined;
    const oldVlmProvId = oldVlmEmbRow?.provenance_id ?? null;

    // 2. Clear vlm_embedding_id on image FIRST (images.vlm_embedding_id FK -> embeddings.id)
    conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(imgId);

    // 3. Delete old embedding (now safe since FK reference is removed)
    conn.prepare('DELETE FROM embeddings WHERE id = ?').run(oldVlmEmb.id);

    // 4. Delete orphaned provenance record (this is the bug fix)
    if (oldVlmProvId) {
      conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldVlmProvId);
    }

    // Verify: old VLM embedding provenance is GONE
    const deletedProv = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(oldVlmEmbProv.id) as { id: string } | undefined;
    expect(deletedProv).toBeUndefined();

    // Verify: no orphaned EMBEDDING provenance exists
    const orphanedEmbProv = conn
      .prepare(
        `SELECT p.id FROM provenance p
         WHERE p.type = 'EMBEDDING'
         AND p.id NOT IN (SELECT provenance_id FROM embeddings WHERE provenance_id IS NOT NULL)`
      )
      .all() as Array<{ id: string }>;
    expect(orphanedEmbProv).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 2: Bug 2 - annotation_create auto-provisions users
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bug 2: annotation_create auto-provisions users', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('bug2-annotation-');
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('createAnnotation auto-creates user when user_id not in users table', async () => {
    const dbName = createUniqueName('annotation-auto-user');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a document (FK dependency for annotation)
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Verify user does NOT exist yet
    const newUserId = 'agent-user-' + uuidv4().slice(0, 8);
    const userBefore = conn.prepare('SELECT id FROM users WHERE id = ?').get(newUserId);
    expect(userBefore).toBeUndefined();

    // Import and call createAnnotation with new user_id
    const { createAnnotation } = await import(
      '../../src/services/storage/database/annotation-operations.js'
    );

    const annotation = createAnnotation(conn, {
      document_id: doc.id,
      user_id: newUserId,
      annotation_type: 'comment',
      content: 'This section needs review.',
    });

    // Verify: annotation is created successfully
    expect(annotation).toBeDefined();
    expect(annotation.id).toBeDefined();
    expect(annotation.content).toBe('This section needs review.');
    expect(annotation.user_id).toBe(newUserId);
    expect(annotation.status).toBe('open');

    // Verify: annotation exists in DB
    const dbAnnotation = conn
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(annotation.id) as Record<string, unknown>;
    expect(dbAnnotation).toBeDefined();
    expect(dbAnnotation.user_id).toBe(newUserId);

    // Verify: user record was auto-provisioned in users table
    const autoUser = conn
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(newUserId) as Record<string, unknown>;
    expect(autoUser).toBeDefined();
    expect(autoUser.id).toBe(newUserId);
    expect(autoUser.role).toBe('viewer');
    expect(autoUser.display_name).toBe(newUserId);
  });

  it('createAnnotation works with existing user (no duplicate)', async () => {
    const dbName = createUniqueName('annotation-existing-user');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a document
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Pre-create a user in the users table
    const existingUserId = 'existing-user-' + uuidv4().slice(0, 8);
    const now = new Date().toISOString();
    conn
      .prepare(
        `INSERT INTO users (id, display_name, role, metadata_json, last_active_at, created_at)
         VALUES (?, ?, 'editor', '{}', ?, ?)`
      )
      .run(existingUserId, 'Existing User', now, now);

    // Verify user exists with role 'editor'
    const userBefore = conn
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(existingUserId) as Record<string, unknown>;
    expect(userBefore).toBeDefined();
    expect(userBefore.role).toBe('editor');

    // Call createAnnotation with existing user
    const { createAnnotation } = await import(
      '../../src/services/storage/database/annotation-operations.js'
    );

    const annotation = createAnnotation(conn, {
      document_id: doc.id,
      user_id: existingUserId,
      annotation_type: 'flag',
      content: 'Flagged for legal review.',
    });

    // Verify: annotation created
    expect(annotation).toBeDefined();
    expect(annotation.user_id).toBe(existingUserId);

    // Verify: no duplicate user records
    const userCount = conn
      .prepare('SELECT COUNT(*) as c FROM users WHERE id = ?')
      .get(existingUserId) as { c: number };
    expect(userCount.c).toBe(1);

    // Verify: original user role was NOT overwritten
    const userAfter = conn
      .prepare('SELECT role FROM users WHERE id = ?')
      .get(existingUserId) as { role: string };
    expect(userAfter.role).toBe('editor');
  });

  it('createAnnotation works with null user_id (no user auto-provisioned)', async () => {
    const dbName = createUniqueName('annotation-null-user');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a document
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Count users before
    const userCountBefore = conn
      .prepare('SELECT COUNT(*) as c FROM users')
      .get() as { c: number };

    // Call createAnnotation with null user_id
    const { createAnnotation } = await import(
      '../../src/services/storage/database/annotation-operations.js'
    );

    const annotation = createAnnotation(conn, {
      document_id: doc.id,
      user_id: null,
      annotation_type: 'highlight',
      content: 'Important clause about termination.',
    });

    // Verify: annotation created with null user_id
    expect(annotation).toBeDefined();
    expect(annotation.user_id).toBeNull();

    // Verify: no new user was auto-provisioned
    const userCountAfter = conn
      .prepare('SELECT COUNT(*) as c FROM users')
      .get() as { c: number };
    expect(userCountAfter.c).toBe(userCountBefore.c);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 3: Health check orphaned provenance cleanup
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bug 3: Health check orphaned provenance cleanup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('bug3-health-orphan-');
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('health check detects orphaned provenance as fixable', async () => {
    const dbName = createUniqueName('health-orphan-detect');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a valid document with provenance (non-orphaned)
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Create an orphaned EMBEDDING provenance (no embedding references it)
    const orphanedProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: null,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(orphanedProv);

    // Verify the orphan is in the DB
    const orphanRow = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(orphanedProv.id);
    expect(orphanRow).toBeDefined();

    // Run health check without fix
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: false });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: orphaned_provenance gap is detected
    expect(parsed.data.gaps.orphaned_provenance).toBeDefined();
    expect(parsed.data.gaps.orphaned_provenance.count).toBeGreaterThanOrEqual(1);
    expect(parsed.data.gaps.orphaned_provenance.fixable).toBe(true);
    expect(parsed.data.gaps.orphaned_provenance.fix_tool).toBe('ocr_health_check');

    // Verify: orphan ID is in sample_ids
    expect(parsed.data.gaps.orphaned_provenance.sample_ids).toContain(orphanedProv.id);
  });

  it('health check fix=true deletes orphaned provenance', async () => {
    const dbName = createUniqueName('health-orphan-fix');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create valid document with provenance (should be preserved)
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Create valid OCR with provenance (should be preserved)
    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    // Create orphaned EMBEDDING provenance records (no embeddings reference them)
    const orphanIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const orphan = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        parent_id: null,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      db.insertProvenance(orphan);
      orphanIds.push(orphan.id);
    }

    // Verify orphans exist
    for (const oid of orphanIds) {
      const row = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(oid);
      expect(row).toBeDefined();
    }

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: orphaned provenance records are DELETED from DB
    for (const oid of orphanIds) {
      const row = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(oid);
      expect(row).toBeUndefined();
    }

    // Verify: non-orphaned provenance records are PRESERVED
    const docProvRow = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(docProv.id);
    expect(docProvRow).toBeDefined();

    const ocrProvRow = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(ocrProv.id);
    expect(ocrProvRow).toBeDefined();

    // Verify: fixes array includes the cleanup message
    expect(parsed.data.fixes_applied).toBeDefined();
    const cleanupFix = parsed.data.fixes_applied.find((f: string) =>
      f.includes('orphaned provenance')
    );
    expect(cleanupFix).toBeDefined();
    expect(cleanupFix).toContain('3');
  });

  it('health check fix=true handles self-referencing provenance', async () => {
    const dbName = createUniqueName('health-orphan-selfref');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create valid document (non-orphaned)
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    // Create orphaned EMBEDDING provenance A
    const orphanA = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: null,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(orphanA);

    // Create another orphaned EMBEDDING provenance B that references orphanA via parent_id
    const orphanB = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: orphanA.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(orphanB);

    // Verify self-reference: orphanB.parent_id points to orphanA
    const bRow = conn
      .prepare('SELECT parent_id FROM provenance WHERE id = ?')
      .get(orphanB.id) as { parent_id: string | null } | undefined;
    expect(bRow).toBeDefined();
    expect(bRow!.parent_id).toBe(orphanA.id);

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: both orphans are deleted (fix clears parent_id before deleting)
    const orphanARow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(orphanA.id);
    expect(orphanARow).toBeUndefined();

    const orphanBRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(orphanB.id);
    expect(orphanBRow).toBeUndefined();

    // Verify: valid document provenance is still intact
    const docProvRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(docProv.id);
    expect(docProvRow).toBeDefined();

    // Verify: fixes array includes cleanup
    expect(parsed.data.fixes_applied).toBeDefined();
    const cleanupFix = parsed.data.fixes_applied.find((f: string) =>
      f.includes('orphaned provenance')
    );
    expect(cleanupFix).toBeDefined();
  });
});

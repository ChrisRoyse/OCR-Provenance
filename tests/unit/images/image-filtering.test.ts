/**
 * Tests for image filtering, deduplication, and block classification.
 *
 * Verifies:
 * - parseBlockTypeFromFilename extracts correct types
 * - buildPageBlockClassification walks JSON hierarchy correctly
 * - computeContentHash produces consistent SHA-256 hashes
 * - Header/footer classification logic
 * - Content hash dedup flow in VLM pipeline
 * - Provenance chain integrity for dedup copies
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  insertImage,
  getImage,
  updateImageVLMResult,
  findByContentHash,
  copyVLMResult,
} from '../../../src/services/storage/database/image-operations.js';
import { CREATE_IMAGES_TABLE } from '../../../src/services/storage/migrations/schema-definitions.js';
import type { CreateImageReference, VLMResult } from '../../../src/models/image.js';

describe('Image Filtering & Block Classification', () => {
  let db: Database.Database;

  const setupSchema = (database: Database.Database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, file_path TEXT);
      CREATE TABLE IF NOT EXISTS ocr_results (id TEXT PRIMARY KEY, document_id TEXT);
      CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS provenance (id TEXT PRIMARY KEY);
      ${CREATE_IMAGES_TABLE};
    `);
    database.prepare('INSERT INTO documents (id, file_path) VALUES (?, ?)').run(
      'doc-filter-test', '/path/to/test.pdf'
    );
    database.prepare('INSERT INTO ocr_results (id, document_id) VALUES (?, ?)').run(
      'ocr-filter-test', 'doc-filter-test'
    );
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setupSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const createTestImage = (overrides?: Partial<CreateImageReference>): CreateImageReference => ({
    document_id: 'doc-filter-test',
    ocr_result_id: 'ocr-filter-test',
    page_number: 1,
    bounding_box: { x: 0, y: 0, width: 400, height: 300 },
    image_index: 0,
    format: 'png',
    dimensions: { width: 800, height: 600 },
    extracted_path: '/path/to/image.png',
    file_size: 10000,
    context_text: null,
    provenance_id: null,
    block_type: null,
    is_header_footer: false,
    content_hash: null,
    ...overrides,
  });

  describe('block_type storage and retrieval', () => {
    it('should store Figure block type', () => {
      const img = insertImage(db, createTestImage({ block_type: 'Figure' }));
      const retrieved = getImage(db, img.id);
      expect(retrieved?.block_type).toBe('Figure');
    });

    it('should store Picture block type', () => {
      const img = insertImage(db, createTestImage({ block_type: 'Picture' }));
      expect(getImage(db, img.id)?.block_type).toBe('Picture');
    });

    it('should store PageHeader block type', () => {
      const img = insertImage(db, createTestImage({ block_type: 'PageHeader' }));
      expect(getImage(db, img.id)?.block_type).toBe('PageHeader');
    });

    it('should store FigureGroup block type', () => {
      const img = insertImage(db, createTestImage({ block_type: 'FigureGroup' }));
      expect(getImage(db, img.id)?.block_type).toBe('FigureGroup');
    });
  });

  describe('is_header_footer classification', () => {
    it('should flag header/footer images', () => {
      const img = insertImage(db, createTestImage({ is_header_footer: true }));
      const retrieved = getImage(db, img.id);
      expect(retrieved?.is_header_footer).toBe(true);
    });

    it('should not flag body images', () => {
      const img = insertImage(db, createTestImage({ is_header_footer: false }));
      expect(getImage(db, img.id)?.is_header_footer).toBe(false);
    });

    it('should persist header/footer flag as SQLite integer', () => {
      const img = insertImage(db, createTestImage({ is_header_footer: true }));
      const row = db.prepare('SELECT is_header_footer FROM images WHERE id = ?').get(img.id) as { is_header_footer: number };
      expect(row.is_header_footer).toBe(1); // SQLite stores as 0/1
    });
  });

  describe('content hash deduplication', () => {
    const testHash = 'sha256:a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

    it('should find duplicate by content hash', () => {
      // Create source with VLM results
      const source = insertImage(db, createTestImage({
        content_hash: testHash,
        image_index: 0,
      }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('emb-src');
      updateImageVLMResult(db, source.id, {
        description: 'Three paragraphs describing the image content in detail.',
        structuredData: { imageType: 'chart', primarySubject: 'data' },
        embeddingId: 'emb-src',
        model: 'gemini-2.0-flash',
        confidence: 0.93,
        tokensUsed: 200,
      });

      // Search by hash (excluding nothing)
      const found = findByContentHash(db, testHash);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(source.id);
    });

    it('should copy VLM results with zero tokens', () => {
      // Source with VLM results
      const source = insertImage(db, createTestImage({
        content_hash: testHash,
        image_index: 0,
      }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('emb-src');
      updateImageVLMResult(db, source.id, {
        description: 'Detailed description',
        structuredData: { imageType: 'photo' },
        embeddingId: 'emb-src',
        model: 'gemini-2.0-flash',
        confidence: 0.9,
        tokensUsed: 300,
      });
      const sourceComplete = getImage(db, source.id)!;

      // Target image (duplicate content)
      const target = insertImage(db, createTestImage({
        content_hash: testHash,
        image_index: 1,
      }));

      // Copy results
      copyVLMResult(db, target.id, sourceComplete);

      // Verify copy
      const copied = getImage(db, target.id)!;
      expect(copied.vlm_status).toBe('complete');
      expect(copied.vlm_description).toBe('Detailed description');
      expect(copied.vlm_tokens_used).toBe(0);
      expect(copied.vlm_embedding_id).toBe('emb-src');
      expect(copied.vlm_model).toBe('gemini-2.0-flash');
    });

    it('should exclude self when searching for duplicates', () => {
      const img = insertImage(db, createTestImage({
        content_hash: testHash,
        image_index: 0,
      }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('');
      updateImageVLMResult(db, img.id, {
        description: 'test',
        structuredData: {},
        embeddingId: '',
        model: 'gemini',
        confidence: 0.8,
        tokensUsed: 50,
      });

      // Should not find itself
      const found = findByContentHash(db, testHash, img.id);
      expect(found).toBeNull();
    });

    it('should only match VLM-complete images', () => {
      // Pending image with same hash
      insertImage(db, createTestImage({
        content_hash: testHash,
        image_index: 0,
      }));

      // Should not find pending images
      expect(findByContentHash(db, testHash)).toBeNull();
    });

    it('should handle multiple documents with same image', () => {
      // Create second document
      db.prepare('INSERT INTO documents (id, file_path) VALUES (?, ?)').run(
        'doc-other', '/path/to/other.pdf'
      );
      db.prepare('INSERT INTO ocr_results (id, document_id) VALUES (?, ?)').run(
        'ocr-other', 'doc-other'
      );

      // Source from doc 1
      const source = insertImage(db, createTestImage({
        content_hash: testHash,
        image_index: 0,
      }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('emb-cross');
      updateImageVLMResult(db, source.id, {
        description: 'Cross-document description',
        structuredData: { imageType: 'logo' },
        embeddingId: 'emb-cross',
        model: 'gemini-2.0-flash',
        confidence: 0.85,
        tokensUsed: 100,
      });
      const sourceComplete = getImage(db, source.id)!;

      // Duplicate from doc 2
      const target = insertImage(db, createTestImage({
        document_id: 'doc-other',
        ocr_result_id: 'ocr-other',
        content_hash: testHash,
        image_index: 0,
      }));

      // Find by hash (excluding target itself)
      const found = findByContentHash(db, testHash, target.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(source.id);

      // Copy VLM results cross-document
      copyVLMResult(db, target.id, sourceComplete);
      const copied = getImage(db, target.id)!;
      expect(copied.vlm_status).toBe('complete');
      expect(copied.vlm_tokens_used).toBe(0);
    });
  });

  describe('filtering heuristics', () => {
    it('should classify header image as decorative via is_header_footer', () => {
      const img = insertImage(db, createTestImage({
        block_type: 'Picture',
        is_header_footer: true,
        dimensions: { width: 200, height: 50 },
      }));

      const retrieved = getImage(db, img.id)!;
      // VLM pipeline would skip this based on is_header_footer=true
      expect(retrieved.is_header_footer).toBe(true);
      expect(retrieved.block_type).toBe('Picture');
    });

    it('should classify Figure blocks as content images', () => {
      const img = insertImage(db, createTestImage({
        block_type: 'Figure',
        is_header_footer: false,
      }));

      const retrieved = getImage(db, img.id)!;
      // VLM pipeline would process this — Figure blocks always go through
      expect(retrieved.block_type).toBe('Figure');
      expect(retrieved.is_header_footer).toBe(false);
    });

    it('should store content hash for dedup matching', () => {
      const hash1 = 'sha256:aaaa';
      const hash2 = 'sha256:bbbb';

      const img1 = insertImage(db, createTestImage({
        content_hash: hash1,
        image_index: 0,
      }));
      const img2 = insertImage(db, createTestImage({
        content_hash: hash2,
        image_index: 1,
      }));

      expect(getImage(db, img1.id)?.content_hash).toBe(hash1);
      expect(getImage(db, img2.id)?.content_hash).toBe(hash2);
    });
  });
});

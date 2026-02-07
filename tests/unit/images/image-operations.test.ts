/**
 * Unit tests for Image Operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  insertImage,
  insertImageBatch,
  getImage,
  getImagesByDocument,
  getPendingImages,
  listImages,
  setImageProcessing,
  updateImageVLMResult,
  setImageVLMFailed,
  updateImageContext,
  getImageStats,
  deleteImage,
  deleteImagesByDocument,
  resetFailedImages,
  findByContentHash,
  copyVLMResult,
} from '../../../src/services/storage/database/image-operations.js';
import { CREATE_IMAGES_TABLE } from '../../../src/services/storage/migrations/schema-definitions.js';
import type { CreateImageReference, VLMResult } from '../../../src/models/image.js';

describe('Image Operations', () => {
  let db: Database.Database;

  // Create minimal schema for testing
  const setupSchema = (database: Database.Database) => {
    // Create minimal tables for FK constraints
    database.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ocr_results (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS provenance (
        id TEXT PRIMARY KEY
      );
    `);
    database.exec(CREATE_IMAGES_TABLE);
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setupSchema(db);

    // Insert test document and OCR result
    db.prepare('INSERT INTO documents (id, file_path) VALUES (?, ?)').run(
      'doc-123',
      '/path/to/test.pdf'
    );
    db.prepare('INSERT INTO ocr_results (id, document_id) VALUES (?, ?)').run(
      'ocr-456',
      'doc-123'
    );
  });

  afterEach(() => {
    db.close();
  });

  const createTestImage = (overrides?: Partial<CreateImageReference>): CreateImageReference => ({
    document_id: 'doc-123',
    ocr_result_id: 'ocr-456',
    page_number: 1,
    bounding_box: { x: 72, y: 100, width: 400, height: 300 },
    image_index: 0,
    format: 'png',
    dimensions: { width: 800, height: 600 },
    extracted_path: '/path/to/images/p001_i000.png',
    file_size: 12345,
    context_text: 'Surrounding text from document',
    provenance_id: null,
    block_type: null,
    is_header_footer: false,
    content_hash: null,
    ...overrides,
  });

  describe('insertImage', () => {
    it('should insert an image and return with generated fields', () => {
      const input = createTestImage();
      const result = insertImage(db, input);

      expect(result.id).toBeDefined();
      expect(result.id).toHaveLength(36); // UUID format
      expect(result.created_at).toBeDefined();
      expect(result.vlm_status).toBe('pending');
      expect(result.vlm_description).toBeNull();
      expect(result.document_id).toBe('doc-123');
      expect(result.page_number).toBe(1);
      expect(result.format).toBe('png');
    });

    it('should store bounding box correctly', () => {
      const input = createTestImage({
        bounding_box: { x: 10.5, y: 20.5, width: 100.5, height: 200.5 },
      });
      const result = insertImage(db, input);
      const retrieved = getImage(db, result.id);

      expect(retrieved?.bounding_box.x).toBe(10.5);
      expect(retrieved?.bounding_box.y).toBe(20.5);
      expect(retrieved?.bounding_box.width).toBe(100.5);
      expect(retrieved?.bounding_box.height).toBe(200.5);
    });
  });

  describe('insertImageBatch', () => {
    it('should insert multiple images in a transaction', () => {
      const images = [
        createTestImage({ image_index: 0 }),
        createTestImage({ image_index: 1, page_number: 1 }),
        createTestImage({ image_index: 0, page_number: 2 }),
      ];

      const results = insertImageBatch(db, images);

      expect(results).toHaveLength(3);
      expect(results[0].image_index).toBe(0);
      expect(results[1].image_index).toBe(1);
      expect(results[2].page_number).toBe(2);

      const stats = getImageStats(db);
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(3);
    });
  });

  describe('getImage', () => {
    it('should return null for non-existent image', () => {
      const result = getImage(db, 'non-existent-id');
      expect(result).toBeNull();
    });

    it('should retrieve an image by ID', () => {
      const inserted = insertImage(db, createTestImage());
      const retrieved = getImage(db, inserted.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(inserted.id);
      expect(retrieved?.format).toBe('png');
      expect(retrieved?.dimensions.width).toBe(800);
      expect(retrieved?.dimensions.height).toBe(600);
    });
  });

  describe('getImagesByDocument', () => {
    it('should return images ordered by page and index', () => {
      insertImage(db, createTestImage({ page_number: 2, image_index: 0 }));
      insertImage(db, createTestImage({ page_number: 1, image_index: 1 }));
      insertImage(db, createTestImage({ page_number: 1, image_index: 0 }));

      const images = getImagesByDocument(db, 'doc-123');

      expect(images).toHaveLength(3);
      expect(images[0].page_number).toBe(1);
      expect(images[0].image_index).toBe(0);
      expect(images[1].page_number).toBe(1);
      expect(images[1].image_index).toBe(1);
      expect(images[2].page_number).toBe(2);
    });

    it('should return empty array for unknown document', () => {
      const images = getImagesByDocument(db, 'unknown-doc');
      expect(images).toHaveLength(0);
    });
  });

  describe('getPendingImages', () => {
    it('should return only pending images', () => {
      const img1 = insertImage(db, createTestImage({ image_index: 0 }));
      insertImage(db, createTestImage({ image_index: 1 }));

      // Insert test embedding for FK constraint
      db.prepare('INSERT INTO embeddings (id) VALUES (?)').run('emb-123');

      // Mark first image as complete
      updateImageVLMResult(db, img1.id, {
        description: 'Test description',
        structuredData: { imageType: 'photo' },
        embeddingId: 'emb-123',
        model: 'gemini-3-flash-preview',
        confidence: 0.95,
        tokensUsed: 500,
      });

      const pending = getPendingImages(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].vlm_status).toBe('pending');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        insertImage(db, createTestImage({ image_index: i }));
      }

      const pending = getPendingImages(db, 3);
      expect(pending).toHaveLength(3);
    });
  });

  describe('listImages', () => {
    it('should support filtering by VLM status', () => {
      const img1 = insertImage(db, createTestImage({ image_index: 0 }));
      insertImage(db, createTestImage({ image_index: 1 }));

      setImageVLMFailed(db, img1.id, 'Test error');

      const failed = listImages(db, { vlmStatus: 'failed' });
      expect(failed).toHaveLength(1);
      expect(failed[0].id).toBe(img1.id);

      const pending = listImages(db, { vlmStatus: 'pending' });
      expect(pending).toHaveLength(1);
    });

    it('should support pagination', () => {
      for (let i = 0; i < 5; i++) {
        insertImage(db, createTestImage({ image_index: i }));
      }

      const page1 = listImages(db, { limit: 2, offset: 0 });
      const page2 = listImages(db, { limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('setImageProcessing', () => {
    it('should update status to processing', () => {
      const img = insertImage(db, createTestImage());
      setImageProcessing(db, img.id);

      const retrieved = getImage(db, img.id);
      expect(retrieved?.vlm_status).toBe('processing');
    });

    it('should return false for non-existent image', () => {
      expect(setImageProcessing(db, 'non-existent')).toBe(false);
    });

    it('should only transition from pending to processing', () => {
      const img = insertImage(db, createTestImage());
      // First call: pending -> processing (returns true)
      expect(setImageProcessing(db, img.id)).toBe(true);
      // Second call: already processing, not pending (returns false)
      expect(setImageProcessing(db, img.id)).toBe(false);
      // Status should still be processing
      const retrieved = getImage(db, img.id);
      expect(retrieved?.vlm_status).toBe('processing');
    });
  });

  describe('updateImageVLMResult', () => {
    it('should update image with VLM results', () => {
      const img = insertImage(db, createTestImage());

      // Insert test embedding for FK constraint
      db.prepare('INSERT INTO embeddings (id) VALUES (?)').run('emb-789');

      const vlmResult: VLMResult = {
        description: 'A photograph showing a building exterior.',
        structuredData: {
          imageType: 'photograph',
          primarySubject: 'building',
          extractedText: ['ENTRANCE', '123 Main St'],
          dates: ['2024-01-15'],
          names: ['ABC Corp'],
          numbers: ['123'],
        },
        embeddingId: 'emb-789',
        model: 'gemini-3-flash-preview',
        confidence: 0.92,
        tokensUsed: 750,
      };

      updateImageVLMResult(db, img.id, vlmResult);

      const retrieved = getImage(db, img.id);
      expect(retrieved?.vlm_status).toBe('complete');
      expect(retrieved?.vlm_description).toBe(vlmResult.description);
      expect(retrieved?.vlm_model).toBe('gemini-3-flash-preview');
      expect(retrieved?.vlm_confidence).toBe(0.92);
      expect(retrieved?.vlm_tokens_used).toBe(750);
      expect(retrieved?.vlm_processed_at).toBeDefined();
      expect(retrieved?.vlm_structured_data?.imageType).toBe('photograph');
      expect(retrieved?.vlm_structured_data?.extractedText).toContain('ENTRANCE');
      expect(retrieved?.error_message).toBeNull();
    });
  });

  describe('setImageVLMFailed', () => {
    it('should mark image as failed with error message', () => {
      const img = insertImage(db, createTestImage());
      setImageVLMFailed(db, img.id, 'API rate limit exceeded');

      const retrieved = getImage(db, img.id);
      expect(retrieved?.vlm_status).toBe('failed');
      expect(retrieved?.error_message).toBe('API rate limit exceeded');
    });
  });

  describe('updateImageContext', () => {
    it('should update context text', () => {
      const img = insertImage(db, createTestImage({ context_text: null }));
      updateImageContext(db, img.id, 'New context text from OCR');

      const retrieved = getImage(db, img.id);
      expect(retrieved?.context_text).toBe('New context text from OCR');
    });
  });

  describe('getImageStats', () => {
    it('should return accurate statistics', () => {
      const img1 = insertImage(db, createTestImage({ image_index: 0 }));
      const img2 = insertImage(db, createTestImage({ image_index: 1 }));
      insertImage(db, createTestImage({ image_index: 2 }));

      // Insert test embedding for FK constraint
      db.prepare('INSERT INTO embeddings (id) VALUES (?)').run('e1');

      updateImageVLMResult(db, img1.id, {
        description: 'test',
        structuredData: {},
        embeddingId: 'e1',
        model: 'gemini',
        confidence: 0.9,
        tokensUsed: 100,
      });
      setImageVLMFailed(db, img2.id, 'error');

      const stats = getImageStats(db);
      expect(stats.total).toBe(3);
      expect(stats.processed).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });

  describe('deleteImage', () => {
    it('should delete an image by ID', () => {
      const img = insertImage(db, createTestImage());
      const deleted = deleteImage(db, img.id);

      expect(deleted).toBe(true);
      expect(getImage(db, img.id)).toBeNull();
    });

    it('should return false for non-existent image', () => {
      const deleted = deleteImage(db, 'non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteImagesByDocument', () => {
    it('should delete all images for a document', () => {
      insertImage(db, createTestImage({ image_index: 0 }));
      insertImage(db, createTestImage({ image_index: 1 }));
      insertImage(db, createTestImage({ image_index: 2 }));

      const count = deleteImagesByDocument(db, 'doc-123');
      expect(count).toBe(3);

      const remaining = getImagesByDocument(db, 'doc-123');
      expect(remaining).toHaveLength(0);
    });
  });

  describe('resetFailedImages', () => {
    it('should reset failed images to pending', () => {
      const img1 = insertImage(db, createTestImage({ image_index: 0 }));
      const img2 = insertImage(db, createTestImage({ image_index: 1 }));

      setImageVLMFailed(db, img1.id, 'error 1');
      setImageVLMFailed(db, img2.id, 'error 2');

      const count = resetFailedImages(db);
      expect(count).toBe(2);

      const retrieved1 = getImage(db, img1.id);
      const retrieved2 = getImage(db, img2.id);
      expect(retrieved1?.vlm_status).toBe('pending');
      expect(retrieved1?.error_message).toBeNull();
      expect(retrieved2?.vlm_status).toBe('pending');
    });

    it('should filter by document ID', () => {
      // Create second document
      db.prepare('INSERT INTO documents (id, file_path) VALUES (?, ?)').run(
        'doc-other',
        '/path/to/other.pdf'
      );
      db.prepare('INSERT INTO ocr_results (id, document_id) VALUES (?, ?)').run(
        'ocr-other',
        'doc-other'
      );

      const img1 = insertImage(db, createTestImage({ image_index: 0 }));
      const img2 = insertImage(db, createTestImage({
        image_index: 0,
        document_id: 'doc-other',
        ocr_result_id: 'ocr-other',
      }));

      setImageVLMFailed(db, img1.id, 'error');
      setImageVLMFailed(db, img2.id, 'error');

      const count = resetFailedImages(db, 'doc-123');
      expect(count).toBe(1);

      expect(getImage(db, img1.id)?.vlm_status).toBe('pending');
      expect(getImage(db, img2.id)?.vlm_status).toBe('failed');
    });
  });

  describe('new image filtering fields', () => {
    it('should store and retrieve block_type', () => {
      const img = insertImage(db, createTestImage({ block_type: 'Figure' }));
      expect(img.block_type).toBe('Figure');

      const retrieved = getImage(db, img.id);
      expect(retrieved?.block_type).toBe('Figure');
    });

    it('should store and retrieve is_header_footer as boolean', () => {
      const img = insertImage(db, createTestImage({ is_header_footer: true }));
      expect(img.is_header_footer).toBe(true);

      const retrieved = getImage(db, img.id);
      expect(retrieved?.is_header_footer).toBe(true);
    });

    it('should default is_header_footer to false', () => {
      const img = insertImage(db, createTestImage());
      expect(img.is_header_footer).toBe(false);
    });

    it('should store and retrieve content_hash', () => {
      const hash = 'sha256:abc123def456';
      const img = insertImage(db, createTestImage({ content_hash: hash }));
      expect(img.content_hash).toBe(hash);

      const retrieved = getImage(db, img.id);
      expect(retrieved?.content_hash).toBe(hash);
    });

    it('should allow null for all new fields', () => {
      const img = insertImage(db, createTestImage({
        block_type: null,
        is_header_footer: false,
        content_hash: null,
      }));

      const retrieved = getImage(db, img.id);
      expect(retrieved?.block_type).toBeNull();
      expect(retrieved?.is_header_footer).toBe(false);
      expect(retrieved?.content_hash).toBeNull();
    });
  });

  describe('findByContentHash', () => {
    it('should find a VLM-complete image by content hash', () => {
      const hash = 'sha256:duplicateimage123';
      const img = insertImage(db, createTestImage({
        content_hash: hash,
        image_index: 0,
      }));

      // Insert dummy embedding for FK constraint
      db.prepare('INSERT INTO embeddings (id) VALUES (?)').run('emb-123');

      // Mark as VLM complete
      const vlmResult: VLMResult = {
        description: 'A test image description',
        structuredData: { imageType: 'photo', primarySubject: 'test' },
        embeddingId: 'emb-123',
        model: 'gemini-2.0-flash',
        confidence: 0.95,
        tokensUsed: 100,
      };
      updateImageVLMResult(db, img.id, vlmResult);

      // Should find it by hash
      const found = findByContentHash(db, hash);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(img.id);
      expect(found?.vlm_status).toBe('complete');
    });

    it('should NOT find a pending image by content hash', () => {
      const hash = 'sha256:pendingimage456';
      insertImage(db, createTestImage({ content_hash: hash }));

      // Should not find pending images
      const found = findByContentHash(db, hash);
      expect(found).toBeNull();
    });

    it('should exclude a specific image ID', () => {
      const hash = 'sha256:excludetest789';

      const img1 = insertImage(db, createTestImage({
        content_hash: hash,
        image_index: 0,
      }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('emb-1');
      const vlmResult: VLMResult = {
        description: 'Description for img1',
        structuredData: { imageType: 'photo', primarySubject: 'test' },
        embeddingId: 'emb-1',
        model: 'gemini-2.0-flash',
        confidence: 0.9,
        tokensUsed: 50,
      };
      updateImageVLMResult(db, img1.id, vlmResult);

      // When excluding img1, should return null (only one match)
      const found = findByContentHash(db, hash, img1.id);
      expect(found).toBeNull();
    });

    it('should return null for non-existent hash', () => {
      const found = findByContentHash(db, 'sha256:doesnotexist');
      expect(found).toBeNull();
    });
  });

  describe('copyVLMResult', () => {
    it('should copy VLM results from source to target image', () => {
      // Create source image with VLM results
      const source = insertImage(db, createTestImage({
        content_hash: 'sha256:source',
        image_index: 0,
      }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('emb-source');
      const vlmResult: VLMResult = {
        description: 'Detailed 3-paragraph description of the source image',
        structuredData: { imageType: 'chart', primarySubject: 'data visualization' },
        embeddingId: 'emb-source',
        model: 'gemini-2.0-flash',
        confidence: 0.92,
        tokensUsed: 150,
      };
      updateImageVLMResult(db, source.id, vlmResult);

      // Reload source to get complete fields
      const sourceComplete = getImage(db, source.id)!;

      // Create target image (same content, different document)
      const target = insertImage(db, createTestImage({
        content_hash: 'sha256:source',
        image_index: 1,
      }));

      // Copy VLM results
      copyVLMResult(db, target.id, sourceComplete);

      // Verify target has copied results
      const copied = getImage(db, target.id);
      expect(copied).not.toBeNull();
      expect(copied!.vlm_status).toBe('complete');
      expect(copied!.vlm_description).toBe('Detailed 3-paragraph description of the source image');
      expect(copied!.vlm_model).toBe('gemini-2.0-flash');
      expect(copied!.vlm_confidence).toBe(0.92);
      expect(copied!.vlm_tokens_used).toBe(0); // Dedup = 0 tokens
      expect(copied!.vlm_embedding_id).toBe('emb-source'); // Embedding ID copied
      expect(copied!.error_message).toBeNull();
    });

    it('should set vlm_tokens_used to 0 for dedup copies', () => {
      const source = insertImage(db, createTestImage({ image_index: 0 }));
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('');
      updateImageVLMResult(db, source.id, {
        description: 'test',
        structuredData: {},
        embeddingId: '',
        model: 'gemini',
        confidence: 0.8,
        tokensUsed: 500,
      });

      const sourceComplete = getImage(db, source.id)!;
      const target = insertImage(db, createTestImage({ image_index: 1 }));

      copyVLMResult(db, target.id, sourceComplete);

      const copied = getImage(db, target.id);
      expect(copied!.vlm_tokens_used).toBe(0);
    });

    it('should throw for non-existent target', () => {
      const source = insertImage(db, createTestImage());
      db.prepare('INSERT OR IGNORE INTO embeddings (id) VALUES (?)').run('');
      updateImageVLMResult(db, source.id, {
        description: 'test',
        structuredData: {},
        embeddingId: '',
        model: 'gemini',
        confidence: 0.8,
        tokensUsed: 50,
      });
      const sourceComplete = getImage(db, source.id)!;

      expect(() => copyVLMResult(db, 'nonexistent', sourceComplete)).toThrow();
    });
  });
});

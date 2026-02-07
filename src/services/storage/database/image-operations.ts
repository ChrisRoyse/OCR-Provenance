/**
 * Image operations for DatabaseService
 *
 * Handles all CRUD operations for extracted images including
 * insert, get, list, update VLM results, and delete.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  ImageReference,
  CreateImageReference,
  VLMResult,
  ImageStats,
} from '../../../models/image.js';
import { ImageRow, ListImagesOptions, DatabaseError, DatabaseErrorCode } from './types.js';
import { rowToImage } from './converters.js';

/**
 * Insert a new image reference
 *
 * @param db - Database connection
 * @param image - Image data (id and timestamps will be generated)
 * @returns ImageReference - The created image with generated fields
 */
export function insertImage(
  db: Database.Database,
  image: CreateImageReference
): ImageReference {
  const id = uuidv4();
  const created_at = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO images (
      id, document_id, ocr_result_id, page_number,
      bbox_x, bbox_y, bbox_width, bbox_height,
      image_index, format, width, height,
      extracted_path, file_size, vlm_status,
      context_text, provenance_id, created_at,
      block_type, is_header_footer, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    image.document_id,
    image.ocr_result_id,
    image.page_number,
    image.bounding_box.x,
    image.bounding_box.y,
    image.bounding_box.width,
    image.bounding_box.height,
    image.image_index,
    image.format,
    image.dimensions.width,
    image.dimensions.height,
    image.extracted_path ?? null,
    image.file_size ?? null,
    image.context_text ?? null,
    image.provenance_id ?? null,
    created_at,
    image.block_type ?? null,
    image.is_header_footer ? 1 : 0,
    image.content_hash ?? null
  );

  return {
    ...image,
    id,
    created_at,
    vlm_status: 'pending',
    vlm_description: null,
    vlm_structured_data: null,
    vlm_embedding_id: null,
    vlm_model: null,
    vlm_confidence: null,
    vlm_processed_at: null,
    vlm_tokens_used: null,
    error_message: null,
    block_type: image.block_type ?? null,
    is_header_footer: image.is_header_footer ?? false,
    content_hash: image.content_hash ?? null,
  };
}

/**
 * Insert multiple images in a batch
 *
 * @param db - Database connection
 * @param images - Array of image data to insert
 * @returns ImageReference[] - Array of created images
 */
export function insertImageBatch(
  db: Database.Database,
  images: CreateImageReference[]
): ImageReference[] {
  const results: ImageReference[] = [];

  const insertFn = db.transaction(() => {
    for (const image of images) {
      results.push(insertImage(db, image));
    }
  });

  insertFn();
  return results;
}

/**
 * Get an image by ID
 *
 * @param db - Database connection
 * @param id - Image ID
 * @returns ImageReference | null - The image or null if not found
 */
export function getImage(db: Database.Database, id: string): ImageReference | null {
  const stmt = db.prepare('SELECT * FROM images WHERE id = ?');
  const row = stmt.get(id) as ImageRow | undefined;
  return row ? rowToImage(row) : null;
}

/**
 * Get images for a document with optional filtering
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @param options - Optional filters: vlmStatus, limit
 * @returns ImageReference[] - Array of images ordered by page and index
 */
export function getImagesByDocument(
  db: Database.Database,
  documentId: string,
  options?: { vlmStatus?: string; limit?: number }
): ImageReference[] {
  const params: unknown[] = [documentId];
  let sql = 'SELECT * FROM images WHERE document_id = ?';

  if (options?.vlmStatus) {
    sql += ' AND vlm_status = ?';
    params.push(options.vlmStatus);
  }

  sql += ' ORDER BY page_number, image_index';

  if (options?.limit && options.limit > 0) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as ImageRow[];
  return rows.map(rowToImage);
}

/**
 * Get all images for an OCR result
 *
 * @param db - Database connection
 * @param ocrResultId - OCR result ID
 * @returns ImageReference[] - Array of images ordered by page and index
 */
export function getImagesByOCRResult(
  db: Database.Database,
  ocrResultId: string
): ImageReference[] {
  const stmt = db.prepare(`
    SELECT * FROM images
    WHERE ocr_result_id = ?
    ORDER BY page_number, image_index
  `);
  const rows = stmt.all(ocrResultId) as ImageRow[];
  return rows.map(rowToImage);
}

/**
 * Get pending images for VLM processing
 *
 * @param db - Database connection
 * @param limit - Maximum number of images to return
 * @returns ImageReference[] - Array of pending images ordered by creation time
 */
export function getPendingImages(
  db: Database.Database,
  limit: number = 100
): ImageReference[] {
  const stmt = db.prepare(`
    SELECT * FROM images
    WHERE vlm_status = 'pending'
    ORDER BY created_at
    LIMIT ?
  `);
  const rows = stmt.all(limit) as ImageRow[];
  return rows.map(rowToImage);
}

/**
 * List images with optional filtering
 *
 * @param db - Database connection
 * @param options - Optional filter options
 * @returns ImageReference[] - Array of images
 */
export function listImages(
  db: Database.Database,
  options?: ListImagesOptions
): ImageReference[] {
  let query = 'SELECT * FROM images';
  const params: (string | number)[] = [];

  if (options?.vlmStatus) {
    query += ' WHERE vlm_status = ?';
    params.push(options.vlmStatus);
  }

  query += ' ORDER BY created_at DESC';

  if (options?.limit !== undefined) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset !== undefined) {
    if (options?.limit === undefined) {
      query += ' LIMIT -1';
    }
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as ImageRow[];
  return rows.map(rowToImage);
}

/**
 * Update image VLM status to processing
 *
 * @param db - Database connection
 * @param id - Image ID
 */
export function setImageProcessing(db: Database.Database, id: string): boolean {
  const stmt = db.prepare(`
    UPDATE images SET vlm_status = 'processing'
    WHERE id = ? AND vlm_status = 'pending'
  `);

  const result = stmt.run(id);
  // Returns false if image not found or already processing/complete/failed
  return result.changes > 0;
}

/**
 * Update image with VLM results
 *
 * @param db - Database connection
 * @param id - Image ID
 * @param result - VLM processing result
 */
export function updateImageVLMResult(
  db: Database.Database,
  id: string,
  result: VLMResult
): void {
  const vlm_processed_at = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE images SET
      vlm_status = 'complete',
      vlm_description = ?,
      vlm_structured_data = ?,
      vlm_embedding_id = ?,
      vlm_model = ?,
      vlm_confidence = ?,
      vlm_tokens_used = ?,
      vlm_processed_at = ?,
      error_message = NULL
    WHERE id = ?
  `);

  const changes = stmt.run(
    result.description,
    JSON.stringify(result.structuredData),
    result.embeddingId,
    result.model,
    result.confidence,
    result.tokensUsed,
    vlm_processed_at,
    id
  ).changes;

  if (changes === 0) {
    throw new DatabaseError(
      `Image "${id}" not found`,
      DatabaseErrorCode.IMAGE_NOT_FOUND
    );
  }
}

/**
 * Mark image VLM processing as failed
 *
 * @param db - Database connection
 * @param id - Image ID
 * @param errorMessage - Error message
 */
export function setImageVLMFailed(
  db: Database.Database,
  id: string,
  errorMessage: string
): void {
  const stmt = db.prepare(`
    UPDATE images SET
      vlm_status = 'failed',
      error_message = ?
    WHERE id = ?
  `);

  const result = stmt.run(errorMessage, id);
  if (result.changes === 0) {
    throw new DatabaseError(
      `Image "${id}" not found`,
      DatabaseErrorCode.IMAGE_NOT_FOUND
    );
  }
}

/**
 * Update image context text
 *
 * @param db - Database connection
 * @param id - Image ID
 * @param contextText - Surrounding text from document
 */
export function updateImageContext(
  db: Database.Database,
  id: string,
  contextText: string
): void {
  const stmt = db.prepare(`
    UPDATE images SET context_text = ?
    WHERE id = ?
  `);

  const result = stmt.run(contextText, id);
  if (result.changes === 0) {
    throw new DatabaseError(
      `Image "${id}" not found`,
      DatabaseErrorCode.IMAGE_NOT_FOUND
    );
  }
}

/**
 * Update image provenance_id
 *
 * @param db - Database connection
 * @param id - Image ID
 * @param provenanceId - Provenance record ID to set
 */
export function updateImageProvenance(
  db: Database.Database,
  id: string,
  provenanceId: string
): void {
  const result = db.prepare('UPDATE images SET provenance_id = ? WHERE id = ?').run(provenanceId, id);
  if (result.changes === 0) {
    throw new DatabaseError(
      `Image "${id}" not found`,
      DatabaseErrorCode.IMAGE_NOT_FOUND
    );
  }
}

/**
 * Get image statistics
 *
 * @param db - Database connection
 * @returns ImageStats - Statistics about images in database
 */
export function getImageStats(db: Database.Database): ImageStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN vlm_status = 'complete' THEN 1 END) as processed,
      COUNT(CASE WHEN vlm_status = 'pending' THEN 1 END) as pending,
      COUNT(CASE WHEN vlm_status = 'failed' THEN 1 END) as failed
    FROM images
  `).get() as { total: number; processed: number; pending: number; failed: number };

  return row;
}

/**
 * Delete an image by ID
 *
 * @param db - Database connection
 * @param id - Image ID
 * @returns boolean - True if image was deleted
 */
export function deleteImage(db: Database.Database, id: string): boolean {
  const stmt = db.prepare('DELETE FROM images WHERE id = ?');
  return stmt.run(id).changes > 0;
}

/**
 * Delete all images for a document
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns number - Number of images deleted
 */
export function deleteImagesByDocument(
  db: Database.Database,
  documentId: string
): number {
  const stmt = db.prepare('DELETE FROM images WHERE document_id = ?');
  return stmt.run(documentId).changes;
}

/**
 * Count images by document
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns number - Number of images for this document
 */
export function countImagesByDocument(
  db: Database.Database,
  documentId: string
): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM images WHERE document_id = ?
  `).get(documentId) as { count: number };
  return row.count;
}

/**
 * Reset VLM status to pending for failed images
 *
 * @param db - Database connection
 * @param documentId - Optional document ID to filter
 * @returns number - Number of images reset
 */
export function resetFailedImages(
  db: Database.Database,
  documentId?: string
): number {
  let query = `
    UPDATE images SET
      vlm_status = 'pending',
      error_message = NULL
    WHERE vlm_status = 'failed'
  `;

  if (documentId) {
    query += ' AND document_id = ?';
    return db.prepare(query).run(documentId).changes;
  }

  return db.prepare(query).run().changes;
}

/**
 * Reset VLM status to pending for images stuck in 'processing' state
 *
 * @param db - Database connection
 * @param documentId - Optional document ID to filter
 * @returns number - Number of images reset
 */
export function resetProcessingImages(
  db: Database.Database,
  documentId?: string
): number {
  let query = `
    UPDATE images SET
      vlm_status = 'pending',
      error_message = 'Reset from stuck processing state'
    WHERE vlm_status = 'processing'
  `;

  if (documentId) {
    query += ' AND document_id = ?';
    return db.prepare(query).run(documentId).changes;
  }

  return db.prepare(query).run().changes;
}

/**
 * Find a VLM-complete image with the same content hash (for deduplication).
 * Returns the first matching image or null.
 *
 * @param db - Database connection
 * @param contentHash - SHA-256 hash to search for
 * @param excludeId - Optional image ID to exclude from results
 * @returns ImageReference | null
 */
export function findByContentHash(
  db: Database.Database,
  contentHash: string,
  excludeId?: string
): ImageReference | null {
  const query = excludeId
    ? `SELECT * FROM images WHERE content_hash = ? AND vlm_status = 'complete' AND id != ? LIMIT 1`
    : `SELECT * FROM images WHERE content_hash = ? AND vlm_status = 'complete' LIMIT 1`;

  const row = excludeId
    ? (db.prepare(query).get(contentHash, excludeId) as ImageRow | undefined)
    : (db.prepare(query).get(contentHash) as ImageRow | undefined);

  return row ? rowToImage(row) : null;
}

/**
 * Copy VLM results from one image to another (deduplication).
 * Sets vlm_status='complete', vlm_tokens_used=0 (no API call made).
 *
 * @param db - Database connection
 * @param targetId - Image ID to copy results TO
 * @param source - Source image to copy results FROM
 */
export function copyVLMResult(
  db: Database.Database,
  targetId: string,
  source: ImageReference
): void {
  const stmt = db.prepare(`
    UPDATE images SET
      vlm_status = 'complete',
      vlm_description = ?,
      vlm_structured_data = ?,
      vlm_embedding_id = ?,
      vlm_model = ?,
      vlm_confidence = ?,
      vlm_tokens_used = 0,
      vlm_processed_at = ?,
      error_message = NULL
    WHERE id = ?
  `);

  const changes = stmt.run(
    source.vlm_description,
    source.vlm_structured_data ? JSON.stringify(source.vlm_structured_data) : null,
    source.vlm_embedding_id,
    source.vlm_model,
    source.vlm_confidence,
    new Date().toISOString(),
    targetId
  ).changes;

  if (changes === 0) {
    throw new DatabaseError(
      `Image "${targetId}" not found`,
      DatabaseErrorCode.IMAGE_NOT_FOUND
    );
  }
}

/**
 * OCR Result operations for DatabaseService
 *
 * Handles all CRUD operations for OCR results.
 */

import Database from 'better-sqlite3';
import { OCRResult } from '../../../models/document.js';
import { OCRResultRow } from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToOCRResult } from './converters.js';

/**
 * Insert an OCR result
 *
 * @param db - Database connection
 * @param result - OCR result data
 * @param updateMetadataCounts - Callback to update metadata counts
 * @returns string - The OCR result ID
 */
export function insertOCRResult(
  db: Database.Database,
  result: OCRResult,
  updateMetadataCounts: () => void
): string {
  const stmt = db.prepare(`
    INSERT INTO ocr_results (
      id, provenance_id, document_id, extracted_text, text_length,
      datalab_request_id, datalab_mode, parse_quality_score, page_count,
      cost_cents, content_hash, processing_started_at, processing_completed_at,
      processing_duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      result.id,
      result.provenance_id,
      result.document_id,
      result.extracted_text,
      result.text_length,
      result.datalab_request_id,
      result.datalab_mode,
      result.parse_quality_score,
      result.page_count,
      result.cost_cents,
      result.content_hash,
      result.processing_started_at,
      result.processing_completed_at,
      result.processing_duration_ms,
    ],
    `inserting OCR result: document_id "${result.document_id}" or provenance_id "${result.provenance_id}" does not exist`
  );

  updateMetadataCounts();
  return result.id;
}

/**
 * Get an OCR result by ID
 *
 * @param db - Database connection
 * @param id - OCR result ID
 * @returns OCRResult | null - The OCR result or null if not found
 */
export function getOCRResult(db: Database.Database, id: string): OCRResult | null {
  const stmt = db.prepare('SELECT * FROM ocr_results WHERE id = ?');
  const row = stmt.get(id) as OCRResultRow | undefined;
  return row ? rowToOCRResult(row) : null;
}

/**
 * Get OCR result by document ID
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns OCRResult | null - The OCR result or null if not found
 */
export function getOCRResultByDocumentId(
  db: Database.Database,
  documentId: string
): OCRResult | null {
  const stmt = db.prepare('SELECT * FROM ocr_results WHERE document_id = ?');
  const row = stmt.get(documentId) as OCRResultRow | undefined;
  return row ? rowToOCRResult(row) : null;
}

/**
 * ProvenanceVerifier - Hash integrity and chain verification
 *
 * Constitution Compliance:
 * - CP-003: Immutable Hash Verification
 * - CP-001: Complete Provenance Chain
 *
 * FAIL FAST: All errors throw immediately
 * NO MOCKS: Tests use real DatabaseService
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import { DatabaseService } from '../storage/database/index.js';
import { ProvenanceTracker, ProvenanceErrorCode } from './tracker.js';
import {
  ProvenanceRecord,
  ProvenanceType,
  VerificationResult,
} from '../../models/provenance.js';
import { Document, OCRResult } from '../../models/document.js';
import { Chunk } from '../../models/chunk.js';
import { Embedding } from '../../models/embedding.js';
import { computeHash, hashFile, isValidHashFormat } from '../../utils/hash.js';
import {
  rowToOCRResult,
  rowToChunk,
  rowToEmbedding,
  rowToProvenance,
  rowToImage,
} from '../storage/database/converters.js';
import type { ImageReference } from '../../models/image.js';
import {
  OCRResultRow,
  ChunkRow,
  EmbeddingRow,
  ProvenanceRow,
  ImageRow,
} from '../storage/database/types.js';

/** Error codes for verifier operations */
export const VerifierErrorCode = {
  ...ProvenanceErrorCode,
  INTEGRITY_FAILED: 'INTEGRITY_VERIFICATION_FAILED',
  CONTENT_NOT_FOUND: 'CONTENT_NOT_FOUND',
  FILE_NOT_FOUND: 'SOURCE_FILE_NOT_FOUND',
  HASH_FORMAT_INVALID: 'HASH_FORMAT_INVALID',
} as const;

export type VerifierErrorCodeType = typeof VerifierErrorCode[keyof typeof VerifierErrorCode];

/**
 * VerifierError - Typed error for verification operations
 * FAIL FAST: Always throw with detailed error information
 */
export class VerifierError extends Error {
  constructor(
    message: string,
    public readonly code: VerifierErrorCodeType,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VerifierError';
    Object.setPrototypeOf(this, VerifierError.prototype);
  }
}

/** Result of single item verification */
export interface ItemVerificationResult {
  valid: boolean;
  item_id: string;
  item_type: ProvenanceType;
  expected_hash: string;
  computed_hash: string;
  format_valid: boolean;
  verified_at: string;
}

/** Result of chain verification */
export interface ChainVerificationResult extends VerificationResult {
  start_id: string;
  chain_depth: number;
  root_document_id: string;
  chain_length: number;
}

/** Result of database-wide verification */
export interface DatabaseVerificationResult extends VerificationResult {
  database_name: string;
  documents_verified: number;
  ocr_results_verified: number;
  chunks_verified: number;
  embeddings_verified: number;
  images_verified: number;
  vlm_descriptions_verified: number;
  duration_ms: number;
}

/**
 * ProvenanceVerifier - Hash integrity and chain verification
 *
 * Provides verification for:
 * 1. Single provenance record content hash
 * 2. Complete provenance chain integrity
 * 3. Database-wide verification
 * 4. Source file integrity
 */
export class ProvenanceVerifier {
  private readonly rawDb: Database.Database;

  constructor(
    private readonly db: DatabaseService,
    private readonly tracker: ProvenanceTracker
  ) {
    this.rawDb = db.getConnection();
  }

  /**
   * Verify content hash for a single provenance record
   *
   * @param provenanceId - Provenance record ID to verify
   * @returns Verification result with computed and expected hashes
   * @throws VerifierError if provenance not found, content not found, or file not accessible
   */
  async verifyContentHash(provenanceId: string): Promise<ItemVerificationResult> {
    // Get provenance record - throws if not found
    const record = this.tracker.getProvenanceById(provenanceId);

    // Get content and expected hash based on type
    const { content, expectedHash, isFile } = this.getContentForVerification(record);

    // Validate expected hash format
    const formatValid = isValidHashFormat(expectedHash);

    // Compute hash of content
    let computedHash: string;
    if (isFile && typeof content === 'string') {
      // For files, content is the file path - hash the file
      computedHash = await hashFile(content);
    } else {
      // For text content, compute hash directly
      computedHash = computeHash(content);
    }

    const valid = formatValid && computedHash === expectedHash;

    return {
      valid,
      item_id: provenanceId,
      item_type: record.type,
      expected_hash: expectedHash,
      computed_hash: computedHash,
      format_valid: formatValid,
      verified_at: new Date().toISOString(),
    };
  }

  /**
   * Verify complete provenance chain from item to root
   *
   * @param provenanceId - Starting provenance record ID
   * @returns Chain verification result with all failing items
   * @throws VerifierError if chain broken or item not found
   */
  async verifyChain(provenanceId: string): Promise<ChainVerificationResult> {
    // Get chain using tracker - throws if not found
    const chain = this.tracker.getProvenanceChain(provenanceId);

    const failedItems: Array<{
      id: string;
      expected_hash: string;
      computed_hash: string;
      type: ProvenanceType;
    }> = [];

    let hashesVerified = 0;
    let hashesFailed = 0;

    // Verify each record in the chain: current + ancestors
    const allRecords = [chain.current, ...chain.ancestors];

    for (const record of allRecords) {
      try {
        const result = await this.verifyContentHash(record.id);
        if (result.valid) {
          hashesVerified++;
        } else {
          hashesFailed++;
          failedItems.push({
            id: record.id,
            expected_hash: result.expected_hash,
            computed_hash: result.computed_hash,
            type: record.type,
          });
        }
      } catch (error) {
        // Content not found or file not accessible - count as failure
        hashesFailed++;
        failedItems.push({
          id: record.id,
          expected_hash: record.content_hash,
          computed_hash: 'ERROR: ' + (error instanceof Error ? error.message : 'Unknown error'),
          type: record.type,
        });
      }
    }

    const valid = hashesFailed === 0 && chain.isComplete;

    return {
      valid,
      chain_intact: chain.isComplete,
      hashes_verified: hashesVerified,
      hashes_failed: hashesFailed,
      failed_items: failedItems,
      verified_at: new Date().toISOString(),
      start_id: provenanceId,
      chain_depth: chain.depth,
      root_document_id: chain.root.root_document_id,
      chain_length: allRecords.length,
    };
  }

  /**
   * Verify all provenance records in database
   *
   * @returns Database verification result with counts by type
   */
  async verifyDatabase(): Promise<DatabaseVerificationResult> {
    const startTime = Date.now();

    const allProvenance = this.getAllProvenance();

    const failedItems: Array<{
      id: string;
      expected_hash: string;
      computed_hash: string;
      type: ProvenanceType;
    }> = [];

    let hashesVerified = 0;
    let hashesFailed = 0;
    let documentsVerified = 0;
    let ocrResultsVerified = 0;
    let chunksVerified = 0;
    let embeddingsVerified = 0;
    let imagesVerified = 0;
    let vlmDescriptionsVerified = 0;

    for (const record of allProvenance) {
      try {
        const result = await this.verifyContentHash(record.id);

        // Count by type
        switch (record.type) {
          case ProvenanceType.DOCUMENT:
            documentsVerified++;
            break;
          case ProvenanceType.OCR_RESULT:
            ocrResultsVerified++;
            break;
          case ProvenanceType.CHUNK:
            chunksVerified++;
            break;
          case ProvenanceType.EMBEDDING:
            embeddingsVerified++;
            break;
          case ProvenanceType.IMAGE:
            imagesVerified++;
            break;
          case ProvenanceType.VLM_DESCRIPTION:
            vlmDescriptionsVerified++;
            break;
        }

        if (result.valid) {
          hashesVerified++;
        } else {
          hashesFailed++;
          failedItems.push({
            id: record.id,
            expected_hash: result.expected_hash,
            computed_hash: result.computed_hash,
            type: record.type,
          });
        }
      } catch (error) {
        hashesFailed++;
        failedItems.push({
          id: record.id,
          expected_hash: record.content_hash,
          computed_hash: 'ERROR: ' + (error instanceof Error ? error.message : 'Unknown error'),
          type: record.type,
        });
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      valid: hashesFailed === 0,
      chain_intact: true, // Database verification doesn't check chain integrity
      hashes_verified: hashesVerified,
      hashes_failed: hashesFailed,
      failed_items: failedItems,
      verified_at: new Date().toISOString(),
      database_name: this.getDatabaseName(),
      documents_verified: documentsVerified,
      ocr_results_verified: ocrResultsVerified,
      chunks_verified: chunksVerified,
      embeddings_verified: embeddingsVerified,
      images_verified: imagesVerified,
      vlm_descriptions_verified: vlmDescriptionsVerified,
      duration_ms: durationMs,
    };
  }

  /**
   * Verify source file still matches stored hash
   *
   * @param documentId - Document ID to verify
   * @returns Verification result for the file
   * @throws VerifierError if document not found or file not accessible
   */
  async verifyFileIntegrity(documentId: string): Promise<ItemVerificationResult> {
    // Get document
    const doc = this.db.getDocument(documentId);
    if (!doc) {
      throw new VerifierError(
        `Document not found: ${documentId}`,
        VerifierErrorCode.NOT_FOUND,
        { documentId }
      );
    }

    // Check file exists
    if (!fs.existsSync(doc.file_path)) {
      throw new VerifierError(
        `Source file not found: ${doc.file_path}`,
        VerifierErrorCode.FILE_NOT_FOUND,
        { documentId, filePath: doc.file_path }
      );
    }

    // Hash the file
    const computedHash = await hashFile(doc.file_path);
    const expectedHash = doc.file_hash;
    const formatValid = isValidHashFormat(expectedHash);
    const valid = formatValid && computedHash === expectedHash;

    return {
      valid,
      item_id: documentId,
      item_type: ProvenanceType.DOCUMENT,
      expected_hash: expectedHash,
      computed_hash: computedHash,
      format_valid: formatValid,
      verified_at: new Date().toISOString(),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // PRIVATE HELPER METHODS
  // ════════════════════════════════════════════════════════════════

  /**
   * Get content and expected hash for a provenance record
   * Returns { content, expectedHash, isFile } or throws if content not found
   *
   * CRITICAL MAPPING:
   * - DOCUMENT: file_path → file_hash (via hashFile)
   * - OCR_RESULT: extracted_text → content_hash
   * - CHUNK: text → text_hash
   * - EMBEDDING: original_text → content_hash
   */
  private getContentForVerification(
    record: ProvenanceRecord
  ): { content: string | Buffer; expectedHash: string; isFile: boolean } {
    switch (record.type) {
      case ProvenanceType.DOCUMENT: {
        // For DOCUMENT, we verify the file on disk using file_hash
        // Query document by provenance_id since record.id IS the document's provenance_id
        const doc = this.getDocumentByProvenanceId(record.id);
        if (!doc) {
          throw new VerifierError(
            `Document not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }

        // Check file exists
        if (!fs.existsSync(doc.file_path)) {
          throw new VerifierError(
            `Source file not found: ${doc.file_path}`,
            VerifierErrorCode.FILE_NOT_FOUND,
            { provenanceId: record.id, filePath: doc.file_path }
          );
        }

        // Return file path - caller will hash the file
        return { content: doc.file_path, expectedHash: doc.file_hash, isFile: true };
      }

      case ProvenanceType.OCR_RESULT: {
        const ocr = this.getOCRResultByProvenanceId(record.id);
        if (!ocr) {
          throw new VerifierError(
            `OCR result not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }
        return { content: ocr.extracted_text, expectedHash: ocr.content_hash, isFile: false };
      }

      case ProvenanceType.CHUNK: {
        const chunk = this.getChunkByProvenanceId(record.id);
        if (!chunk) {
          throw new VerifierError(
            `Chunk not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }
        // CRITICAL: CHUNK uses text_hash, not content_hash
        return { content: chunk.text, expectedHash: chunk.text_hash, isFile: false };
      }

      case ProvenanceType.EMBEDDING: {
        const emb = this.getEmbeddingByProvenanceId(record.id);
        if (!emb) {
          throw new VerifierError(
            `Embedding not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }
        return { content: emb.original_text, expectedHash: emb.content_hash, isFile: false };
      }

      case ProvenanceType.IMAGE: {
        // IMAGE verification: hash the extracted image file
        const image = this.getImageByProvenanceId(record.id);
        if (!image) {
          throw new VerifierError(
            `Image not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }

        // Check extracted file exists
        if (!image.extracted_path || !fs.existsSync(image.extracted_path)) {
          throw new VerifierError(
            `Extracted image file not found: ${image.extracted_path}`,
            VerifierErrorCode.FILE_NOT_FOUND,
            { provenanceId: record.id, imagePath: image.extracted_path }
          );
        }

        // Return file path - caller will hash the file
        return { content: image.extracted_path, expectedHash: record.content_hash, isFile: true };
      }

      case ProvenanceType.VLM_DESCRIPTION: {
        // VLM_DESCRIPTION verification: hash the VLM description text
        // The description is stored in images.vlm_description, but we need to find it
        // via the provenance chain - the parent should be an IMAGE

        // Get the parent IMAGE to find the VLM description
        if (!record.parent_id) {
          throw new VerifierError(
            `VLM_DESCRIPTION has no parent_id: ${record.id}`,
            VerifierErrorCode.CHAIN_BROKEN,
            { provenanceId: record.id }
          );
        }

        const image = this.getImageByProvenanceId(record.parent_id);
        if (!image) {
          throw new VerifierError(
            `Parent image not found for VLM_DESCRIPTION ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, parentId: record.parent_id }
          );
        }

        if (!image.vlm_description) {
          throw new VerifierError(
            `VLM description is empty for image ${image.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, imageId: image.id }
          );
        }

        return { content: image.vlm_description, expectedHash: record.content_hash, isFile: false };
      }

      default: {
        const unknownType: never = record.type;
        throw new VerifierError(
          `Unknown provenance type: ${unknownType as string}`,
          VerifierErrorCode.INVALID_TYPE,
          { type: unknownType as string }
        );
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // RAW SQL HELPERS (methods not in DatabaseService)
  // ════════════════════════════════════════════════════════════════

  /**
   * Get document by its provenance_id
   */
  private getDocumentByProvenanceId(provenanceId: string): Document | null {
    const row = this.rawDb.prepare(
      'SELECT * FROM documents WHERE provenance_id = ?'
    ).get(provenanceId) as import('../storage/database/types.js').DocumentRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      file_hash: row.file_hash,
      file_size: row.file_size,
      file_type: row.file_type,
      status: row.status as import('../../models/document.js').DocumentStatus,
      page_count: row.page_count,
      provenance_id: row.provenance_id,
      created_at: row.created_at,
      modified_at: row.modified_at,
      ocr_completed_at: row.ocr_completed_at,
      error_message: row.error_message,
    };
  }

  /**
   * Get OCR result by its provenance_id
   */
  private getOCRResultByProvenanceId(provenanceId: string): OCRResult | null {
    const row = this.rawDb.prepare(
      'SELECT * FROM ocr_results WHERE provenance_id = ?'
    ).get(provenanceId) as OCRResultRow | undefined;
    return row ? rowToOCRResult(row) : null;
  }

  /**
   * Get chunk by its provenance_id
   */
  private getChunkByProvenanceId(provenanceId: string): Chunk | null {
    const row = this.rawDb.prepare(
      'SELECT * FROM chunks WHERE provenance_id = ?'
    ).get(provenanceId) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  /**
   * Get embedding by its provenance_id (without vector)
   */
  private getEmbeddingByProvenanceId(provenanceId: string): Omit<Embedding, 'vector'> | null {
    const row = this.rawDb.prepare(
      'SELECT * FROM embeddings WHERE provenance_id = ?'
    ).get(provenanceId) as EmbeddingRow | undefined;
    return row ? rowToEmbedding(row) : null;
  }

  /**
   * Get image by its provenance_id
   */
  private getImageByProvenanceId(provenanceId: string): ImageReference | null {
    const row = this.rawDb.prepare(
      'SELECT * FROM images WHERE provenance_id = ?'
    ).get(provenanceId) as ImageRow | undefined;
    return row ? rowToImage(row) : null;
  }

  /**
   * Get all provenance records ordered by chain_depth
   */
  private getAllProvenance(): ProvenanceRecord[] {
    const rows = this.rawDb.prepare(
      'SELECT * FROM provenance ORDER BY chain_depth ASC'
    ).all() as ProvenanceRow[];
    return rows.map(row => rowToProvenance(row));
  }

  /**
   * Get database name from metadata
   */
  private getDatabaseName(): string {
    try {
      const row = this.rawDb.prepare(
        'SELECT database_name FROM database_metadata LIMIT 1'
      ).get() as { database_name: string } | undefined;
      return row?.database_name ?? 'unknown';
    } catch {
      // database_metadata table may not exist
      return 'unknown';
    }
  }
}

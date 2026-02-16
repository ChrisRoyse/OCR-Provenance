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
import { ProvenanceRecord, ProvenanceType, VerificationResult } from '../../models/provenance.js';
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

type VerifierErrorCodeType = (typeof VerifierErrorCode)[keyof typeof VerifierErrorCode];

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
interface ItemVerificationResult {
  valid: boolean;
  item_id: string;
  item_type: ProvenanceType;
  expected_hash: string;
  computed_hash: string;
  format_valid: boolean;
  verified_at: string;
}

/** Result of chain verification */
interface ChainVerificationResult extends VerificationResult {
  start_id: string;
  chain_depth: number;
  root_document_id: string;
  chain_length: number;
}

/** Result of database-wide verification */
interface DatabaseVerificationResult extends VerificationResult {
  database_name: string;
  documents_verified: number;
  ocr_results_verified: number;
  chunks_verified: number;
  embeddings_verified: number;
  images_verified: number;
  vlm_descriptions_verified: number;
  duration_ms: number;
  /** Number of failed items beyond the MAX_FAILED_ITEMS cap (H-6) */
  failed_overflow: number;
  /** Chain integrity errors (missing parents, depth mismatches) */
  chain_errors?: string[];
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

    // H-6: Cap failedItems to prevent unbounded memory growth
    const MAX_FAILED_ITEMS = 1000;
    const failedItems: Array<{
      id: string;
      expected_hash: string;
      computed_hash: string;
      type: ProvenanceType;
    }> = [];
    let failedOverflow = 0;

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
          if (failedItems.length < MAX_FAILED_ITEMS) {
            failedItems.push({
              id: record.id,
              expected_hash: result.expected_hash,
              computed_hash: result.computed_hash,
              type: record.type,
            });
          } else {
            failedOverflow++;
          }
        }
      } catch (error) {
        hashesFailed++;
        if (failedItems.length < MAX_FAILED_ITEMS) {
          failedItems.push({
            id: record.id,
            expected_hash: record.content_hash,
            computed_hash: 'ERROR: ' + (error instanceof Error ? error.message : 'Unknown error'),
            type: record.type,
          });
        } else {
          failedOverflow++;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Chain integrity check: verify all parent_id references exist and depths are correct
    let chainIntact = true;
    const chainErrors: string[] = [];

    const parentedRecords = this.rawDb
      .prepare(
        `SELECT id, parent_id, type, chain_depth FROM provenance WHERE parent_id IS NOT NULL`
      )
      .all() as Array<{ id: string; parent_id: string; type: string; chain_depth: number }>;

    for (const record of parentedRecords) {
      const parent = this.rawDb
        .prepare('SELECT id, chain_depth FROM provenance WHERE id = ?')
        .get(record.parent_id) as { id: string; chain_depth: number } | undefined;

      if (!parent) {
        chainIntact = false;
        if (chainErrors.length < 10) {
          chainErrors.push(`${record.id} (${record.type}): parent ${record.parent_id} not found`);
        }
      } else if (parent.chain_depth !== record.chain_depth - 1) {
        chainIntact = false;
        if (chainErrors.length < 10) {
          chainErrors.push(
            `${record.id} (${record.type}): depth ${record.chain_depth} but parent depth ${parent.chain_depth} (expected ${record.chain_depth - 1})`
          );
        }
      }
    }

    return {
      valid: hashesFailed === 0 && chainIntact,
      chain_intact: chainIntact,
      chain_errors: chainErrors.length > 0 ? chainErrors : undefined,
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
      failed_overflow: failedOverflow,
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
      throw new VerifierError(`Document not found: ${documentId}`, VerifierErrorCode.NOT_FOUND, {
        documentId,
      });
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
  private getContentForVerification(record: ProvenanceRecord): {
    content: string | Buffer;
    expectedHash: string;
    isFile: boolean;
  } {
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

      case ProvenanceType.COMPARISON: {
        const comparison = this.rawDb
          .prepare(
            'SELECT text_diff_json, structural_diff_json, entity_diff_json FROM comparisons WHERE provenance_id = ?'
          )
          .get(record.id) as
          | { text_diff_json: string; structural_diff_json: string; entity_diff_json: string }
          | undefined;

        if (!comparison) {
          throw new VerifierError(
            `Comparison not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id }
          );
        }

        const parseDiffField = (json: string, field: string): unknown => {
          try {
            return JSON.parse(json);
          } catch (error) {
            console.error(
              `[ProvenanceVerifier] Failed to parse ${field} JSON for provenance ${record.id}:`,
              error instanceof Error ? error.message : String(error)
            );
            throw new VerifierError(
              `Corrupt ${field} in comparison for provenance ${record.id}`,
              VerifierErrorCode.CONTENT_NOT_FOUND,
              { provenanceId: record.id, field }
            );
          }
        };

        const diffContent = JSON.stringify({
          text_diff: parseDiffField(comparison.text_diff_json, 'text_diff_json'),
          structural_diff: parseDiffField(comparison.structural_diff_json, 'structural_diff_json'),
          entity_diff: parseDiffField(comparison.entity_diff_json, 'entity_diff_json'),
        });

        return { content: diffContent, expectedHash: record.content_hash, isFile: false };
      }

      case ProvenanceType.EXTRACTION: {
        // EXTRACTION: content_hash = computeHash(JSON.stringify(extractionJson))
        // Re-derive: Load extraction record and hash its extraction_json field
        const extraction = this.rawDb
          .prepare('SELECT extraction_json FROM extractions WHERE provenance_id = ?')
          .get(record.id) as { extraction_json: string } | undefined;

        if (!extraction) {
          throw new VerifierError(
            `Extraction not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }

        // The hash was computed over JSON.stringify(response.extractionJson) which was
        // stored as extraction_json. Re-hash the stored string directly.
        return {
          content: extraction.extraction_json,
          expectedHash: record.content_hash,
          isFile: false,
        };
      }

      case ProvenanceType.FORM_FILL: {
        // FORM_FILL: content_hash = computeHash(JSON.stringify({ fields_filled, fields_not_found }))
        // Re-derive: Load from form_fills table, reconstruct the same object
        const formFill = this.rawDb
          .prepare('SELECT fields_filled, fields_not_found FROM form_fills WHERE provenance_id = ?')
          .get(record.id) as { fields_filled: string; fields_not_found: string } | undefined;

        if (!formFill) {
          throw new VerifierError(
            `Form fill not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }

        // Reconstruct the exact object that was hashed: { fields_filled, fields_not_found }
        // The original code hashes: computeHash(JSON.stringify({ fields_filled: result.fieldsFilled, fields_not_found: result.fieldsNotFound }))
        // form_fills stores these as JSON strings, so parse them back to arrays
        const formFillContent = JSON.stringify({
          fields_filled: JSON.parse(formFill.fields_filled),
          fields_not_found: JSON.parse(formFill.fields_not_found),
        });

        return { content: formFillContent, expectedHash: record.content_hash, isFile: false };
      }

      case ProvenanceType.ENTITY_EXTRACTION: {
        // ENTITY_EXTRACTION has 3 creation paths:
        // 1. Gemini extraction: computeHash(JSON.stringify([...dedupMap.values()]))
        //    processor = 'gemini-entity-extraction'
        // 2. VLM extraction: computeHash(JSON.stringify({ document_id, source: 'vlm' }))
        //    processor = 'vlm-entity-extraction'
        // 3. Extraction mapper: computeHash(JSON.stringify({ document_id, source: 'extraction' }))
        //    processor = 'extraction-entity-mapper'

        const processingParams = record.processing_params
          ? typeof record.processing_params === 'string'
            ? JSON.parse(record.processing_params)
            : record.processing_params
          : {};

        if (processingParams.source === 'vlm' || processingParams.source === 'extraction') {
          // VLM and extraction entity extraction hash a simple metadata object
          // Find the document_id from entities linked to this provenance
          const entityRow = this.rawDb
            .prepare('SELECT document_id FROM entities WHERE provenance_id = ? LIMIT 1')
            .get(record.id) as { document_id: string } | undefined;

          if (!entityRow) {
            throw new VerifierError(
              `No entities found for entity_extraction provenance ${record.id}`,
              VerifierErrorCode.CONTENT_NOT_FOUND,
              { provenanceId: record.id, type: record.type }
            );
          }

          const entityContent = JSON.stringify({
            document_id: entityRow.document_id,
            source: processingParams.source,
          });
          return { content: entityContent, expectedHash: record.content_hash, isFile: false };
        }

        // Gemini entity extraction: hash was computed over the deduped entity array
        // Re-derive by loading entities for this provenance_id, ordered the same way
        const entities = this.rawDb
          .prepare(
            'SELECT raw_text, entity_type, confidence FROM entities WHERE provenance_id = ? ORDER BY entity_type, normalized_text'
          )
          .all(record.id) as Array<{ raw_text: string; entity_type: string; confidence: number }>;

        if (entities.length === 0) {
          throw new VerifierError(
            `No entities found for entity_extraction provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }

        // The original hash was: computeHash(JSON.stringify([...dedupMap.values()]))
        // where dedupMap values were { type, raw_text, confidence }
        const entityContent = JSON.stringify(
          entities.map((e) => ({
            type: e.entity_type,
            raw_text: e.raw_text,
            confidence: e.confidence,
          }))
        );
        return { content: entityContent, expectedHash: record.content_hash, isFile: false };
      }

      case ProvenanceType.CLUSTERING: {
        // CLUSTERING: content_hash = computeHash(JSON.stringify(centroid) + ':' + runId)
        // Re-derive: Load cluster record and reconstruct the same input
        const cluster = this.rawDb
          .prepare('SELECT centroid_json, run_id FROM clusters WHERE provenance_id = ?')
          .get(record.id) as { centroid_json: string; run_id: string } | undefined;

        if (!cluster) {
          throw new VerifierError(
            `Cluster not found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type }
          );
        }

        // The original hash: computeHash(JSON.stringify(centroid) + ':' + runId)
        // centroid_json is already JSON.stringify(centroid), so use it directly
        const clusterContent = cluster.centroid_json + ':' + cluster.run_id;
        return { content: clusterContent, expectedHash: record.content_hash, isFile: false };
      }

      case ProvenanceType.KNOWLEDGE_GRAPH: {
        // KNOWLEDGE_GRAPH has two creation paths:
        // 1. Build provenance: computeHash(JSON.stringify(sortedEntityIds))
        //    processor = 'knowledge-graph-builder'
        // 2. Per-node provenance: computeHash(JSON.stringify({ node_id, canonical_name }))
        //    processor = 'entity-resolution'

        const processor = record.processor ?? '';

        if (processor === 'entity-resolution') {
          // Per-node provenance: hash was computed over { node_id, canonical_name }
          const kgNode = this.rawDb
            .prepare('SELECT id, canonical_name FROM knowledge_nodes WHERE provenance_id = ?')
            .get(record.id) as { id: string; canonical_name: string } | undefined;

          if (!kgNode) {
            // Node provenance references may also be stored differently: the node's
            // provenance_id is the build-level provenance, while per-node provenance
            // records are separate. Search by processing_params.node_id.
            const params = record.processing_params
              ? typeof record.processing_params === 'string'
                ? JSON.parse(record.processing_params)
                : record.processing_params
              : {};

            if (params.node_id) {
              const nodeRow = this.rawDb
                .prepare('SELECT id, canonical_name FROM knowledge_nodes WHERE id = ?')
                .get(params.node_id) as { id: string; canonical_name: string } | undefined;

              if (nodeRow) {
                const nodeContent = JSON.stringify({
                  node_id: nodeRow.id,
                  canonical_name: nodeRow.canonical_name,
                });
                return { content: nodeContent, expectedHash: record.content_hash, isFile: false };
              }
            }

            throw new VerifierError(
              `Knowledge node not found for provenance ${record.id}`,
              VerifierErrorCode.CONTENT_NOT_FOUND,
              { provenanceId: record.id, type: record.type }
            );
          }

          const nodeContent = JSON.stringify({
            node_id: kgNode.id,
            canonical_name: kgNode.canonical_name,
          });
          return { content: nodeContent, expectedHash: record.content_hash, isFile: false };
        }

        // Build-level provenance: hash was computed over sorted entity IDs
        // Re-derive: collect all entity IDs from the documents that were part of this build
        const processingParams = record.processing_params
          ? typeof record.processing_params === 'string'
            ? JSON.parse(record.processing_params)
            : record.processing_params
          : {};

        // Get all nodes created with this provenance_id to find which entities were included
        // The nodes' entity links point to the entities that were resolved
        const linkedEntityIds = this.rawDb
          .prepare(
            `
          SELECT nel.entity_id FROM node_entity_links nel
          JOIN knowledge_nodes kn ON nel.node_id = kn.id
          WHERE kn.provenance_id = ?
          ORDER BY nel.entity_id
        `
          )
          .all(record.id) as Array<{ entity_id: string }>;

        if (linkedEntityIds.length === 0) {
          throw new VerifierError(
            `No knowledge graph data found for provenance ${record.id}`,
            VerifierErrorCode.CONTENT_NOT_FOUND,
            { provenanceId: record.id, type: record.type, processingParams }
          );
        }

        // The original hash: computeHash(JSON.stringify(sortedEntityIds))
        const sortedIds = linkedEntityIds.map((r) => r.entity_id).sort();
        const kgContent = JSON.stringify(sortedIds);
        return { content: kgContent, expectedHash: record.content_hash, isFile: false };
      }

      case ProvenanceType.CORPUS_INTELLIGENCE: {
        // Corpus intelligence provenance: the content_hash was computed over the synthesis output
        // Re-derive by reading the corpus_intelligence or document_narratives or entity_roles row
        const ciRow = this.rawDb
          .prepare('SELECT corpus_summary, key_actors, themes FROM corpus_intelligence WHERE provenance_id = ?')
          .get(record.id) as { corpus_summary: string; key_actors: string; themes: string } | undefined;

        if (ciRow) {
          const ciContent = JSON.stringify({ corpus_summary: ciRow.corpus_summary, key_actors: ciRow.key_actors, themes: ciRow.themes });
          return { content: ciContent, expectedHash: record.content_hash, isFile: false };
        }

        const dnRow = this.rawDb
          .prepare('SELECT narrative_text, entity_roster FROM document_narratives WHERE provenance_id = ?')
          .get(record.id) as { narrative_text: string; entity_roster: string } | undefined;

        if (dnRow) {
          const dnContent = JSON.stringify({ narrative_text: dnRow.narrative_text, entity_roster: dnRow.entity_roster });
          return { content: dnContent, expectedHash: record.content_hash, isFile: false };
        }

        const erRow = this.rawDb
          .prepare('SELECT node_id, role, scope FROM entity_roles WHERE provenance_id = ?')
          .get(record.id) as { node_id: string; role: string; scope: string } | undefined;

        if (erRow) {
          const erContent = JSON.stringify({ node_id: erRow.node_id, role: erRow.role, scope: erRow.scope });
          return { content: erContent, expectedHash: record.content_hash, isFile: false };
        }

        throw new VerifierError(
          `No corpus intelligence data found for provenance ${record.id}`,
          VerifierErrorCode.CONTENT_NOT_FOUND,
          { provenanceId: record.id, type: record.type }
        );
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
    const row = this.rawDb
      .prepare('SELECT * FROM documents WHERE provenance_id = ?')
      .get(provenanceId) as import('../storage/database/types.js').DocumentRow | undefined;
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
      doc_title: row.doc_title ?? null,
      doc_author: row.doc_author ?? null,
      doc_subject: row.doc_subject ?? null,
    };
  }

  /**
   * Get OCR result by its provenance_id
   */
  private getOCRResultByProvenanceId(provenanceId: string): OCRResult | null {
    const row = this.rawDb
      .prepare('SELECT * FROM ocr_results WHERE provenance_id = ?')
      .get(provenanceId) as OCRResultRow | undefined;
    return row ? rowToOCRResult(row) : null;
  }

  /**
   * Get chunk by its provenance_id
   */
  private getChunkByProvenanceId(provenanceId: string): Chunk | null {
    const row = this.rawDb
      .prepare('SELECT * FROM chunks WHERE provenance_id = ?')
      .get(provenanceId) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  /**
   * Get embedding by its provenance_id (without vector)
   */
  private getEmbeddingByProvenanceId(provenanceId: string): Omit<Embedding, 'vector'> | null {
    const row = this.rawDb
      .prepare('SELECT * FROM embeddings WHERE provenance_id = ?')
      .get(provenanceId) as EmbeddingRow | undefined;
    return row ? rowToEmbedding(row) : null;
  }

  /**
   * Get image by its provenance_id
   */
  private getImageByProvenanceId(provenanceId: string): ImageReference | null {
    const row = this.rawDb
      .prepare('SELECT * FROM images WHERE provenance_id = ?')
      .get(provenanceId) as ImageRow | undefined;
    return row ? rowToImage(row) : null;
  }

  /**
   * Get all provenance records ordered by chain_depth
   */
  private getAllProvenance(): ProvenanceRecord[] {
    // H-6: Use iterate() to avoid double-allocation (.all() + .map())
    const records: ProvenanceRecord[] = [];
    const stmt = this.rawDb.prepare('SELECT * FROM provenance ORDER BY chain_depth ASC');
    for (const row of stmt.iterate() as Iterable<ProvenanceRow>) {
      records.push(rowToProvenance(row));
    }
    return records;
  }

  /**
   * Get database name from metadata
   */
  private getDatabaseName(): string {
    try {
      const row = this.rawDb
        .prepare('SELECT database_name FROM database_metadata LIMIT 1')
        .get() as { database_name: string } | undefined;
      return row?.database_name ?? 'unknown';
    } catch (error) {
      console.error(`[Verifier] Failed to get database name from metadata: ${String(error)}`);
      return 'unknown';
    }
  }
}

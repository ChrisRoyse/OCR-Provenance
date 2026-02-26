/**
 * OCR Processing Orchestrator
 *
 * Complete pipeline: Document -> OCR -> Provenance -> Store -> Status Update
 * FAIL-FAST: No fallbacks, errors propagate immediately
 */

import { v4 as uuidv4 } from 'uuid';
import { DatalabClient, type DatalabClientConfig } from './datalab.js';
import { OCRError, OCRRateLimitError } from './errors.js';
import { backoffSleep } from '../../utils/backoff.js';
import { DatabaseService } from '../storage/database/index.js';
import type { Document, OCRResult, PageOffset } from '../../models/document.js';
import { ProvenanceType, type ProvenanceRecord } from '../../models/provenance.js';

interface ProcessorConfig extends DatalabClientConfig {
  maxConcurrent?: number;
  defaultMode?: 'fast' | 'balanced' | 'accurate';
}

export interface ProcessResult {
  success: boolean;
  documentId: string;
  ocrResultId?: string;
  provenanceId?: string;
  pageCount?: number;
  textLength?: number;
  durationMs?: number;
  error?: string;
  /** Images extracted by Datalab: {filename: base64_data} */
  images?: Record<string, string>;
  /** JSON block hierarchy from Datalab (when output_format includes 'json') */
  jsonBlocks?: Record<string, unknown> | null;
  /** Datalab metadata (page_stats, block_counts, etc.) */
  metadata?: Record<string, unknown> | null;
  /** Page character offsets from Datalab for page-aware chunking */
  pageOffsets?: PageOffset[];
  /** Structured extraction result from page_schema */
  extractionJson?: Record<string, unknown> | unknown[] | null;
  /** Document title from metadata */
  docTitle?: string | null;
  /** Document author from metadata */
  docAuthor?: string | null;
  /** Document subject from metadata */
  docSubject?: string | null;
}

export interface BatchResult {
  processed: number;
  failed: number;
  remaining: number;
  totalDurationMs: number;
  results: ProcessResult[];
}

/**
 * SDK version for provenance - hardcoded since we can't easily get it at runtime
 * Update this when datalab-sdk version changes
 */
const DATALAB_SDK_VERSION = '1.0.0';

/**
 * Default Datalab extras requested when none are explicitly provided.
 * extract_links and table_row_bboxes are always useful for document intelligence.
 * track_changes is NOT included by default since it is only relevant for
 * DOCX files with revision tracking enabled.
 */
const DEFAULT_EXTRAS: readonly string[] = ['extract_links', 'table_row_bboxes'];

function parseMaxConcurrent(): number {
  const raw = process.env.DATALAB_MAX_CONCURRENT ?? '3';
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric env var DATALAB_MAX_CONCURRENT: "${raw}"`);
  }
  return parsed;
}

export class OCRProcessor {
  private readonly client: DatalabClient;
  private readonly db: DatabaseService;
  private readonly maxConcurrent: number;
  private readonly defaultMode: 'fast' | 'balanced' | 'accurate';

  constructor(db: DatabaseService, config: ProcessorConfig = {}) {
    this.db = db;
    this.client = new DatalabClient(config);
    this.maxConcurrent = config.maxConcurrent ?? parseMaxConcurrent();
    this.defaultMode = config.defaultMode ?? 'balanced';
  }

  /**
   * Process single document through OCR
   *
   * Pipeline:
   * 1. Get document from database (FAIL if not found)
   * 2. Update status to 'processing'
   * 3. Call Datalab OCR via Python worker
   * 4. Create OCR_RESULT provenance record
   * 5. Store OCR result in database
   * 6. Update document status to 'complete'
   *
   * On failure: Update status to 'failed' with error message
   */
  async processDocument(
    documentId: string,
    mode?: 'fast' | 'balanced' | 'accurate',
    ocrOptions?: {
      maxPages?: number;
      pageRange?: string;
      skipCache?: boolean;
      disableImageExtraction?: boolean;
      extras?: string[];
      pageSchema?: string;
      additionalConfig?: Record<string, unknown>;
    }
  ): Promise<ProcessResult> {
    const ocrMode = mode ?? this.defaultMode;
    const startTime = Date.now();

    // 1. Get document (FAIL-FAST: throw if not found)
    const document = this.db.getDocument(documentId);
    if (!document) {
      throw new OCRError(`Document not found: ${documentId}`, 'OCR_FILE_ERROR');
    }

    // 2. Update status to 'processing'
    this.db.updateDocumentStatus(documentId, 'processing');

    try {
      // 3. Generate provenance ID and call OCR (with 1 retry on timeout)
      const ocrProvenanceId = uuidv4();
      let ocrResult: OCRResult;
      let images: Record<string, string>;
      let jsonBlocks: Record<string, unknown> | null = null;
      let metadata: Record<string, unknown> | null = null;
      let pageOffsets: PageOffset[] = [];
      let extractionJson: Record<string, unknown> | unknown[] | null = null;
      let docTitle: string | null = null;
      let docAuthor: string | null = null;
      let docSubject: string | null = null;

      // Apply default extras when none explicitly provided
      const effectiveOptions = ocrOptions
        ? { ...ocrOptions, extras: ocrOptions.extras ?? [...DEFAULT_EXTRAS] }
        : { extras: [...DEFAULT_EXTRAS] };

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await this.client.processDocument(
            document.file_path,
            documentId,
            ocrProvenanceId,
            ocrMode,
            effectiveOptions
          );
          ocrResult = response.result;
          images = response.images;
          jsonBlocks = response.jsonBlocks;
          metadata = response.metadata;
          pageOffsets = response.pageOffsets;
          extractionJson = response.extractionJson;
          docTitle = response.docTitle;
          docAuthor = response.docAuthor;
          docSubject = response.docSubject;
          break;
        } catch (error) {
          if (attempt === 1 && error instanceof OCRError && error.category === 'OCR_TIMEOUT') {
            console.error(`[WARN] OCR timeout on attempt 1 for ${documentId}, retrying...`);
            continue;
          }
          if (attempt === 1 && error instanceof OCRError && error.category === 'OCR_RATE_LIMIT') {
            const retryAfter = (error as OCRRateLimitError).retryAfter;
            if (retryAfter !== undefined && retryAfter > 0) {
              console.error(
                `[WARN] OCR rate limited on attempt 1 for ${documentId}, server says wait ${retryAfter}s`
              );
              await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            } else {
              console.error(
                `[WARN] OCR rate limited on attempt 1 for ${documentId}, using exponential backoff`
              );
              await backoffSleep(0);
            }
            continue;
          }
          throw error;
        }
      }

      // TypeScript: guaranteed assigned after loop or thrown
      ocrResult = ocrResult!;
      images = images!;

      // 4. Create OCR_RESULT provenance record
      const provenance = this.createOCRProvenance(ocrProvenanceId, document, ocrResult, ocrMode);
      this.db.insertProvenance(provenance);

      // 5. Store OCR result
      this.db.insertOCRResult(ocrResult);

      // 6. Update document status
      this.db.updateDocumentOCRComplete(
        documentId,
        ocrResult.page_count,
        ocrResult.processing_completed_at
      );

      // Capture image count for logging
      const imageCount = Object.keys(images).length;
      if (imageCount > 0) {
        console.error(`[INFO] Captured ${imageCount} images from Datalab`);
      }

      return {
        success: true,
        documentId,
        ocrResultId: ocrResult.id,
        provenanceId: ocrProvenanceId,
        pageCount: ocrResult.page_count,
        textLength: ocrResult.text_length,
        durationMs: Date.now() - startTime,
        images: imageCount > 0 ? images : undefined,
        jsonBlocks,
        metadata,
        pageOffsets: pageOffsets.length > 0 ? pageOffsets : undefined,
        extractionJson: extractionJson ?? undefined,
        docTitle: docTitle ?? undefined,
        docAuthor: docAuthor ?? undefined,
        docSubject: docSubject ?? undefined,
      };
    } catch (error) {
      // Update status to 'failed' and re-throw (FAIL-FAST: callers must handle)
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.db.updateDocumentStatus(documentId, 'failed', errorMsg);

      // Re-throw as OCRError if not already one
      if (error instanceof OCRError) {
        throw error;
      }
      throw new OCRError(`OCR processing failed for ${documentId}: ${errorMsg}`, 'OCR_API_ERROR');
    }
  }

  /**
   * Process all pending documents.
   *
   * H-2 fix: Before processing, recover any documents stuck in 'processing'
   * status for longer than 30 minutes (indicates a prior server crash).
   * These are reset to 'pending' so they get re-processed.
   */
  async processPending(mode?: 'fast' | 'balanced' | 'accurate'): Promise<BatchResult> {
    const startTime = Date.now();
    const ocrMode = mode ?? this.defaultMode;

    // H-2: Recover stale 'processing' documents (crashed mid-OCR)
    this.recoverStaleProcessingDocuments();

    const pending = this.db.listDocuments({ status: 'pending' });
    if (pending.length === 0) {
      return {
        processed: 0,
        failed: 0,
        remaining: 0,
        totalDurationMs: 0,
        results: [],
      };
    }

    const results: ProcessResult[] = [];

    // Process in batches for concurrency control
    for (let i = 0; i < pending.length; i += this.maxConcurrent) {
      const batch = pending.slice(i, i + this.maxConcurrent);
      const batchResults = await Promise.all(
        batch.map(async (doc) => {
          try {
            return await this.processDocument(doc.id, ocrMode);
          } catch (error) {
            // processDocument already marks doc as 'failed' before throwing
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
              success: false,
              documentId: doc.id,
              error: errorMsg,
              durationMs: 0,
            } as ProcessResult;
          }
        })
      );
      results.push(...batchResults);
    }

    const processed = results.filter((r) => r.success).length;
    const failed = results.length - processed;

    const remaining = this.db.listDocuments({ status: 'pending' }).length;

    return {
      processed,
      failed,
      remaining,
      totalDurationMs: Date.now() - startTime,
      results,
    };
  }

  /**
   * H-2: Recover documents stuck in 'processing' status after a server crash.
   * Any document that has been 'processing' for longer than 30 minutes is
   * assumed to be orphaned from a crash and is reset to 'pending'.
   */
  private recoverStaleProcessingDocuments(): void {
    const conn = this.db.getConnection();
    const staleRows = conn
      .prepare(
        `SELECT id FROM documents WHERE status = 'processing'
         AND modified_at < datetime('now', '-30 minutes')`
      )
      .all() as Array<{ id: string }>;

    for (const row of staleRows) {
      console.error(
        `[WARN] Recovering stale 'processing' document ${row.id} (stuck >30min, likely server crash). Resetting to 'pending'.`
      );
      this.db.updateDocumentStatus(row.id, 'pending');
    }

    if (staleRows.length > 0) {
      console.error(
        `[INFO] Recovered ${staleRows.length} stale 'processing' document(s) to 'pending' status.`
      );
    }
  }

  /**
   * Create OCR_RESULT provenance record
   */
  private createOCRProvenance(
    id: string,
    document: Document,
    ocrResult: OCRResult,
    mode: 'fast' | 'balanced' | 'accurate'
  ): ProvenanceRecord {
    const now = new Date().toISOString();

    return {
      id,
      type: ProvenanceType.OCR_RESULT,
      created_at: now,
      processed_at: ocrResult.processing_completed_at,
      source_file_created_at: null,
      source_file_modified_at: document.modified_at,
      source_type: 'OCR',
      source_path: document.file_path,
      source_id: document.provenance_id,
      root_document_id: document.provenance_id,
      location: null,
      content_hash: ocrResult.content_hash,
      input_hash: document.file_hash,
      file_hash: document.file_hash,
      processor: 'datalab-ocr',
      processor_version: DATALAB_SDK_VERSION,
      processing_params: {
        mode,
        output_format: 'markdown,json',
        request_id: ocrResult.datalab_request_id,
        paginate: true,
      },
      processing_duration_ms: ocrResult.processing_duration_ms,
      processing_quality_score: ocrResult.parse_quality_score,
      parent_id: document.provenance_id,
      parent_ids: JSON.stringify([document.provenance_id]),
      chain_depth: 1,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT']),
    };
  }
}

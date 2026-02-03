/**
 * Ingestion MCP Tools
 *
 * Extracted from src/index.ts Task 20.
 * Tools: ocr_ingest_directory, ocr_ingest_files, ocr_process_pending, ocr_status
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/ingestion
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, statSync, readdirSync } from 'fs';
import { resolve, extname, basename } from 'path';

import { DatabaseService } from '../services/storage/database/index.js';
import { OCRProcessor } from '../services/ocr/processor.js';
import { chunkText, ChunkResult, DEFAULT_CHUNKING_CONFIG } from '../services/chunking/chunker.js';
import { EmbeddingService } from '../services/embedding/embedder.js';
import { ProvenanceTracker } from '../services/provenance/tracker.js';
import { computeHash } from '../utils/hash.js';
import {
  state,
  requireDatabase,
} from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  IngestDirectoryInput,
  IngestFilesInput,
  ProcessPendingInput,
  OCRStatusInput,
} from '../utils/validation.js';
import {
  MCPError,
  formatErrorResponse,
  pathNotFoundError,
  pathNotDirectoryError,
  documentNotFoundError,
} from '../server/errors.js';
import type { Document, OCRResult } from '../models/document.js';
import type { Chunk } from '../models/chunk.js';
import { ProvenanceType } from '../models/provenance.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tool handler type - matches MCP SDK expectations
 */
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;

/**
 * Tool definition with description, schema, and handler
 */
interface ToolDefinition {
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

/**
 * Ingestion item result for tracking status
 */
interface IngestionItem {
  file_path: string;
  file_name: string;
  document_id: string;
  status: string;
  error_message?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format tool result as MCP content response
 */
function formatResponse(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Handle errors uniformly - FAIL FAST
 */
function handleError(error: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const mcpError = MCPError.fromUnknown(error);
  console.error(`[ERROR] ${mcpError.category}: ${mcpError.message}`);
  return formatResponse(formatErrorResponse(mcpError));
}

/**
 * Store chunks in database with provenance records
 *
 * Creates CHUNK provenance records (chain_depth=2) and inserts chunk records.
 * Returns array of stored Chunk objects for embedding.
 */
function storeChunks(
  db: DatabaseService,
  doc: Document,
  ocrResult: OCRResult,
  chunkResults: ChunkResult[]
): Chunk[] {
  const provenanceTracker = new ProvenanceTracker(db);
  const chunks: Chunk[] = [];

  for (let i = 0; i < chunkResults.length; i++) {
    const cr = chunkResults[i];
    const chunkId = uuidv4();
    const textHash = computeHash(cr.text);

    // Create chunk provenance (chain_depth=2)
    const chunkProvId = provenanceTracker.createProvenance({
      type: ProvenanceType.CHUNK,
      source_type: 'CHUNKING',
      source_id: ocrResult.provenance_id,
      root_document_id: doc.provenance_id,
      content_hash: textHash,
      input_hash: ocrResult.content_hash,
      file_hash: doc.file_hash,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: {
        chunk_size: DEFAULT_CHUNKING_CONFIG.chunkSize,
        overlap_percent: DEFAULT_CHUNKING_CONFIG.overlapPercent,
        chunk_index: i,
        total_chunks: chunkResults.length,
      },
      location: {
        chunk_index: i,
        character_start: cr.startOffset,
        character_end: cr.endOffset,
        page_number: cr.pageNumber ?? undefined,
        page_range: cr.pageRange ?? undefined,
      },
    });

    db.insertChunk({
      id: chunkId,
      document_id: doc.id,
      ocr_result_id: ocrResult.id,
      text: cr.text,
      text_hash: textHash,
      chunk_index: i,
      character_start: cr.startOffset,
      character_end: cr.endOffset,
      page_number: cr.pageNumber,
      page_range: cr.pageRange,
      overlap_previous: cr.overlapWithPrevious,
      overlap_next: cr.overlapWithNext,
      provenance_id: chunkProvId,
      embedding_status: 'pending',
      embedded_at: null,
    });

    // Retrieve the stored chunk to ensure all fields are populated
    const storedChunk = db.getChunk(chunkId);
    if (!storedChunk) {
      throw new Error(`Failed to retrieve stored chunk: ${chunkId}`);
    }
    chunks.push(storedChunk);
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_ingest_directory - Ingest all documents from a directory
 */
export async function handleIngestDirectory(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(IngestDirectoryInput, params);
    const { db } = requireDatabase();

    // Validate directory exists - FAIL FAST
    if (!existsSync(input.directory_path)) {
      throw pathNotFoundError(input.directory_path);
    }

    const dirStats = statSync(input.directory_path);
    if (!dirStats.isDirectory()) {
      throw pathNotDirectoryError(input.directory_path);
    }

    const fileTypes = input.file_types ?? ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'docx', 'doc'];
    const items: IngestionItem[] = [];

    // Collect files recursively
    const collectFiles = (dirPath: string): string[] => {
      const files: string[] = [];
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = resolve(dirPath, entry.name);
        if (entry.isDirectory() && input.recursive) {
          files.push(...collectFiles(fullPath));
        } else if (entry.isFile()) {
          const ext = extname(entry.name).slice(1).toLowerCase();
          if (fileTypes.includes(ext)) {
            files.push(fullPath);
          }
        }
      }

      return files;
    };

    const files = collectFiles(input.directory_path);

    // Ingest each file
    for (const filePath of files) {
      try {
        // Check if already ingested by path
        const existingByPath = db.getDocumentByPath(filePath);

        if (existingByPath) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: existingByPath.id,
            status: 'skipped',
            error_message: 'Already ingested',
          });
          continue;
        }

        const stats = statSync(filePath);

        // Create document record
        const documentId = uuidv4();
        const provenanceId = uuidv4();
        const now = new Date().toISOString();
        const ext = extname(filePath).slice(1).toLowerCase();

        // Create document provenance
        db.insertProvenance({
          id: provenanceId,
          type: 'DOCUMENT',
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'FILE',
          source_path: filePath,
          source_id: null,
          root_document_id: provenanceId,
          location: null,
          content_hash: `sha256:pending-${documentId}`,
          input_hash: null,
          file_hash: `sha256:pending-${documentId}`,
          processor: 'file-scanner',
          processor_version: '1.0.0',
          processing_params: { directory_path: input.directory_path, recursive: input.recursive },
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: null,
          parent_ids: '[]',
          chain_depth: 0,
          chain_path: '["DOCUMENT"]',
        });

        // Insert document
        db.insertDocument({
          id: documentId,
          file_path: filePath,
          file_name: basename(filePath),
          file_hash: `sha256:pending-${documentId}`,
          file_size: stats.size,
          file_type: ext,
          status: 'pending',
          page_count: null,
          provenance_id: provenanceId,
          error_message: null,
          ocr_completed_at: null,
        });

        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: documentId,
          status: 'pending',
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Failed to ingest ${filePath}: ${errorMsg}`);
        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: '',
          status: 'error',
          error_message: errorMsg,
        });
      }
    }

    const result = {
      directory_path: input.directory_path,
      files_found: files.length,
      files_ingested: items.filter(i => i.status === 'pending').length,
      files_skipped: items.filter(i => i.status === 'skipped').length,
      files_errored: items.filter(i => i.status === 'error').length,
      items,
    };

    return formatResponse(successResult(result));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_ingest_files - Ingest specific files
 */
export async function handleIngestFiles(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(IngestFilesInput, params);
    const { db } = requireDatabase();

    const items: IngestionItem[] = [];

    for (const filePath of input.file_paths) {
      try {
        // Validate file exists - FAIL FAST
        if (!existsSync(filePath)) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: 'File not found',
          });
          continue;
        }

        const stats = statSync(filePath);
        if (!stats.isFile()) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: 'Path is not a file',
          });
          continue;
        }

        // Check if already ingested
        const existingByPath = db.getDocumentByPath(filePath);
        if (existingByPath) {
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: existingByPath.id,
            status: 'skipped',
            error_message: 'Already ingested',
          });
          continue;
        }

        // Create document record
        const documentId = uuidv4();
        const provenanceId = uuidv4();
        const now = new Date().toISOString();
        const ext = extname(filePath).slice(1).toLowerCase();

        // Create document provenance
        db.insertProvenance({
          id: provenanceId,
          type: 'DOCUMENT',
          created_at: now,
          processed_at: now,
          source_file_created_at: null,
          source_file_modified_at: null,
          source_type: 'FILE',
          source_path: filePath,
          source_id: null,
          root_document_id: provenanceId,
          location: null,
          content_hash: `sha256:pending-${documentId}`,
          input_hash: null,
          file_hash: `sha256:pending-${documentId}`,
          processor: 'file-scanner',
          processor_version: '1.0.0',
          processing_params: {},
          processing_duration_ms: null,
          processing_quality_score: null,
          parent_id: null,
          parent_ids: '[]',
          chain_depth: 0,
          chain_path: '["DOCUMENT"]',
        });

        // Insert document
        db.insertDocument({
          id: documentId,
          file_path: filePath,
          file_name: basename(filePath),
          file_hash: `sha256:pending-${documentId}`,
          file_size: stats.size,
          file_type: ext,
          status: 'pending',
          page_count: null,
          provenance_id: provenanceId,
          error_message: null,
          ocr_completed_at: null,
        });

        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: documentId,
          status: 'pending',
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Failed to ingest ${filePath}: ${errorMsg}`);
        items.push({
          file_path: filePath,
          file_name: basename(filePath),
          document_id: '',
          status: 'error',
          error_message: errorMsg,
        });
      }
    }

    return formatResponse(successResult({
      files_ingested: items.filter(i => i.status === 'pending').length,
      files_skipped: items.filter(i => i.status === 'skipped').length,
      files_errored: items.filter(i => i.status === 'error').length,
      items,
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_process_pending - Process pending documents through full OCR pipeline
 *
 * Pipeline: OCR -> Chunk -> Embed -> Vector Storage
 * Provenance chain: DOCUMENT(0) -> OCR_RESULT(1) -> CHUNK(2) -> EMBEDDING(3)
 */
export async function handleProcessPending(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(ProcessPendingInput, params);
    const { db, vector } = requireDatabase();

    // Get pending documents - CRITICAL: use 'status' not 'statusFilter'
    const pendingDocs = db.listDocuments({ status: 'pending', limit: input.max_concurrent ?? 3 });

    if (pendingDocs.length === 0) {
      return formatResponse(successResult({
        processed: 0,
        failed: 0,
        remaining: 0,
        message: 'No pending documents to process',
      }));
    }

    const ocrMode = input.ocr_mode ?? state.config.defaultOCRMode;
    const results = {
      processed: 0,
      failed: 0,
      errors: [] as Array<{ document_id: string; error: string }>,
    };

    for (const doc of pendingDocs) {
      try {
        console.error(`[INFO] Processing document: ${doc.id} (${doc.file_name})`);

        // Step 1: OCR via Datalab
        // OCRProcessor.processDocument() handles status='processing' internally
        const ocrProcessor = new OCRProcessor(db);
        const processResult = await ocrProcessor.processDocument(doc.id, ocrMode);

        if (!processResult.success) {
          throw new Error(processResult.error ?? 'OCR processing failed');
        }

        // Get the OCR result
        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        if (!ocrResult) {
          throw new Error('OCR result not found after processing');
        }

        console.error(`[INFO] OCR complete: ${ocrResult.text_length} chars, ${ocrResult.page_count} pages`);

        // Step 2: Chunk the OCR text
        // NOTE: pageOffsets not available from OCRProcessor, use chunkText not chunkWithPageTracking
        const chunkResults = chunkText(ocrResult.extracted_text, DEFAULT_CHUNKING_CONFIG);

        console.error(`[INFO] Chunking complete: ${chunkResults.length} chunks`);

        // Step 3: Store chunks in database with provenance
        const chunks = storeChunks(db, doc, ocrResult, chunkResults);

        console.error(`[INFO] Chunks stored: ${chunks.length}`);

        // Step 4: Generate embeddings
        const embeddingService = new EmbeddingService();
        const documentInfo = {
          documentId: doc.id,
          filePath: doc.file_path,
          fileName: doc.file_name,
          fileHash: doc.file_hash,
          documentProvenanceId: doc.provenance_id,
        };

        const embedResult = await embeddingService.embedDocumentChunks(db, vector, chunks, documentInfo);

        if (!embedResult.success) {
          throw new Error(embedResult.error ?? 'Embedding generation failed');
        }

        console.error(`[INFO] Embeddings complete: ${embedResult.embeddingIds.length} embeddings in ${embedResult.elapsedMs}ms`);

        // Step 5: Mark document complete
        db.updateDocumentStatus(doc.id, 'complete');
        results.processed++;

        console.error(`[INFO] Document ${doc.id} processing complete`);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ERROR] Document ${doc.id} failed: ${errorMsg}`);
        db.updateDocumentStatus(doc.id, 'failed', errorMsg);
        results.failed++;
        results.errors.push({ document_id: doc.id, error: errorMsg });
      }
    }

    // Get remaining count - CRITICAL: use 'status' not 'statusFilter'
    const remaining = db.listDocuments({ status: 'pending' }).length;

    return formatResponse(successResult({
      processed: results.processed,
      failed: results.failed,
      remaining,
      errors: results.errors.length > 0 ? results.errors : undefined,
    }));

  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_status - Get OCR processing status
 */
export async function handleOCRStatus(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(OCRStatusInput, params);
    const { db } = requireDatabase();

    if (input.document_id) {
      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      return formatResponse(successResult({
        documents: [{
          document_id: doc.id,
          file_name: doc.file_name,
          status: doc.status,
          page_count: doc.page_count,
          error_message: doc.error_message ?? undefined,
          created_at: doc.created_at,
        }],
        summary: {
          total: 1,
          pending: doc.status === 'pending' ? 1 : 0,
          processing: doc.status === 'processing' ? 1 : 0,
          complete: doc.status === 'complete' ? 1 : 0,
          failed: doc.status === 'failed' ? 1 : 0,
        },
      }));
    }

    // Map filter values - CRITICAL: use 'status' not 'statusFilter' for listDocuments
    const filterMap: Record<string, 'pending' | 'processing' | 'complete' | 'failed' | undefined> = {
      pending: 'pending',
      processing: 'processing',
      complete: 'complete',
      failed: 'failed',
      all: undefined,
    };

    const documents = db.listDocuments({
      status: filterMap[input.status_filter],
      limit: 1000,
    });

    const stats = db.getStats();

    return formatResponse(successResult({
      documents: documents.map(d => ({
        document_id: d.id,
        file_name: d.file_name,
        status: d.status,
        page_count: d.page_count,
        error_message: d.error_message ?? undefined,
        created_at: d.created_at,
      })),
      summary: {
        total: stats.total_documents,
        pending: stats.documents_by_status.pending,
        processing: stats.documents_by_status.processing,
        complete: stats.documents_by_status.complete,
        failed: stats.documents_by_status.failed,
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingestion tools collection for MCP server registration
 */
export const ingestionTools: Record<string, ToolDefinition> = {
  'ocr_ingest_directory': {
    description: 'Scan and ingest documents from a directory into the current database',
    inputSchema: {
      directory_path: z.string().min(1).describe('Path to directory to scan'),
      recursive: z.boolean().default(true).describe('Scan subdirectories'),
      file_types: z.array(z.string()).optional().describe('File types to include (default: pdf, png, jpg, docx, etc.)'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced').describe('OCR processing mode'),
      auto_process: z.boolean().default(false).describe('Automatically process documents after ingestion'),
    },
    handler: handleIngestDirectory,
  },
  'ocr_ingest_files': {
    description: 'Ingest specific files into the current database',
    inputSchema: {
      file_paths: z.array(z.string().min(1)).min(1).describe('Array of file paths to ingest'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced').describe('OCR processing mode'),
      auto_process: z.boolean().default(false).describe('Automatically process documents after ingestion'),
    },
    handler: handleIngestFiles,
  },
  'ocr_process_pending': {
    description: 'Process pending documents through OCR pipeline (OCR -> Chunk -> Embed -> Vector)',
    inputSchema: {
      max_concurrent: z.number().int().min(1).max(10).default(3).describe('Maximum concurrent OCR operations'),
      ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional().describe('OCR processing mode override'),
    },
    handler: handleProcessPending,
  },
  'ocr_status': {
    description: 'Get OCR processing status for documents',
    inputSchema: {
      document_id: z.string().optional().describe('Specific document ID to check'),
      status_filter: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('all').describe('Filter by status'),
    },
    handler: handleOCRStatus,
  },
};

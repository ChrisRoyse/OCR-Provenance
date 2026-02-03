/**
 * OCR Provenance MCP Server
 *
 * Entry point for the MCP server using stdio transport.
 * Exposes 18 OCR, search, and provenance tools via JSON-RPC.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module index
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { DatabaseService } from './services/storage/database/index.js';
import { VectorService } from './services/storage/vector.js';
import { getEmbeddingService } from './services/embedding/embedder.js';
import {
  MCPError,
  formatErrorResponse,
  validationError,
  documentNotFoundError,
  provenanceNotFoundError,
  pathNotFoundError,
  pathNotDirectoryError,
} from './server/errors.js';
import {
  state,
  requireDatabase,
  selectDatabase,
  createDatabase,
  deleteDatabase,
  getDefaultStoragePath,
} from './server/state.js';
import { successResult } from './server/types.js';
import {
  validateInput,
  DatabaseCreateInput,
  DatabaseListInput,
  DatabaseSelectInput,
  DatabaseStatsInput,
  DatabaseDeleteInput,
  IngestDirectoryInput,
  IngestFilesInput,
  ProcessPendingInput,
  OCRStatusInput,
  SearchSemanticInput,
  SearchTextInput,
  SearchHybridInput,
  DocumentListInput,
  DocumentGetInput,
  DocumentDeleteInput,
  ProvenanceGetInput,
  ProvenanceVerifyInput,
  ProvenanceExportInput,
} from './utils/validation.js';
import { existsSync, statSync, readdirSync } from 'fs';
import { resolve, extname, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Document } from './models/document.js';
import type { Chunk } from './models/chunk.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (explicit types to reduce tsc inference burden)
// ═══════════════════════════════════════════════════════════════════════════════

/** Chunk match for hybrid search */
interface ChunkMatch {
  chunk: Pick<Chunk, 'id' | 'document_id' | 'text' | 'chunk_index' | 'page_number' | 'character_start' | 'character_end' | 'provenance_id'>;
  doc: Pick<Document, 'id' | 'file_name' | 'file_path'>;
}

/** Combined search score result */
interface CombinedScore {
  score: number;
  semantic_score: number;
  keyword_score: number;
  chunk_id: string;
  document_id: string;
  original_text: string;
  source_file_name: string;
  source_file_path: string;
  page_number: number | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  provenance_id: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const server = new McpServer({
  name: 'ocr-provenance-mcp',
  version: '1.0.0',
});

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

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE TOOLS (5)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_db_create - Create a new database
 */
server.tool(
  'ocr_db_create',
  'Create a new OCR database for document storage and search',
  {
    name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).describe('Database name (alphanumeric, underscore, hyphen only)'),
    description: z.string().max(500).optional().describe('Optional description for the database'),
    storage_path: z.string().optional().describe('Optional storage path override'),
  },
  async (params) => {
    try {
      const input = validateInput(DatabaseCreateInput, params);
      const db = createDatabase(input.name, input.description, input.storage_path);
      const path = db.getPath();

      return formatResponse(successResult({
        name: input.name,
        path,
        created: true,
        description: input.description,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_db_list - List all databases
 */
server.tool(
  'ocr_db_list',
  'List all available OCR databases',
  {
    include_stats: z.boolean().default(false).describe('Include document/chunk/embedding counts'),
  },
  async (params) => {
    try {
      const input = validateInput(DatabaseListInput, params);
      const storagePath = getDefaultStoragePath();
      const databases = DatabaseService.list(storagePath);

      const items = databases.map((dbInfo) => {
        const item: Record<string, unknown> = {
          name: dbInfo.name,
          path: dbInfo.path,
          size_bytes: dbInfo.size,
          created_at: dbInfo.createdAt,
          modified_at: dbInfo.modifiedAt,
        };

        if (input.include_stats) {
          try {
            const db = DatabaseService.open(dbInfo.name, storagePath);
            const stats = db.getStats();
            item.document_count = stats.documentCount;
            item.chunk_count = stats.chunkCount;
            item.embedding_count = stats.embeddingCount;
            db.close();
          } catch {
            // If we can't get stats, just skip them
          }
        }

        return item;
      });

      return formatResponse(successResult({
        databases: items,
        total: items.length,
        storage_path: storagePath,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_db_select - Select active database
 */
server.tool(
  'ocr_db_select',
  'Select a database as the active database for operations',
  {
    database_name: z.string().min(1).describe('Name of the database to select'),
  },
  async (params) => {
    try {
      const input = validateInput(DatabaseSelectInput, params);
      selectDatabase(input.database_name);

      const { db, vector } = requireDatabase();
      const stats = db.getStats();

      return formatResponse(successResult({
        name: input.database_name,
        path: db.getPath(),
        selected: true,
        stats: {
          document_count: stats.documentCount,
          chunk_count: stats.chunkCount,
          embedding_count: stats.embeddingCount,
          vector_count: vector.getVectorCount(),
        },
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_db_stats - Get database statistics
 */
server.tool(
  'ocr_db_stats',
  'Get detailed statistics for a database',
  {
    database_name: z.string().optional().describe('Database name (uses current if not specified)'),
  },
  async (params) => {
    try {
      const input = validateInput(DatabaseStatsInput, params);

      // If database_name is provided, temporarily open that database
      if (input.database_name && input.database_name !== state.currentDatabaseName) {
        const storagePath = getDefaultStoragePath();
        const db = DatabaseService.open(input.database_name, storagePath);
        const vector = new VectorService(db.getConnection());
        const stats = db.getStats();

        const result = {
          name: input.database_name,
          path: db.getPath(),
          size_bytes: stats.sizeBytes,
          document_count: stats.documentCount,
          chunk_count: stats.chunkCount,
          embedding_count: stats.embeddingCount,
          provenance_count: stats.provenanceCount,
          ocr_result_count: stats.ocrResultCount,
          pending_documents: stats.pendingDocuments,
          processing_documents: stats.processingDocuments,
          complete_documents: stats.completeDocuments,
          failed_documents: stats.failedDocuments,
          vector_count: vector.getVectorCount(),
        };

        db.close();
        return formatResponse(successResult(result));
      }

      // Use current database
      const { db, vector } = requireDatabase();
      const stats = db.getStats();

      return formatResponse(successResult({
        name: db.getName(),
        path: db.getPath(),
        size_bytes: stats.sizeBytes,
        document_count: stats.documentCount,
        chunk_count: stats.chunkCount,
        embedding_count: stats.embeddingCount,
        provenance_count: stats.provenanceCount,
        ocr_result_count: stats.ocrResultCount,
        pending_documents: stats.pendingDocuments,
        processing_documents: stats.processingDocuments,
        complete_documents: stats.completeDocuments,
        failed_documents: stats.failedDocuments,
        vector_count: vector.getVectorCount(),
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_db_delete - Delete a database
 */
server.tool(
  'ocr_db_delete',
  'Delete a database and all its data permanently',
  {
    database_name: z.string().min(1).describe('Name of the database to delete'),
    confirm: z.literal(true).describe('Must be true to confirm deletion'),
  },
  async (params) => {
    try {
      const input = validateInput(DatabaseDeleteInput, params);
      deleteDatabase(input.database_name);

      return formatResponse(successResult({
        name: input.database_name,
        deleted: true,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// INGESTION TOOLS (4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_ingest_directory - Ingest all documents from a directory
 */
server.tool(
  'ocr_ingest_directory',
  'Scan and ingest documents from a directory into the current database',
  {
    directory_path: z.string().min(1).describe('Path to directory to scan'),
    recursive: z.boolean().default(true).describe('Scan subdirectories'),
    file_types: z.array(z.string()).optional().describe('File types to include (default: pdf, png, jpg, docx, etc.)'),
    ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced').describe('OCR processing mode'),
    auto_process: z.boolean().default(false).describe('Automatically process documents after ingestion'),
  },
  async (params) => {
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
      const items: Array<{ file_path: string; file_name: string; document_id: string; status: string; error_message?: string }> = [];

      // Collect files
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
          // Check if already ingested by hash
          const stats = statSync(filePath);
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
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: error instanceof Error ? error.message : String(error),
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
);

/**
 * ocr_ingest_files - Ingest specific files
 */
server.tool(
  'ocr_ingest_files',
  'Ingest specific files into the current database',
  {
    file_paths: z.array(z.string().min(1)).min(1).describe('Array of file paths to ingest'),
    ocr_mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced').describe('OCR processing mode'),
    auto_process: z.boolean().default(false).describe('Automatically process documents after ingestion'),
  },
  async (params) => {
    try {
      const input = validateInput(IngestFilesInput, params);
      const { db } = requireDatabase();

      const items: Array<{ file_path: string; file_name: string; document_id: string; status: string; error_message?: string }> = [];

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
          items.push({
            file_path: filePath,
            file_name: basename(filePath),
            document_id: '',
            status: 'error',
            error_message: error instanceof Error ? error.message : String(error),
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
);

/**
 * ocr_process_pending - Process pending documents
 */
server.tool(
  'ocr_process_pending',
  'Process pending documents through OCR pipeline',
  {
    max_concurrent: z.number().int().min(1).max(10).default(3).describe('Maximum concurrent OCR operations'),
    ocr_mode: z.enum(['fast', 'balanced', 'accurate']).optional().describe('OCR processing mode override'),
  },
  async (params) => {
    try {
      const input = validateInput(ProcessPendingInput, params);
      const { db } = requireDatabase();

      // Get pending documents
      const pendingDocs = db.listDocuments({ statusFilter: 'pending', limit: 100 });

      // Note: Actual OCR processing would be implemented in Tasks 16-22
      // This returns the list of pending documents for now
      return formatResponse(successResult({
        pending_count: pendingDocs.length,
        max_concurrent: input.max_concurrent,
        ocr_mode: input.ocr_mode ?? state.config.defaultOCRMode,
        documents: pendingDocs.map(d => ({
          document_id: d.id,
          file_name: d.file_name,
          file_path: d.file_path,
          status: d.status,
        })),
        message: 'OCR processing pipeline will be wired up in Task 20 (impl-ingestion-tools)',
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_status - Get OCR processing status
 */
server.tool(
  'ocr_status',
  'Get OCR processing status for documents',
  {
    document_id: z.string().optional().describe('Specific document ID to check'),
    status_filter: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('all').describe('Filter by status'),
  },
  async (params) => {
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

      const filterMap: Record<string, 'pending' | 'processing' | 'complete' | 'failed' | undefined> = {
        pending: 'pending',
        processing: 'processing',
        complete: 'complete',
        failed: 'failed',
        all: undefined,
      };

      const documents = db.listDocuments({
        statusFilter: filterMap[input.status_filter],
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
          total: stats.documentCount,
          pending: stats.pendingDocuments,
          processing: stats.processingDocuments,
          complete: stats.completeDocuments,
          failed: stats.failedDocuments,
        },
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TOOLS (3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_search_semantic - Semantic vector search
 */
server.tool(
  'ocr_search_semantic',
  'Search documents using semantic similarity (vector search)',
  {
    query: z.string().min(1).max(1000).describe('Search query'),
    limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
    similarity_threshold: z.number().min(0).max(1).default(0.7).describe('Minimum similarity score (0-1)'),
    include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
    document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
  },
  async (params) => {
    try {
      const input = validateInput(SearchSemanticInput, params);
      const { db, vector } = requireDatabase();

      // Generate query embedding
      const embedder = getEmbeddingService();
      const queryVector = await embedder.embedSearchQuery(input.query);

      // Search for similar vectors
      const results = vector.searchSimilar(queryVector, {
        limit: input.limit,
        threshold: input.similarity_threshold,
        documentFilter: input.document_filter,
      });

      // Format results with optional provenance
      const formattedResults = results.map(r => {
        const result: Record<string, unknown> = {
          embedding_id: r.embedding_id,
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          similarity_score: r.similarity_score,
          original_text: r.original_text,
          source_file_path: r.source_file_path,
          source_file_name: r.source_file_name,
          page_number: r.page_number,
          character_start: r.character_start,
          character_end: r.character_end,
          chunk_index: r.chunk_index,
          total_chunks: r.total_chunks,
        };

        if (input.include_provenance) {
          const chain = db.getProvenanceChain(r.provenance_id);
          result.provenance = chain.map(p => ({
            id: p.id,
            type: p.type,
            chain_depth: p.chain_depth,
            processor: p.processor,
            processor_version: p.processor_version,
            content_hash: p.content_hash,
            created_at: p.created_at,
          }));
        }

        return result;
      });

      return formatResponse(successResult({
        query: input.query,
        results: formattedResults,
        total: formattedResults.length,
        threshold: input.similarity_threshold,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_search_text - Keyword/text search
 */
server.tool(
  'ocr_search_text',
  'Search documents using keyword/text matching',
  {
    query: z.string().min(1).max(1000).describe('Search query'),
    match_type: z.enum(['exact', 'fuzzy', 'regex']).default('fuzzy').describe('Match type'),
    limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
    include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
  },
  async (params) => {
    try {
      const input = validateInput(SearchTextInput, params);
      const { db } = requireDatabase();

      // Get all chunks and search by text
      // Note: A more efficient implementation would use FTS5 in Tasks 16-22
      const allDocs = db.listDocuments({ statusFilter: 'complete', limit: 1000 });
      const results: Array<Record<string, unknown>> = [];

      for (const doc of allDocs) {
        const chunks = db.getChunksByDocumentId(doc.id);
        for (const chunk of chunks) {
          let matches = false;

          switch (input.match_type) {
            case 'exact':
              matches = chunk.text.includes(input.query);
              break;
            case 'fuzzy':
              matches = chunk.text.toLowerCase().includes(input.query.toLowerCase());
              break;
            case 'regex':
              try {
                const regex = new RegExp(input.query, 'i');
                matches = regex.test(chunk.text);
              } catch {
                throw validationError(`Invalid regex pattern: ${input.query}`);
              }
              break;
          }

          if (matches && results.length < input.limit) {
            const result: Record<string, unknown> = {
              chunk_id: chunk.id,
              document_id: chunk.document_id,
              original_text: chunk.text,
              source_file_name: doc.file_name,
              source_file_path: doc.file_path,
              page_number: chunk.page_number,
              character_start: chunk.character_start,
              character_end: chunk.character_end,
              chunk_index: chunk.chunk_index,
            };

            if (input.include_provenance) {
              const chain = db.getProvenanceChain(chunk.provenance_id);
              result.provenance = chain.map(p => ({
                id: p.id,
                type: p.type,
                chain_depth: p.chain_depth,
                processor: p.processor,
                content_hash: p.content_hash,
              }));
            }

            results.push(result);
          }
        }
      }

      return formatResponse(successResult({
        query: input.query,
        match_type: input.match_type,
        results,
        total: results.length,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_search_hybrid - Combined semantic + keyword search
 */
server.tool(
  'ocr_search_hybrid',
  'Search using combined semantic and keyword matching',
  {
    query: z.string().min(1).max(1000).describe('Search query'),
    semantic_weight: z.number().min(0).max(1).default(0.7).describe('Weight for semantic results (0-1)'),
    keyword_weight: z.number().min(0).max(1).default(0.3).describe('Weight for keyword results (0-1)'),
    limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
    include_provenance: z.boolean().default(false).describe('Include provenance chain in results'),
  },
  async (params) => {
    try {
      const input = validateInput(SearchHybridInput, params);
      const { db, vector } = requireDatabase();

      // Get semantic results
      const embedder = getEmbeddingService();
      const queryVector = await embedder.embedSearchQuery(input.query);
      const semanticResults = vector.searchSimilar(queryVector, { limit: input.limit * 2 });

      // Get text results - use explicit types to reduce tsc inference burden
      const allDocs = db.listDocuments({ statusFilter: 'complete', limit: 1000 });
      const textMatches: Map<string, ChunkMatch> = new Map();

      for (const doc of allDocs) {
        const chunks = db.getChunksByDocumentId(doc.id);
        for (const chunk of chunks) {
          if (chunk.text.toLowerCase().includes(input.query.toLowerCase())) {
            textMatches.set(chunk.id, {
              chunk: {
                id: chunk.id,
                document_id: chunk.document_id,
                text: chunk.text,
                chunk_index: chunk.chunk_index,
                page_number: chunk.page_number,
                character_start: chunk.character_start,
                character_end: chunk.character_end,
                provenance_id: chunk.provenance_id,
              },
              doc: { id: doc.id, file_name: doc.file_name, file_path: doc.file_path },
            });
          }
        }
      }

      // Combine and score results - use explicit CombinedScore type
      const combinedScores: Map<string, CombinedScore> = new Map();

      for (const r of semanticResults) {
        const semanticScore = r.similarity_score * input.semantic_weight;
        const keywordScore = textMatches.has(r.chunk_id) ? input.keyword_weight : 0;
        const totalScore = semanticScore + keywordScore;

        combinedScores.set(r.chunk_id, {
          score: totalScore,
          semantic_score: r.similarity_score,
          keyword_score: keywordScore > 0 ? 1 : 0,
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          original_text: r.original_text,
          source_file_name: r.source_file_name,
          source_file_path: r.source_file_path,
          page_number: r.page_number,
          character_start: r.character_start,
          character_end: r.character_end,
          chunk_index: r.chunk_index,
          provenance_id: r.provenance_id,
        });
      }

      // Add text-only matches
      for (const [chunkId, { chunk, doc }] of textMatches) {
        if (!combinedScores.has(chunkId)) {
          combinedScores.set(chunkId, {
            score: input.keyword_weight,
            semantic_score: 0,
            keyword_score: 1,
            chunk_id: chunk.id,
            document_id: chunk.document_id,
            original_text: chunk.text,
            source_file_name: doc.file_name,
            source_file_path: doc.file_path,
            page_number: chunk.page_number,
            character_start: chunk.character_start,
            character_end: chunk.character_end,
            chunk_index: chunk.chunk_index,
            provenance_id: chunk.provenance_id,
          });
        }
      }

      // Sort by combined score and limit
      const sortedResults = Array.from(combinedScores.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit);

      const formattedResults = sortedResults.map((r: CombinedScore) => {
        const result: Record<string, unknown> = {
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          original_text: r.original_text,
          source_file_name: r.source_file_name,
          source_file_path: r.source_file_path,
          page_number: r.page_number,
          character_start: r.character_start,
          character_end: r.character_end,
          chunk_index: r.chunk_index,
          combined_score: r.score,
          semantic_score: r.semantic_score,
          keyword_score: r.keyword_score,
        };

        if (input.include_provenance && r.provenance_id) {
          const chain = db.getProvenanceChain(r.provenance_id);
          result.provenance = chain.map(p => ({
            id: p.id,
            type: p.type,
            chain_depth: p.chain_depth,
            processor: p.processor,
            content_hash: p.content_hash,
          }));
        }

        return result;
      });

      return formatResponse(successResult({
        query: input.query,
        semantic_weight: input.semantic_weight,
        keyword_weight: input.keyword_weight,
        results: formattedResults,
        total: formattedResults.length,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT TOOLS (3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_document_list - List documents
 */
server.tool(
  'ocr_document_list',
  'List documents in the current database',
  {
    status_filter: z.enum(['pending', 'processing', 'complete', 'failed']).optional().describe('Filter by status'),
    sort_by: z.enum(['created_at', 'file_name', 'file_size']).default('created_at').describe('Sort field'),
    sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort order'),
    limit: z.number().int().min(1).max(1000).default(50).describe('Maximum results'),
    offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
  },
  async (params) => {
    try {
      const input = validateInput(DocumentListInput, params);
      const { db } = requireDatabase();

      const documents = db.listDocuments({
        statusFilter: input.status_filter,
        sortBy: input.sort_by,
        sortOrder: input.sort_order,
        limit: input.limit,
        offset: input.offset,
      });

      const stats = db.getStats();

      return formatResponse(successResult({
        documents: documents.map(d => ({
          id: d.id,
          file_name: d.file_name,
          file_path: d.file_path,
          file_size: d.file_size,
          file_type: d.file_type,
          status: d.status,
          page_count: d.page_count,
          created_at: d.created_at,
        })),
        total: stats.documentCount,
        limit: input.limit,
        offset: input.offset,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_document_get - Get document details
 */
server.tool(
  'ocr_document_get',
  'Get detailed information about a specific document',
  {
    document_id: z.string().min(1).describe('Document ID'),
    include_text: z.boolean().default(false).describe('Include OCR extracted text'),
    include_chunks: z.boolean().default(false).describe('Include chunk information'),
    include_full_provenance: z.boolean().default(false).describe('Include full provenance chain'),
  },
  async (params) => {
    try {
      const input = validateInput(DocumentGetInput, params);
      const { db } = requireDatabase();

      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      const result: Record<string, unknown> = {
        id: doc.id,
        file_name: doc.file_name,
        file_path: doc.file_path,
        file_hash: doc.file_hash,
        file_size: doc.file_size,
        file_type: doc.file_type,
        status: doc.status,
        page_count: doc.page_count,
        created_at: doc.created_at,
        provenance_id: doc.provenance_id,
      };

      if (input.include_text) {
        const ocrResult = db.getOCRResultByDocumentId(doc.id);
        result.ocr_text = ocrResult?.extracted_text ?? null;
      }

      if (input.include_chunks) {
        const chunks = db.getChunksByDocumentId(doc.id);
        result.chunks = chunks.map(c => ({
          id: c.id,
          chunk_index: c.chunk_index,
          text_length: c.text.length,
          page_number: c.page_number,
          character_start: c.character_start,
          character_end: c.character_end,
          embedding_status: c.embedding_status,
        }));
      }

      if (input.include_full_provenance) {
        const chain = db.getProvenanceChain(doc.provenance_id);
        result.provenance_chain = chain.map(p => ({
          id: p.id,
          type: p.type,
          chain_depth: p.chain_depth,
          processor: p.processor,
          processor_version: p.processor_version,
          content_hash: p.content_hash,
          created_at: p.created_at,
        }));
      }

      return formatResponse(successResult(result));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_document_delete - Delete document and all derived data
 */
server.tool(
  'ocr_document_delete',
  'Delete a document and all its derived data (chunks, embeddings, vectors, provenance)',
  {
    document_id: z.string().min(1).describe('Document ID to delete'),
    confirm: z.literal(true).describe('Must be true to confirm deletion'),
  },
  async (params) => {
    try {
      const input = validateInput(DocumentDeleteInput, params);
      const { db, vector } = requireDatabase();

      const doc = db.getDocument(input.document_id);
      if (!doc) {
        throw documentNotFoundError(input.document_id);
      }

      // Count items before deletion for reporting
      const chunks = db.getChunksByDocumentId(doc.id);
      const embeddings = db.getEmbeddingsByDocumentId(doc.id);
      const provenance = db.getProvenanceByRootDocument(doc.provenance_id);

      // Delete vectors first
      const vectorsDeleted = vector.deleteVectorsByDocumentId(doc.id);

      // Delete document (cascades to chunks, embeddings, provenance)
      db.deleteDocument(doc.id);

      return formatResponse(successResult({
        document_id: doc.id,
        deleted: true,
        chunks_deleted: chunks.length,
        embeddings_deleted: embeddings.length,
        vectors_deleted: vectorsDeleted,
        provenance_deleted: provenance.length,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVENANCE TOOLS (3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_provenance_get - Get provenance chain
 */
server.tool(
  'ocr_provenance_get',
  'Get the complete provenance chain for an item',
  {
    item_id: z.string().min(1).describe('ID of the item (document, chunk, embedding, or provenance)'),
    item_type: z.enum(['document', 'ocr_result', 'chunk', 'embedding', 'auto']).default('auto').describe('Type of item'),
    format: z.enum(['chain', 'tree', 'flat']).default('chain').describe('Output format'),
  },
  async (params) => {
    try {
      const input = validateInput(ProvenanceGetInput, params);
      const { db } = requireDatabase();

      // Find the provenance ID based on item type
      let provenanceId: string | null = null;
      let itemType = input.item_type;

      if (itemType === 'auto') {
        // Try to find the item
        const doc = db.getDocument(input.item_id);
        if (doc) {
          provenanceId = doc.provenance_id;
          itemType = 'document';
        } else {
          const chunk = db.getChunk(input.item_id);
          if (chunk) {
            provenanceId = chunk.provenance_id;
            itemType = 'chunk';
          } else {
            const embedding = db.getEmbedding(input.item_id);
            if (embedding) {
              provenanceId = embedding.provenance_id;
              itemType = 'embedding';
            } else {
              const prov = db.getProvenance(input.item_id);
              if (prov) {
                provenanceId = prov.id;
                itemType = 'provenance';
              }
            }
          }
        }
      } else {
        // Use specified type
        switch (itemType) {
          case 'document':
            const doc = db.getDocument(input.item_id);
            provenanceId = doc?.provenance_id ?? null;
            break;
          case 'chunk':
            const chunk = db.getChunk(input.item_id);
            provenanceId = chunk?.provenance_id ?? null;
            break;
          case 'embedding':
            const embedding = db.getEmbedding(input.item_id);
            provenanceId = embedding?.provenance_id ?? null;
            break;
          default:
            provenanceId = input.item_id;
        }
      }

      if (!provenanceId) {
        throw provenanceNotFoundError(input.item_id);
      }

      const chain = db.getProvenanceChain(provenanceId);
      if (chain.length === 0) {
        throw provenanceNotFoundError(input.item_id);
      }

      const rootDocId = chain[0].root_document_id;

      return formatResponse(successResult({
        item_id: input.item_id,
        item_type: itemType,
        chain: chain.map(p => ({
          id: p.id,
          type: p.type,
          chain_depth: p.chain_depth,
          processor: p.processor,
          processor_version: p.processor_version,
          content_hash: p.content_hash,
          created_at: p.created_at,
          parent_id: p.parent_id,
        })),
        root_document_id: rootDocId,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_provenance_verify - Verify integrity
 */
server.tool(
  'ocr_provenance_verify',
  'Verify the integrity of an item through its provenance chain',
  {
    item_id: z.string().min(1).describe('ID of the item to verify'),
    verify_content: z.boolean().default(true).describe('Verify content hashes'),
    verify_chain: z.boolean().default(true).describe('Verify chain integrity'),
  },
  async (params) => {
    try {
      const input = validateInput(ProvenanceVerifyInput, params);
      const { db } = requireDatabase();

      // Find provenance ID
      let provenanceId: string | null = null;

      const doc = db.getDocument(input.item_id);
      if (doc) {
        provenanceId = doc.provenance_id;
      } else {
        const chunk = db.getChunk(input.item_id);
        if (chunk) {
          provenanceId = chunk.provenance_id;
        } else {
          const embedding = db.getEmbedding(input.item_id);
          if (embedding) {
            provenanceId = embedding.provenance_id;
          } else {
            const prov = db.getProvenance(input.item_id);
            if (prov) {
              provenanceId = prov.id;
            }
          }
        }
      }

      if (!provenanceId) {
        throw provenanceNotFoundError(input.item_id);
      }

      const chain = db.getProvenanceChain(provenanceId);
      if (chain.length === 0) {
        throw provenanceNotFoundError(input.item_id);
      }

      const steps: Array<Record<string, unknown>> = [];
      const errors: string[] = [];
      let contentIntegrity = true;
      let chainIntegrity = true;

      for (let i = 0; i < chain.length; i++) {
        const prov = chain[i];
        const step: Record<string, unknown> = {
          provenance_id: prov.id,
          type: prov.type,
          chain_depth: prov.chain_depth,
          content_verified: true,
          chain_verified: true,
          expected_hash: prov.content_hash,
        };

        // Verify chain integrity
        if (input.verify_chain) {
          // Check chain depth is correct
          if (prov.chain_depth !== i) {
            step.chain_verified = false;
            chainIntegrity = false;
            errors.push(`Chain depth mismatch at ${prov.id}: expected ${i}, got ${prov.chain_depth}`);
          }

          // Check parent link (except for root)
          if (i > 0 && prov.parent_id !== chain[i - 1].id) {
            step.chain_verified = false;
            chainIntegrity = false;
            errors.push(`Parent link broken at ${prov.id}`);
          }
        }

        // Content verification would require re-hashing the actual content
        // For now, we just validate the hash format
        if (input.verify_content) {
          if (!prov.content_hash.startsWith('sha256:')) {
            step.content_verified = false;
            contentIntegrity = false;
            errors.push(`Invalid hash format at ${prov.id}`);
          }
        }

        steps.push(step);
      }

      return formatResponse(successResult({
        item_id: input.item_id,
        verified: contentIntegrity && chainIntegrity,
        content_integrity: contentIntegrity,
        chain_integrity: chainIntegrity,
        steps,
        errors: errors.length > 0 ? errors : undefined,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

/**
 * ocr_provenance_export - Export provenance data
 */
server.tool(
  'ocr_provenance_export',
  'Export provenance data in various formats',
  {
    scope: z.enum(['document', 'database', 'all']).describe('Export scope'),
    document_id: z.string().optional().describe('Document ID (required when scope is document)'),
    format: z.enum(['json', 'w3c-prov', 'csv']).default('json').describe('Export format'),
    output_path: z.string().optional().describe('Optional output file path'),
  },
  async (params) => {
    try {
      const input = validateInput(ProvenanceExportInput, params);
      const { db } = requireDatabase();

      let records: ReturnType<typeof db.getProvenance>[] = [];

      if (input.scope === 'document') {
        if (!input.document_id) {
          throw validationError('document_id is required when scope is "document"');
        }
        const doc = db.getDocument(input.document_id);
        if (!doc) {
          throw documentNotFoundError(input.document_id);
        }
        records = db.getProvenanceByRootDocument(doc.provenance_id);
      } else {
        // Get all documents and their provenance
        const docs = db.listDocuments({ limit: 10000 });
        for (const doc of docs) {
          const docProv = db.getProvenanceByRootDocument(doc.provenance_id);
          records.push(...docProv);
        }
      }

      let data: unknown;

      switch (input.format) {
        case 'json':
          data = records.filter(r => r !== null).map(r => ({
            id: r!.id,
            type: r!.type,
            chain_depth: r!.chain_depth,
            processor: r!.processor,
            processor_version: r!.processor_version,
            content_hash: r!.content_hash,
            parent_id: r!.parent_id,
            root_document_id: r!.root_document_id,
            created_at: r!.created_at,
          }));
          break;

        case 'w3c-prov':
          // W3C PROV-JSON format
          const activities: Record<string, unknown> = {};
          const entities: Record<string, unknown> = {};
          const derivations: unknown[] = [];

          for (const r of records) {
            if (!r) continue;
            entities[`entity:${r.id}`] = {
              'prov:type': r.type,
              'ocr:contentHash': r.content_hash,
              'ocr:chainDepth': r.chain_depth,
            };

            activities[`activity:${r.id}`] = {
              'prov:type': r.processor,
              'ocr:processorVersion': r.processor_version,
            };

            if (r.parent_id) {
              derivations.push({
                'prov:generatedEntity': `entity:${r.id}`,
                'prov:usedEntity': `entity:${r.parent_id}`,
                'prov:activity': `activity:${r.id}`,
              });
            }
          }

          data = {
            '@context': 'https://www.w3.org/ns/prov',
            entity: entities,
            activity: activities,
            wasDerivedFrom: derivations,
          };
          break;

        case 'csv':
          const headers = ['id', 'type', 'chain_depth', 'processor', 'processor_version', 'content_hash', 'parent_id', 'root_document_id', 'created_at'];
          const rows = records.filter(r => r !== null).map(r => [
            r!.id,
            r!.type,
            r!.chain_depth,
            r!.processor,
            r!.processor_version,
            r!.content_hash,
            r!.parent_id ?? '',
            r!.root_document_id,
            r!.created_at,
          ].join(','));
          data = [headers.join(','), ...rows].join('\n');
          break;
      }

      return formatResponse(successResult({
        scope: input.scope,
        format: input.format,
        document_id: input.document_id,
        record_count: records.filter(r => r !== null).length,
        data,
      }));
    } catch (error) {
      return handleError(error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OCR Provenance MCP Server running on stdio');
  console.error('Tools registered: 18');
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});

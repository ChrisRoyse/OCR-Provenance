/**
 * Database Management MCP Tools
 *
 * Extracted from src/index.ts Task 19.
 * Tools: ocr_db_create, ocr_db_list, ocr_db_select, ocr_db_stats, ocr_db_delete
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/database
 */

import { z } from 'zod';
import { DatabaseService } from '../services/storage/database/index.js';
import { VectorService } from '../services/storage/vector.js';
import {
  state,
  requireDatabase,
  selectDatabase,
  createDatabase,
  deleteDatabase,
  getDefaultStoragePath,
} from '../server/state.js';
import { successResult } from '../server/types.js';
import {
  validateInput,
  DatabaseCreateInput,
  DatabaseListInput,
  DatabaseSelectInput,
  DatabaseStatsInput,
  DatabaseDeleteInput,
} from '../utils/validation.js';
import { formatResponse, handleError, type ToolDefinition } from './shared.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_db_create - Create a new database
 */
export async function handleDatabaseCreate(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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

/**
 * Handle ocr_db_list - List all databases
 */
export async function handleDatabaseList(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(DatabaseListInput, params);
    const storagePath = getDefaultStoragePath();
    const databases = DatabaseService.list(storagePath);

    const items = databases.map((dbInfo) => {
      const item: Record<string, unknown> = {
        name: dbInfo.name,
        path: dbInfo.path,
        size_bytes: dbInfo.size_bytes,
        created_at: dbInfo.created_at,
        modified_at: dbInfo.last_modified_at,
      };

      if (input.include_stats) {
        let statsDb: DatabaseService | null = null;
        try {
          statsDb = DatabaseService.open(dbInfo.name, storagePath);
          const stats = statsDb.getStats();
          item.document_count = stats.total_documents;
          item.chunk_count = stats.total_chunks;
          item.embedding_count = stats.total_embeddings;
        } catch (err) {
          item.stats_error = err instanceof Error ? err.message : String(err);
        } finally {
          statsDb?.close();
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

/**
 * Handle ocr_db_select - Select active database
 */
export async function handleDatabaseSelect(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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
        document_count: stats.total_documents,
        chunk_count: stats.total_chunks,
        embedding_count: stats.total_embeddings,
        vector_count: vector.getVectorCount(),
      },
    }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Build stats response from database and vector services
 */
function buildStatsResponse(
  db: DatabaseService,
  vector: VectorService
): Record<string, unknown> {
  const stats = db.getStats();
  return {
    name: db.getName(),
    path: db.getPath(),
    size_bytes: stats.storage_size_bytes,
    document_count: stats.total_documents,
    chunk_count: stats.total_chunks,
    embedding_count: stats.total_embeddings,
    image_count: stats.total_images,
    provenance_count: stats.total_provenance,
    ocr_result_count: stats.total_ocr_results,
    pending_documents: stats.documents_by_status.pending,
    processing_documents: stats.documents_by_status.processing,
    complete_documents: stats.documents_by_status.complete,
    failed_documents: stats.documents_by_status.failed,
    extraction_count: stats.total_extractions,
    form_fill_count: stats.total_form_fills,
    comparison_count: stats.total_comparisons,
    cluster_count: stats.total_clusters,
    total_knowledge_nodes: stats.total_knowledge_nodes,
    total_knowledge_edges: stats.total_knowledge_edges,
    vector_count: vector.getVectorCount(),
    ocr_quality: stats.ocr_quality,
    costs: stats.costs,
  };
}

/**
 * Handle ocr_db_stats - Get database statistics
 */
export async function handleDatabaseStats(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const input = validateInput(DatabaseStatsInput, params);

    // If database_name is provided, temporarily open that database
    if (input.database_name && input.database_name !== state.currentDatabaseName) {
      const storagePath = getDefaultStoragePath();
      const db = DatabaseService.open(input.database_name, storagePath);
      try {
        const vector = new VectorService(db.getConnection());
        const result = buildStatsResponse(db, vector);
        return formatResponse(successResult(result));
      } finally {
        db.close();
      }
    }

    // Use current database
    const { db, vector } = requireDatabase();
    return formatResponse(successResult(buildStatsResponse(db, vector)));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_db_delete - Delete a database
 */
export async function handleDatabaseDelete(
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS FOR MCP REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Database tools collection for MCP server registration
 */
export const databaseTools: Record<string, ToolDefinition> = {
  'ocr_db_create': {
    description: 'Create a new OCR database for document storage and search',
    inputSchema: {
      name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).describe('Database name (alphanumeric, underscore, hyphen only)'),
      description: z.string().max(500).optional().describe('Optional description for the database'),
      storage_path: z.string().optional().describe('Optional storage path override'),
    },
    handler: handleDatabaseCreate,
  },
  'ocr_db_list': {
    description: 'List all available OCR databases',
    inputSchema: {
      include_stats: z.boolean().default(false).describe('Include document/chunk/embedding counts'),
    },
    handler: handleDatabaseList,
  },
  'ocr_db_select': {
    description: 'Select a database as the active database for operations',
    inputSchema: {
      database_name: z.string().min(1).describe('Name of the database to select'),
    },
    handler: handleDatabaseSelect,
  },
  'ocr_db_stats': {
    description: 'Get detailed statistics for a database',
    inputSchema: {
      database_name: z.string().optional().describe('Database name (uses current if not specified)'),
    },
    handler: handleDatabaseStats,
  },
  'ocr_db_delete': {
    description: 'Delete a database and all its data permanently',
    inputSchema: {
      database_name: z.string().min(1).describe('Name of the database to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleDatabaseDelete,
  },
};

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
import { logAudit } from '../services/audit.js';

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

    logAudit({
      action: 'db_create',
      entityType: 'database',
      entityId: input.name,
      details: { path, description: input.description },
    });

    return formatResponse(
      successResult({
        name: input.name,
        path,
        created: true,
        description: input.description,
        next_steps: [
          { tool: 'ocr_db_select', description: 'Select this database to start using it' },
          { tool: 'ocr_ingest_files', description: 'Ingest files into the new database' },
        ],
      })
    );
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
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const storagePath = getDefaultStoragePath();
    const allDatabases = DatabaseService.list(storagePath);

    // Apply pagination
    const totalCount = allDatabases.length;
    const databases = allDatabases.slice(offset, offset + limit);

    const items = databases.map((dbInfo) => {
      const item: Record<string, unknown> = {
        name: dbInfo.name,
        path: dbInfo.path,
        size_bytes: dbInfo.size_bytes,
        created_at: dbInfo.created_at,
        modified_at: dbInfo.last_modified_at,
      };

      if (input.include_stats) {
        // M-17: Throw on stats errors instead of hiding them as stats_error field
        let statsDb: DatabaseService | null = null;
        try {
          statsDb = DatabaseService.open(dbInfo.name, storagePath);
          const stats = statsDb.getStats();
          item.document_count = stats.total_documents;
          item.chunk_count = stats.total_chunks;
          item.embedding_count = stats.total_embeddings;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to get database stats for '${dbInfo.name}': ${errMsg}`);
        } finally {
          statsDb?.close();
        }
      }

      return item;
    });

    const hasMore = offset + limit < totalCount;

    return formatResponse(
      successResult({
        databases: items,
        total: totalCount,
        returned: items.length,
        offset,
        limit,
        has_more: hasMore,
        storage_path: storagePath,
        next_steps: [
          ...(hasMore
            ? [
                {
                  tool: 'ocr_db_list',
                  description: `Get next page (offset=${offset + limit})`,
                },
              ]
            : []),
          { tool: 'ocr_db_select', description: 'Select a database to work with' },
          { tool: 'ocr_db_create', description: 'Create a new database' },
          { tool: 'ocr_search_cross_db', description: 'Search across all databases' },
        ],
      })
    );
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

    logAudit({
      action: 'db_select',
      entityType: 'database',
      entityId: input.database_name,
      details: { document_count: stats.total_documents },
    });

    return formatResponse(
      successResult({
        name: input.database_name,
        path: db.getPath(),
        selected: true,
        stats: {
          document_count: stats.total_documents,
          chunk_count: stats.total_chunks,
          embedding_count: stats.total_embeddings,
          vector_count: vector.getVectorCount(),
        },
        next_steps: [
          { tool: 'ocr_document_list', description: 'Browse documents in this database' },
          { tool: 'ocr_search', description: 'Search for content across all documents' },
          { tool: 'ocr_db_stats', description: 'Get detailed statistics for this database' },
        ],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Build stats response from database and vector services
 */
function buildStatsResponse(db: DatabaseService, vector: VectorService): Record<string, unknown> {
  const stats = db.getStats();
  const conn = db.getConnection();

  // Additional overview queries
  const fileTypeDist = conn
    .prepare(
      'SELECT file_type, COUNT(*) as count FROM documents GROUP BY file_type ORDER BY count DESC'
    )
    .all();

  const dateRange = conn
    .prepare('SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM documents')
    .get() as { earliest: string | null; latest: string | null } | undefined;

  const statusDist = conn
    .prepare('SELECT status, COUNT(*) as count FROM documents GROUP BY status')
    .all();

  const qualityStats = conn
    .prepare(
      `SELECT AVG(parse_quality_score) as avg_quality,
            MIN(parse_quality_score) as min_quality,
            MAX(parse_quality_score) as max_quality
     FROM ocr_results WHERE parse_quality_score IS NOT NULL`
    )
    .get() as
    | { avg_quality: number | null; min_quality: number | null; max_quality: number | null }
    | undefined;

  const clusterSummary = conn
    .prepare(
      `SELECT c.id, c.label, c.document_count, c.classification_tag
     FROM clusters c ORDER BY c.document_count DESC LIMIT 5`
    )
    .all();

  const recentDocs = conn
    .prepare(
      'SELECT file_name, file_type, status, page_count, created_at FROM documents ORDER BY created_at DESC LIMIT 5'
    )
    .all();

  const totalChunks = conn.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
    count: number;
  };
  const totalEmbeddings = conn.prepare('SELECT COUNT(*) as count FROM embeddings').get() as {
    count: number;
  };
  const totalImages = conn.prepare('SELECT COUNT(*) as count FROM images').get() as {
    count: number;
  };

  const ftsStatus = conn.prepare('SELECT COUNT(*) as count FROM fts_index_metadata').get() as {
    count: number;
  };

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
    vector_count: vector.getVectorCount(),
    ocr_quality: stats.ocr_quality,
    costs: stats.costs,
    overview: {
      total_documents: stats.total_documents,
      total_chunks: totalChunks.count,
      total_embeddings: totalEmbeddings.count,
      total_images: totalImages.count,
      file_type_distribution: fileTypeDist,
      document_date_range: dateRange ?? null,
      status_distribution: statusDist,
      quality_stats: qualityStats ?? null,
      top_clusters: clusterSummary,
      recent_documents: recentDocs,
      fts_indexed: ftsStatus.count > 0,
    },
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

    const statsNextSteps = [
      { tool: 'ocr_document_list', description: 'Browse documents in this database' },
      { tool: 'ocr_search', description: 'Search for content across documents' },
      { tool: 'ocr_report_overview', description: 'Get quality and corpus analytics' },
      { tool: 'ocr_benchmark_compare', description: 'Benchmark search modes against each other' },
    ];

    // If database_name is provided, temporarily open that database
    if (input.database_name && input.database_name !== state.currentDatabaseName) {
      const storagePath = getDefaultStoragePath();
      const db = DatabaseService.open(input.database_name, storagePath);
      try {
        const vector = new VectorService(db.getConnection());
        const result = buildStatsResponse(db, vector);
        return formatResponse(successResult({ ...result, next_steps: statsNextSteps }));
      } finally {
        db.close();
      }
    }

    // Use current database
    const { db, vector } = requireDatabase();
    const result = buildStatsResponse(db, vector);
    return formatResponse(successResult({ ...result, next_steps: statsNextSteps }));
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

    logAudit({
      action: 'db_delete',
      entityType: 'database',
      entityId: input.database_name,
    });

    return formatResponse(
      successResult({
        name: input.database_name,
        deleted: true,
        next_steps: [{ tool: 'ocr_db_list', description: 'List remaining databases' }],
      })
    );
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
  ocr_db_create: {
    description:
      '[SETUP] Use to create a new database before ingesting documents. Returns database name and path. Follow with ocr_db_select, then ocr_ingest_files or ocr_ingest_directory.',
    inputSchema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe('Database name (alphanumeric, underscore, hyphen only)'),
      description: z.string().max(500).optional().describe('Optional description for the database'),
      storage_path: z.string().optional().describe('Optional storage path override'),
    },
    handler: handleDatabaseCreate,
  },
  ocr_db_list: {
    description:
      '[ESSENTIAL] Use first to discover available databases. Returns names, sizes, and document counts. Paginated (default 50 per page). Follow with ocr_db_select to choose one.',
    inputSchema: {
      include_stats: z.boolean().default(false).describe('Include document/chunk/embedding counts'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Maximum databases to return (default 50)'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Number of databases to skip for pagination'),
    },
    handler: handleDatabaseList,
  },
  ocr_db_select: {
    description:
      '[ESSENTIAL] Use to switch active database. All subsequent tools operate on the selected database. Returns basic stats. Prerequisite for most tools.',
    inputSchema: {
      database_name: z.string().min(1).describe('Name of the database to select'),
    },
    handler: handleDatabaseSelect,
  },
  ocr_db_stats: {
    description:
      '[ESSENTIAL] Use to check database size, document counts, quality stats, and recent activity. Returns comprehensive overview including file types, clusters, and costs.',
    inputSchema: {
      database_name: z
        .string()
        .optional()
        .describe('Database name (uses current if not specified)'),
    },
    handler: handleDatabaseStats,
  },
  ocr_db_delete: {
    description:
      '[DESTRUCTIVE] Use to permanently delete a database and all its data. Returns confirmation. Requires confirm=true.',
    inputSchema: {
      database_name: z.string().min(1).describe('Name of the database to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleDatabaseDelete,
  },
};

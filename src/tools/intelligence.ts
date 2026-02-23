/**
 * Intelligence MCP Tools
 *
 * Tools: ocr_guide, ocr_document_tables, ocr_document_recommend, ocr_document_extras
 *
 * Internal-only data access and analysis tools. No external API calls needed.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/intelligence
 */

import { z } from 'zod';
import { state, hasDatabase, requireDatabase, getDefaultStoragePath } from '../server/state.js';
import { DatabaseService } from '../services/storage/database/index.js';
import { successResult } from '../server/types.js';
import { validateInput } from '../utils/validation.js';
import { MCPError, documentNotFoundError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const GuideInput = z.object({
  intent: z.enum(['explore', 'search', 'ingest', 'analyze', 'status']).optional()
    .describe('Optional intent hint: explore (browse data), search (find content), ingest (add documents), analyze (compare/cluster), status (check health). Omit for general guidance.'),
});

const DocumentTablesInput = z.object({
  document_id: z.string().min(1).describe('Document ID to extract tables from'),
  table_index: z.number().int().min(0).optional()
    .describe('Specific table index (0-based) to retrieve. Omit for all tables.'),
});

const DocumentRecommendInput = z.object({
  document_id: z.string().min(1).describe('Source document ID to get recommendations for'),
  limit: z.number().int().min(1).max(50).default(10)
    .describe('Maximum number of recommendations'),
});

const DocumentExtrasInput = z.object({
  document_id: z.string().min(1).describe('Document ID to retrieve extras data for'),
  section: z.string().optional()
    .describe('Specific extras section to retrieve (charts, links, tracked_changes, table_row_bboxes, infographics). Omit for all.'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** Parsed table cell */
interface TableCell {
  row: number;
  col: number;
  text: string;
}

/** Parsed table from JSON blocks */
interface ParsedTable {
  table_index: number;
  page_number: number | null;
  caption: string | null;
  row_count: number;
  column_count: number;
  cells: TableCell[];
}

/** Recommendation entry */
interface RecommendationEntry {
  document_id: string;
  file_name: string | null;
  file_type: string | null;
  status: string | null;
  score: number;
  reasons: string[];
  cluster_match: boolean;
  similarity: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE EXTRACTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Walk JSON blocks tree looking for Table-type blocks.
 * Extracts cell data into a structured format.
 */
function extractTablesFromBlocks(blocks: Array<Record<string, unknown>>): ParsedTable[] {
  const tables: ParsedTable[] = [];

  function walkBlock(block: Record<string, unknown>, pageNumber: number | null): void {
    const blockType = block.block_type as string | undefined;

    // Track page number from Page blocks
    const currentPage = blockType === 'Page' && typeof block.id === 'number'
      ? (block.id as number) + 1
      : pageNumber;

    if (blockType === 'Table') {
      const table = parseTableBlock(block, tables.length, currentPage);
      tables.push(table);
    }

    // Recurse into children
    const children = block.children as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(children)) {
      for (const child of children) {
        walkBlock(child, currentPage);
      }
    }
  }

  for (const block of blocks) {
    walkBlock(block, null);
  }

  return tables;
}

/**
 * Parse a single Table block into a structured table representation.
 */
function parseTableBlock(
  block: Record<string, unknown>,
  tableIndex: number,
  pageNumber: number | null
): ParsedTable {
  const cells: TableCell[] = [];
  let maxRow = 0;
  let maxCol = 0;
  let caption: string | null = null;

  // Look for caption in the block itself or nearby
  if (typeof block.html === 'string' && block.html.includes('<caption>')) {
    const captionMatch = (block.html as string).match(/<caption>(.*?)<\/caption>/);
    if (captionMatch) {
      caption = captionMatch[1];
    }
  }

  // Try to extract cells from HTML if available
  if (typeof block.html === 'string') {
    const html = block.html as string;
    extractCellsFromHTML(html, cells);
  }

  // Also try to extract from children blocks (TableRow/TableCell pattern)
  const children = block.children as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(children) && cells.length === 0) {
    let rowIndex = 0;
    for (const child of children) {
      const childType = child.block_type as string | undefined;
      if (childType === 'TableRow' || childType === 'TableHeader') {
        const rowChildren = child.children as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(rowChildren)) {
          let colIndex = 0;
          for (const cell of rowChildren) {
            const cellType = cell.block_type as string | undefined;
            if (cellType === 'TableCell' || cellType === 'TableHeaderCell') {
              const text = extractBlockText(cell);
              cells.push({ row: rowIndex, col: colIndex, text });
              if (colIndex > maxCol) maxCol = colIndex;
              colIndex++;
            }
          }
        }
        rowIndex++;
      }
    }
    maxRow = rowIndex > 0 ? rowIndex - 1 : 0;
  }

  // Compute maxRow/maxCol from cells
  for (const cell of cells) {
    if (cell.row > maxRow) maxRow = cell.row;
    if (cell.col > maxCol) maxCol = cell.col;
  }

  return {
    table_index: tableIndex,
    page_number: pageNumber,
    caption,
    row_count: cells.length > 0 ? maxRow + 1 : 0,
    column_count: cells.length > 0 ? maxCol + 1 : 0,
    cells,
  };
}

/**
 * Extract cells from HTML table string.
 */
function extractCellsFromHTML(html: string, cells: TableCell[]): void {
  // Split by rows
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  let rowIndex = 0;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    let colIndex = 0;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      // Strip inner HTML tags to get text
      const text = cellMatch[1].replace(/<[^>]*>/g, '').trim();
      cells.push({ row: rowIndex, col: colIndex, text });
      colIndex++;
    }
    rowIndex++;
  }
}

/**
 * Extract text content from a block recursively.
 */
function extractBlockText(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text as string;
  if (typeof block.html === 'string') {
    return (block.html as string).replace(/<[^>]*>/g, '').trim();
  }

  const children = block.children as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(children)) {
    return children.map(extractBlockText).filter(Boolean).join(' ');
  }

  return '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: ocr_guide
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_guide - Contextual navigation aid for AI agents.
 *
 * Inspects current system state (databases, selected DB, document counts,
 * processing status) and returns actionable guidance. No external API calls.
 */
async function handleGuide(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(GuideInput, params);
    const intent = input.intent;

    const storagePath = getDefaultStoragePath();
    const databases = DatabaseService.list(storagePath);
    const selectedDb = state.currentDatabaseName;
    const dbSelected = hasDatabase();

    // Build context about current state
    const context: Record<string, unknown> = {
      databases_available: databases.length,
      database_names: databases.map(d => d.name),
      selected_database: selectedDb ?? 'none',
    };

    // If a database is selected, get its stats
    let docCount = 0;
    let pendingCount = 0;
    let completeCount = 0;
    let failedCount = 0;
    let chunkCount = 0;
    let embeddingCount = 0;
    let imageCount = 0;
    let clusterCount = 0;
    let embeddingCoverage = 0;
    let vlmCoverage = 0;

    if (dbSelected) {
      try {
        const { db, vector } = requireDatabase();
        const conn = db.getConnection();

        const statusRows = conn.prepare(
          'SELECT status, COUNT(*) as count FROM documents GROUP BY status'
        ).all() as Array<{ status: string; count: number }>;

        for (const row of statusRows) {
          docCount += row.count;
          if (row.status === 'pending') pendingCount = row.count;
          else if (row.status === 'complete') completeCount = row.count;
          else if (row.status === 'failed') failedCount = row.count;
        }

        chunkCount = (conn.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c;
        embeddingCount = (conn.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number }).c;
        imageCount = (conn.prepare('SELECT COUNT(*) as c FROM images').get() as { c: number }).c;
        clusterCount = (conn.prepare('SELECT COUNT(*) as c FROM clusters').get() as { c: number }).c;

        context.database_stats = {
          total_documents: docCount,
          complete: completeCount,
          pending: pendingCount,
          failed: failedCount,
          chunks: chunkCount,
          embeddings: embeddingCount,
          images: imageCount,
          clusters: clusterCount,
          vectors: vector.getVectorCount(),
        };

        // V7: Corpus snapshot for smarter guide
        if (docCount > 0) {
          const fileTypeRows = conn.prepare(
            "SELECT file_type, COUNT(*) as count FROM documents WHERE file_type IS NOT NULL GROUP BY file_type ORDER BY count DESC"
          ).all() as Array<{ file_type: string; count: number }>;

          const comparisonCount = (conn.prepare('SELECT COUNT(*) as c FROM comparisons').get() as { c: number }).c;

          embeddingCoverage = chunkCount > 0
            ? Math.round((embeddingCount / chunkCount) * 100)
            : 0;

          // Count images with VLM descriptions vs total
          const vlmCompleteCount = imageCount > 0
            ? (conn.prepare("SELECT COUNT(*) as c FROM images WHERE vlm_status = 'complete'").get() as { c: number }).c
            : 0;
          vlmCoverage = imageCount > 0
            ? Math.round((vlmCompleteCount / imageCount) * 100)
            : 0;

          context.corpus_snapshot = {
            document_count: docCount,
            total_chunks: chunkCount,
            total_images: imageCount,
            file_types: fileTypeRows.map(r => r.file_type),
            has_clusters: clusterCount > 0,
            has_comparisons: comparisonCount > 0,
            embedding_coverage: `${embeddingCoverage}%`,
            vlm_coverage: `${vlmCoverage}%`,
          };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        context.database_stats_error = errMsg;
        return formatResponse(successResult({
          status: 'database_error',
          message: `Database "${selectedDb}" selected but query failed: ${errMsg}. Try ocr_health_check to diagnose.`,
          context,
          next_steps: [
            { tool: 'ocr_health_check', description: 'Diagnose database integrity issues.', priority: 'required' },
            { tool: 'ocr_db_select', description: 'Re-select the database to reset connection.', priority: 'optional' },
          ],
        }));
      }
    }

    // Build next_steps based on state and intent
    const next_steps: Array<{ tool: string; description: string; priority: string }> = [];

    if (!dbSelected) {
      if (databases.length === 0) {
        next_steps.push({
          tool: 'ocr_db_create',
          description: 'Create a database first, then ingest documents.',
          priority: 'required',
        });
      } else {
        next_steps.push({
          tool: 'ocr_db_select',
          description: 'Select a database to work with (see database_names in context above)',
          priority: 'required',
        });
      }
      return formatResponse(successResult({
        status: 'no_database_selected',
        message: databases.length === 0
          ? 'No databases exist. Create one with ocr_db_create, then ingest documents.'
          : `${databases.length} database(s) available. Select one with ocr_db_select to get started.`,
        context,
        next_steps,
      }));
    }

    // Database is selected - provide guidance based on intent and state
    if (intent === 'ingest' || (docCount === 0 && !intent)) {
      next_steps.push({
        tool: 'ocr_ingest_files',
        description: 'Ingest specific files by path.',
        priority: docCount === 0 ? 'required' : 'optional',
      });
      next_steps.push({
        tool: 'ocr_ingest_directory',
        description: 'Scan a directory for documents to ingest.',
        priority: 'optional',
      });
      if (pendingCount > 0) {
        next_steps.push({
          tool: 'ocr_process_pending',
          description: `Process ${pendingCount} pending documents through OCR pipeline.`,
          priority: 'required',
        });
      }
    } else if (intent === 'search' || (!intent && completeCount > 0)) {
      next_steps.push({
        tool: 'ocr_search',
        description: 'Search across all documents. Default and recommended search tool.',
        priority: 'recommended',
      });
      next_steps.push({
        tool: 'ocr_rag_context',
        description: 'Get pre-assembled context for answering a specific question.',
        priority: 'recommended',
      });
      if (embeddingCount === 0 && chunkCount > 0) {
        next_steps.push({
          tool: 'ocr_health_check',
          description: 'Chunks exist but no embeddings. Run health check with fix=true.',
          priority: 'required',
        });
      }
    } else if (intent === 'explore') {
      next_steps.push({
        tool: 'ocr_document_list',
        description: `Browse ${docCount} documents in the database.`,
        priority: 'recommended',
      });
      next_steps.push({
        tool: 'ocr_report_overview',
        description: 'Get corpus overview with content type distribution (section="corpus").',
        priority: 'optional',
      });
    } else if (intent === 'analyze') {
      if (clusterCount > 0) {
        next_steps.push({
          tool: 'ocr_cluster_list',
          description: `View ${clusterCount} existing clusters.`,
          priority: 'recommended',
        });
      } else if (completeCount >= 2) {
        next_steps.push({
          tool: 'ocr_cluster_documents',
          description: `Cluster ${completeCount} documents by similarity.`,
          priority: 'recommended',
        });
      }
      if (completeCount >= 2) {
        next_steps.push({
          tool: 'ocr_document_compare',
          description: 'Compare two documents to find differences.',
          priority: 'optional',
        });
      }
      next_steps.push({
        tool: 'ocr_document_duplicates',
        description: 'Find duplicate documents by hash or similarity.',
        priority: 'optional',
      });
    } else if (intent === 'status') {
      next_steps.push({
        tool: 'ocr_health_check',
        description: 'Check for data integrity issues.',
        priority: 'recommended',
      });
      next_steps.push({
        tool: 'ocr_db_stats',
        description: 'Get comprehensive database statistics.',
        priority: 'optional',
      });
      if (failedCount > 0) {
        next_steps.push({
          tool: 'ocr_retry_failed',
          description: `${failedCount} failed documents. Reset for reprocessing.`,
          priority: 'recommended',
        });
      }
    } else {
      // General guidance when DB has data and no specific intent
      if (pendingCount > 0) {
        next_steps.push({
          tool: 'ocr_process_pending',
          description: `${pendingCount} documents awaiting processing.`,
          priority: 'recommended',
        });
      }
      if (failedCount > 0) {
        next_steps.push({
          tool: 'ocr_retry_failed',
          description: `${failedCount} failed documents need attention.`,
          priority: 'recommended',
        });
      }
      if (completeCount > 0) {
        next_steps.push({
          tool: 'ocr_search',
          description: 'Search across all documents.',
          priority: 'recommended',
        });
      }
      next_steps.push({
        tool: 'ocr_document_list',
        description: `Browse ${docCount} documents.`,
        priority: 'optional',
      });
      // V7: Context-aware next_steps from corpus snapshot
      if (embeddingCoverage < 100 && chunkCount > 0) {
        next_steps.push({
          tool: 'ocr_health_check',
          description: `Check for processing gaps (${embeddingCoverage}% embedding coverage).`,
          priority: 'recommended',
        });
      }
      if (clusterCount > 0) {
        next_steps.push({
          tool: 'ocr_cluster_list',
          description: `Explore ${clusterCount} topic clusters.`,
          priority: 'optional',
        });
      }
    }

    // Build summary message
    const parts: string[] = [];
    parts.push(`Database "${selectedDb}" selected.`);
    parts.push(`${docCount} documents (${completeCount} complete, ${pendingCount} pending, ${failedCount} failed).`);
    if (chunkCount > 0) parts.push(`${chunkCount} chunks, ${embeddingCount} embeddings.`);
    if (imageCount > 0) parts.push(`${imageCount} images.`);
    if (clusterCount > 0) parts.push(`${clusterCount} clusters.`);

    return formatResponse(successResult({
      status: 'ready',
      message: parts.join(' '),
      context,
      next_steps,
      workflow_chains: docCount > 0 ? [
        { name: 'find_and_read', steps: ['ocr_search -> ocr_chunk_context -> ocr_document_page'], description: 'Find content, expand context, read full page' },
        { name: 'compare_documents', steps: ['ocr_comparison_discover -> ocr_document_compare -> ocr_comparison_get'], description: 'Find similar pairs, diff them, inspect results' },
        { name: 'process_new', steps: ['ocr_ingest_files -> ocr_process_pending -> ocr_health_check'], description: 'Add files, run OCR pipeline, verify completeness' },
      ] : undefined,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: ocr_document_tables
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_tables - Extract table data from JSON blocks
 */
async function handleDocumentTables(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentTablesInput, params);
    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Get json_blocks from ocr_results
    const ocrRow = db.getConnection()
      .prepare('SELECT json_blocks FROM ocr_results WHERE document_id = ?')
      .get(input.document_id) as { json_blocks: string | null } | undefined;

    const tableNextSteps = [
      { tool: 'ocr_document_page', description: 'Read the page containing a table' },
      { tool: 'ocr_search', description: 'Search for related content' },
    ];

    if (!ocrRow?.json_blocks) {
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        tables: [],
        total_tables: 0,
        source: 'no_ocr_results_or_blocks',
        next_steps: tableNextSteps,
      }));
    }

    let blocks: Array<Record<string, unknown>>;
    try {
      blocks = JSON.parse(ocrRow.json_blocks) as Array<Record<string, unknown>>;
    } catch (parseErr) {
      console.error(`[DocumentTables] Failed to parse json_blocks for ${input.document_id}: ${String(parseErr)}`);
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        tables: [],
        total_tables: 0,
        source: 'json_blocks_parse_error',
        next_steps: tableNextSteps,
      }));
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        tables: [],
        total_tables: 0,
        source: 'empty_json_blocks',
        next_steps: tableNextSteps,
      }));
    }

    const allTables = extractTablesFromBlocks(blocks);

    // Filter by table_index if specified
    let tables: ParsedTable[];
    if (input.table_index !== undefined) {
      if (input.table_index >= allTables.length) {
        return formatResponse(successResult({
          document_id: input.document_id,
          file_name: doc.file_name,
          tables: [],
          total_tables: allTables.length,
          requested_index: input.table_index,
          message: `Table index ${input.table_index} out of range. Document has ${allTables.length} table(s).`,
          next_steps: tableNextSteps,
        }));
      }
      tables = [allTables[input.table_index]];
    } else {
      tables = allTables;
    }

    return formatResponse(successResult({
      document_id: input.document_id,
      file_name: doc.file_name,
      tables,
      total_tables: allTables.length,
      source: 'json_blocks',
      next_steps: tableNextSteps,
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: ocr_document_recommend
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle ocr_document_recommend - Cluster-based document recommendations
 *
 * Combines two signals:
 * 1. Cluster peers (documents in the same cluster)
 * 2. Vector similarity (centroid-based similar documents)
 */
async function handleDocumentRecommend(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentRecommendInput, params);
    const { db, vector } = requireDatabase();

    // Verify source document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    const conn = db.getConnection();
    const limit = input.limit ?? 10;

    // Map of document_id -> recommendation entry
    const recommendations = new Map<string, {
      cluster_match: boolean;
      cluster_ids: string[];
      similarity: number | null;
    }>();

    // ──────────────────────────────────────────────────────────────
    // Signal 1: Cluster peers
    // ──────────────────────────────────────────────────────────────
    const sourceClusters = conn.prepare(
      'SELECT cluster_id FROM document_clusters WHERE document_id = ?'
    ).all(input.document_id) as Array<{ cluster_id: string }>;

    if (sourceClusters.length > 0) {
      const clusterIds = sourceClusters.map(c => c.cluster_id);
      for (const clusterId of clusterIds) {
        const peers = conn.prepare(
          'SELECT document_id FROM document_clusters WHERE cluster_id = ? AND document_id != ?'
        ).all(clusterId, input.document_id) as Array<{ document_id: string }>;

        for (const peer of peers) {
          const existing = recommendations.get(peer.document_id);
          if (existing) {
            existing.cluster_match = true;
            existing.cluster_ids.push(clusterId);
          } else {
            recommendations.set(peer.document_id, {
              cluster_match: true,
              cluster_ids: [clusterId],
              similarity: null,
            });
          }
        }
      }
    }

    // ──────────────────────────────────────────────────────────────
    // Signal 2: Vector similarity (centroid approach)
    // ──────────────────────────────────────────────────────────────
    const embeddingRows = conn.prepare(
      'SELECT id FROM embeddings WHERE document_id = ? AND chunk_id IS NOT NULL'
    ).all(input.document_id) as Array<{ id: string }>;

    if (embeddingRows.length > 0) {
      const vectors: Float32Array[] = [];
      for (const row of embeddingRows) {
        const vec = vector.getVector(row.id);
        if (vec) vectors.push(vec);
      }

      if (vectors.length > 0) {
        // Compute centroid
        const dims = 768;
        const centroid = new Float32Array(dims);
        for (const vec of vectors) {
          for (let i = 0; i < dims; i++) {
            centroid[i] += vec[i];
          }
        }
        for (let i = 0; i < dims; i++) {
          centroid[i] /= vectors.length;
        }

        // Search for similar embeddings
        const searchResults = vector.searchSimilar(centroid, {
          limit: limit * 10,
          threshold: 0.4,
        });

        // Aggregate by document
        const docSimilarityMap = new Map<string, { totalSim: number; count: number }>();
        for (const r of searchResults) {
          if (r.document_id === input.document_id) continue;
          const entry = docSimilarityMap.get(r.document_id);
          if (entry) {
            entry.totalSim += r.similarity_score;
            entry.count += 1;
          } else {
            docSimilarityMap.set(r.document_id, { totalSim: r.similarity_score, count: 1 });
          }
        }

        for (const [docId, { totalSim, count }] of docSimilarityMap.entries()) {
          const avgSim = Math.round((totalSim / count) * 1000000) / 1000000;
          const existing = recommendations.get(docId);
          if (existing) {
            existing.similarity = avgSim;
          } else {
            recommendations.set(docId, {
              cluster_match: false,
              cluster_ids: [],
              similarity: avgSim,
            });
          }
        }
      }
    }

    // ──────────────────────────────────────────────────────────────
    // Merge, score, and rank
    // ──────────────────────────────────────────────────────────────
    const ranked: RecommendationEntry[] = [];
    for (const [docId, rec] of recommendations.entries()) {
      const recDoc = db.getDocument(docId);
      // Score: cluster match = 0.5 bonus, similarity = actual value
      const clusterBonus = rec.cluster_match ? 0.5 : 0;
      const simScore = rec.similarity ?? 0;
      const score = Math.round((clusterBonus + simScore) * 1000000) / 1000000;

      const reasons: string[] = [];
      if (rec.cluster_match) {
        reasons.push(`cluster_peer (clusters: ${rec.cluster_ids.join(', ')})`);
      }
      if (rec.similarity !== null) {
        reasons.push(`similar (score: ${rec.similarity})`);
      }

      ranked.push({
        document_id: docId,
        file_name: recDoc?.file_name ?? null,
        file_type: recDoc?.file_type ?? null,
        status: recDoc?.status ?? null,
        score,
        reasons,
        cluster_match: rec.cluster_match,
        similarity: rec.similarity,
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    const topRanked = ranked.slice(0, limit);

    return formatResponse(successResult({
      source_document_id: input.document_id,
      source_file_name: doc.file_name,
      source_cluster_count: sourceClusters.length,
      source_embedding_count: embeddingRows.length,
      recommendations: topRanked,
      total_candidates: ranked.length,
      returned: topRanked.length,
      next_steps: [{ tool: 'ocr_document_get', description: 'Get details for a recommended document' }, { tool: 'ocr_document_compare', description: 'Compare the source document with a recommendation' }],
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: ocr_document_extras
// ═══════════════════════════════════════════════════════════════════════════════

/** Known extras sections */
const KNOWN_EXTRAS_SECTIONS = ['charts', 'links', 'tracked_changes', 'table_row_bboxes', 'infographics'] as const;

/**
 * Handle ocr_document_extras - Surface extras_json data from OCR results
 */
async function handleDocumentExtras(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(DocumentExtrasInput, params);
    const { db } = requireDatabase();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw documentNotFoundError(input.document_id);
    }

    // Get extras_json from ocr_results
    const ocrRow = db.getConnection()
      .prepare('SELECT extras_json FROM ocr_results WHERE document_id = ?')
      .get(input.document_id) as { extras_json: string | null } | undefined;

    if (!ocrRow?.extras_json) {
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        extras: {},
        available_sections: [],
        message: 'No extras data available for this document.',
        next_steps: [{ tool: 'ocr_document_get', description: 'View document details' }],
      }));
    }

    let extras: Record<string, unknown>;
    try {
      extras = JSON.parse(ocrRow.extras_json) as Record<string, unknown>;
    } catch (parseErr) {
      console.error(`[DocumentExtras] Failed to parse extras_json for ${input.document_id}: ${String(parseErr)}`);
      throw new MCPError('INTERNAL_ERROR', `Failed to parse extras_json: ${String(parseErr)}`);
    }

    // Determine available sections
    const availableSections = Object.keys(extras).filter(
      key => extras[key] !== null && extras[key] !== undefined
    );

    // Filter by specific section if requested
    if (input.section) {
      if (!KNOWN_EXTRAS_SECTIONS.includes(input.section as typeof KNOWN_EXTRAS_SECTIONS[number]) &&
          !(input.section in extras)) {
        throw new MCPError('VALIDATION_ERROR',
          `Unknown section "${input.section}". Available sections: ${availableSections.join(', ')}`
        );
      }

      const sectionData = extras[input.section];
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        section: input.section,
        data: sectionData ?? null,
        available_sections: availableSections,
        next_steps: [{ tool: 'ocr_document_tables', description: 'Extract table data from the document' }, { tool: 'ocr_document_get', description: 'View core document metadata' }],
      }));
    }

    // Return all extras organized by section
    const organized: Record<string, unknown> = {};
    for (const section of KNOWN_EXTRAS_SECTIONS) {
      if (section in extras) {
        organized[section] = extras[section];
      }
    }

    // Include any non-standard sections
    for (const key of Object.keys(extras)) {
      if (!KNOWN_EXTRAS_SECTIONS.includes(key as typeof KNOWN_EXTRAS_SECTIONS[number])) {
        organized[key] = extras[key];
      }
    }

    return formatResponse(successResult({
      document_id: input.document_id,
      file_name: doc.file_name,
      extras: organized,
      available_sections: availableSections,
      next_steps: [{ tool: 'ocr_document_tables', description: 'Extract table data from the document' }, { tool: 'ocr_document_get', description: 'View core document metadata' }],
    }));
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Intelligence tools collection for MCP server registration
 */
export const intelligenceTools: Record<string, ToolDefinition> = {
  ocr_guide: {
    description:
      '[ESSENTIAL] System state overview with prioritized next_steps. Shows databases, stats, and tool recommendations. Optional intent: explore/search/ingest/analyze/status.',
    inputSchema: GuideInput.shape,
    handler: handleGuide,
  },
  ocr_document_tables: {
    description:
      '[ANALYSIS] Use to extract structured table data from a document. Returns rows, columns, and cell text for each table. Specify table_index for a specific table, or omit for all.',
    inputSchema: DocumentTablesInput.shape,
    handler: handleDocumentTables,
  },
  ocr_document_recommend: {
    description:
      '[ANALYSIS] Related document recommendations via cluster membership and vector similarity. Requires embeddings and/or clustering.',
    inputSchema: DocumentRecommendInput.shape,
    handler: handleDocumentRecommend,
  },
  ocr_document_extras: {
    description:
      '[ANALYSIS] Supplementary OCR data: charts, links, tracked changes, bounding boxes, infographics. Specify section to filter.',
    inputSchema: DocumentExtrasInput.shape,
    handler: handleDocumentExtras,
  },
};

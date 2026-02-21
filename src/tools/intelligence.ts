/**
 * Intelligence MCP Tools
 *
 * Tools: ocr_document_tables, ocr_document_recommend, ocr_document_extras
 *
 * Internal-only data access and analysis tools. No external API calls needed.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/intelligence
 */

import { z } from 'zod';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { validateInput } from '../utils/validation.js';
import { MCPError } from '../server/errors.js';
import { documentNotFoundError } from '../server/errors.js';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

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

    if (!ocrRow?.json_blocks) {
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        tables: [],
        total_tables: 0,
        source: 'no_ocr_results_or_blocks',
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
      }));
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return formatResponse(successResult({
        document_id: input.document_id,
        file_name: doc.file_name,
        tables: [],
        total_tables: 0,
        source: 'empty_json_blocks',
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
  ocr_document_tables: {
    description:
      'Extract structured table data from document JSON blocks. Returns rows, columns, and cell data for each table found in OCR results.',
    inputSchema: DocumentTablesInput.shape,
    handler: handleDocumentTables,
  },
  ocr_document_recommend: {
    description:
      'Get document recommendations based on cluster membership and vector similarity. Combines cluster peers with centroid-based similar documents.',
    inputSchema: DocumentRecommendInput.shape,
    handler: handleDocumentRecommend,
  },
  ocr_document_extras: {
    description:
      'Surface extras data from OCR results including charts, links, tracked changes, table row bounding boxes, and infographics.',
    inputSchema: DocumentExtrasInput.shape,
    handler: handleDocumentExtras,
  },
};

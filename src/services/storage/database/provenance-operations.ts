/**
 * Provenance operations for DatabaseService
 *
 * Handles all CRUD operations for provenance records including
 * chain traversal and tree queries.
 */

import Database from 'better-sqlite3';
import { ProvenanceRecord } from '../../../models/provenance.js';
import { ProvenanceRow } from './types.js';
import { runWithForeignKeyCheck } from './helpers.js';
import { rowToProvenance } from './converters.js';
import { computeChainHash } from '../../provenance/chain-hash.js';

/**
 * Insert a provenance record
 *
 * @param db - Database connection
 * @param record - Provenance record data
 * @returns string - The provenance record ID
 */
export function insertProvenance(db: Database.Database, record: ProvenanceRecord): string {
  // Compute chain_hash: SHA-256(content_hash + ":" + parent.chain_hash)
  // For root records (no parent): SHA-256(content_hash)
  let parentChainHash: string | null = null;
  if (record.parent_id) {
    try {
      const parentRow = db
        .prepare('SELECT chain_hash FROM provenance WHERE id = ?')
        .get(record.parent_id) as { chain_hash: string | null } | undefined;
      if (!parentRow) {
        console.error(
          `[CHAIN_HASH] Parent record ${record.parent_id} not found for provenance insertion. Chain hash will be computed without parent hash.`
        );
      }
      parentChainHash = parentRow?.chain_hash ?? null;
    } catch (err) {
      console.error(
        `[Provenance] Failed to lookup parent chain_hash for ${record.parent_id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const chainHash = computeChainHash(record.content_hash, parentChainHash);

  const stmt = db.prepare(`
    INSERT INTO provenance (
      id, type, created_at, processed_at, source_file_created_at,
      source_file_modified_at, source_type, source_path, source_id,
      root_document_id, location, content_hash, input_hash, file_hash,
      processor, processor_version, processing_params, processing_duration_ms,
      processing_quality_score, parent_id, parent_ids, chain_depth, chain_path,
      chain_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      record.id,
      record.type,
      record.created_at,
      record.processed_at,
      record.source_file_created_at,
      record.source_file_modified_at,
      record.source_type,
      record.source_path,
      record.source_id,
      record.root_document_id,
      record.location ? JSON.stringify(record.location) : null,
      record.content_hash,
      record.input_hash,
      record.file_hash,
      record.processor,
      record.processor_version,
      JSON.stringify(record.processing_params),
      record.processing_duration_ms,
      record.processing_quality_score,
      record.parent_id,
      record.parent_ids,
      record.chain_depth,
      record.chain_path,
      chainHash,
    ],
    'inserting provenance: source_id or parent_id does not exist'
  );

  return record.id;
}

/**
 * Get a provenance record by ID
 *
 * @param db - Database connection
 * @param id - Provenance record ID
 * @returns ProvenanceRecord | null - The provenance record or null if not found
 */
export function getProvenance(db: Database.Database, id: string): ProvenanceRecord | null {
  const stmt = db.prepare('SELECT * FROM provenance WHERE id = ?');
  const row = stmt.get(id) as ProvenanceRow | undefined;
  return row ? rowToProvenance(row) : null;
}

/**
 * Get the complete provenance chain for a record
 * Walks parent_id links from the given record to the root document
 *
 * @param db - Database connection
 * @param id - Starting provenance record ID
 * @returns ProvenanceRecord[] - Array ordered from current to root
 */
export function getProvenanceChain(db: Database.Database, id: string): ProvenanceRecord[] {
  const chain: ProvenanceRecord[] = [];
  let currentId: string | null = id;
  const seen = new Set<string>();

  const MAX_CHAIN_DEPTH = 100;
  let iterations = 0;
  while (currentId !== null) {
    if (seen.has(currentId)) {
      throw new Error(`Circular reference detected in provenance chain at record ${currentId}`);
    }
    seen.add(currentId);

    if (++iterations > MAX_CHAIN_DEPTH) {
      throw new Error(
        `Provenance chain walk exceeded ${MAX_CHAIN_DEPTH} iterations at record ${currentId} — ` +
          `possible circular reference. Chain collected so far: ${chain.length} records.`
      );
    }
    const record = getProvenance(db, currentId);
    if (!record) {
      break;
    }
    chain.push(record);
    currentId = record.parent_id;
  }

  return chain;
}

/**
 * Get all provenance records for a root document
 *
 * @param db - Database connection
 * @param rootDocumentId - The root document ID
 * @returns ProvenanceRecord[] - Array of all provenance records
 */
export function getProvenanceByRootDocument(
  db: Database.Database,
  rootDocumentId: string,
  options?: { limit?: number; offset?: number }
): ProvenanceRecord[] {
  let sql = 'SELECT * FROM provenance WHERE root_document_id = ? ORDER BY chain_depth';
  const params: (string | number)[] = [rootDocumentId];

  const limit = options?.limit ?? 10000;
  sql += ' LIMIT ?';
  params.push(limit);

  if (options?.offset !== undefined) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as ProvenanceRow[];
  return rows.map(rowToProvenance);
}

/**
 * Get child provenance records for a parent
 *
 * @param db - Database connection
 * @param parentId - Parent provenance record ID
 * @returns ProvenanceRecord[] - Array of child records
 */
export function getProvenanceChildren(db: Database.Database, parentId: string): ProvenanceRecord[] {
  const stmt = db.prepare(
    'SELECT * FROM provenance WHERE parent_id = ? ORDER BY created_at LIMIT 10000'
  );
  const rows = stmt.all(parentId) as ProvenanceRow[];
  return rows.map(rowToProvenance);
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY & ANALYTICS OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Filter options for querying provenance records
 */
export interface ProvenanceQueryFilters {
  processor?: string;
  type?: string;
  chain_depth?: number;
  created_after?: string;
  created_before?: string;
  min_quality_score?: number;
  min_duration_ms?: number;
  root_document_id?: string;
  limit?: number;
  offset?: number;
  order_by?: 'created_at' | 'processing_duration_ms' | 'processing_quality_score';
  order_dir?: 'asc' | 'desc';
}

/**
 * Query provenance records with dynamic filters
 *
 * Builds a parameterized SQL WHERE clause from provided filters.
 * All filters are optional. Default order: created_at DESC. Default limit: 50.
 *
 * @param db - Database connection
 * @param filters - Query filter options
 * @returns { records: ProvenanceRecord[], total: number }
 */
export function queryProvenance(
  db: Database.Database,
  filters: ProvenanceQueryFilters
): { records: ProvenanceRecord[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.processor !== undefined) {
    conditions.push('processor = ?');
    params.push(filters.processor);
  }

  if (filters.type !== undefined) {
    conditions.push('type = ?');
    params.push(filters.type);
  }

  if (filters.chain_depth !== undefined) {
    conditions.push('chain_depth = ?');
    params.push(filters.chain_depth);
  }

  if (filters.created_after !== undefined) {
    conditions.push('created_at >= ?');
    params.push(filters.created_after);
  }

  if (filters.created_before !== undefined) {
    conditions.push('created_at <= ?');
    params.push(filters.created_before);
  }

  if (filters.min_quality_score !== undefined) {
    conditions.push('processing_quality_score >= ?');
    params.push(filters.min_quality_score);
  }

  if (filters.min_duration_ms !== undefined) {
    conditions.push('processing_duration_ms >= ?');
    params.push(filters.min_duration_ms);
  }

  if (filters.root_document_id !== undefined) {
    conditions.push('root_document_id = ?');
    params.push(filters.root_document_id);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM provenance ${whereClause}`);
  const countRow = countStmt.get(...params) as { count: number };
  const total = countRow.count;

  // Validate and apply ordering with whitelist guard
  const VALID_ORDER_COLUMNS = new Set([
    'created_at',
    'processing_duration_ms',
    'processing_quality_score',
  ]);
  const orderBy = filters.order_by ?? 'created_at';
  if (!VALID_ORDER_COLUMNS.has(orderBy)) {
    throw new Error(`Invalid order column: ${orderBy}`);
  }
  const orderDir = filters.order_dir === 'asc' ? 'ASC' : 'DESC';

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const queryStmt = db.prepare(
    `SELECT * FROM provenance ${whereClause} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`
  );
  const rows = queryStmt.all(...params, limit, offset) as ProvenanceRow[];

  return {
    records: rows.map(rowToProvenance),
    total,
  };
}

/**
 * Processor statistics result
 */
export interface ProvenanceProcessorStat {
  processor: string;
  processor_version: string;
  total_operations: number;
  avg_duration_ms: number;
  min_duration_ms: number;
  max_duration_ms: number;
  avg_quality_score: number | null;
  total_processing_time_ms: number;
}

/**
 * Get aggregate statistics per processor/version
 *
 * Groups by processor and processor_version with AVG, MIN, MAX, SUM, COUNT
 * aggregations on processing_duration_ms and processing_quality_score.
 *
 * @param db - Database connection
 * @param filters - Optional filters for processor, created_after, created_before
 * @returns Array of per-processor stats
 */
export function getProvenanceProcessorStats(
  db: Database.Database,
  filters?: {
    processor?: string;
    created_after?: string;
    created_before?: string;
  }
): ProvenanceProcessorStat[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.processor !== undefined) {
    conditions.push('processor = ?');
    params.push(filters.processor);
  }

  if (filters?.created_after !== undefined) {
    conditions.push('created_at >= ?');
    params.push(filters.created_after);
  }

  if (filters?.created_before !== undefined) {
    conditions.push('created_at <= ?');
    params.push(filters.created_before);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const stmt = db.prepare(`
    SELECT
      processor,
      processor_version,
      COUNT(*) as total_operations,
      COALESCE(AVG(processing_duration_ms), 0) as avg_duration_ms,
      COALESCE(MIN(processing_duration_ms), 0) as min_duration_ms,
      COALESCE(MAX(processing_duration_ms), 0) as max_duration_ms,
      AVG(processing_quality_score) as avg_quality_score,
      COALESCE(SUM(processing_duration_ms), 0) as total_processing_time_ms
    FROM provenance
    ${whereClause}
    GROUP BY processor, processor_version
    ORDER BY total_operations DESC
  `);

  const rows = stmt.all(...params) as Array<{
    processor: string;
    processor_version: string;
    total_operations: number;
    avg_duration_ms: number;
    min_duration_ms: number;
    max_duration_ms: number;
    avg_quality_score: number | null;
    total_processing_time_ms: number;
  }>;

  return rows.map((row) => ({
    processor: row.processor,
    processor_version: row.processor_version,
    total_operations: row.total_operations,
    avg_duration_ms: Math.round(row.avg_duration_ms * 100) / 100,
    min_duration_ms: row.min_duration_ms,
    max_duration_ms: row.max_duration_ms,
    avg_quality_score:
      row.avg_quality_score !== null ? Math.round(row.avg_quality_score * 100) / 100 : null,
    total_processing_time_ms: row.total_processing_time_ms,
  }));
}

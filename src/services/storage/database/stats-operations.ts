/**
 * Statistics operations for DatabaseService
 *
 * Handles database statistics retrieval.
 */

import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { DatabaseStats } from './types.js';

/**
 * Get database statistics
 *
 * @param db - Database connection
 * @param name - Database name
 * @param path - Database file path
 * @returns DatabaseStats - Live statistics from database
 */
export function getStats(db: Database.Database, name: string, path: string): DatabaseStats {
  const docStats = db
    .prepare(
      `
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'complete') as complete,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) as total
    FROM documents
  `
    )
    .get() as {
    pending: number;
    processing: number;
    complete: number;
    failed: number;
    total: number;
  };

  const chunkStats = db
    .prepare(
      `
    SELECT
      COUNT(*) FILTER (WHERE embedding_status = 'pending') as pending,
      COUNT(*) FILTER (WHERE embedding_status = 'complete') as complete,
      COUNT(*) FILTER (WHERE embedding_status = 'failed') as failed,
      COUNT(*) as total
    FROM chunks
  `
    )
    .get() as {
    pending: number;
    complete: number;
    failed: number;
    total: number;
  };

  const otherCounts = db
    .prepare(
      `
    SELECT
      (SELECT COUNT(*) FROM ocr_results) as ocr_count,
      (SELECT COUNT(*) FROM embeddings) as embedding_count,
      (SELECT COUNT(*) FROM provenance) as provenance_count,
      (SELECT COUNT(*) FROM images) as image_count,
      (SELECT COUNT(*) FROM extractions) as extraction_count,
      (SELECT COUNT(*) FROM form_fills) as form_fill_count,
      (SELECT COUNT(*) FROM comparisons) as comparison_count,
      (SELECT COUNT(*) FROM clusters) as cluster_count
  `
    )
    .get() as {
    ocr_count: number;
    embedding_count: number;
    provenance_count: number;
    image_count: number;
    extraction_count: number;
    form_fill_count: number;
    comparison_count: number;
    cluster_count: number;
  };

  const embeddingCount = otherCounts.embedding_count;

  const qualityCosts = db
    .prepare(
      `
    SELECT
      (SELECT AVG(parse_quality_score) FROM ocr_results WHERE parse_quality_score IS NOT NULL) as avg_quality,
      (SELECT MIN(parse_quality_score) FROM ocr_results WHERE parse_quality_score IS NOT NULL) as min_quality,
      (SELECT MAX(parse_quality_score) FROM ocr_results WHERE parse_quality_score IS NOT NULL) as max_quality,
      (SELECT COUNT(parse_quality_score) FROM ocr_results WHERE parse_quality_score IS NOT NULL) as quality_count,
      (SELECT COALESCE(SUM(cost_cents), 0) FROM ocr_results) as total_ocr_cost,
      (SELECT COALESCE(SUM(cost_cents), 0) FROM form_fills) as total_form_fill_cost
  `
    )
    .get() as {
    avg_quality: number | null;
    min_quality: number | null;
    max_quality: number | null;
    quality_count: number;
    total_ocr_cost: number;
    total_form_fill_cost: number;
  };

  const stats = statSync(path);

  const avgChunksPerDocument = docStats.total > 0 ? chunkStats.total / docStats.total : 0;
  const avgEmbeddingsPerChunk = chunkStats.total > 0 ? embeddingCount / chunkStats.total : 0;

  return {
    name,
    total_documents: docStats.total,
    documents_by_status: {
      pending: docStats.pending,
      processing: docStats.processing,
      complete: docStats.complete,
      failed: docStats.failed,
    },
    total_ocr_results: otherCounts.ocr_count,
    total_chunks: chunkStats.total,
    chunks_by_embedding_status: {
      pending: chunkStats.pending,
      complete: chunkStats.complete,
      failed: chunkStats.failed,
    },
    total_embeddings: embeddingCount,
    total_images: otherCounts.image_count,
    total_extractions: otherCounts.extraction_count,
    total_form_fills: otherCounts.form_fill_count,
    total_comparisons: otherCounts.comparison_count,
    total_clusters: otherCounts.cluster_count,
    total_provenance: otherCounts.provenance_count,
    storage_size_bytes: stats.size,
    avg_chunks_per_document: avgChunksPerDocument,
    avg_embeddings_per_chunk: avgEmbeddingsPerChunk,
    ocr_quality: {
      avg: qualityCosts.avg_quality,
      min: qualityCosts.min_quality,
      max: qualityCosts.max_quality,
      scored_count: qualityCosts.quality_count,
    },
    costs: {
      total_ocr_cost_cents: qualityCosts.total_ocr_cost,
      total_form_fill_cost_cents: qualityCosts.total_form_fill_cost,
      total_cost_cents: qualityCosts.total_ocr_cost + qualityCosts.total_form_fill_cost,
    },
  };
}

/**
 * Update metadata counts from actual table counts
 *
 * @param db - Database connection
 */
export function updateMetadataCounts(db: Database.Database): void {
  const now = new Date().toISOString();

  // M-2: Single query for all counts instead of 4 separate COUNT(*) scans
  const counts = db
    .prepare(
      `
    SELECT
      (SELECT COUNT(*) FROM documents) as doc_count,
      (SELECT COUNT(*) FROM ocr_results) as ocr_count,
      (SELECT COUNT(*) FROM chunks) as chunk_count,
      (SELECT COUNT(*) FROM embeddings) as emb_count
  `
    )
    .get() as { doc_count: number; ocr_count: number; chunk_count: number; emb_count: number };

  db.prepare(
    `
    UPDATE database_metadata
    SET total_documents = ?, total_ocr_results = ?, total_chunks = ?,
        total_embeddings = ?, last_modified_at = ?
    WHERE id = 1
  `
  ).run(counts.doc_count, counts.ocr_count, counts.chunk_count, counts.emb_count, now);
}

/**
 * Update metadata last_modified_at timestamp
 *
 * @param db - Database connection
 */
export function updateMetadataModified(db: Database.Database): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE database_metadata SET last_modified_at = ? WHERE id = 1
  `);
  stmt.run(now);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMELINE STATS
// ═══════════════════════════════════════════════════════════════════════════════

export type TimelineBucket = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type TimelineMetric = 'documents' | 'pages' | 'chunks' | 'embeddings' | 'images' | 'cost';

export interface TimelineStatsOptions {
  bucket: TimelineBucket;
  metric: TimelineMetric;
  created_after?: string;
  created_before?: string;
}

export interface TimelineDataPoint {
  period: string;
  count: number;
  total?: number;
}

/**
 * Get strftime format string for the given bucket type
 */
function getBucketFormat(bucket: TimelineBucket): string {
  switch (bucket) {
    case 'hourly':
      return '%Y-%m-%d %H:00';
    case 'daily':
      return '%Y-%m-%d';
    case 'weekly':
      return '%Y-W%W';
    case 'monthly':
      return '%Y-%m';
  }
}

/**
 * Get processing volume over time buckets for various metrics.
 *
 * @param db - Database connection
 * @param options - Bucket type, metric, optional date range
 * @returns Array of { period, count, total? } data points
 */
export function getTimelineStats(
  db: Database.Database,
  options: TimelineStatsOptions
): TimelineDataPoint[] {
  const format = getBucketFormat(options.bucket);
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Build metric-specific query
  let table: string;
  let dateColumn: string;
  let selectExpr: string;

  switch (options.metric) {
    case 'documents':
      table = 'documents';
      dateColumn = 'created_at';
      selectExpr = 'COUNT(*) as count';
      break;
    case 'pages':
      table = 'documents';
      dateColumn = 'created_at';
      selectExpr = 'COALESCE(SUM(page_count), 0) as count';
      break;
    case 'chunks':
      table = 'chunks';
      dateColumn = 'created_at';
      selectExpr = 'COUNT(*) as count';
      break;
    case 'embeddings':
      table = 'embeddings';
      dateColumn = 'created_at';
      selectExpr = 'COUNT(*) as count';
      break;
    case 'images':
      table = 'images';
      dateColumn = 'created_at';
      selectExpr = 'COUNT(*) as count';
      break;
    case 'cost':
      table = 'ocr_results';
      dateColumn = 'processing_completed_at';
      selectExpr = 'COALESCE(SUM(cost_cents), 0) as count';
      break;
  }

  if (options.created_after) {
    conditions.push(`${dateColumn} >= ?`);
    params.push(options.created_after);
  }
  if (options.created_before) {
    conditions.push(`${dateColumn} <= ?`);
    params.push(options.created_before);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      strftime('${format}', ${dateColumn}) as period,
      ${selectExpr}
    FROM ${table}
    ${whereClause}
    GROUP BY period
    ORDER BY period ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<{ period: string | null; count: number }>;

  // Filter out null periods (rows with null dateColumn values)
  return rows
    .filter((r) => r.period !== null)
    .map((r) => ({
      period: r.period as string,
      count: r.count,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUALITY TRENDS
// ═══════════════════════════════════════════════════════════════════════════════

export interface QualityTrendOptions {
  bucket: TimelineBucket;
  group_by?: 'none' | 'ocr_mode' | 'processor';
  created_after?: string;
  created_before?: string;
}

export interface QualityTrendDataPoint {
  period: string;
  avg_quality: number;
  min_quality: number;
  max_quality: number;
  sample_count: number;
  group?: string;
}

/**
 * Get quality score trends over time, optionally grouped by OCR mode or processor.
 *
 * Uses ocr_results.parse_quality_score for ocr_mode grouping,
 * and provenance.processing_quality_score for processor grouping.
 *
 * @param db - Database connection
 * @param options - Bucket type, group_by, optional date range
 * @returns Array of quality trend data points
 */
export function getQualityTrends(
  db: Database.Database,
  options: QualityTrendOptions
): QualityTrendDataPoint[] {
  const format = getBucketFormat(options.bucket);
  const groupBy = options.group_by || 'none';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (groupBy === 'processor') {
    // Use provenance table for processor grouping
    conditions.push('processing_quality_score IS NOT NULL');

    if (options.created_after) {
      conditions.push('created_at >= ?');
      params.push(options.created_after);
    }
    if (options.created_before) {
      conditions.push('created_at <= ?');
      params.push(options.created_before);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      SELECT
        strftime('${format}', created_at) as period,
        processor as grp,
        AVG(processing_quality_score) as avg_quality,
        MIN(processing_quality_score) as min_quality,
        MAX(processing_quality_score) as max_quality,
        COUNT(*) as sample_count
      FROM provenance
      ${whereClause}
      GROUP BY period, grp
      ORDER BY period ASC, grp ASC
    `;

    const rows = db.prepare(sql).all(...params) as Array<{
      period: string | null;
      grp: string;
      avg_quality: number;
      min_quality: number;
      max_quality: number;
      sample_count: number;
    }>;

    return rows
      .filter((r) => r.period !== null)
      .map((r) => ({
        period: r.period as string,
        avg_quality: Math.round(r.avg_quality * 100) / 100,
        min_quality: Math.round(r.min_quality * 100) / 100,
        max_quality: Math.round(r.max_quality * 100) / 100,
        sample_count: r.sample_count,
        group: r.grp,
      }));
  } else {
    // Use ocr_results table for no grouping or ocr_mode grouping
    conditions.push('parse_quality_score IS NOT NULL');

    if (options.created_after) {
      conditions.push('processing_completed_at >= ?');
      params.push(options.created_after);
    }
    if (options.created_before) {
      conditions.push('processing_completed_at <= ?');
      params.push(options.created_before);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const groupByColumn = groupBy === 'ocr_mode' ? ', datalab_mode' : '';
    const selectGroup = groupBy === 'ocr_mode' ? ', datalab_mode as grp' : '';

    const sql = `
      SELECT
        strftime('${format}', processing_completed_at) as period
        ${selectGroup},
        AVG(parse_quality_score) as avg_quality,
        MIN(parse_quality_score) as min_quality,
        MAX(parse_quality_score) as max_quality,
        COUNT(*) as sample_count
      FROM ocr_results
      ${whereClause}
      GROUP BY period${groupByColumn}
      ORDER BY period ASC${groupBy === 'ocr_mode' ? ', grp ASC' : ''}
    `;

    const rows = db.prepare(sql).all(...params) as Array<{
      period: string | null;
      grp?: string;
      avg_quality: number;
      min_quality: number;
      max_quality: number;
      sample_count: number;
    }>;

    return rows
      .filter((r) => r.period !== null)
      .map((r) => ({
        period: r.period as string,
        avg_quality: Math.round(r.avg_quality * 100) / 100,
        min_quality: Math.round(r.min_quality * 100) / 100,
        max_quality: Math.round(r.max_quality * 100) / 100,
        sample_count: r.sample_count,
        ...(groupBy === 'ocr_mode' && r.grp !== undefined ? { group: r.grp } : {}),
      }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THROUGHPUT ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ThroughputOptions {
  bucket: TimelineBucket;
  created_after?: string;
  created_before?: string;
}

export interface ThroughputDataPoint {
  period: string;
  pages_processed: number;
  embeddings_generated: number;
  images_processed: number;
  total_ocr_duration_ms: number;
  total_embedding_duration_ms: number;
  avg_ms_per_page: number;
  avg_ms_per_embedding: number;
}

/**
 * Get processing throughput metrics per time bucket.
 *
 * Queries provenance table for OCR_RESULT, EMBEDDING, and IMAGE types
 * to compute per-bucket throughput rates.
 *
 * @param db - Database connection
 * @param options - Bucket type, optional date range
 * @returns Array of throughput data points per bucket
 */
export function getThroughputAnalytics(
  db: Database.Database,
  options: ThroughputOptions
): ThroughputDataPoint[] {
  const format = getBucketFormat(options.bucket);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.created_after) {
    conditions.push('p.created_at >= ?');
    params.push(options.created_after);
  }
  if (options.created_before) {
    conditions.push('p.created_at <= ?');
    params.push(options.created_before);
  }

  const extraWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  // Use a single query with conditional aggregation across types
  const sql = `
    SELECT
      strftime('${format}', p.created_at) as period,
      COALESCE(SUM(CASE WHEN p.type = 'OCR_RESULT' THEN 1 ELSE 0 END), 0) as pages_processed,
      COALESCE(SUM(CASE WHEN p.type = 'EMBEDDING' THEN 1 ELSE 0 END), 0) as embeddings_generated,
      COALESCE(SUM(CASE WHEN p.type = 'IMAGE' THEN 1 ELSE 0 END), 0) as images_processed,
      COALESCE(SUM(CASE WHEN p.type = 'OCR_RESULT' THEN p.processing_duration_ms ELSE 0 END), 0) as total_ocr_duration_ms,
      COALESCE(SUM(CASE WHEN p.type = 'EMBEDDING' THEN p.processing_duration_ms ELSE 0 END), 0) as total_embedding_duration_ms
    FROM provenance p
    WHERE p.type IN ('OCR_RESULT', 'EMBEDDING', 'IMAGE')
      ${extraWhere}
    GROUP BY period
    ORDER BY period ASC
  `;

  // Duplicate params for each condition usage (they apply once)
  const rows = db.prepare(sql).all(...params) as Array<{
    period: string | null;
    pages_processed: number;
    embeddings_generated: number;
    images_processed: number;
    total_ocr_duration_ms: number;
    total_embedding_duration_ms: number;
  }>;

  return rows
    .filter((r) => r.period !== null)
    .map((r) => ({
      period: r.period as string,
      pages_processed: r.pages_processed,
      embeddings_generated: r.embeddings_generated,
      images_processed: r.images_processed,
      total_ocr_duration_ms: r.total_ocr_duration_ms,
      total_embedding_duration_ms: r.total_embedding_duration_ms,
      avg_ms_per_page:
        r.pages_processed > 0
          ? Math.round((r.total_ocr_duration_ms / r.pages_processed) * 100) / 100
          : 0,
      avg_ms_per_embedding:
        r.embeddings_generated > 0
          ? Math.round((r.total_embedding_duration_ms / r.embeddings_generated) * 100) / 100
          : 0,
    }));
}

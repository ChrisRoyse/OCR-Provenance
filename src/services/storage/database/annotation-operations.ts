/**
 * Annotation Database Operations
 *
 * CRUD operations for document annotations with threading support.
 * Annotations can be attached to documents or specific chunks, with
 * optional page numbers and threaded replies via parent_id.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module database/annotation-operations
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface CreateAnnotationParams {
  document_id: string;
  user_id?: string | null;
  chunk_id?: string | null;
  page_number?: number | null;
  annotation_type: string;
  content: string;
  parent_id?: string | null;
}

export interface AnnotationRow {
  id: string;
  document_id: string;
  user_id: string | null;
  chunk_id: string | null;
  page_number: number | null;
  annotation_type: string;
  content: string;
  status: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListAnnotationsOptions {
  document_id: string;
  annotation_type?: string;
  status?: string;
  user_id?: string;
  page_number?: number;
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANNOTATION CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new annotation on a document or chunk.
 *
 * @param conn - Database connection
 * @param params - Annotation creation parameters
 * @returns The created annotation row
 * @throws Error if document, chunk, or parent annotation not found
 */
export function createAnnotation(
  conn: Database.Database,
  params: CreateAnnotationParams
): AnnotationRow {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Validate document exists
  const doc = conn.prepare('SELECT id FROM documents WHERE id = ?').get(params.document_id);
  if (!doc) {
    throw new Error(`Document not found: ${params.document_id}`);
  }

  // Validate chunk exists if provided
  if (params.chunk_id) {
    const chunk = conn.prepare('SELECT id FROM chunks WHERE id = ?').get(params.chunk_id);
    if (!chunk) {
      throw new Error(`Chunk not found: ${params.chunk_id}`);
    }
  }

  // Validate parent exists if provided (for threaded replies)
  if (params.parent_id) {
    const parent = conn.prepare('SELECT id FROM annotations WHERE id = ?').get(params.parent_id);
    if (!parent) {
      throw new Error(`Parent annotation not found: ${params.parent_id}`);
    }
  }

  conn
    .prepare(
      `
    INSERT INTO annotations (id, document_id, user_id, chunk_id, page_number, annotation_type, content, status, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `
    )
    .run(
      id,
      params.document_id,
      params.user_id ?? null,
      params.chunk_id ?? null,
      params.page_number ?? null,
      params.annotation_type,
      params.content,
      params.parent_id ?? null,
      now,
      now
    );

  return conn.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow;
}

/**
 * Get an annotation by ID.
 *
 * @param conn - Database connection
 * @param id - Annotation ID
 * @returns The annotation row or null if not found
 */
export function getAnnotation(conn: Database.Database, id: string): AnnotationRow | null {
  return (conn.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow) ?? null;
}

/**
 * Get an annotation with its threaded replies.
 *
 * @param conn - Database connection
 * @param id - Annotation ID
 * @returns The annotation and its replies, or null if not found
 */
export function getAnnotationWithThread(
  conn: Database.Database,
  id: string
): { annotation: AnnotationRow; replies: AnnotationRow[] } | null {
  const annotation = getAnnotation(conn, id);
  if (!annotation) return null;

  const replies = conn
    .prepare('SELECT * FROM annotations WHERE parent_id = ? ORDER BY created_at ASC')
    .all(id) as AnnotationRow[];

  return { annotation, replies };
}

/**
 * List annotations for a document with optional filters.
 *
 * @param conn - Database connection
 * @param opts - Filter and pagination options
 * @returns Paginated annotations and total count
 */
export function listAnnotations(
  conn: Database.Database,
  opts: ListAnnotationsOptions
): { annotations: AnnotationRow[]; total: number } {
  const conditions: string[] = ['document_id = ?'];
  const params: unknown[] = [opts.document_id];

  if (opts.annotation_type) {
    conditions.push('annotation_type = ?');
    params.push(opts.annotation_type);
  }
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (opts.user_id) {
    conditions.push('user_id = ?');
    params.push(opts.user_id);
  }
  if (opts.page_number !== undefined) {
    conditions.push('page_number = ?');
    params.push(opts.page_number);
  }

  const where = conditions.join(' AND ');

  const totalRow = conn
    .prepare(`SELECT COUNT(*) as c FROM annotations WHERE ${where}`)
    .get(...params) as { c: number };

  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const annotations = conn
    .prepare(`SELECT * FROM annotations WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as AnnotationRow[];

  return { annotations, total: totalRow.c };
}

/**
 * Update an annotation's content and/or status.
 *
 * @param conn - Database connection
 * @param id - Annotation ID
 * @param updates - Fields to update (content and/or status)
 * @returns The updated annotation row
 * @throws Error if annotation not found
 */
export function updateAnnotation(
  conn: Database.Database,
  id: string,
  updates: { content?: string; status?: string }
): AnnotationRow {
  const annotation = getAnnotation(conn, id);
  if (!annotation) {
    throw new Error(`Annotation not found: ${id}`);
  }

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];

  if (updates.content !== undefined) {
    sets.push('content = ?');
    params.push(updates.content);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }

  params.push(id);
  conn.prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return conn.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow;
}

/**
 * Delete an annotation by ID.
 * Child annotations (replies) are cascade-deleted by the FK constraint.
 *
 * @param conn - Database connection
 * @param id - Annotation ID
 * @throws Error if annotation not found
 */
export function deleteAnnotation(conn: Database.Database, id: string): void {
  const annotation = getAnnotation(conn, id);
  if (!annotation) {
    throw new Error(`Annotation not found: ${id}`);
  }
  conn.prepare('DELETE FROM annotations WHERE id = ?').run(id);
}

/**
 * Get annotation summary statistics for a document.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @returns Summary with counts by type, status, and totals
 */
export function getAnnotationSummary(
  conn: Database.Database,
  documentId: string
): Record<string, unknown> {
  const byType = conn
    .prepare(
      `
    SELECT annotation_type, status, COUNT(*) as count
    FROM annotations WHERE document_id = ?
    GROUP BY annotation_type, status
  `
    )
    .all(documentId) as { annotation_type: string; status: string; count: number }[];

  const totalOpen = conn
    .prepare(`SELECT COUNT(*) as c FROM annotations WHERE document_id = ? AND status = 'open'`)
    .get(documentId) as { c: number };

  const totalResolved = conn
    .prepare(`SELECT COUNT(*) as c FROM annotations WHERE document_id = ? AND status = 'resolved'`)
    .get(documentId) as { c: number };

  const totalDismissed = conn
    .prepare(`SELECT COUNT(*) as c FROM annotations WHERE document_id = ? AND status = 'dismissed'`)
    .get(documentId) as { c: number };

  return {
    document_id: documentId,
    total_open: totalOpen.c,
    total_resolved: totalResolved.c,
    total_dismissed: totalDismissed.c,
    total: totalOpen.c + totalResolved.c + totalDismissed.c,
    by_type_and_status: byType,
  };
}

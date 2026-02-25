/**
 * Obligation Operations for DatabaseService
 *
 * Provides CRUD and query operations for the obligations table.
 * Obligations track contract deadlines, deliverables, and compliance items.
 *
 * @module database/obligation-operations
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// TYPES
// =============================================================================

export interface Obligation {
  id: string;
  document_id: string;
  extraction_id: string | null;
  obligation_type: string;
  description: string;
  responsible_party: string | null;
  due_date: string | null;
  recurring: string | null;
  status: string;
  source_chunk_id: string | null;
  source_page: number | null;
  confidence: number;
  created_at: string;
  metadata_json: string;
}

export const OBLIGATION_TYPES = [
  'payment',
  'delivery',
  'notification',
  'renewal',
  'termination',
  'compliance',
  'reporting',
  'approval',
  'other',
] as const;

export const OBLIGATION_STATUSES = ['active', 'fulfilled', 'overdue', 'waived', 'expired'] as const;

export type ObligationType = (typeof OBLIGATION_TYPES)[number];
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export interface CreateObligationParams {
  document_id: string;
  extraction_id?: string | null;
  obligation_type: ObligationType;
  description: string;
  responsible_party?: string | null;
  due_date?: string | null;
  recurring?: string | null;
  status?: ObligationStatus;
  source_chunk_id?: string | null;
  source_page?: number | null;
  confidence?: number;
  metadata_json?: string;
}

export interface ListObligationsFilters {
  document_id?: string;
  obligation_type?: ObligationType;
  status?: ObligationStatus;
  due_before?: string;
  due_after?: string;
  responsible_party?: string;
  limit?: number;
  offset?: number;
}

export interface CalendarOptions {
  months_ahead?: number;
  status?: ObligationStatus;
  document_id?: string;
}

export interface CalendarMonth {
  month: string; // YYYY-MM
  obligations: Obligation[];
}

// =============================================================================
// CREATE
// =============================================================================

/**
 * Create a new obligation
 */
export function createObligation(
  db: Database.Database,
  params: CreateObligationParams
): Obligation {
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO obligations (id, document_id, extraction_id, obligation_type, description,
      responsible_party, due_date, recurring, status, source_chunk_id, source_page,
      confidence, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    params.document_id,
    params.extraction_id ?? null,
    params.obligation_type,
    params.description,
    params.responsible_party ?? null,
    params.due_date ?? null,
    params.recurring ?? null,
    params.status ?? 'active',
    params.source_chunk_id ?? null,
    params.source_page ?? null,
    params.confidence ?? 1.0,
    now,
    params.metadata_json ?? '{}'
  );

  return {
    id,
    document_id: params.document_id,
    extraction_id: params.extraction_id ?? null,
    obligation_type: params.obligation_type,
    description: params.description,
    responsible_party: params.responsible_party ?? null,
    due_date: params.due_date ?? null,
    recurring: params.recurring ?? null,
    status: params.status ?? 'active',
    source_chunk_id: params.source_chunk_id ?? null,
    source_page: params.source_page ?? null,
    confidence: params.confidence ?? 1.0,
    created_at: now,
    metadata_json: params.metadata_json ?? '{}',
  };
}

// =============================================================================
// LIST WITH FILTERS
// =============================================================================

/**
 * List obligations with optional filters
 */
export function listObligations(
  db: Database.Database,
  filters: ListObligationsFilters
): { obligations: Obligation[]; total: number } {
  const conditions: string[] = [];
  const queryParams: (string | number)[] = [];

  if (filters.document_id) {
    conditions.push('o.document_id = ?');
    queryParams.push(filters.document_id);
  }
  if (filters.obligation_type) {
    conditions.push('o.obligation_type = ?');
    queryParams.push(filters.obligation_type);
  }
  if (filters.status) {
    conditions.push('o.status = ?');
    queryParams.push(filters.status);
  }
  if (filters.due_before) {
    conditions.push('o.due_date IS NOT NULL AND o.due_date <= ?');
    queryParams.push(filters.due_before);
  }
  if (filters.due_after) {
    conditions.push('o.due_date IS NOT NULL AND o.due_date >= ?');
    queryParams.push(filters.due_after);
  }
  if (filters.responsible_party) {
    conditions.push('o.responsible_party = ?');
    queryParams.push(filters.responsible_party);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db
    .prepare(`SELECT COUNT(*) as cnt FROM obligations o ${whereClause}`)
    .get(...queryParams) as { cnt: number };

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const obligations = db
    .prepare(
      `
    SELECT o.* FROM obligations o
    ${whereClause}
    ORDER BY o.due_date ASC NULLS LAST, o.created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(...queryParams, limit, offset) as Obligation[];

  return { obligations, total: countRow.cnt };
}

// =============================================================================
// UPDATE STATUS
// =============================================================================

/**
 * Update obligation status
 * @throws Error if obligation not found
 */
export function updateObligationStatus(
  db: Database.Database,
  id: string,
  status: ObligationStatus,
  reason?: string
): Obligation {
  const existing = db.prepare('SELECT * FROM obligations WHERE id = ?').get(id) as
    | Obligation
    | undefined;
  if (!existing) {
    throw new Error(`Obligation not found: ${id}`);
  }

  // Update metadata with status change reason if provided
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(existing.metadata_json || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  if (reason) {
    const statusHistory = (metadata.status_history as Array<Record<string, string>>) ?? [];
    statusHistory.push({
      from: existing.status,
      to: status,
      reason,
      changed_at: new Date().toISOString(),
    });
    metadata.status_history = statusHistory;
  }

  db.prepare(
    `
    UPDATE obligations SET status = ?, metadata_json = ? WHERE id = ?
  `
  ).run(status, JSON.stringify(metadata), id);

  return {
    ...existing,
    status,
    metadata_json: JSON.stringify(metadata),
  };
}

// =============================================================================
// CALENDAR VIEW
// =============================================================================

/**
 * Get obligations grouped by month for calendar view
 */
export function getObligationCalendar(
  db: Database.Database,
  options: CalendarOptions
): CalendarMonth[] {
  const monthsAhead = options.months_ahead ?? 3;
  const now = new Date();
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + monthsAhead);

  const conditions: string[] = ['o.due_date IS NOT NULL', 'o.due_date >= ?', 'o.due_date <= ?'];
  const queryParams: (string | number)[] = [now.toISOString(), endDate.toISOString()];

  if (options.status) {
    conditions.push('o.status = ?');
    queryParams.push(options.status);
  }
  if (options.document_id) {
    conditions.push('o.document_id = ?');
    queryParams.push(options.document_id);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const obligations = db
    .prepare(
      `
    SELECT o.* FROM obligations o
    ${whereClause}
    ORDER BY o.due_date ASC
  `
    )
    .all(...queryParams) as Obligation[];

  // Group by month
  const monthMap = new Map<string, Obligation[]>();
  for (const ob of obligations) {
    if (!ob.due_date) continue;
    const month = ob.due_date.substring(0, 7); // YYYY-MM
    const existing = monthMap.get(month);
    if (existing) {
      existing.push(ob);
    } else {
      monthMap.set(month, [ob]);
    }
  }

  // Convert to sorted array
  const result: CalendarMonth[] = [];
  for (const [month, obs] of monthMap.entries()) {
    result.push({ month, obligations: obs });
  }
  result.sort((a, b) => a.month.localeCompare(b.month));

  return result;
}

// =============================================================================
// MARK OVERDUE
// =============================================================================

/**
 * Mark active obligations with past due dates as overdue
 * @returns Number of obligations marked overdue
 */
export function markOverdueObligations(db: Database.Database): number {
  const result = db
    .prepare(
      `
    UPDATE obligations
    SET status = 'overdue'
    WHERE due_date < datetime('now')
      AND status = 'active'
      AND due_date IS NOT NULL
  `
    )
    .run();

  return result.changes;
}

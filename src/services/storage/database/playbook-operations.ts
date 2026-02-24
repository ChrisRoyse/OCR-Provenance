/**
 * Playbook Operations for DatabaseService
 *
 * Provides CRUD operations for the playbooks table and clause comparison.
 * Playbooks define preferred contract terms for deviation detection.
 *
 * @module database/playbook-operations
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { ContractClause } from '../../clm/contract-schemas.js';

export type { ContractClause };

export interface Playbook {
  id: string;
  name: string;
  description: string | null;
  clauses_json: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface PlaybookWithClauses extends Omit<Playbook, 'clauses_json'> {
  clauses: ContractClause[];
}

export interface ClauseComparisonResult {
  clause_name: string;
  severity: 'critical' | 'major' | 'minor';
  status: 'match' | 'alternative_match' | 'deviation' | 'missing';
  preferred_text: string;
  matched_text: string | null;
  matched_chunk_id: string | null;
  matched_page: number | null;
  details: string;
}

export interface PlaybookComparisonResult {
  playbook_id: string;
  playbook_name: string;
  document_id: string;
  total_clauses: number;
  matches: number;
  alternative_matches: number;
  deviations: number;
  missing: number;
  compliance_score: number;
  clause_results: ClauseComparisonResult[];
}

// =============================================================================
// CREATE
// =============================================================================

/**
 * Create a new playbook with clauses
 */
export function createPlaybook(
  db: Database.Database,
  params: {
    name: string;
    description?: string | null;
    clauses: ContractClause[];
    created_by?: string | null;
  }
): PlaybookWithClauses {
  const id = uuidv4();
  const now = new Date().toISOString();
  const clausesJson = JSON.stringify(params.clauses);

  db.prepare(`
    INSERT INTO playbooks (id, name, description, clauses_json, created_at, updated_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.name,
    params.description ?? null,
    clausesJson,
    now,
    now,
    params.created_by ?? null,
  );

  return {
    id,
    name: params.name,
    description: params.description ?? null,
    clauses: params.clauses,
    created_at: now,
    updated_at: now,
    created_by: params.created_by ?? null,
  };
}

// =============================================================================
// GET
// =============================================================================

/**
 * Get a playbook by ID
 * @throws Error if not found
 */
export function getPlaybook(db: Database.Database, id: string): PlaybookWithClauses {
  const row = db.prepare('SELECT * FROM playbooks WHERE id = ?').get(id) as Playbook | undefined;
  if (!row) {
    throw new Error(`Playbook not found: ${id}`);
  }

  let clauses: ContractClause[] = [];
  try {
    clauses = JSON.parse(row.clauses_json) as ContractClause[];
  } catch {
    clauses = [];
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    clauses,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

// =============================================================================
// LIST
// =============================================================================

/**
 * List all playbooks
 */
export function listPlaybooks(db: Database.Database): PlaybookWithClauses[] {
  const rows = db.prepare(
    'SELECT * FROM playbooks ORDER BY updated_at DESC LIMIT 1000'
  ).all() as Playbook[];

  return rows.map((row) => {
    let clauses: ContractClause[] = [];
    try {
      clauses = JSON.parse(row.clauses_json) as ContractClause[];
    } catch {
      clauses = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      clauses,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
    };
  });
}

// =============================================================================
// COMPARE WITH PLAYBOOK
// =============================================================================

/**
 * Compare document text against a playbook's clauses.
 *
 * For each clause in the playbook, searches the document's chunks for matching
 * content using simple text matching (case-insensitive indexOf). Returns
 * deviations where neither preferred text nor alternatives are found.
 */
export function compareWithPlaybook(
  db: Database.Database,
  documentId: string,
  playbookId: string
): PlaybookComparisonResult {
  // Verify document exists
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(documentId) as { id: string } | undefined;
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }

  // Get playbook
  const playbook = getPlaybook(db, playbookId);

  // Get all chunks for the document
  const chunks = db.prepare(`
    SELECT c.id, c.text, c.page_number
    FROM chunks c
    INNER JOIN ocr_results o ON o.id = c.ocr_result_id
    WHERE o.document_id = ?
    ORDER BY c.chunk_index ASC
  `).all(documentId) as Array<{ id: string; text: string; page_number: number | null }>;

  const clauseResults: ClauseComparisonResult[] = [];
  let matches = 0;
  let alternativeMatches = 0;
  let deviations = 0;
  let missing = 0;

  for (const clause of playbook.clauses) {
    const result = matchClauseInChunks(clause, chunks);
    clauseResults.push(result);

    switch (result.status) {
      case 'match':
        matches++;
        break;
      case 'alternative_match':
        alternativeMatches++;
        break;
      case 'deviation':
        deviations++;
        break;
      case 'missing':
        missing++;
        break;
    }
  }

  const totalClauses = playbook.clauses.length;
  const complianceScore = totalClauses > 0
    ? Math.round(((matches + alternativeMatches) / totalClauses) * 100) / 100
    : 1.0;

  return {
    playbook_id: playbook.id,
    playbook_name: playbook.name,
    document_id: documentId,
    total_clauses: totalClauses,
    matches,
    alternative_matches: alternativeMatches,
    deviations,
    missing,
    compliance_score: complianceScore,
    clause_results: clauseResults,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Search chunks for a clause match using case-insensitive text matching.
 * Checks preferred text first, then alternatives.
 */
function matchClauseInChunks(
  clause: ContractClause,
  chunks: Array<{ id: string; text: string; page_number: number | null }>
): ClauseComparisonResult {
  const preferredLower = clause.preferred_text.toLowerCase();

  // Check preferred text first
  for (const chunk of chunks) {
    const textLower = chunk.text.toLowerCase();
    if (textLower.includes(preferredLower)) {
      return {
        clause_name: clause.clause_name,
        severity: clause.severity,
        status: 'match',
        preferred_text: clause.preferred_text,
        matched_text: extractContext(chunk.text, clause.preferred_text),
        matched_chunk_id: chunk.id,
        matched_page: chunk.page_number,
        details: 'Preferred text found in document',
      };
    }
  }

  // Check alternatives
  for (const alt of clause.alternatives) {
    const altLower = alt.toLowerCase();
    for (const chunk of chunks) {
      const textLower = chunk.text.toLowerCase();
      if (textLower.includes(altLower)) {
        return {
          clause_name: clause.clause_name,
          severity: clause.severity,
          status: 'alternative_match',
          preferred_text: clause.preferred_text,
          matched_text: extractContext(chunk.text, alt),
          matched_chunk_id: chunk.id,
          matched_page: chunk.page_number,
          details: `Alternative text found: "${alt}"`,
        };
      }
    }
  }

  // Check if clause topic is mentioned at all (by clause name)
  const clauseNameLower = clause.clause_name.toLowerCase();
  for (const chunk of chunks) {
    const textLower = chunk.text.toLowerCase();
    if (textLower.includes(clauseNameLower)) {
      return {
        clause_name: clause.clause_name,
        severity: clause.severity,
        status: 'deviation',
        preferred_text: clause.preferred_text,
        matched_text: extractContext(chunk.text, clause.clause_name),
        matched_chunk_id: chunk.id,
        matched_page: chunk.page_number,
        details: `Clause topic "${clause.clause_name}" found but preferred/alternative text not matched`,
      };
    }
  }

  // Not found at all
  return {
    clause_name: clause.clause_name,
    severity: clause.severity,
    status: 'missing',
    preferred_text: clause.preferred_text,
    matched_text: null,
    matched_chunk_id: null,
    matched_page: null,
    details: `Clause "${clause.clause_name}" not found in document`,
  };
}

/**
 * Extract context around a matched substring (up to 200 chars on each side)
 */
function extractContext(fullText: string, searchText: string): string {
  const lowerFull = fullText.toLowerCase();
  const lowerSearch = searchText.toLowerCase();
  const idx = lowerFull.indexOf(lowerSearch);
  if (idx === -1) return fullText.substring(0, 400);

  const start = Math.max(0, idx - 100);
  const end = Math.min(fullText.length, idx + searchText.length + 100);
  let context = fullText.substring(start, end);
  if (start > 0) context = '...' + context;
  if (end < fullText.length) context = context + '...';
  return context;
}

/**
 * Query Expander for Legal/Medical Domain + Corpus-Driven Expansion
 *
 * Expands search queries with domain-specific synonyms and corpus cluster top terms.
 * When enabled, the query "injury" also searches for "wound", "trauma", etc.
 * With a database connection, also expands from cluster top_terms_json for
 * corpus-specific vocabulary.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/search/query-expander
 */

import type { DatabaseService } from '../storage/database/index.js';

/** FTS5 metacharacters that must be stripped from expansion terms */
const FTS5_METACHAR_RE = /['"()*:^~+{}[\]\\;@<>#!$%&|,./`?-]/g;

/** FTS5 boolean operators that corrupt query semantics if used as literal terms */
const FTS5_OPERATOR_WORDS = new Set(['AND', 'OR', 'NOT']);

/**
 * Sanitize a single term for safe inclusion in an FTS5 OR-joined query.
 *
 * 1. Strips all FTS5 metacharacters
 * 2. Returns empty string if the cleaned term is an FTS5 operator (AND/OR/NOT)
 *    to prevent accidental operator injection from corpus/table data
 *
 * @param term - Raw term from corpus clusters, table columns, or synonyms
 * @returns Sanitized term safe for FTS5, or empty string if term should be skipped
 */
export function sanitizeFTS5Term(term: string): string {
  const cleaned = term.replace(FTS5_METACHAR_RE, '').trim();
  if (cleaned.length === 0) return '';
  if (FTS5_OPERATOR_WORDS.has(cleaned.toUpperCase())) return '';
  return cleaned;
}

const SYNONYM_MAP: Record<string, string[]> = {
  // Legal terms
  injury: ['wound', 'trauma', 'harm', 'damage'],
  accident: ['collision', 'crash', 'incident', 'wreck'],
  plaintiff: ['claimant', 'complainant', 'petitioner'],
  defendant: ['respondent', 'accused'],
  contract: ['agreement', 'covenant', 'pact'],
  negligence: ['carelessness', 'recklessness', 'fault'],
  damages: ['compensation', 'restitution', 'remedy'],
  testimony: ['deposition', 'declaration', 'statement', 'affidavit'],
  evidence: ['exhibit', 'proof', 'documentation'],
  settlement: ['resolution', 'compromise', 'accord'],
  // Medical terms
  fracture: ['break', 'crack', 'rupture'],
  surgery: ['operation', 'procedure', 'intervention'],
  diagnosis: ['assessment', 'evaluation', 'finding'],
  medication: ['drug', 'prescription', 'pharmaceutical', 'medicine'],
  chronic: ['persistent', 'ongoing', 'long-term', 'recurring'],
  pain: ['discomfort', 'ache', 'soreness', 'agony'],
  treatment: ['therapy', 'care', 'intervention', 'management'],
};

/** Max corpus expansion terms per cluster match */
const MAX_CORPUS_TERMS_PER_CLUSTER = 3;

/** Max table column terms to add per query */
const MAX_TABLE_COLUMN_TERMS = 5;

/**
 * Get matching table column names from provenance processing_params.
 * Searches for column headers that contain any of the query words.
 *
 * @param db - DatabaseService instance
 * @param queryWords - Lowercased query words to match against column names
 * @returns Array of matching column name terms
 */
export function getTableColumnExpansionTerms(
  db: DatabaseService,
  queryWords: string[]
): string[] {
  const terms: string[] = [];

  try {
    const conn = db.getConnection();
    const rows = conn.prepare(
      "SELECT DISTINCT processing_params FROM provenance WHERE processing_params LIKE '%table_columns%' LIMIT 500"
    ).all() as Array<{ processing_params: string }>;

    const allColumns = new Set<string>();
    for (const row of rows) {
      try {
        const params = JSON.parse(row.processing_params) as Record<string, unknown>;
        const cols = params.table_columns;
        if (Array.isArray(cols)) {
          for (const col of cols) {
            if (typeof col === 'string' && col.length > 0) {
              allColumns.add(col);
            }
          }
        }
      } catch (error) {
        console.error(`[query-expander] Failed to parse table_columns from processing_params: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Find columns matching any query word
    for (const col of allColumns) {
      const colLower = col.toLowerCase();
      for (const word of queryWords) {
        if (colLower.includes(word) || word.includes(colLower)) {
          // Add individual words from the column name, sanitized for FTS5 safety
          const colWords = col.split(/\s+/)
            .map(w => sanitizeFTS5Term(w))
            .filter(w => w.length > 2);
          terms.push(...colWords);
          break;
        }
      }
      if (terms.length >= MAX_TABLE_COLUMN_TERMS) break;
    }
  } catch (error) {
    console.error(`[QueryExpander] Failed to query table column terms: ${String(error)}`);
  }

  return [...new Set(terms)].slice(0, MAX_TABLE_COLUMN_TERMS);
}

/**
 * Query cluster top terms from the database for corpus-specific expansion.
 *
 * For each query word, checks if it appears in any cluster's top_terms_json
 * (clusters with coherence_score > 0.3). Returns other terms from matching
 * clusters as expansion candidates (max 3 per cluster match).
 *
 * @param db - DatabaseService instance
 * @param queryWords - Lowercased query words to match against cluster terms
 * @returns Map of query word -> corpus expansion terms
 */
export function getCorpusExpansionTerms(
  db: DatabaseService,
  queryWords: string[]
): Record<string, string[]> {
  const corpusTerms: Record<string, string[]> = {};

  try {
    const conn = db.getConnection();
    const rows = conn
      .prepare(
        'SELECT top_terms_json FROM clusters WHERE top_terms_json IS NOT NULL AND coherence_score > 0.3 LIMIT 200'
      )
      .all() as Array<{ top_terms_json: string }>;

    if (rows.length === 0) return corpusTerms;

    // Parse all cluster top terms
    const clusterTermSets: string[][] = [];
    for (const row of rows) {
      try {
        const terms = JSON.parse(row.top_terms_json);
        if (Array.isArray(terms) && terms.length > 0) {
          clusterTermSets.push(terms.map((t: unknown) => String(t).toLowerCase()));
        }
      } catch (error) {
        console.error(`[query-expander] Failed to parse cluster top_terms_json: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // For each query word, find matching clusters and extract expansion terms
    for (const word of queryWords) {
      const expansions: string[] = [];
      for (const clusterTerms of clusterTermSets) {
        if (clusterTerms.includes(word)) {
          // Add other terms from this cluster as expansions (max 3)
          const otherTerms = clusterTerms
            .filter((t) => t !== word && !queryWords.includes(t))
            .slice(0, MAX_CORPUS_TERMS_PER_CLUSTER);
          expansions.push(...otherTerms);
        }
      }
      if (expansions.length > 0) {
        // Deduplicate
        corpusTerms[word] = [...new Set(expansions)];
      }
    }
  } catch (error) {
    console.error(`[QueryExpander] Failed to query corpus expansion terms: ${String(error)}`);
  }

  return corpusTerms;
}

/**
 * Get detailed expansion information for a query.
 * Shows which words were expanded and what synonyms were found.
 * When a database is provided, also includes corpus-driven expansion from cluster top terms.
 *
 * @param query - Original search query
 * @param db - Optional DatabaseService for corpus-driven expansion
 * @param isTableQuery - Whether the query targets table content
 * @returns Expansion details: original query, new expanded terms, synonym map, corpus terms
 */
export function getExpandedTerms(
  query: string,
  db?: DatabaseService,
  isTableQuery?: boolean,
): {
  original: string;
  expanded: string[];
  synonyms_found: Record<string, string[]>;
  corpus_terms?: Record<string, string[]>;
  table_column_terms?: string[];
} {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const synonymsFound: Record<string, string[]> = {};
  const expanded: string[] = [];

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      synonymsFound[word] = synonyms;
      expanded.push(...synonyms);
    }
  }

  // Corpus-driven expansion from cluster top terms
  let corpusTerms: Record<string, string[]> | undefined;
  if (db) {
    corpusTerms = getCorpusExpansionTerms(db, words);
    for (const terms of Object.values(corpusTerms)) {
      expanded.push(...terms);
    }
  }

  // Table column expansion
  let tableColumnTerms: string[] | undefined;
  if (isTableQuery && db) {
    tableColumnTerms = getTableColumnExpansionTerms(db, words);
    expanded.push(...tableColumnTerms);
  }

  return {
    original: query,
    expanded,
    synonyms_found: synonymsFound,
    ...(corpusTerms && Object.keys(corpusTerms).length > 0 ? { corpus_terms: corpusTerms } : {}),
    ...(tableColumnTerms && tableColumnTerms.length > 0 ? { table_column_terms: tableColumnTerms } : {}),
  };
}

/**
 * Expand query using static synonyms and optional corpus cluster terms.
 * When isTableQuery is true, also expands with matching table column names.
 *
 * @param query - Original search query
 * @param db - Optional DatabaseService for corpus-driven expansion
 * @param isTableQuery - Whether the query targets table content
 * @returns OR-joined expanded query string
 */
export function expandQuery(query: string, db?: DatabaseService, isTableQuery?: boolean): string {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  // Sanitize every term (including original query words) before adding to the set.
  // This ensures the final OR-joined string is a valid FTS5 expression with no
  // metacharacters or accidental operator words from any source.
  const expanded = new Set<string>();
  for (const w of words) {
    const safe = sanitizeFTS5Term(w);
    if (safe.length > 0) expanded.add(safe);
  }

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      for (const syn of synonyms) {
        const safe = sanitizeFTS5Term(syn);
        if (safe.length > 0) expanded.add(safe);
      }
    }
  }

  // Corpus-driven expansion from cluster top terms.
  // Corpus terms may be multi-word (e.g. "patient records") -- split into
  // individual words so each becomes a separate OR operand.
  if (db) {
    const corpusTerms = getCorpusExpansionTerms(db, words);
    for (const terms of Object.values(corpusTerms)) {
      for (const term of terms) {
        for (const part of term.split(/\s+/)) {
          const safe = sanitizeFTS5Term(part);
          if (safe.length > 0) expanded.add(safe);
        }
      }
    }
  }

  // Table column expansion for table-related queries
  if (isTableQuery && db) {
    const tableTerms = getTableColumnExpansionTerms(db, words);
    for (const term of tableTerms) {
      for (const part of term.toLowerCase().split(/\s+/)) {
        const safe = sanitizeFTS5Term(part);
        if (safe.length > 0) expanded.add(safe);
      }
    }
  }

  const terms = [...expanded];
  if (terms.length > 20) {
    // Cap expanded terms to prevent query dilution
    // Keep the first 20 terms (original words come first, then synonyms, then corpus terms)
    return terms.slice(0, 20).join(' OR ');
  }
  return terms.join(' OR ');
}

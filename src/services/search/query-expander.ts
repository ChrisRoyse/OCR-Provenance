/**
 * Query Expander for Legal/Medical Domain
 *
 * Expands search queries with domain-specific synonyms.
 * When enabled, the query "injury" also searches for "wound", "trauma", etc.
 * Also supports dynamic expansion via knowledge graph aliases.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module services/search/query-expander
 */

import type Database from 'better-sqlite3';

const SYNONYM_MAP: Record<string, string[]> = {
  // Legal terms
  'injury': ['wound', 'trauma', 'harm', 'damage'],
  'accident': ['collision', 'crash', 'incident', 'wreck'],
  'plaintiff': ['claimant', 'complainant', 'petitioner'],
  'defendant': ['respondent', 'accused'],
  'contract': ['agreement', 'covenant', 'pact'],
  'negligence': ['carelessness', 'recklessness', 'fault'],
  'damages': ['compensation', 'restitution', 'remedy'],
  'testimony': ['deposition', 'declaration', 'statement', 'affidavit'],
  'evidence': ['exhibit', 'proof', 'documentation'],
  'settlement': ['resolution', 'compromise', 'accord'],
  // Medical terms
  'fracture': ['break', 'crack', 'rupture'],
  'surgery': ['operation', 'procedure', 'intervention'],
  'diagnosis': ['assessment', 'evaluation', 'finding'],
  'medication': ['drug', 'prescription', 'pharmaceutical', 'medicine'],
  'chronic': ['persistent', 'ongoing', 'long-term', 'recurring'],
  'pain': ['discomfort', 'ache', 'soreness', 'agony'],
  'treatment': ['therapy', 'care', 'intervention', 'management'],
};

/**
 * Expand a search query with domain-specific synonyms.
 * Returns an OR-joined query suitable for BM25 FTS5 search.
 *
 * @param query - Original search query
 * @returns OR-joined expanded query string
 */
export function expandQuery(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const expanded = new Set<string>(words);

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn);
      }
    }
  }

  // Return as OR-joined query for BM25 FTS5
  return [...expanded].join(' OR ');
}

/**
 * Get detailed expansion information for a query.
 * Shows which words were expanded and what synonyms were found.
 *
 * @param query - Original search query
 * @returns Expansion details: original query, new expanded terms, synonym map
 */
export function getExpandedTerms(query: string): {
  original: string;
  expanded: string[];
  synonyms_found: Record<string, string[]>;
} {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const synonymsFound: Record<string, string[]> = {};
  const expanded: string[] = [];

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      synonymsFound[word] = synonyms;
      expanded.push(...synonyms);
    }
  }

  return { original: query, expanded, synonyms_found: synonymsFound };
}

/**
 * Get the full synonym map (for inspection/debugging).
 */
export function getSynonymMap(): Record<string, string[]> {
  return { ...SYNONYM_MAP };
}

/**
 * Expand query using both static synonyms AND knowledge graph aliases.
 * Queries knowledge_nodes table for matching canonical names and aliases.
 * Caps at 5 aliases per term to prevent query explosion.
 *
 * @param query - Original search query
 * @param db - better-sqlite3 database connection
 * @returns OR-joined expanded query string
 */
export function expandQueryWithKG(query: string, db: Database.Database): string {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const expanded = new Set<string>(words);

  // Static synonyms (existing behavior)
  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn);
    }
  }

  // Dynamic KG aliases - look up each word in knowledge_nodes
  const stmt = db.prepare(
    'SELECT aliases, canonical_name FROM knowledge_nodes WHERE LOWER(canonical_name) = LOWER(?) OR LOWER(normalized_name) = LOWER(?)'
  );
  for (const word of words) {
    const rows = stmt.all(word, word) as Array<{ aliases: string | null; canonical_name: string }>;
    for (const row of rows) {
      expanded.add(row.canonical_name.toLowerCase());
      if (row.aliases) {
        try {
          const aliases = JSON.parse(row.aliases) as string[];
          for (const alias of aliases.slice(0, 5)) {
            expanded.add(alias.toLowerCase());
          }
        } catch {
          // Malformed aliases JSON - skip
        }
      }
    }
  }

  return [...expanded].join(' OR ');
}

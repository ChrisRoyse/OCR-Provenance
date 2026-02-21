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
        'SELECT top_terms_json FROM clusters WHERE top_terms_json IS NOT NULL AND coherence_score > 0.3'
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
      } catch {
        // Skip malformed JSON
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
 * @returns Expansion details: original query, new expanded terms, synonym map, corpus terms
 */
export function getExpandedTerms(
  query: string,
  db?: DatabaseService
): {
  original: string;
  expanded: string[];
  synonyms_found: Record<string, string[]>;
  corpus_terms?: Record<string, string[]>;
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

  return {
    original: query,
    expanded,
    synonyms_found: synonymsFound,
    ...(corpusTerms && Object.keys(corpusTerms).length > 0 ? { corpus_terms: corpusTerms } : {}),
  };
}

/**
 * Expand query using static synonyms and optional corpus cluster terms.
 *
 * @param query - Original search query
 * @param db - Optional DatabaseService for corpus-driven expansion
 * @returns OR-joined expanded query string
 */
export function expandQuery(query: string, db?: DatabaseService): string {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const expanded = new Set<string>(words);

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn);
    }
  }

  // Corpus-driven expansion from cluster top terms
  if (db) {
    const corpusTerms = getCorpusExpansionTerms(db, words);
    for (const terms of Object.values(corpusTerms)) {
      for (const term of terms) expanded.add(term);
    }
  }

  return [...expanded].join(' OR ');
}

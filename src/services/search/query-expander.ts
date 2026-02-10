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
 * Expand query using both static synonyms AND knowledge graph aliases.
 * Uses FTS5 full-text search on knowledge_nodes_fts for multi-word entity matching.
 * Tries full query phrase first, then bigrams, then individual words.
 * Caps at 20 KG aliases total to prevent query explosion.
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

  // Dynamic KG aliases via FTS5 (multi-word aware)
  const aliasesCollected = new Set<string>();

  // 1. Try FULL query as a phrase match against FTS5
  collectKGAliases(db, `"${escapeFTS5(query)}"`, aliasesCollected);

  // 2. Try bigrams (consecutive word pairs)
  if (words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      collectKGAliases(db, `"${escapeFTS5(bigram)}"`, aliasesCollected);
    }
  }

  // 3. Fall back to individual words via FTS5
  for (const word of words) {
    if (word.length >= 3) { // Skip very short words
      collectKGAliases(db, escapeFTS5(word), aliasesCollected);
    }
  }

  // Add collected aliases (cap at 20 total to prevent query explosion)
  let aliasCount = 0;
  for (const alias of aliasesCollected) {
    if (aliasCount >= 20) break;
    // Add each word of the alias separately for FTS5 compatibility
    for (const w of alias.toLowerCase().split(/\s+/)) {
      if (w.length > 0) expanded.add(w);
    }
    aliasCount++;
  }

  return [...expanded].join(' OR ');
}

/**
 * Expand query using static synonyms, KG aliases, AND co-mentioned entities.
 * After standard KG expansion, finds entities that frequently co-occur with
 * matched entities (via knowledge_edges) and adds their names to the query.
 * Best used for hybrid search where the broadest expansion is beneficial.
 *
 * @param query - Original search query
 * @param db - better-sqlite3 database connection
 * @param maxExpansions - Maximum co-mentioned entity names to add (default 5)
 * @returns OR-joined expanded query string
 */
export function expandQueryWithCoMentioned(query: string, db: Database.Database, maxExpansions: number = 5): string {
  // Start with standard KG expansion (synonyms + aliases)
  const baseExpanded = expandQueryWithKG(query, db);

  // Find node IDs matching query terms
  const matchedNodeIds = findMatchingNodeIds(query, db);
  if (matchedNodeIds.length === 0) return baseExpanded;

  // Get co-mentioned entities from edges (limit source nodes to avoid explosion)
  const coMentioned = new Set<string>();
  for (const nodeId of matchedNodeIds.slice(0, 3)) {
    try {
      const edges = db.prepare(`
        SELECT kn.canonical_name, ke.weight
        FROM knowledge_edges ke
        JOIN knowledge_nodes kn ON (
          CASE WHEN ke.source_node_id = ? THEN ke.target_node_id ELSE ke.source_node_id END = kn.id
        )
        WHERE (ke.source_node_id = ? OR ke.target_node_id = ?)
        ORDER BY ke.weight DESC
        LIMIT ?
      `).all(nodeId, nodeId, nodeId, maxExpansions) as Array<{ canonical_name: string; weight: number }>;

      for (const edge of edges) {
        coMentioned.add(edge.canonical_name.toLowerCase());
      }
    } catch {
      // knowledge_edges table may not exist - skip gracefully
    }
  }

  // Add co-mentioned terms to the expanded set
  const expanded = new Set(baseExpanded.split(' OR ').map(t => t.trim()).filter(t => t.length > 0));
  for (const term of coMentioned) {
    for (const word of term.split(/\s+/)) {
      if (word.length >= 3) expanded.add(word);
    }
  }

  return [...expanded].join(' OR ');
}

/**
 * Find KG node IDs that match query terms via FTS5.
 * Reuses the same FTS5 matching strategy as collectKGAliases but returns node IDs.
 *
 * @param query - Search query
 * @param db - Database connection
 * @returns Array of matching knowledge node IDs
 */
function findMatchingNodeIds(query: string, db: Database.Database): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const nodeIds = new Set<string>();

  try {
    // 1. Try full query as phrase match
    const fullPhrase = `"${escapeFTS5(query)}"`;
    if (fullPhrase !== '""' && fullPhrase !== '"  "') {
      const rows = db.prepare(
        `SELECT kn.id
         FROM knowledge_nodes_fts fts
         JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
         WHERE knowledge_nodes_fts MATCH ?
         LIMIT 5`
      ).all(fullPhrase) as Array<{ id: string }>;
      for (const row of rows) nodeIds.add(row.id);
    }

    // 2. Try bigrams
    if (words.length >= 2) {
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `"${escapeFTS5(words[i] + ' ' + words[i + 1])}"`;
        const rows = db.prepare(
          `SELECT kn.id
           FROM knowledge_nodes_fts fts
           JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
           WHERE knowledge_nodes_fts MATCH ?
           LIMIT 5`
        ).all(bigram) as Array<{ id: string }>;
        for (const row of rows) nodeIds.add(row.id);
      }
    }

    // 3. Individual words
    for (const word of words) {
      if (word.length >= 3) {
        const rows = db.prepare(
          `SELECT kn.id
           FROM knowledge_nodes_fts fts
           JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
           WHERE knowledge_nodes_fts MATCH ?
           LIMIT 5`
        ).all(escapeFTS5(word)) as Array<{ id: string }>;
        for (const row of rows) nodeIds.add(row.id);
      }
    }
  } catch {
    // FTS5 table may not exist - return empty
  }

  return [...nodeIds];
}

/**
 * Escape special FTS5 characters in a query term.
 * Replaces FTS5 metacharacters with spaces to prevent syntax errors.
 */
function escapeFTS5(term: string): string {
  return term.replace(/["*()\\+:^-]/g, ' ').trim();
}

/**
 * Query knowledge_nodes_fts and collect canonical names + aliases.
 * Uses the FTS5 virtual table (schema v17) for full-text matching.
 * Joins back to knowledge_nodes via implicit rowid.
 *
 * @param db - Database connection
 * @param ftsQuery - FTS5 MATCH query string (may be quoted phrase or bare term)
 * @param collected - Set to accumulate discovered aliases into
 */
function collectKGAliases(db: Database.Database, ftsQuery: string, collected: Set<string>): void {
  if (!ftsQuery || ftsQuery.trim().length === 0) return;
  // Skip empty quoted phrases like '""'
  if (ftsQuery === '""' || ftsQuery === '"  "') return;

  try {
    const rows = db.prepare(
      `SELECT kn.canonical_name, kn.aliases
       FROM knowledge_nodes_fts fts
       JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
       WHERE knowledge_nodes_fts MATCH ?
       LIMIT 10`
    ).all(ftsQuery) as Array<{ canonical_name: string; aliases: string | null }>;

    for (const row of rows) {
      collected.add(row.canonical_name);
      if (row.aliases) {
        try {
          const aliases = JSON.parse(row.aliases) as string[];
          for (const alias of aliases.slice(0, 5)) {
            collected.add(alias);
          }
        } catch {
          // Malformed aliases JSON - skip
        }
      }
    }
  } catch {
    // FTS5 query error (malformed query, table not exists) - skip gracefully
  }
}

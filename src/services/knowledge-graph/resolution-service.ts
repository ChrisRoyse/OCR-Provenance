/**
 * Entity Resolution Service
 *
 * Resolves entities across documents into canonical knowledge graph nodes
 * using a 3-tier strategy: exact match, fuzzy match, and optional AI disambiguation.
 *
 * Uses Union-Find for efficient merging of entity groups.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 */

import type { Entity, EntityType } from '../../models/entity.js';
import type { KnowledgeNode, NodeEntityLink } from '../../models/knowledge-graph.js';
import { computeImportanceScore } from '../../models/knowledge-graph.js';
import {
  sorensenDice,
  tokenSortedSimilarity,
  initialMatch,
  expandAbbreviations,
  normalizeCaseNumber,
  amountsMatch,
  locationContains,
} from './string-similarity.js';
import { v4 as uuidv4 } from 'uuid';

/** Maximum entities per type group for fuzzy comparison (fail fast) */
const MAX_FUZZY_GROUP_SIZE = 5000;

/** Default minimum similarity score for automatic fuzzy merge */
const FUZZY_MERGE_THRESHOLD = 0.85;

/** Lower fuzzy threshold for person names to catch OCR variants (e.g., Tynescia/Tyneisha/Tynisha) */
const PERSON_FUZZY_MERGE_THRESHOLD = 0.75;

/** Lower bound for AI disambiguation range */
const AI_LOWER_THRESHOLD = 0.70;

/**
 * Get the fuzzy merge threshold for a given entity type.
 * Person names use a lower threshold (0.75) to catch OCR name variants.
 * All other types use the default threshold (0.85).
 */
function getFuzzyThreshold(entityType: string): number {
  return entityType === 'person' ? PERSON_FUZZY_MERGE_THRESHOLD : FUZZY_MERGE_THRESHOLD;
}

export type ResolutionMode = 'exact' | 'fuzzy' | 'ai';

interface ResolutionResult {
  nodes: KnowledgeNode[];
  links: NodeEntityLink[];
  stats: {
    total_entities: number;
    exact_matches: number;
    fuzzy_matches: number;
    ai_matches: number;
    unmatched: number;
    cross_document_nodes: number;
    single_document_nodes: number;
  };
}

/**
 * Union-Find (disjoint set) data structure for efficient entity merging
 *
 * Supports union-by-rank and path compression for near-constant time operations.
 */
class UnionFind {
  private parent: Map<number, number>;
  private rank: Map<number, number>;

  constructor(size: number) {
    this.parent = new Map();
    this.rank = new Map();
    for (let i = 0; i < size; i++) {
      this.parent.set(i, i);
      this.rank.set(i, 0);
    }
  }

  /**
   * Find the root representative for element x with path compression
   *
   * @param x - Element index
   * @returns Root representative index
   */
  find(x: number): number {
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  /**
   * Unite two elements into the same group using union-by-rank
   *
   * @param x - First element index
   * @param y - Second element index
   */
  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;

    const rankX = this.rank.get(rootX)!;
    const rankY = this.rank.get(rootY)!;

    if (rankX < rankY) {
      this.parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      this.parent.set(rootY, rootX);
    } else {
      this.parent.set(rootY, rootX);
      this.rank.set(rootX, rankX + 1);
    }
  }

  /**
   * Get all groups as arrays of member indices
   *
   * @returns Map of root index to array of member indices
   */
  getGroups(): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (const [idx] of this.parent) {
      const root = this.find(idx);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(idx);
    }
    return groups;
  }
}

/**
 * Cluster context for entity resolution boost.
 * Maps document_id to cluster_id. Entities from the same cluster
 * get a similarity boost since they are more likely to refer to the same entity.
 */
export interface ClusterContext {
  clusterMap: Map<string, string>; // document_id -> cluster_id
}

/**
 * Compute type-specific similarity between two entities
 *
 * Uses different strategies depending on entity type:
 * - person: tokenSortedSimilarity + initialMatch bonus
 * - organization: expandAbbreviations then sorensenDice
 * - case_number: normalizeCaseNumber exact comparison (0 or 1)
 * - amount: amountsMatch with 1% tolerance (0 or 1)
 * - location: locationContains check (0 or 1) plus sorensenDice
 * - others: sorensenDice on normalized_text
 *
 * Optionally applies a cluster boost (+0.08) when both entities come from
 * documents in the same cluster.
 *
 * @param a - First entity
 * @param b - Second entity
 * @param clusterContext - Optional cluster context for same-cluster boost
 * @returns Similarity score between 0 and 1
 */
export function computeTypeSimilarity(
  a: Entity,
  b: Entity,
  clusterContext?: ClusterContext,
): number {
  const textA = a.normalized_text;
  const textB = b.normalized_text;

  let score: number;

  switch (a.entity_type) {
    case 'person': {
      const tokenSim = tokenSortedSimilarity(textA, textB);
      if (initialMatch(textA, textB)) {
        // Initial match gets a boost: at least 0.90
        score = Math.max(tokenSim, 0.90);
      } else {
        score = tokenSim;
      }
      break;
    }

    case 'organization': {
      const expandedA = expandAbbreviations(textA);
      const expandedB = expandAbbreviations(textB);
      score = sorensenDice(expandedA, expandedB);
      break;
    }

    case 'case_number': {
      const normA = normalizeCaseNumber(textA);
      const normB = normalizeCaseNumber(textB);
      score = normA === normB ? 1.0 : 0.0;
      break;
    }

    case 'amount': {
      score = amountsMatch(textA, textB, 0.01) ? 1.0 : 0.0;
      break;
    }

    case 'location': {
      if (locationContains(textA, textB)) {
        score = Math.max(sorensenDice(textA, textB), 0.85);
      } else {
        score = sorensenDice(textA, textB);
      }
      break;
    }

    case 'medication': {
      // Medications: use token-sorted similarity to handle reordering
      // (e.g., "metoprolol 25mg" vs "metoprolol tartrate 25 mg")
      score = tokenSortedSimilarity(textA, textB);
      break;
    }

    case 'diagnosis': {
      // Diagnoses: standard bigram similarity handles abbreviations and variants
      score = sorensenDice(textA, textB);
      break;
    }

    case 'medical_device': {
      // Medical devices: token-sorted similarity to handle reordering
      // (e.g., "PEG tube" vs "percutaneous endoscopic gastrostomy tube")
      score = tokenSortedSimilarity(textA, textB);
      break;
    }

    case 'date': {
      // Dates: EXACT match only. Fuzzy matching (Dice) is dangerous because
      // "2024-04-10" vs "2024-04-11" have Dice=0.875 which exceeds the 0.85
      // threshold, incorrectly merging different dates into one KG node.
      score = textA === textB ? 1.0 : 0.0;
      break;
    }

    default:
      score = sorensenDice(textA, textB);
  }

  // Cluster boost: entities from same cluster are more likely to be the same entity
  if (clusterContext) {
    const clusterA = clusterContext.clusterMap.get(a.document_id);
    const clusterB = clusterContext.clusterMap.get(b.document_id);
    if (clusterA && clusterB && clusterA === clusterB) {
      score = Math.min(1.0, score + 0.08);
    }
  }

  return score;
}

/**
 * Group entities by entity_type
 *
 * @param entities - Array of entities to group
 * @returns Map of entity_type to array of entities
 */
function groupByEntityType(entities: Entity[]): Map<EntityType, Entity[]> {
  const groups = new Map<EntityType, Entity[]>();
  for (const entity of entities) {
    if (!groups.has(entity.entity_type)) {
      groups.set(entity.entity_type, []);
    }
    groups.get(entity.entity_type)!.push(entity);
  }
  return groups;
}

/**
 * Sub-block entity groups within a type for more efficient pairwise comparison.
 *
 * Instead of comparing all N exact groups pairwise (O(N^2)), partition them
 * into blocks by prefix (first 3 chars of normalized_text) and, for persons,
 * additionally by each name token. This ensures that "john smith" and
 * "smith, john" land in the same block via the shared token "smith" or "john".
 *
 * @param exactGroupList - Array of exact match groups (each group is Entity[])
 * @returns Map of block key to array of indices into exactGroupList
 */
function subBlockEntities(
  exactGroupList: Entity[][],
): Map<string, Set<number>> {
  const blocks = new Map<string, Set<number>>();

  for (let idx = 0; idx < exactGroupList.length; idx++) {
    const representative = exactGroupList[idx][0];
    const normalized = representative.normalized_text;

    // Primary block: first 3 chars (lowercased)
    const prefix = normalized.slice(0, 3).toLowerCase();

    // Add to prefix block
    if (!blocks.has(prefix)) blocks.set(prefix, new Set());
    blocks.get(prefix)!.add(idx);

    // Secondary blocking for persons: add a block for each name token.
    // This handles "john smith" vs "smith, john" (share token blocks "john" and "smith")
    if (representative.entity_type === 'person') {
      // Remove punctuation like commas before tokenizing
      const cleaned = normalized.replace(/[,.']/g, ' ').trim();
      const tokens = cleaned.split(/\s+/).filter(t => t.length > 1);
      for (const token of tokens) {
        const tokenKey = `token:${token.toLowerCase()}`;
        if (!blocks.has(tokenKey)) blocks.set(tokenKey, new Set());
        blocks.get(tokenKey)!.add(idx);
      }
    }
  }

  return blocks;
}

/**
 * Build a KnowledgeNode from a group of resolved entities
 *
 * @param groupEntities - Entities that have been resolved to the same node
 * @param provenanceId - Provenance record ID for the resolution run
 * @returns The constructed KnowledgeNode
 */
function buildNode(groupEntities: Entity[], provenanceId: string): KnowledgeNode {
  // Canonical name = raw_text of highest confidence entity
  const sortedByConfidence = [...groupEntities].sort((a, b) => b.confidence - a.confidence);
  const canonical = sortedByConfidence[0];

  // Unique document count
  const uniqueDocs = new Set(groupEntities.map(e => e.document_id));

  // Average confidence
  const avgConfidence = groupEntities.reduce((sum, e) => sum + e.confidence, 0) / groupEntities.length;

  // Collect aliases (unique raw_text values other than canonical)
  const aliasSet = new Set<string>();
  for (const e of groupEntities) {
    if (e.raw_text !== canonical.raw_text) {
      aliasSet.add(e.raw_text);
    }
  }
  const aliases = aliasSet.size > 0 ? JSON.stringify([...aliasSet]) : null;

  const now = new Date().toISOString();

  const importanceScore = computeImportanceScore(avgConfidence, uniqueDocs.size, groupEntities.length);

  return {
    id: uuidv4(),
    entity_type: canonical.entity_type,
    canonical_name: canonical.raw_text,
    normalized_name: canonical.normalized_text,
    aliases,
    document_count: uniqueDocs.size,
    mention_count: groupEntities.length,
    edge_count: 0,
    avg_confidence: Math.round(avgConfidence * 10000) / 10000,
    importance_score: importanceScore,
    metadata: null,
    provenance_id: provenanceId,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Build NodeEntityLink records for a node and its source entities
 *
 * @param node - The knowledge node
 * @param groupEntities - Entities linked to this node
 * @param similarityScores - Map of entity ID to similarity score (1.0 for exact matches)
 * @param resolutionMethod - The method used to resolve these entities ('exact', 'fuzzy', 'ai', 'singleton')
 * @returns Array of NodeEntityLink records
 */
function buildLinks(
  node: KnowledgeNode,
  groupEntities: Entity[],
  similarityScores: Map<string, number>,
  resolutionMethod: string,
): NodeEntityLink[] {
  const now = new Date().toISOString();
  return groupEntities.map(entity => ({
    id: uuidv4(),
    node_id: node.id,
    entity_id: entity.id,
    document_id: entity.document_id,
    similarity_score: similarityScores.get(entity.id) ?? 1.0,
    resolution_method: resolutionMethod,
    created_at: now,
  }));
}

/**
 * Resolve entities into canonical knowledge graph nodes
 *
 * Strategy:
 * 1. Group entities by entity_type
 * 2. Within each group:
 *    a. Tier 1 (exact): Group by normalized_text -> merge into nodes
 *    b. Tier 2 (fuzzy): Pairwise Sorensen-Dice similarity -> merge if >= 0.85
 *    c. Tier 3 (AI): Optional Gemini disambiguation for 0.70-0.85 range
 * 3. Single-entity groups become solo nodes
 *
 * @param entities - Entities to resolve
 * @param mode - Resolution mode: 'exact' (tier 1 only), 'fuzzy' (tiers 1+2), 'ai' (tiers 1+2+3)
 * @param provenanceId - Provenance ID for this resolution run
 * @param geminiClassifier - Optional AI classifier for tier 3 disambiguation
 * @returns ResolutionResult with nodes, links, and statistics
 * @throws Error if a type group exceeds MAX_FUZZY_GROUP_SIZE in fuzzy/ai mode
 */
export async function resolveEntities(
  entities: Entity[],
  mode: ResolutionMode,
  provenanceId: string,
  geminiClassifier?: (
    candidates: Array<{ entityA: Entity; entityB: Entity }>
  ) => Promise<Array<{ same_entity: boolean; confidence: number }>>,
  clusterContext?: ClusterContext,
): Promise<ResolutionResult> {
  const allNodes: KnowledgeNode[] = [];
  const allLinks: NodeEntityLink[] = [];
  const stats = {
    total_entities: entities.length,
    exact_matches: 0,
    fuzzy_matches: 0,
    ai_matches: 0,
    unmatched: 0,
    cross_document_nodes: 0,
    single_document_nodes: 0,
  };

  if (entities.length === 0) {
    return { nodes: allNodes, links: allLinks, stats };
  }

  const typeGroups = groupByEntityType(entities);

  for (const [entityType, typeEntities] of typeGroups) {
    // -- Tier 1: Exact matching by normalized_text --
    const exactGroups = new Map<string, Entity[]>();
    for (const entity of typeEntities) {
      const key = entity.normalized_text;
      if (!exactGroups.has(key)) {
        exactGroups.set(key, []);
      }
      exactGroups.get(key)!.push(entity);
    }

    // Track which exact groups got merged (multi-entity) vs single
    for (const [, group] of exactGroups) {
      if (group.length > 1) {
        stats.exact_matches += group.length;
      }
    }

    if (mode === 'exact') {
      // In exact mode, each exact group becomes a node
      for (const [, group] of exactGroups) {
        const resMethod = group.length === 1 ? 'singleton' : 'exact';
        const node = buildNode(group, provenanceId);
        // Store resolution algorithm in node metadata
        node.metadata = JSON.stringify({ resolution_algorithm: resMethod });
        const scores = new Map<string, number>();
        for (const e of group) {
          scores.set(e.id, 1.0);
        }
        const links = buildLinks(node, group, scores, resMethod);
        allNodes.push(node);
        allLinks.push(...links);
      }
      continue;
    }

    // -- Tier 2: Fuzzy matching --
    // Convert exact groups into a list for pairwise comparison
    const exactGroupList = [...exactGroups.values()];

    if (exactGroupList.length > MAX_FUZZY_GROUP_SIZE) {
      throw new Error(
        `Entity type "${entityType}" has ${exactGroupList.length} distinct normalized forms, ` +
        `exceeding the maximum of ${MAX_FUZZY_GROUP_SIZE} for fuzzy resolution. ` +
        `Use 'exact' mode or reduce entity count.`
      );
    }

    // Build Union-Find over exact groups
    const uf = new UnionFind(exactGroupList.length);

    // Pairwise similarity between exact group representatives
    // Use the first entity of each group as representative
    const aiCandidates: Array<{ i: number; j: number; entityA: Entity; entityB: Entity }> = [];

    // Sub-block entities for efficient comparison (avoids full O(N^2))
    const blocks = subBlockEntities(exactGroupList);

    // Collect unique pairs to compare from overlapping blocks
    const comparedPairs = new Set<string>();

    for (const [, blockIndices] of blocks) {
      const indices = [...blockIndices];
      for (let a = 0; a < indices.length; a++) {
        for (let b = a + 1; b < indices.length; b++) {
          const i = indices[a];
          const j = indices[b];

          // Canonical ordering for dedup
          const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (comparedPairs.has(pairKey)) continue;
          comparedPairs.add(pairKey);

          // Already in same group? Skip
          if (uf.find(i) === uf.find(j)) continue;

          const repA = exactGroupList[i][0];
          const repB = exactGroupList[j][0];

          const sim = computeTypeSimilarity(repA, repB, clusterContext);
          const threshold = getFuzzyThreshold(repA.entity_type);

          if (sim >= threshold) {
            uf.union(i, j);
            // Count all entities in both groups as fuzzy matched
            stats.fuzzy_matches += exactGroupList[i].length + exactGroupList[j].length;
          } else if (mode === 'ai' && sim >= AI_LOWER_THRESHOLD && sim < threshold) {
            aiCandidates.push({ i, j, entityA: repA, entityB: repB });
          }
        }
      }
    }

    // -- Tier 3: AI disambiguation --
    if (mode === 'ai' && aiCandidates.length > 0 && geminiClassifier) {
      const classifierInput = aiCandidates.map(c => ({
        entityA: c.entityA,
        entityB: c.entityB,
      }));

      const aiResults = await geminiClassifier(classifierInput);

      for (let k = 0; k < aiResults.length; k++) {
        const result = aiResults[k];
        const candidate = aiCandidates[k];

        if (result.same_entity && result.confidence >= 0.70) {
          // Only merge if not already in same group
          if (uf.find(candidate.i) !== uf.find(candidate.j)) {
            uf.union(candidate.i, candidate.j);
            stats.ai_matches +=
              exactGroupList[candidate.i].length + exactGroupList[candidate.j].length;
          }
        }
      }
    }

    // Build final merged groups from Union-Find
    // Track which groups were merged by fuzzy or AI for resolution_method
    const fuzzyMergedRoots = new Set<number>();
    const aiMergedRoots = new Set<number>();

    // Re-check pairwise to determine which merge method was used
    for (let i = 0; i < exactGroupList.length; i++) {
      for (let j = i + 1; j < exactGroupList.length; j++) {
        if (uf.find(i) === uf.find(j)) {
          const repA = exactGroupList[i][0];
          const repB = exactGroupList[j][0];
          const sim = computeTypeSimilarity(repA, repB, clusterContext);
          const root = uf.find(i);
          if (sim >= getFuzzyThreshold(repA.entity_type)) {
            fuzzyMergedRoots.add(root);
          } else if (sim >= AI_LOWER_THRESHOLD) {
            aiMergedRoots.add(root);
          }
        }
      }
    }

    const mergedGroups = uf.getGroups();

    for (const [rootIdx, memberIndices] of mergedGroups) {
      // Flatten all entities from merged exact groups
      const groupEntities: Entity[] = [];
      for (const idx of memberIndices) {
        groupEntities.push(...exactGroupList[idx]);
      }

      // Determine resolution method: ai > fuzzy > exact > singleton
      let resMethod: string;
      if (aiMergedRoots.has(rootIdx)) {
        resMethod = 'ai';
      } else if (fuzzyMergedRoots.has(rootIdx)) {
        resMethod = 'fuzzy';
      } else if (memberIndices.length > 1 || groupEntities.length > 1) {
        resMethod = 'exact';
      } else {
        resMethod = 'singleton';
      }

      const node = buildNode(groupEntities, provenanceId);
      // Store resolution algorithm in node metadata
      node.metadata = JSON.stringify({ resolution_algorithm: resMethod });

      // Compute similarity scores for each entity relative to the canonical
      const scores = new Map<string, number>();
      for (const entity of groupEntities) {
        if (entity.normalized_text === node.normalized_name) {
          scores.set(entity.id, 1.0);
        } else {
          scores.set(entity.id, computeTypeSimilarity(
            // Use a proxy with the canonical normalized_text
            { ...entity, normalized_text: node.normalized_name } as Entity,
            entity,
            clusterContext,
          ));
        }
      }

      const links = buildLinks(node, groupEntities, scores, resMethod);
      allNodes.push(node);
      allLinks.push(...links);
    }
  }

  // Compute cross-document vs single-document node counts
  for (const node of allNodes) {
    if (node.document_count > 1) {
      stats.cross_document_nodes++;
    } else {
      stats.single_document_nodes++;
    }
  }

  // Unmatched = entities that ended up in single-entity nodes
  stats.unmatched = allNodes.filter(n => n.mention_count === 1).length;

  return { nodes: allNodes, links: allLinks, stats };
}

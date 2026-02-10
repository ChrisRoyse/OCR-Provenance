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

import { Entity, EntityType } from '../../models/entity.js';
import { KnowledgeNode, NodeEntityLink } from '../../models/knowledge-graph.js';
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
const MAX_FUZZY_GROUP_SIZE = 1000;

/** Minimum Sorensen-Dice score for automatic fuzzy merge */
const FUZZY_MERGE_THRESHOLD = 0.85;

/** Lower bound for AI disambiguation range */
const AI_LOWER_THRESHOLD = 0.70;

export type ResolutionMode = 'exact' | 'fuzzy' | 'ai';

export interface ResolutionResult {
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
 * @param a - First entity
 * @param b - Second entity
 * @returns Similarity score between 0 and 1
 */
function computeTypeSimilarity(a: Entity, b: Entity): number {
  const textA = a.normalized_text;
  const textB = b.normalized_text;

  switch (a.entity_type) {
    case 'person': {
      const tokenSim = tokenSortedSimilarity(textA, textB);
      if (initialMatch(textA, textB)) {
        // Initial match gets a boost: at least 0.90
        return Math.max(tokenSim, 0.90);
      }
      return tokenSim;
    }

    case 'organization': {
      const expandedA = expandAbbreviations(textA);
      const expandedB = expandAbbreviations(textB);
      return sorensenDice(expandedA, expandedB);
    }

    case 'case_number': {
      const normA = normalizeCaseNumber(textA);
      const normB = normalizeCaseNumber(textB);
      return normA === normB ? 1.0 : 0.0;
    }

    case 'amount': {
      return amountsMatch(textA, textB, 0.01) ? 1.0 : 0.0;
    }

    case 'location': {
      if (locationContains(textA, textB)) {
        return Math.max(sorensenDice(textA, textB), 0.85);
      }
      return sorensenDice(textA, textB);
    }

    default:
      return sorensenDice(textA, textB);
  }
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

  return {
    id: uuidv4(),
    entity_type: canonical.entity_type,
    canonical_name: canonical.raw_text,
    normalized_name: canonical.normalized_text,
    aliases,
    document_count: uniqueDocs.size,
    mention_count: groupEntities.length,
    avg_confidence: Math.round(avgConfidence * 10000) / 10000,
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
 * @returns Array of NodeEntityLink records
 */
function buildLinks(
  node: KnowledgeNode,
  groupEntities: Entity[],
  similarityScores: Map<string, number>,
): NodeEntityLink[] {
  const now = new Date().toISOString();
  return groupEntities.map(entity => ({
    id: uuidv4(),
    node_id: node.id,
    entity_id: entity.id,
    document_id: entity.document_id,
    similarity_score: similarityScores.get(entity.id) ?? 1.0,
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
        const node = buildNode(group, provenanceId);
        const scores = new Map<string, number>();
        for (const e of group) {
          scores.set(e.id, 1.0);
        }
        const links = buildLinks(node, group, scores);
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

    for (let i = 0; i < exactGroupList.length; i++) {
      for (let j = i + 1; j < exactGroupList.length; j++) {
        // Already in same group? Skip
        if (uf.find(i) === uf.find(j)) continue;

        const repA = exactGroupList[i][0];
        const repB = exactGroupList[j][0];

        const sim = computeTypeSimilarity(repA, repB);

        if (sim >= FUZZY_MERGE_THRESHOLD) {
          uf.union(i, j);
          // Count all entities in both groups as fuzzy matched
          stats.fuzzy_matches += exactGroupList[i].length + exactGroupList[j].length;
        } else if (mode === 'ai' && sim >= AI_LOWER_THRESHOLD && sim < FUZZY_MERGE_THRESHOLD) {
          aiCandidates.push({ i, j, entityA: repA, entityB: repB });
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
    const mergedGroups = uf.getGroups();

    for (const [, memberIndices] of mergedGroups) {
      // Flatten all entities from merged exact groups
      const groupEntities: Entity[] = [];
      for (const idx of memberIndices) {
        groupEntities.push(...exactGroupList[idx]);
      }

      const node = buildNode(groupEntities, provenanceId);

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
          ));
        }
      }

      const links = buildLinks(node, groupEntities, scores);
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

  // Deduplicate exact/fuzzy/ai counts: entities counted in fuzzy may have
  // already been counted in exact. Adjust exact to only count those NOT
  // also counted as fuzzy or AI.
  // Actually, exact_matches counts entities in multi-entity exact groups,
  // while fuzzy_matches counts entities whose groups were merged by fuzzy.
  // An entity can be in both counts if its exact group had >1 entity AND
  // got fuzzy-merged. This is intentional -- the stats show how many
  // entities benefited from each tier.

  return { nodes: allNodes, links: allLinks, stats };
}

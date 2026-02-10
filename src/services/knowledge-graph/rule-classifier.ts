/**
 * Rule-based relationship classification for knowledge graph edges
 *
 * Deterministic classification using entity type pairs to avoid
 * unnecessary Gemini API calls. Applied BEFORE AI classification.
 * Saves ~60-70% of API calls.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module services/knowledge-graph/rule-classifier
 */

import type { EntityType } from '../../models/entity.js';
import type { RelationshipType } from '../../models/knowledge-graph.js';

interface RuleResult {
  type: RelationshipType;
  confidence: number;
}

/**
 * Rule matrix for deterministic entity type pair -> relationship type mapping.
 * Checked in BOTH orderings (source/target can be either entity).
 */
const RULE_MATRIX: Array<{
  source_type: EntityType;
  target_type: EntityType;
  result: RelationshipType;
  confidence: number;
}> = [
  { source_type: 'person', target_type: 'organization', result: 'works_at', confidence: 0.75 },
  { source_type: 'organization', target_type: 'location', result: 'located_in', confidence: 0.80 },
  { source_type: 'case_number', target_type: 'date', result: 'filed_in', confidence: 0.85 },
  { source_type: 'statute', target_type: 'case_number', result: 'cites', confidence: 0.90 },
  { source_type: 'case_number', target_type: 'statute', result: 'cites', confidence: 0.90 },
  { source_type: 'person', target_type: 'location', result: 'located_in', confidence: 0.70 },
  { source_type: 'organization', target_type: 'case_number', result: 'party_to', confidence: 0.75 },
  { source_type: 'person', target_type: 'case_number', result: 'party_to', confidence: 0.75 },
];

/**
 * Classify a relationship between two entity types using deterministic rules.
 * Checks both orderings of the type pair.
 *
 * @param sourceType - Entity type of source node
 * @param targetType - Entity type of target node
 * @returns Rule result with relationship type and confidence, or null if no rule matches
 */
export function classifyByRules(
  sourceType: EntityType,
  targetType: EntityType,
): RuleResult | null {
  const match = RULE_MATRIX.find(r =>
    (r.source_type === sourceType && r.target_type === targetType) ||
    (r.source_type === targetType && r.target_type === sourceType)
  );
  return match ? { type: match.result, confidence: match.confidence } : null;
}

/**
 * Classify relationships using extraction schema context.
 * When entities come from structured extractions, use the schema
 * to deterministically assign relationship types.
 *
 * @param sourceMetadata - Metadata JSON of source entity (may contain extraction_id)
 * @param targetMetadata - Metadata JSON of target entity (may contain extraction_id)
 * @param sourceType - Entity type of source
 * @param targetType - Entity type of target
 * @returns Rule result or null
 */
export function classifyByExtractionSchema(
  sourceMetadata: string | null,
  targetMetadata: string | null,
  sourceType: EntityType,
  targetType: EntityType,
): RuleResult | null {
  if (!sourceMetadata && !targetMetadata) return null;

  try {
    const srcMeta = sourceMetadata ? JSON.parse(sourceMetadata) : {};
    const tgtMeta = targetMetadata ? JSON.parse(targetMetadata) : {};

    // Both from same extraction = high confidence
    if (srcMeta.extraction_id && tgtMeta.extraction_id && srcMeta.extraction_id === tgtMeta.extraction_id) {
      // Invoice/contract patterns
      if ((sourceType === 'organization' || sourceType === 'person') &&
          (targetType === 'organization' || targetType === 'person')) {
        return { type: 'party_to', confidence: 0.90 };
      }
      if ((sourceType === 'organization' || sourceType === 'person') && targetType === 'amount') {
        return { type: 'party_to', confidence: 0.85 };
      }
    }
  } catch {
    // Malformed metadata JSON - skip
  }

  return null;
}

/**
 * Classify relationships using cluster context.
 * When both entities' documents share a classified cluster,
 * use the cluster tag to hint at the relationship type.
 *
 * @param clusterTag - The classification tag of the shared cluster (e.g., "employment", "litigation")
 * @param sourceType - Entity type of source
 * @param targetType - Entity type of target
 * @returns Rule result or null
 */
export function classifyByClusterHint(
  clusterTag: string | null,
  sourceType: EntityType,
  targetType: EntityType,
): RuleResult | null {
  if (!clusterTag) return null;

  const tag = clusterTag.toLowerCase();

  if (tag.includes('employment') || tag.includes('hr') || tag.includes('personnel')) {
    if (sourceType === 'person' && targetType === 'organization') {
      return { type: 'works_at', confidence: 0.90 };
    }
    if (sourceType === 'organization' && targetType === 'person') {
      return { type: 'works_at', confidence: 0.90 };
    }
  }

  if (tag.includes('litigation') || tag.includes('legal') || tag.includes('court')) {
    if (sourceType === 'person' && targetType === 'person') {
      return { type: 'party_to', confidence: 0.80 };
    }
    if ((sourceType === 'person' || sourceType === 'organization') && targetType === 'case_number') {
      return { type: 'party_to', confidence: 0.85 };
    }
    if ((targetType === 'person' || targetType === 'organization') && sourceType === 'case_number') {
      return { type: 'party_to', confidence: 0.85 };
    }
  }

  return null;
}

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

import Database from 'better-sqlite3';
import type { EntityType } from '../../models/entity.js';
import {
  RELATIONSHIP_TYPES,
  type RelationshipType,
  type KnowledgeEdge,
} from '../../models/knowledge-graph.js';
import { getSharedClient } from '../gemini/client.js';
import {
  getKnowledgeNode,
  getLinksForNode,
  updateKnowledgeEdge,
  updateEdgeRelationshipType,
} from '../storage/database/knowledge-graph-operations.js';
import { getEntityMentions } from '../storage/database/entity-operations.js';

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
  // --- Legal: Person/Organization relationships ---
  { source_type: 'person', target_type: 'organization', result: 'works_at', confidence: 0.75 },
  { source_type: 'person', target_type: 'location', result: 'located_in', confidence: 0.7 },
  { source_type: 'organization', target_type: 'location', result: 'located_in', confidence: 0.8 },

  // --- Legal: Case/Statute/Filing relationships ---
  { source_type: 'case_number', target_type: 'date', result: 'filed_in', confidence: 0.85 },
  { source_type: 'statute', target_type: 'case_number', result: 'cites', confidence: 0.9 },
  { source_type: 'organization', target_type: 'case_number', result: 'party_to', confidence: 0.75 },
  { source_type: 'person', target_type: 'case_number', result: 'party_to', confidence: 0.75 },
  { source_type: 'location', target_type: 'case_number', result: 'filed_in', confidence: 0.75 },

  // --- Legal: Exhibit relationships ---
  { source_type: 'exhibit', target_type: 'case_number', result: 'references', confidence: 0.85 },
  { source_type: 'exhibit', target_type: 'person', result: 'references', confidence: 0.7 },
  { source_type: 'exhibit', target_type: 'organization', result: 'references', confidence: 0.7 },

  // --- Legal: Statute/Citation relationships ---
  { source_type: 'statute', target_type: 'person', result: 'cites', confidence: 0.7 },
  { source_type: 'statute', target_type: 'organization', result: 'cites', confidence: 0.7 },

  // --- Temporal: Date associations ---
  { source_type: 'date', target_type: 'person', result: 'occurred_at', confidence: 0.7 },
  { source_type: 'date', target_type: 'organization', result: 'occurred_at', confidence: 0.7 },
  { source_type: 'date', target_type: 'location', result: 'occurred_at', confidence: 0.7 },

  // --- Financial: Amount associations ---
  { source_type: 'amount', target_type: 'case_number', result: 'party_to', confidence: 0.7 },
  { source_type: 'amount', target_type: 'person', result: 'references', confidence: 0.65 },
  { source_type: 'amount', target_type: 'organization', result: 'references', confidence: 0.65 },

  // --- Medical: Person/Treatment relationships ---
  { source_type: 'person', target_type: 'medication', result: 'references', confidence: 0.75 },
  { source_type: 'person', target_type: 'diagnosis', result: 'references', confidence: 0.75 },
  { source_type: 'person', target_type: 'medical_device', result: 'references', confidence: 0.75 },

  // --- Medical: Treatment/Device/Diagnosis relationships (GAP-M8) ---
  { source_type: 'diagnosis', target_type: 'medication', result: 'treated_with', confidence: 0.85 },
  {
    source_type: 'medication',
    target_type: 'medical_device',
    result: 'administered_via',
    confidence: 0.8,
  },
  {
    source_type: 'diagnosis',
    target_type: 'medical_device',
    result: 'managed_by',
    confidence: 0.8,
  },
  {
    source_type: 'medication',
    target_type: 'medication',
    result: 'interacts_with',
    confidence: 0.75,
  },
];

/**
 * Classify a relationship between two entity types using deterministic rules.
 * Checks both orderings of the type pair.
 *
 * @param sourceType - Entity type of source node
 * @param targetType - Entity type of target node
 * @returns Rule result with relationship type and confidence, or null if no rule matches
 */
export function classifyByRules(sourceType: EntityType, targetType: EntityType): RuleResult | null {
  const match = RULE_MATRIX.find(
    (r) =>
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
  targetType: EntityType
): RuleResult | null {
  if (!sourceMetadata && !targetMetadata) return null;

  try {
    const srcMeta = sourceMetadata ? JSON.parse(sourceMetadata) : {};
    const tgtMeta = targetMetadata ? JSON.parse(targetMetadata) : {};

    // Both from same extraction = high confidence
    if (
      srcMeta.extraction_id &&
      tgtMeta.extraction_id &&
      srcMeta.extraction_id === tgtMeta.extraction_id
    ) {
      // Invoice/contract patterns
      if (
        (sourceType === 'organization' || sourceType === 'person') &&
        (targetType === 'organization' || targetType === 'person')
      ) {
        return { type: 'party_to', confidence: 0.9 };
      }
      if ((sourceType === 'organization' || sourceType === 'person') && targetType === 'amount') {
        return { type: 'party_to', confidence: 0.85 };
      }
    }
  } catch (error) {
    console.error(`[RuleClassifier] Failed to parse edge metadata JSON: ${String(error)}`);
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
  targetType: EntityType
): RuleResult | null {
  if (!clusterTag) return null;

  const tag = clusterTag.toLowerCase();

  // Check if the type pair matches in either ordering
  function typePairMatches(a: EntityType, b: EntityType): boolean {
    return (sourceType === a && targetType === b) || (sourceType === b && targetType === a);
  }

  if (tag.includes('employment') || tag.includes('hr') || tag.includes('personnel')) {
    if (typePairMatches('person', 'organization')) {
      return { type: 'works_at', confidence: 0.9 };
    }
  }

  if (
    tag.includes('medical') ||
    tag.includes('health') ||
    tag.includes('clinical') ||
    tag.includes('hospice')
  ) {
    if (
      typePairMatches('person', 'medication') ||
      typePairMatches('person', 'diagnosis') ||
      typePairMatches('person', 'medical_device')
    ) {
      return { type: 'references', confidence: 0.85 };
    }
    if (
      typePairMatches('medication', 'diagnosis') ||
      typePairMatches('medical_device', 'diagnosis')
    ) {
      return { type: 'related_to', confidence: 0.85 };
    }
  }

  if (tag.includes('litigation') || tag.includes('legal') || tag.includes('court')) {
    if (sourceType === 'person' && targetType === 'person') {
      return { type: 'party_to', confidence: 0.8 };
    }
    if (
      typePairMatches('person', 'case_number') ||
      typePairMatches('organization', 'case_number')
    ) {
      return { type: 'party_to', confidence: 0.85 };
    }
  }

  return null;
}

// ============================================================
// Gemini-based Semantic Relationship Classification
// ============================================================

/** Classification types that Gemini can assign (excludes co_mentioned/co_located which are structural) */
const CLASSIFIABLE_TYPES: RelationshipType[] = RELATIONSHIP_TYPES.filter(
  (t) => t !== 'co_mentioned' && t !== 'co_located'
);

/** Result statistics from classifyEdgesWithGemini */
export interface ClassificationStats {
  edges_processed: number;
  edges_classified: number;
  edges_unchanged: number;
  edges_failed: number;
  type_distribution: Record<string, number>;
  processing_duration_ms: number;
}

/** Context gathered for a single edge to send to Gemini */
interface EdgeContext {
  edge_id: string;
  source_name: string;
  source_type: string;
  target_name: string;
  target_type: string;
  text_contexts: string[];
}

/**
 * Gather text context for an edge by looking at entity mentions
 * for both endpoint nodes. Collects context_text from entity_mentions
 * and chunk text from shared chunks.
 */
function gatherEdgeContext(conn: Database.Database, edge: KnowledgeEdge): EdgeContext | null {
  const sourceNode = getKnowledgeNode(conn, edge.source_node_id);
  const targetNode = getKnowledgeNode(conn, edge.target_node_id);
  if (!sourceNode || !targetNode) return null;

  const textContexts: string[] = [];

  // Strategy 1: Get shared chunk text from edge metadata
  if (edge.metadata) {
    try {
      const meta = JSON.parse(edge.metadata) as { shared_chunk_ids?: string[] };
      if (meta.shared_chunk_ids) {
        for (const chunkId of meta.shared_chunk_ids.slice(0, 3)) {
          const chunkRow = conn.prepare('SELECT text FROM chunks WHERE id = ?').get(chunkId) as
            | { text: string }
            | undefined;
          if (chunkRow) {
            textContexts.push(chunkRow.text.slice(0, 1500));
          }
        }
      }
    } catch (error) {
      console.error(
        `[RuleClassifier] Failed to extract text context from edge metadata: ${String(error)}`
      );
    }
  }

  // Strategy 2: Get context_text from entity_mentions for both nodes
  if (textContexts.length === 0) {
    const sourceLinks = getLinksForNode(conn, sourceNode.id);
    const targetLinks = getLinksForNode(conn, targetNode.id);

    // Collect chunk IDs from source node's entities
    const sourceChunkIds = new Set<string>();
    for (const link of sourceLinks.slice(0, 5)) {
      const mentions = getEntityMentions(conn, link.entity_id);
      for (const m of mentions) {
        if (m.context_text && m.context_text.length > 20) {
          textContexts.push(m.context_text.slice(0, 500));
        }
        if (m.chunk_id) sourceChunkIds.add(m.chunk_id);
      }
    }

    // Find shared chunks with target
    for (const link of targetLinks.slice(0, 5)) {
      const mentions = getEntityMentions(conn, link.entity_id);
      for (const m of mentions) {
        if (m.chunk_id && sourceChunkIds.has(m.chunk_id)) {
          // Shared chunk - get its text
          const chunkRow = conn.prepare('SELECT text FROM chunks WHERE id = ?').get(m.chunk_id) as
            | { text: string }
            | undefined;
          if (chunkRow) {
            textContexts.push(chunkRow.text.slice(0, 1500));
          }
        }
      }
    }
  }

  // Deduplicate and limit total context size
  const uniqueContexts = [...new Set(textContexts)].slice(0, 5);

  return {
    edge_id: edge.id,
    source_name: sourceNode.canonical_name,
    source_type: sourceNode.entity_type,
    target_name: targetNode.canonical_name,
    target_type: targetNode.entity_type,
    text_contexts: uniqueContexts,
  };
}

/**
 * Build a Gemini prompt for a batch of edge contexts.
 * Returns a prompt that asks Gemini to classify each edge.
 */
function buildBatchPrompt(batch: EdgeContext[]): string {
  const typeList = CLASSIFIABLE_TYPES.map((t) => `  - ${t}`).join('\n');

  const pairs = batch
    .map((ctx, i) => {
      const contextStr =
        ctx.text_contexts.length > 0
          ? `\n   Context: "${ctx.text_contexts.join(' ... ').slice(0, 2000)}"`
          : '';
      return `${i + 1}. Entity A: "${ctx.source_name}" (${ctx.source_type}) <-> Entity B: "${ctx.target_name}" (${ctx.target_type})${contextStr}`;
    })
    .join('\n\n');

  return `Given these entity pairs and the text context where they appear together, classify each relationship.

Valid relationship types:
${typeList}

If the co-occurrence does not imply a specific relationship, respond with "co_mentioned".

Entity pairs to classify:

${pairs}

For each pair, respond with the relationship type.`;
}

/**
 * Parse Gemini's response schema output into per-edge classifications.
 */
function parseClassificationResponse(
  responseText: string,
  batch: EdgeContext[]
): Map<string, RelationshipType> {
  const results = new Map<string, RelationshipType>();

  try {
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed.classifications)) {
      for (let i = 0; i < parsed.classifications.length && i < batch.length; i++) {
        const classification = parsed.classifications[i];
        const relType = (classification.relationship_type ?? '')
          .trim()
          .toLowerCase() as RelationshipType;
        if (RELATIONSHIP_TYPES.includes(relType)) {
          results.set(batch[i].edge_id, relType);
        }
      }
    }
  } catch (error) {
    console.error(
      '[RuleClassifier] Structured JSON parse failed, attempting line-by-line fallback:',
      error instanceof Error ? error.message : String(error)
    );
    // If structured parse fails, try line-by-line fallback
    const lines = responseText
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length && i < batch.length; i++) {
      const cleaned = lines[i]
        .replace(/^\d+[.):\s]+/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z_]/g, '') as RelationshipType;
      if (RELATIONSHIP_TYPES.includes(cleaned)) {
        results.set(batch[i].edge_id, cleaned);
      }
    }
  }

  return results;
}

/**
 * Classify knowledge graph edges using Gemini semantic analysis.
 *
 * For each edge, gathers the text context where the two entities co-occur,
 * batches edges (up to batchSize per Gemini call), and updates
 * relationship_type in the database.
 *
 * @param conn - Database connection
 * @param options - Optional edge IDs, limit, batch size
 * @returns Classification statistics
 */
export async function classifyEdgesWithGemini(
  conn: Database.Database,
  options?: {
    edge_ids?: string[];
    limit?: number;
    batch_size?: number;
  }
): Promise<ClassificationStats> {
  const startTime = Date.now();
  const limit = options?.limit ?? 100;
  const batchSize = Math.min(options?.batch_size ?? 20, 50);

  // Get edges to classify
  let edges: KnowledgeEdge[];
  if (options?.edge_ids && options.edge_ids.length > 0) {
    // Specific edges requested
    edges = [];
    for (const edgeId of options.edge_ids.slice(0, limit)) {
      const row = conn.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get(edgeId) as
        | KnowledgeEdge
        | undefined;
      if (row) edges.push(row);
    }
  } else {
    // Default: all co_mentioned and co_located edges
    edges = conn
      .prepare(
        `SELECT * FROM knowledge_edges
       WHERE relationship_type IN ('co_mentioned', 'co_located')
       ORDER BY weight DESC
       LIMIT ?`
      )
      .all(limit) as KnowledgeEdge[];
  }

  if (edges.length === 0) {
    return {
      edges_processed: 0,
      edges_classified: 0,
      edges_unchanged: 0,
      edges_failed: 0,
      type_distribution: {},
      processing_duration_ms: Date.now() - startTime,
    };
  }

  // Initialize Gemini client
  const client = getSharedClient();

  // Gather context for all edges
  const edgeContexts: EdgeContext[] = [];
  for (const edge of edges) {
    const ctx = gatherEdgeContext(conn, edge);
    if (ctx) edgeContexts.push(ctx);
  }

  console.error(
    `[RelClassifier] Classifying ${edgeContexts.length} edges in batches of ${batchSize}`
  );

  // Response schema for structured output
  const responseSchema = {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            relationship_type: {
              type: 'string',
              enum: [...RELATIONSHIP_TYPES],
            },
          },
          required: ['relationship_type'],
        },
      },
    },
    required: ['classifications'],
  };

  let edgesClassified = 0;
  let edgesUnchanged = 0;
  let edgesFailed = 0;
  const typeDistribution: Record<string, number> = {};

  // Process in batches
  for (let i = 0; i < edgeContexts.length; i += batchSize) {
    const batch = edgeContexts.slice(i, i + batchSize);
    const prompt = buildBatchPrompt(batch);

    try {
      const response = await client.fast(prompt, responseSchema);
      const classifications = parseClassificationResponse(response.text, batch);

      for (const ctx of batch) {
        const newType = classifications.get(ctx.edge_id);
        if (!newType || newType === 'co_mentioned' || newType === 'co_located') {
          edgesUnchanged++;
          continue;
        }

        // Find the original edge to get its current metadata
        const originalEdge = edges.find((e) => e.id === ctx.edge_id);
        const existingMeta = originalEdge?.metadata ? JSON.parse(originalEdge.metadata) : {};
        const originalType = originalEdge?.relationship_type ?? 'co_mentioned';

        // Update the edge type
        updateEdgeRelationshipType(conn, ctx.edge_id, newType);

        // Update metadata with classification history
        updateKnowledgeEdge(conn, ctx.edge_id, {
          metadata: JSON.stringify({
            ...existingMeta,
            classified_by: 'gemini_semantic',
            classification_history: [
              ...(existingMeta.classification_history ?? []),
              {
                original_type: originalType,
                classified_type: newType,
                classified_by: 'gemini_semantic',
                classified_at: new Date().toISOString(),
              },
            ],
          }),
        });

        edgesClassified++;
        typeDistribution[newType] = (typeDistribution[newType] ?? 0) + 1;
      }
    } catch (error) {
      console.error(
        `[RelClassifier] Batch ${Math.floor(i / batchSize) + 1} failed:`,
        error instanceof Error ? error.message : String(error)
      );
      edgesFailed += batch.length;
    }
  }

  console.error(
    `[RelClassifier] Done: ${edgesClassified} classified, ${edgesUnchanged} unchanged, ${edgesFailed} failed`
  );

  return {
    edges_processed: edgeContexts.length,
    edges_classified: edgesClassified,
    edges_unchanged: edgesUnchanged,
    edges_failed: edgesFailed,
    type_distribution: typeDistribution,
    processing_duration_ms: Date.now() - startTime,
  };
}

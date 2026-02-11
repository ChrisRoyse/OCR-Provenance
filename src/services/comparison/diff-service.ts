/**
 * Document Comparison Diff Service
 *
 * Computes text, structural, and entity diffs between two OCR-processed documents.
 * Uses the `diff` npm package (jsdiff) for text comparison.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 */

import { diffLines } from 'diff';
import type Database from 'better-sqlite3';
import type {
  TextDiffOperation,
  TextDiffResult,
  StructuralDiff,
  EntityDiffByType,
  EntityDiff,
  Contradiction,
  ContradictionResult,
} from '../../models/comparison.js';
import type { Entity } from '../../models/entity.js';
import type { RelationshipType } from '../../models/knowledge-graph.js';

/**
 * Input shape for a document's structural metadata used in compareStructure()
 */
export interface StructuralDocInput {
  page_count: number | null;
  text_length: number;
  quality_score: number | null;
  ocr_mode: string;
  chunk_count: number;
}

/**
 * Compare structural metadata between two documents
 *
 * @param doc1 - First document structural metadata
 * @param doc2 - Second document structural metadata
 * @returns StructuralDiff with side-by-side metadata
 */
export function compareStructure(doc1: StructuralDocInput, doc2: StructuralDocInput): StructuralDiff {
  return {
    doc1_page_count: doc1.page_count,
    doc2_page_count: doc2.page_count,
    doc1_chunk_count: doc1.chunk_count,
    doc2_chunk_count: doc2.chunk_count,
    doc1_text_length: doc1.text_length,
    doc2_text_length: doc2.text_length,
    doc1_quality_score: doc1.quality_score,
    doc2_quality_score: doc2.quality_score,
    doc1_ocr_mode: doc1.ocr_mode,
    doc2_ocr_mode: doc2.ocr_mode,
  };
}

/**
 * Compare two texts using line-level diff
 *
 * @param text1 - First document text
 * @param text2 - Second document text
 * @param maxOperations - Maximum operations to return (default 1000)
 * @returns TextDiffResult with operations, counts, and similarity ratio
 */
export function compareText(text1: string, text2: string, maxOperations: number = 1000): TextDiffResult {
  const changes = diffLines(text1, text2);

  let doc1Offset = 0;
  let doc2Offset = 0;
  let insertions = 0;
  let deletions = 0;
  let unchanged = 0;
  const operations: TextDiffOperation[] = [];

  for (const change of changes) {
    let type: TextDiffOperation['type'];
    if (change.added) {
      type = 'insert';
    } else if (change.removed) {
      type = 'delete';
    } else {
      type = 'equal';
    }

    operations.push({
      type,
      text: change.value,
      doc1_offset: doc1Offset,
      doc2_offset: doc2Offset,
      line_count: change.count ?? 0,
    });

    if (change.added) {
      insertions++;
      doc2Offset += change.value.length;
    } else if (change.removed) {
      deletions++;
      doc1Offset += change.value.length;
    } else {
      unchanged++;
      doc1Offset += change.value.length;
      doc2Offset += change.value.length;
    }
  }

  const totalOps = operations.length;
  const truncated = totalOps > maxOperations;
  const finalOps = truncated ? operations.slice(0, maxOperations) : operations;

  // Similarity = unchanged chars / total chars
  const unchangedChars = operations.filter(o => o.type === 'equal').reduce((sum, o) => sum + o.text.length, 0);
  const totalChars = text1.length + text2.length;
  const similarityRatio = totalChars === 0 ? 1.0 : (2 * unchangedChars) / totalChars;

  return {
    operations: finalOps,
    total_operations: totalOps,
    truncated,
    insertions,
    deletions,
    unchanged,
    similarity_ratio: Math.round(similarityRatio * 10000) / 10000,
    doc1_length: text1.length,
    doc2_length: text2.length,
  };
}

/**
 * Compare entities between two documents.
 *
 * When a database connection is provided, entities are resolved through
 * the knowledge graph: each entity is mapped to its KG canonical node
 * via node_entity_links -> knowledge_nodes. This means "J. Smith" and
 * "John Smith" will compare as the same entity if the KG resolved them.
 * Falls back to normalized_text for entities without KG node links.
 *
 * @param entities1 - Entities from first document
 * @param entities2 - Entities from second document
 * @param db - Optional database connection for KG-aware comparison
 */
export function compareEntities(entities1: Entity[], entities2: Entity[], db?: Database.Database): EntityDiff {
  // Build KG resolution map if database is available
  const kgNameMap = db ? buildKGResolutionMap(db, entities1, entities2) : null;

  const resolveEntityName = (e: Entity): string => {
    if (kgNameMap) {
      const canonical = kgNameMap.get(e.id);
      if (canonical) return canonical;
    }
    return e.normalized_text;
  };

  const byType1 = groupByType(entities1);
  const byType2 = groupByType(entities2);
  const allTypes = new Set([...Object.keys(byType1), ...Object.keys(byType2)]);

  const by_type: Record<string, EntityDiffByType> = {};
  for (const type of allTypes) {
    const set1 = new Set((byType1[type] ?? []).map(resolveEntityName));
    const set2 = new Set((byType2[type] ?? []).map(resolveEntityName));
    by_type[type] = {
      doc1_count: set1.size,
      doc2_count: set2.size,
      common: [...set1].filter(x => set2.has(x)),
      doc1_only: [...set1].filter(x => !set2.has(x)),
      doc2_only: [...set2].filter(x => !set1.has(x)),
    };
  }

  return {
    doc1_total_entities: entities1.length,
    doc2_total_entities: entities2.length,
    by_type,
    kg_resolved: kgNameMap !== null && kgNameMap.size > 0,
  };
}

/**
 * Build a map from entity ID -> KG canonical name for two sets of entities.
 * Uses a batch query per document for efficiency (avoids N+1 queries).
 */
function buildKGResolutionMap(
  db: Database.Database,
  entities1: Entity[],
  entities2: Entity[],
): Map<string, string> {
  const result = new Map<string, string>();

  // Collect unique document IDs
  const docIds = new Set<string>();
  for (const e of entities1) docIds.add(e.document_id);
  for (const e of entities2) docIds.add(e.document_id);

  try {
    // Batch query: for each document, get entity_id -> canonical_name mapping
    const stmt = db.prepare(`
      SELECT e.id as entity_id, kn.canonical_name
      FROM entities e
      JOIN node_entity_links nel ON nel.entity_id = e.id
      JOIN knowledge_nodes kn ON nel.node_id = kn.id
      WHERE e.document_id = ?
    `);

    for (const docId of docIds) {
      const rows = stmt.all(docId) as Array<{ entity_id: string; canonical_name: string }>;
      for (const row of rows) {
        result.set(row.entity_id, row.canonical_name);
      }
    }
  } catch {
    // KG tables may not exist (no graph built yet) - return empty map
  }

  return result;
}

function groupByType(entities: Entity[]): Record<string, Entity[]> {
  const groups: Record<string, Entity[]> = {};
  for (const e of entities) {
    (groups[e.entity_type] ??= []).push(e);
  }
  return groups;
}

/**
 * Generate a human-readable summary of the comparison
 */
export function generateSummary(
  textDiff: TextDiffResult | null,
  structuralDiff: StructuralDiff,
  entityDiff: EntityDiff | null,
  doc1Name: string,
  doc2Name: string
): string {
  const parts: string[] = [];

  parts.push(`Comparison of "${doc1Name}" vs "${doc2Name}".`);

  if (textDiff) {
    const pct = Math.round(textDiff.similarity_ratio * 100);
    parts.push(`Text similarity: ${pct}%.`);
    parts.push(`${textDiff.insertions} insertions, ${textDiff.deletions} deletions, ${textDiff.unchanged} unchanged sections.`);
    if (textDiff.truncated) {
      parts.push(`(Diff truncated: showing ${textDiff.operations.length} of ${textDiff.total_operations} operations.)`);
    }
  }

  const pageDiff = (structuralDiff.doc1_page_count ?? 0) - (structuralDiff.doc2_page_count ?? 0);
  if (pageDiff !== 0) {
    parts.push(`Page count difference: ${Math.abs(pageDiff)} pages.`);
  }

  if (entityDiff && Object.keys(entityDiff.by_type).length > 0) {
    let totalCommon = 0;
    let totalUnique1 = 0;
    let totalUnique2 = 0;
    for (const t of Object.values(entityDiff.by_type)) {
      totalCommon += t.common.length;
      totalUnique1 += t.doc1_only.length;
      totalUnique2 += t.doc2_only.length;
    }
    parts.push(`Entities: ${totalCommon} common, ${totalUnique1} unique to doc1, ${totalUnique2} unique to doc2.`);
  }

  return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// KG CONTRADICTION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Semantic relationship types that imply directional, meaningful connections.
 * Co-occurrence types (co_mentioned, co_located) are excluded because they
 * don't assert a specific relationship that can be contradicted.
 */
const SEMANTIC_RELATIONSHIP_TYPES: Set<RelationshipType> = new Set([
  'works_at', 'represents', 'party_to', 'located_in',
  'filed_in', 'cites', 'references', 'occurred_at', 'precedes',
]);

/** Internal representation of an entity's relationship from KG edges */
interface EntityRelationship {
  nodeId: string;
  canonicalName: string;
  entityType: string;
  relationshipType: RelationshipType;
  relatedNodeId: string;
  relatedCanonicalName: string;
  relatedEntityType: string;
  /** Which document IDs this edge was evidenced from */
  edgeDocumentIds: string[];
}

/**
 * Detect contradictions between two documents' entities and KG edges.
 *
 * For entities present in both documents that have KG nodes with semantic
 * edges, checks whether the two documents assert conflicting relationships.
 * For example, if doc1 says "John works_at Acme" but doc2 says "John works_at Beta",
 * that is a HIGH severity contradiction.
 *
 * Severity levels:
 * - HIGH: same entity has same relationship type pointing to different targets
 * - MEDIUM: same entity exists in both docs but with different relationship types
 * - LOW: entity in one doc has semantic relationships not present in the other
 *
 * Returns empty result if KG tables don't exist or have no data.
 *
 * @param conn - Database connection
 * @param doc1Entities - Entities from first document
 * @param doc2Entities - Entities from second document
 */
export function detectKGContradictions(
  conn: Database.Database,
  doc1Entities: Entity[],
  doc2Entities: Entity[],
): ContradictionResult {
  const emptyResult: ContradictionResult = {
    contradictions: [],
    entities_checked: 0,
    kg_edges_analyzed: 0,
  };

  if (doc1Entities.length === 0 && doc2Entities.length === 0) {
    return emptyResult;
  }

  // Step 1: Resolve entities to KG nodes. Build entity_id -> { node_id, canonical_name, entity_type }
  const entityToNode = new Map<string, { nodeId: string; canonicalName: string; entityType: string }>();
  let kgEdgesAnalyzed = 0;

  try {
    const stmt = conn.prepare(`
      SELECT e.id as entity_id, kn.id as node_id, kn.canonical_name, kn.entity_type
      FROM entities e
      JOIN node_entity_links nel ON nel.entity_id = e.id
      JOIN knowledge_nodes kn ON nel.node_id = kn.id
      WHERE e.id = ?
    `);

    const allEntities = [...doc1Entities, ...doc2Entities];
    for (const entity of allEntities) {
      if (entityToNode.has(entity.id)) continue;
      const row = stmt.get(entity.id) as { entity_id: string; node_id: string; canonical_name: string; entity_type: string } | undefined;
      if (row) {
        entityToNode.set(row.entity_id, {
          nodeId: row.node_id,
          canonicalName: row.canonical_name,
          entityType: row.entity_type,
        });
      }
    }
  } catch {
    // KG tables don't exist - return empty
    return emptyResult;
  }

  if (entityToNode.size === 0) {
    return emptyResult;
  }

  // Build reverse lookup: node_id -> { nodeId, canonicalName, entityType }
  const nodeIdToInfo = new Map<string, { nodeId: string; canonicalName: string; entityType: string }>();
  for (const info of entityToNode.values()) {
    if (!nodeIdToInfo.has(info.nodeId)) {
      nodeIdToInfo.set(info.nodeId, info);
    }
  }

  // Step 2: Build node_id -> document sets (which docs mention this KG node)
  const doc1NodeIds = new Set<string>();
  const doc2NodeIds = new Set<string>();
  for (const e of doc1Entities) {
    const node = entityToNode.get(e.id);
    if (node) doc1NodeIds.add(node.nodeId);
  }
  for (const e of doc2Entities) {
    const node = entityToNode.get(e.id);
    if (node) doc2NodeIds.add(node.nodeId);
  }

  // Step 3: For shared nodes, get semantic edges and check for contradictions
  const sharedNodeIds = [...doc1NodeIds].filter(id => doc2NodeIds.has(id));
  const doc1OnlyNodeIds = [...doc1NodeIds].filter(id => !doc2NodeIds.has(id));
  const doc2OnlyNodeIds = [...doc2NodeIds].filter(id => !doc1NodeIds.has(id));

  const entitiesChecked = new Set([...doc1NodeIds, ...doc2NodeIds]).size;

  // Get semantic edges for all relevant nodes
  const getSemanticEdgesForNode = (nodeId: string): EntityRelationship[] => {
    const relationships: EntityRelationship[] = [];
    const nodeInfo = nodeIdToInfo.get(nodeId) ?? null;
    if (!nodeInfo) return relationships;

    const edges = conn.prepare(`
      SELECT ke.*, kn_src.canonical_name as src_name, kn_src.entity_type as src_type,
             kn_tgt.canonical_name as tgt_name, kn_tgt.entity_type as tgt_type
      FROM knowledge_edges ke
      JOIN knowledge_nodes kn_src ON kn_src.id = ke.source_node_id
      JOIN knowledge_nodes kn_tgt ON kn_tgt.id = ke.target_node_id
      WHERE (ke.source_node_id = ? OR ke.target_node_id = ?)
      ORDER BY ke.weight DESC
    `).all(nodeId, nodeId) as Array<{
      id: string; source_node_id: string; target_node_id: string;
      relationship_type: string; weight: number; document_ids: string;
      src_name: string; src_type: string; tgt_name: string; tgt_type: string;
    }>;

    kgEdgesAnalyzed += edges.length;

    for (const edge of edges) {
      if (!SEMANTIC_RELATIONSHIP_TYPES.has(edge.relationship_type as RelationshipType)) {
        continue;
      }

      // Determine direction: the entity is the source, the related entity is the target
      const isSource = edge.source_node_id === nodeId;
      const relatedNodeId = isSource ? edge.target_node_id : edge.source_node_id;
      const relatedName = isSource ? edge.tgt_name : edge.src_name;
      const relatedType = isSource ? edge.tgt_type : edge.src_type;

      let edgeDocIds: string[] = [];
      try {
        edgeDocIds = JSON.parse(edge.document_ids);
      } catch {
        edgeDocIds = [];
      }

      relationships.push({
        nodeId,
        canonicalName: nodeInfo.canonicalName,
        entityType: nodeInfo.entityType,
        relationshipType: edge.relationship_type as RelationshipType,
        relatedNodeId,
        relatedCanonicalName: relatedName,
        relatedEntityType: relatedType,
        edgeDocumentIds: edgeDocIds,
      });
    }

    return relationships;
  };

  const contradictions: Contradiction[] = [];

  // Get doc IDs for source attribution
  const doc1Id = doc1Entities.length > 0 ? doc1Entities[0].document_id : '';
  const doc2Id = doc2Entities.length > 0 ? doc2Entities[0].document_id : '';

  // HIGH severity: shared entities with conflicting same-type relationships
  for (const nodeId of sharedNodeIds) {
    const allRels = getSemanticEdgesForNode(nodeId);
    if (allRels.length === 0) continue;

    // Group by relationship_type
    const byRelType = new Map<string, EntityRelationship[]>();
    for (const rel of allRels) {
      const existing = byRelType.get(rel.relationshipType) ?? [];
      existing.push(rel);
      byRelType.set(rel.relationshipType, existing);
    }

    for (const [relType, rels] of byRelType) {
      if (rels.length < 2) continue;

      // Find relationships evidenced by doc1 vs doc2
      const doc1Rels = rels.filter(r => r.edgeDocumentIds.includes(doc1Id));
      const doc2Rels = rels.filter(r => r.edgeDocumentIds.includes(doc2Id));

      if (doc1Rels.length === 0 || doc2Rels.length === 0) continue;

      // Check for conflicting targets (different related entities for same relationship type)
      const doc1Targets = new Set(doc1Rels.map(r => r.relatedNodeId));
      const doc2Targets = new Set(doc2Rels.map(r => r.relatedNodeId));

      for (const d1Rel of doc1Rels) {
        if (doc2Targets.has(d1Rel.relatedNodeId)) continue; // Same target - not a contradiction

        for (const d2Rel of doc2Rels) {
          if (doc1Targets.has(d2Rel.relatedNodeId)) continue; // Same target - not a contradiction

          contradictions.push({
            entity_name: d1Rel.canonicalName,
            entity_type: d1Rel.entityType,
            relationship_type: relType,
            doc1_related: d1Rel.relatedCanonicalName,
            doc2_related: d2Rel.relatedCanonicalName,
            kg_source: 'doc1',
            severity: 'high',
          });
        }
      }
    }

    // MEDIUM severity: entity in both docs but with different relationship types
    const doc1RelTypes = new Set<string>();
    const doc2RelTypes = new Set<string>();
    for (const rel of allRels) {
      if (rel.edgeDocumentIds.includes(doc1Id)) doc1RelTypes.add(rel.relationshipType);
      if (rel.edgeDocumentIds.includes(doc2Id)) doc2RelTypes.add(rel.relationshipType);
    }

    // Relationship types in doc1 but not doc2 (and vice versa)
    for (const relType of doc1RelTypes) {
      if (!doc2RelTypes.has(relType) && doc2RelTypes.size > 0) {
        const rel = allRels.find(r => r.relationshipType === relType && r.edgeDocumentIds.includes(doc1Id));
        if (!rel) continue;
        const otherRel = allRels.find(r => r.edgeDocumentIds.includes(doc2Id));
        if (!otherRel) continue;

        contradictions.push({
          entity_name: rel.canonicalName,
          entity_type: rel.entityType,
          relationship_type: relType,
          doc1_related: rel.relatedCanonicalName,
          doc2_related: `[${otherRel.relationshipType}] ${otherRel.relatedCanonicalName}`,
          kg_source: 'doc1',
          severity: 'medium',
        });
      }
    }
    for (const relType of doc2RelTypes) {
      if (!doc1RelTypes.has(relType) && doc1RelTypes.size > 0) {
        const rel = allRels.find(r => r.relationshipType === relType && r.edgeDocumentIds.includes(doc2Id));
        if (!rel) continue;
        const otherRel = allRels.find(r => r.edgeDocumentIds.includes(doc1Id));
        if (!otherRel) continue;

        contradictions.push({
          entity_name: rel.canonicalName,
          entity_type: rel.entityType,
          relationship_type: relType,
          doc1_related: `[${otherRel.relationshipType}] ${otherRel.relatedCanonicalName}`,
          doc2_related: rel.relatedCanonicalName,
          kg_source: 'doc2',
          severity: 'medium',
        });
      }
    }
  }

  // LOW severity: entity in one doc has KG relationships not present in the other
  const checkLowSeverity = (nodeIds: string[], source: 'doc1' | 'doc2') => {
    for (const nodeId of nodeIds) {
      const rels = getSemanticEdgesForNode(nodeId);
      if (rels.length === 0) continue;

      for (const rel of rels) {
        contradictions.push({
          entity_name: rel.canonicalName,
          entity_type: rel.entityType,
          relationship_type: rel.relationshipType,
          doc1_related: source === 'doc1' ? rel.relatedCanonicalName : '(not present)',
          doc2_related: source === 'doc2' ? rel.relatedCanonicalName : '(not present)',
          kg_source: source,
          severity: 'low',
        });
      }
    }
  };

  checkLowSeverity(doc1OnlyNodeIds, 'doc1');
  checkLowSeverity(doc2OnlyNodeIds, 'doc2');

  // Deduplicate contradictions (same entity + relationship_type + both targets)
  const seen = new Set<string>();
  const dedupedContradictions: Contradiction[] = [];
  for (const c of contradictions) {
    const key = `${c.entity_name}|${c.relationship_type}|${c.doc1_related}|${c.doc2_related}|${c.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedContradictions.push(c);
    }
  }

  // Sort: high first, then medium, then low
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  dedupedContradictions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    contradictions: dedupedContradictions,
    entities_checked: entitiesChecked,
    kg_edges_analyzed: kgEdgesAnalyzed,
  };
}


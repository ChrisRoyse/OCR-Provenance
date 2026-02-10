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
} from '../../models/comparison.js';
import type { Entity } from '../../models/entity.js';

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

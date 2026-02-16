/**
 * Entity Analysis MCP Tools
 *
 * Tools for named entity extraction, search, timeline building,
 * and expert witness analysis using Gemini AI.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/entity-analysis
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse, handleError, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { validateInput, escapeLikePattern } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { GeminiClient, getSharedClient } from '../services/gemini/client.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import { ENTITY_TYPES, type EntityType } from '../models/entity.js';
import {
  searchEntities,
  getEntityMentions,
  deleteEntitiesByDocument,
  getEntitiesByDocumentKeyed,
} from '../services/storage/database/entity-operations.js';
import { getChunksByDocumentId } from '../services/storage/database/chunk-operations.js';
import {
  getClusterSummariesForDocument,
  reassignDocumentToCluster,
  type ClusterReassignmentResult,
} from '../services/storage/database/cluster-operations.js';
import {
  getKnowledgeNodeSummariesByDocument,
  getEntityRolesForNode,
} from '../services/storage/database/knowledge-graph-operations.js';
import { extractEntitiesFromVLM } from '../services/knowledge-graph/vlm-entity-extractor.js';
import { mapExtractionEntitiesToDB } from '../services/knowledge-graph/extraction-entity-mapper.js';
import { incrementalBuildGraph } from '../services/knowledge-graph/incremental-builder.js';
import { findGraphPaths } from '../services/knowledge-graph/graph-service.js';
import {
  processSegmentsAndStoreEntities,
  computeExtractionQualityScore,
  TOTAL_ENTITY_TYPES,
  MAX_CHARS_PER_CALL,
  SEGMENT_OVERLAP_CHARS,
} from '../utils/entity-extraction-helpers.js';
import { detectEntityBoundaryIssues } from '../services/chunking/chunker.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Safely parse a JSON aliases string into a string array */
function parseAliases(aliasesJson: string | null | undefined): string[] {
  if (!aliasesJson) return [];
  try {
    const parsed = JSON.parse(aliasesJson);
    return Array.isArray(parsed)
      ? parsed.filter((a: unknown) => typeof a === 'string' && a.length > 0)
      : [];
  } catch (error) {
    console.error(
      '[entity-analysis] parseAliases JSON parse failed:',
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const EntityExtractInput = z.object({
  document_id: z.string().min(1).describe('Document ID (must be OCR processed)'),
  entity_types: z
    .array(
      z.enum([
        'person',
        'organization',
        'date',
        'amount',
        'case_number',
        'location',
        'statute',
        'exhibit',
        'medication',
        'diagnosis',
        'medical_device',
        'other',
      ])
    )
    .optional()
    .describe('Entity types to extract (default: all types)'),
  incremental: z
    .boolean()
    .default(false)
    .describe(
      'When true, diff new entities against existing instead of deleting all. Preserves KG node_entity_links for unchanged entities.'
    ),
  auto_reassign_clusters: z
    .boolean()
    .default(false)
    .describe('After extraction + KG merge, reassign document to clusters if clusters exist'),
});

const EntitySearchInput = z.object({
  query: z.string().min(1).max(500).describe('Search query for entity names'),
  entity_type: z
    .enum([
      'person',
      'organization',
      'date',
      'amount',
      'case_number',
      'location',
      'statute',
      'exhibit',
      'medication',
      'diagnosis',
      'medical_device',
      'other',
    ])
    .optional()
    .describe('Filter by entity type'),
  document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
  limit: z.number().int().min(1).max(200).default(50).describe('Maximum results'),
});

const TimelineBuildInput = z.object({
  document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
  date_format: z.string().optional().default('iso').describe('Date format for output: iso, us, eu'),
  entity_names: z
    .array(z.string())
    .optional()
    .describe(
      'Filter timeline to only show events involving these entities (searches entity mentions context)'
    ),
  entity_path_source: z
    .string()
    .optional()
    .describe('Show events along the KG path from this entity to entity_path_target'),
  entity_path_target: z
    .string()
    .optional()
    .describe('Show events along the KG path from entity_path_source to this entity'),
});

const WitnessAnalysisInput = z.object({
  document_ids: z.array(z.string().min(1)).min(1).describe('Document IDs to analyze'),
  focus_area: z.string().optional().describe('Specific area to focus analysis on'),
  include_images: z.boolean().default(false).describe('Include VLM image descriptions in analysis'),
});

const VLMEntityExtractInput = z.object({
  document_id: z.string().min(1).describe('Document ID with VLM-processed images'),
});

const ExtractionEntityExtractInput = z.object({
  document_id: z.string().min(1).describe('Document ID with structured extractions'),
});

const CoreferenceResolveInput = z.object({
  document_id: z.string().min(1).describe('Document ID to resolve coreferences in'),
  max_chunks: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum chunks to process for coreference resolution'),
  merge_into_kg: z
    .boolean()
    .default(false)
    .describe('Automatically merge resolved coreferences into knowledge graph'),
  resolution_scope: z
    .enum(['chunk', 'document'])
    .default('chunk')
    .describe(
      'Resolution scope: chunk processes independently, document passes full entity index as persistent context'
    ),
});

const EntityDossierInput = z.object({
  entity_name: z.string().min(1).describe('Entity name or KG node canonical name to look up'),
  node_id: z.string().optional().describe('Direct KG node ID if known'),
  include_mentions: z.boolean().default(true).describe('Include all mention positions'),
  include_relationships: z.boolean().default(true).describe('Include KG relationships'),
  include_documents: z.boolean().default(true).describe('Include document list'),
  include_timeline: z.boolean().default(false).describe('Include timeline of date co-occurrences'),
  include_clusters: z
    .boolean()
    .default(false)
    .describe('Include cluster memberships for entity documents and co-clustered entities'),
  max_mentions: z.number().min(1).max(500).default(50).describe('Max mentions to return'),
});

const EntityUpdateConfidenceInput = z.object({
  document_id: z.string().optional().describe('Update for specific document, or all if omitted'),
  dry_run: z.boolean().default(false).describe('Preview changes without applying'),
  factor_kg_importance: z
    .boolean()
    .default(false)
    .describe(
      'Factor KG node importance_score into confidence: adjusted = base * (1 + min(importance,10) * 0.02), capped at 1.0'
    ),
});

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH AUTO-MERGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a knowledge graph exists in the database and, if so, incrementally
 * merge newly extracted entities into it. Called after successful entity extraction.
 *
 * @param db - DatabaseService instance
 * @param documentId - Document ID whose entities were just extracted
 * @returns KG merge result if KG exists and merge succeeded, or null if no KG exists
 */
async function autoMergeIntoKnowledgeGraph(
  db: import('../services/storage/database/index.js').DatabaseService,
  documentId: string
): Promise<Record<string, unknown> | null> {
  const conn = db.getConnection();

  // Check if knowledge graph exists (has any nodes)
  const row = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number };
  if (row.cnt === 0) {
    return null;
  }

  console.error(
    `[INFO] Knowledge graph detected (${row.cnt} nodes), auto-merging entities for document ${documentId}`
  );

  try {
    const kgResult = await incrementalBuildGraph(db, {
      document_ids: [documentId],
      resolution_mode: 'fuzzy',
    });

    return {
      kg_auto_merged: true,
      kg_documents_processed: kgResult.documents_processed,
      kg_new_entities_found: kgResult.new_entities_found,
      kg_entities_matched_to_existing: kgResult.entities_matched_to_existing,
      kg_new_nodes_created: kgResult.new_nodes_created,
      kg_existing_nodes_updated: kgResult.existing_nodes_updated,
      kg_new_edges_created: kgResult.new_edges_created,
      kg_existing_edges_updated: kgResult.existing_edges_updated,
      kg_provenance_id: kgResult.provenance_id,
      kg_processing_duration_ms: kgResult.processing_duration_ms,
    };
  } catch (mergeError) {
    const msg = mergeError instanceof Error ? mergeError.message : String(mergeError);
    // Re-throw critical database errors — don't mask corruption or constraint violations
    if (
      msg.includes('FOREIGN KEY') ||
      msg.includes('constraint') ||
      msg.includes('database is locked') ||
      msg.includes('database disk image')
    ) {
      throw mergeError;
    }
    console.error(`[WARN] KG auto-merge skipped for document ${documentId}: ${msg}`);
    return { kg_auto_merged: false, kg_auto_merge_skipped_reason: msg };
  }
}

/**
 * Create an entity extraction provenance record for a given document.
 * Used by VLM and structured extraction handlers that share identical provenance logic.
 */
export function createEntityExtractionProvenance(
  db: import('../services/storage/database/index.js').DatabaseService,
  doc: { id: string; file_path: string; provenance_id: string; file_hash: string },
  processor: string,
  source: string
): string {
  const now = new Date().toISOString();
  const entityProvId = uuidv4();
  const entityHash = computeHash(JSON.stringify({ document_id: doc.id, source }));

  db.insertProvenance({
    id: entityProvId,
    type: ProvenanceType.ENTITY_EXTRACTION,
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'ENTITY_EXTRACTION',
    source_path: doc.file_path,
    source_id: doc.provenance_id,
    root_document_id: doc.provenance_id,
    location: null,
    content_hash: entityHash,
    input_hash: computeHash(doc.id),
    file_hash: doc.file_hash,
    processor,
    processor_version: '1.0.0',
    processing_params: { source },
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: doc.provenance_id,
    parent_ids: JSON.stringify([doc.provenance_id]),
    chain_depth: 2,
    chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION']),
  });

  return entityProvId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ocr_entity_extract - Extract named entities from a document using Gemini
 */
async function handleEntityExtract(params: Record<string, unknown>) {
  try {
    const input = validateInput(EntityExtractInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists and has OCR text
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }
    if (doc.status !== 'complete') {
      throw new Error(
        `Document not OCR processed yet (status: ${doc.status}). Run ocr_process_pending first.`
      );
    }

    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult) {
      throw new Error(`No OCR result found for document ${doc.id}`);
    }

    // Incremental mode: capture existing state before deletion for diff and KG link restoration
    let oldKGLinks:
      | Map<
          string,
          Array<{
            node_id: string;
            document_id: string;
            similarity_score: number;
            resolution_method: string | null;
            created_at: string;
          }>
        >
      | undefined;
    let oldEntityKeys: Set<string> | undefined;
    if (input.incremental) {
      const oldEntities = getEntitiesByDocumentKeyed(conn, doc.id);
      oldEntityKeys = new Set(oldEntities.keys());

      // Capture existing KG links keyed by entity key (type::normalized_text)
      oldKGLinks = new Map();
      for (const [key, entity] of oldEntities) {
        try {
          const links = conn
            .prepare(
              'SELECT node_id, document_id, similarity_score, resolution_method, created_at FROM node_entity_links WHERE entity_id = ?'
            )
            .all(entity.id) as Array<{
            node_id: string;
            document_id: string;
            similarity_score: number;
            resolution_method: string | null;
            created_at: string;
          }>;
          if (links.length > 0) {
            oldKGLinks.set(key, links);
          }
        } catch (err) {
          console.error(
            `[entity-analysis] node_entity_links query failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      console.error(
        `[INFO] Incremental mode: captured ${oldEntities.size} existing entities, ${oldKGLinks.size} with KG links`
      );
    }

    // Delete existing entities for this document before re-extracting
    const existingCount = deleteEntitiesByDocument(conn, doc.id);
    if (existingCount > 0) {
      console.error(
        `[INFO] Deleted ${existingCount} existing entities for document ${doc.id} before re-extraction`
      );
    }

    // Use default Gemini model (gemini-3-flash-preview) for entity extraction
    const client = new GeminiClient({
      retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000 },
    });
    const startTime = Date.now();
    const textLength = ocrResult.extracted_text.length;
    const ocrText = ocrResult.extracted_text;
    const now = new Date().toISOString();

    // Create ENTITY_EXTRACTION provenance record BEFORE segments
    // so segments can reference this provenance chain
    const entityProvId = uuidv4();

    db.insertProvenance({
      id: entityProvId,
      type: ProvenanceType.ENTITY_EXTRACTION,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'ENTITY_EXTRACTION',
      source_path: doc.file_path,
      source_id: ocrResult.provenance_id,
      root_document_id: doc.provenance_id,
      location: null,
      content_hash: computeHash(`entity-extraction-pending-${doc.id}-${now}`),
      input_hash: ocrResult.content_hash,
      file_hash: doc.file_hash,
      processor: 'gemini-entity-extraction',
      processor_version: '2.0.0',
      processing_params: {
        entity_types: input.entity_types ?? ENTITY_TYPES,
        text_length: textLength,
        segment_size: MAX_CHARS_PER_CALL,
        segment_overlap: SEGMENT_OVERLAP_CHARS,
      },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: ocrResult.provenance_id,
      parent_ids: JSON.stringify([doc.provenance_id, ocrResult.provenance_id]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION']),
    });

    // Build type filter prompt fragment
    const entityTypes = input.entity_types ?? ENTITY_TYPES;
    const typeFilter = input.entity_types
      ? `Only extract entities of these types: ${input.entity_types.join(', ')}.`
      : `Extract all entity types: ${ENTITY_TYPES.join(', ')}.`;

    const result = await processSegmentsAndStoreEntities(
      conn,
      client,
      doc.id,
      ocrResult.id,
      ocrText,
      entityProvId,
      typeFilter,
      entityTypes,
      startTime
    );

    // Restore KG links for entities that existed before re-extraction
    let incrementalStats: Record<string, unknown> | undefined;
    if (input.incremental && oldKGLinks && oldEntityKeys) {
      const newEntities = getEntitiesByDocumentKeyed(conn, doc.id);
      const newKeys = new Set(newEntities.keys());

      let kgLinksRestored = 0;
      let restoredEntityCount = 0;

      // For each new entity that also existed before, restore KG node links
      for (const [key, newEntity] of newEntities) {
        if (oldKGLinks.has(key)) {
          const links = oldKGLinks.get(key)!;
          for (const link of links) {
            try {
              conn
                .prepare(
                  'INSERT OR IGNORE INTO node_entity_links (id, node_id, entity_id, document_id, similarity_score, resolution_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                )
                .run(
                  uuidv4(),
                  link.node_id,
                  newEntity.id,
                  link.document_id,
                  link.similarity_score,
                  link.resolution_method,
                  link.created_at
                );
              kgLinksRestored++;
            } catch (err) {
              console.error(
                `[WARN] Failed to restore KG link for entity ${key}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          restoredEntityCount++;
        }
      }

      // Compute diff stats
      const addedKeys = [...newKeys].filter((k) => !oldEntityKeys!.has(k));
      const removedKeys = [...oldEntityKeys].filter((k) => !newKeys.has(k));
      const unchangedKeys = [...newKeys].filter((k) => oldEntityKeys!.has(k));

      incrementalStats = {
        incremental_mode: true,
        entities_added: addedKeys.length,
        entities_removed: removedKeys.length,
        entities_unchanged: unchangedKeys.length,
        kg_links_restored: kgLinksRestored,
        restored_entity_count: restoredEntityCount,
      };

      console.error(
        `[INFO] Incremental re-extraction: +${addedKeys.length} added, -${removedKeys.length} removed, =${unchangedKeys.length} unchanged, ${kgLinksRestored} KG links restored`
      );
    }

    // Auto-merge into knowledge graph if one exists
    const kgMergeResult = await autoMergeIntoKnowledgeGraph(db, doc.id);

    // Optionally reassign clusters after entity extraction + KG merge
    let clusterReassignment: ClusterReassignmentResult | undefined;
    if (input.auto_reassign_clusters) {
      try {
        clusterReassignment = reassignDocumentToCluster(conn, doc.id);
      } catch (clusterErr) {
        const msg = clusterErr instanceof Error ? clusterErr.message : String(clusterErr);
        console.error(`[entity-analysis] cluster reassignment failed for doc ${doc.id}: ${msg}`);
        clusterReassignment = { document_id: doc.id, reassigned: false, error: msg };
      }
    }

    // Compute related documents by shared entity overlap
    let relatedDocuments: Array<Record<string, unknown>> | undefined;
    try {
      const relDocRows = conn
        .prepare(
          `
        SELECT e2.document_id, d.file_name, COUNT(DISTINCT e2.normalized_text) as shared_entities
        FROM entities e1
        JOIN entities e2 ON e1.normalized_text = e2.normalized_text AND e1.entity_type = e2.entity_type
        JOIN documents d ON d.id = e2.document_id
        WHERE e1.document_id = ? AND e2.document_id != ?
        GROUP BY e2.document_id
        ORDER BY shared_entities DESC
        LIMIT 5
      `
        )
        .all(doc.id, doc.id) as Array<{
        document_id: string;
        file_name: string;
        shared_entities: number;
      }>;
      if (relDocRows.length > 0) {
        relatedDocuments = relDocRows.map((r) => ({
          document_id: r.document_id,
          file_name: r.file_name,
          shared_entities: r.shared_entities,
        }));
      }
    } catch (err) {
      console.error(
        `[entity-analysis] related documents query failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Compute extraction quality score
    let extractionQuality:
      | { score: number; metrics: Record<string, number>; recommendations: string[] }
      | undefined;
    try {
      // Count pages with entity mentions
      const dbChunks = getChunksByDocumentId(conn, doc.id);
      const pagesWithEntitiesRows = conn
        .prepare(
          `
        SELECT COUNT(DISTINCT em.page_number) as cnt
        FROM entity_mentions em
        WHERE em.document_id = ? AND em.page_number IS NOT NULL
      `
        )
        .get(doc.id) as { cnt: number };
      const pagesWithEntities = pagesWithEntitiesRows.cnt;
      const totalPages = ocrResult.page_count ?? 0;

      extractionQuality = computeExtractionQualityScore(
        result.totalEntities,
        textLength,
        Object.keys(result.entitiesByType).length,
        TOTAL_ENTITY_TYPES,
        result.noiseFiltered,
        result.totalRawExtracted,
        pagesWithEntities,
        totalPages
      );

      // Detect entity boundary issues
      if (dbChunks.length > 1) {
        const mentionRows = conn
          .prepare(
            `
          SELECT em.character_start as char_start, em.character_end as char_end, e.raw_text
          FROM entity_mentions em
          JOIN entities e ON em.entity_id = e.id
          WHERE em.document_id = ? AND em.character_start IS NOT NULL AND em.character_end IS NOT NULL
        `
          )
          .all(doc.id) as Array<{ char_start: number; char_end: number; raw_text: string }>;

        if (mentionRows.length > 0) {
          const chunkData = dbChunks.map((c) => ({
            text: c.text,
            character_start: c.character_start,
            character_end: c.character_end,
          }));
          const boundaryIssues = detectEntityBoundaryIssues(chunkData, mentionRows);
          if (boundaryIssues.split_entities > 0) {
            (extractionQuality as Record<string, unknown>).entity_boundary_issues = boundaryIssues;
          }
        }
      }
    } catch (err) {
      console.error(
        `[entity-analysis] extraction quality computation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return formatResponse(
      successResult({
        document_id: doc.id,
        total_entities: result.totalEntities,
        total_mentions: result.totalMentions,
        total_raw_extracted: result.totalRawExtracted,
        noise_filtered: result.noiseFiltered,
        deduplicated: result.deduplicated,
        entities_by_type: result.entitiesByType,
        chunk_mapped: result.chunkMapped,
        chunk_unmapped: result.totalEntities - result.chunkMapped,
        total_db_chunks: getChunksByDocumentId(conn, doc.id).length,
        provenance_id: entityProvId,
        processing_duration_ms: result.processingDurationMs,
        text_length: textLength,
        api_calls: result.apiCalls,
        segments_total: result.segmentsTotal,
        segments_complete: result.segmentsComplete,
        segments_failed: result.segmentsFailed,
        segment_size: MAX_CHARS_PER_CALL,
        segment_overlap: SEGMENT_OVERLAP_CHARS,
        ...incrementalStats,
        ...kgMergeResult,
        ...(clusterReassignment ? { cluster_reassignment: clusterReassignment } : {}),
        ...(relatedDocuments ? { related_documents: relatedDocuments } : {}),
        ...(extractionQuality ? { extraction_quality: extractionQuality } : {}),
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_entity_search - Search entities by name/type across documents
 */
async function handleEntitySearch(params: Record<string, unknown>) {
  try {
    const input = validateInput(EntitySearchInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const entities = searchEntities(conn, input.query, {
      entityType: input.entity_type as EntityType | undefined,
      documentFilter: input.document_filter,
      limit: input.limit,
    });

    // Prepare KG lookup statements (wrapped in try/catch for pre-v16 schema compat)
    let kgNodeStmt: ReturnType<typeof conn.prepare> | null = null;
    let kgEdgesStmt: ReturnType<typeof conn.prepare> | null = null;
    try {
      kgNodeStmt = conn.prepare(`
        SELECT kn.id as node_id, kn.canonical_name, kn.aliases, kn.document_count, kn.edge_count
        FROM node_entity_links nel
        JOIN knowledge_nodes kn ON nel.node_id = kn.id
        WHERE nel.entity_id = ?
      `);
      kgEdgesStmt = conn.prepare(`
        SELECT kn2.canonical_name, ke.relationship_type, ke.weight
        FROM knowledge_edges ke
        JOIN knowledge_nodes kn2 ON (
          CASE WHEN ke.source_node_id = @nid THEN ke.target_node_id ELSE ke.source_node_id END = kn2.id
        )
        WHERE ke.source_node_id = @nid OR ke.target_node_id = @nid
        ORDER BY ke.weight DESC
        LIMIT 5
      `);
    } catch (err) {
      console.error(
        `[entity-analysis] KG statement preparation failed: ${err instanceof Error ? err.message : String(err)}`
      );
      // Pre-v16 schema without knowledge graph tables - skip KG enrichment
    }

    // Enrich with mentions, document info, and KG context
    const results = entities.map((entity) => {
      const mentions = getEntityMentions(conn, entity.id);
      const document = db.getDocument(entity.document_id);

      const result: Record<string, unknown> = {
        entity_id: entity.id,
        entity_type: entity.entity_type,
        raw_text: entity.raw_text,
        normalized_text: entity.normalized_text,
        confidence: entity.confidence,
        document: document
          ? {
              id: document.id,
              file_name: document.file_name,
              file_path: document.file_path,
            }
          : null,
        mentions: mentions.map((m) => ({
          id: m.id,
          page_number: m.page_number,
          character_start: m.character_start,
          character_end: m.character_end,
          context_text: m.context_text,
        })),
        mention_count: mentions.length,
      };

      // Enrich with knowledge graph data if available
      if (kgNodeStmt) {
        try {
          const kgNode = kgNodeStmt.get(entity.id) as
            | {
                node_id: string;
                canonical_name: string;
                aliases: string | null;
                document_count: number;
                edge_count: number;
              }
            | undefined;

          if (kgNode) {
            const aliases = parseAliases(kgNode.aliases);

            result.kg_node_id = kgNode.node_id;
            result.kg_canonical_name = kgNode.canonical_name;
            result.kg_aliases = aliases;
            result.kg_document_count = kgNode.document_count;
            result.kg_edge_count = kgNode.edge_count;

            // Fetch top connected entities
            if (kgEdgesStmt) {
              try {
                const connectedRows = kgEdgesStmt.all({ nid: kgNode.node_id }) as Array<{
                  canonical_name: string;
                  relationship_type: string;
                  weight: number;
                }>;
                if (connectedRows.length > 0) {
                  result.kg_connected_entities = connectedRows.map((r) => ({
                    name: r.canonical_name,
                    relationship_type: r.relationship_type,
                    weight: r.weight,
                  }));
                }
              } catch (err) {
                console.error(
                  `[entity-analysis] KG edge query failed: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
          }
        } catch (err) {
          console.error(
            `[entity-analysis] KG lookup failed for entity: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return result;
    });

    return formatResponse(
      successResult({
        query: input.query,
        entity_type_filter: input.entity_type ?? null,
        total_results: results.length,
        results,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_timeline_build - Build a chronological timeline from date entities
 *
 * Supports filtering by:
 * - document_filter: only show events from specific documents
 * - entity_names: only show events co-located with specific entities (same chunk)
 * - entity_path_source + entity_path_target: only show events from documents along a KG path
 */
async function handleTimelineBuild(params: Record<string, unknown>) {
  try {
    const input = validateInput(TimelineBuildInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Validate path filter params: both must be provided or neither
    if (
      (input.entity_path_source && !input.entity_path_target) ||
      (!input.entity_path_source && input.entity_path_target)
    ) {
      throw new Error(
        'Both entity_path_source and entity_path_target must be provided for path-based filtering'
      );
    }

    // If path filtering is requested, find documents along the KG path
    let pathDocumentIds: Set<string> | null = null;
    let pathInfo: Record<string, unknown> | null = null;

    if (input.entity_path_source && input.entity_path_target) {
      const pathResult = findGraphPaths(db, input.entity_path_source, input.entity_path_target, {
        max_hops: 4,
      });

      if (pathResult.total_paths === 0) {
        return formatResponse(
          successResult({
            total_entries: 0,
            date_format: input.date_format,
            document_filter: input.document_filter ?? null,
            entity_names: input.entity_names ?? null,
            entity_path_source: input.entity_path_source,
            entity_path_target: input.entity_path_target,
            path_info: {
              source: pathResult.source,
              target: pathResult.target,
              total_paths: 0,
              message: 'No path found between entities; no timeline events to show',
            },
            timeline: [],
          })
        );
      }

      // Collect all node IDs along all paths
      const pathNodeIds = new Set<string>();
      for (const path of pathResult.paths) {
        for (const node of path.nodes) {
          pathNodeIds.add(node.id);
        }
      }

      // Get document_ids from node_entity_links for those nodes
      pathDocumentIds = new Set<string>();
      const nodeIdList = [...pathNodeIds];
      const placeholders = nodeIdList.map(() => '?').join(',');
      const docRows = conn
        .prepare(
          `SELECT DISTINCT document_id FROM node_entity_links WHERE node_id IN (${placeholders})`
        )
        .all(...nodeIdList) as Array<{ document_id: string }>;

      for (const row of docRows) {
        pathDocumentIds.add(row.document_id);
      }

      pathInfo = {
        source: pathResult.source,
        target: pathResult.target,
        total_paths: pathResult.total_paths,
        path_node_count: pathNodeIds.size,
        path_document_count: pathDocumentIds.size,
      };

      console.error(
        `[INFO] Timeline path filter: ${pathNodeIds.size} nodes -> ${pathDocumentIds.size} documents`
      );
    }

    // Build effective document filter (intersection of document_filter and pathDocumentIds)
    let effectiveDocFilter: string[] | undefined = input.document_filter;
    if (pathDocumentIds) {
      if (effectiveDocFilter) {
        // Intersect: only keep documents in both filters
        effectiveDocFilter = effectiveDocFilter.filter((id) => pathDocumentIds!.has(id));
      } else {
        effectiveDocFilter = [...pathDocumentIds];
      }
      // If intersection is empty, no results possible
      if (effectiveDocFilter.length === 0) {
        return formatResponse(
          successResult({
            total_entries: 0,
            date_format: input.date_format,
            document_filter: input.document_filter ?? null,
            entity_names: input.entity_names ?? null,
            entity_path_source: input.entity_path_source ?? null,
            entity_path_target: input.entity_path_target ?? null,
            path_info: pathInfo,
            timeline: [],
          })
        );
      }
    }

    // Query date entities, optionally filtered by documents
    const dateEntities = searchEntities(conn, '', {
      entityType: 'date',
      documentFilter: effectiveDocFilter,
      limit: 500,
    });

    // If entity_names filter is provided, build a set of chunk_ids that contain
    // mentions of the requested entities for co-location filtering
    let entityNameChunkIds: Set<string> | null = null;
    if (input.entity_names && input.entity_names.length > 0) {
      entityNameChunkIds = new Set<string>();
      // Query entity_mentions for entities whose normalized_text or raw_text matches
      // any of the entity_names (case-insensitive LIKE match)
      for (const name of input.entity_names) {
        const likePattern = `%${escapeLikePattern(name)}%`;
        const rows = conn
          .prepare(
            `
          SELECT DISTINCT em.chunk_id
          FROM entity_mentions em
          JOIN entities e ON em.entity_id = e.id
          WHERE em.chunk_id IS NOT NULL
            AND (e.normalized_text LIKE ? ESCAPE '\\' COLLATE NOCASE OR e.raw_text LIKE ? ESCAPE '\\' COLLATE NOCASE)
        `
          )
          .all(likePattern, likePattern) as Array<{ chunk_id: string }>;
        for (const row of rows) {
          entityNameChunkIds.add(row.chunk_id);
        }
      }
      console.error(
        `[INFO] Timeline entity_names filter: ${input.entity_names.length} names -> ${entityNameChunkIds.size} matching chunks`
      );
    }

    // Parse dates and build timeline entries
    // Prepare cluster lookup statement for timeline entries
    let clusterLookupStmt: ReturnType<typeof conn.prepare> | null = null;
    try {
      clusterLookupStmt = conn.prepare(`
        SELECT dc.cluster_id, c.label FROM document_clusters dc
        JOIN clusters c ON dc.cluster_id = c.id
        WHERE dc.document_id = ?
        LIMIT 1
      `);
    } catch (err) {
      console.error(
        `[entity-analysis] cluster lookup statement preparation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const timelineEntries: Array<{
      date_iso: string;
      date_display: string;
      raw_text: string;
      confidence: number;
      document_id: string;
      document_name: string | null;
      context: string | null;
      cluster_id?: string;
      cluster_label?: string;
      co_located_entities?: Array<{ name: string; relationship_type?: string; weight?: number }>;
    }> = [];

    for (const entity of dateEntities) {
      const mentions = getEntityMentions(conn, entity.id);

      // If entity_names filter is active, check co-location via chunk_id
      if (entityNameChunkIds) {
        // Check if any mention of this date entity shares a chunk with the target entities
        const hasCoLocated = mentions.some(
          (m) => m.chunk_id && entityNameChunkIds!.has(m.chunk_id)
        );
        if (!hasCoLocated) {
          // Also check context_text as fallback for entities without chunk mappings
          const contextMatch = mentions.some((m) => {
            if (!m.context_text) return false;
            const ctx = m.context_text.toLowerCase();
            return input.entity_names!.some((name) => ctx.includes(name.toLowerCase()));
          });
          if (!contextMatch) {
            continue; // Skip this date entity - not co-located with requested entities
          }
        }
      }

      const parsed = Date.parse(entity.normalized_text);
      let dateIso: string;
      let dateDisplay: string;

      if (!isNaN(parsed)) {
        const d = new Date(parsed);
        dateIso = d.toISOString().slice(0, 10);
        if (input.date_format === 'us') {
          dateDisplay = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
        } else if (input.date_format === 'eu') {
          dateDisplay = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        } else {
          dateDisplay = dateIso;
        }
      } else {
        // Unparseable date - use the normalized text as-is
        dateIso = entity.normalized_text;
        dateDisplay = entity.raw_text;
      }

      const document = db.getDocument(entity.document_id);
      const contextText = mentions.length > 0 ? mentions[0].context_text : null;

      // If entity_names filter active, find which co-located entities appear
      // and enrich with KG relationship types
      let coLocatedWithRelationships:
        | Array<{ name: string; relationship_type?: string; weight?: number }>
        | undefined;
      if (entityNameChunkIds && mentions.length > 0) {
        const coLocated = new Set<string>();
        for (const m of mentions) {
          if (!m.chunk_id) continue;
          // Find other entity mentions in the same chunk
          const coRows = conn
            .prepare(
              `
            SELECT DISTINCT e.normalized_text
            FROM entity_mentions em
            JOIN entities e ON em.entity_id = e.id
            WHERE em.chunk_id = ?
              AND e.entity_type != 'date'
          `
            )
            .all(m.chunk_id) as Array<{ normalized_text: string }>;
          for (const row of coRows) {
            // Only include entities that match the requested entity_names
            if (
              input.entity_names!.some((name) =>
                row.normalized_text.toLowerCase().includes(name.toLowerCase())
              )
            ) {
              coLocated.add(row.normalized_text);
            }
          }
        }

        if (coLocated.size > 0) {
          // Resolve date entity -> KG node
          let dateNodeId: string | null = null;
          try {
            const dateNodeRow = conn
              .prepare(
                `
              SELECT kn.id FROM knowledge_nodes kn
              JOIN node_entity_links nel ON nel.node_id = kn.id
              JOIN entities e ON nel.entity_id = e.id
              WHERE e.normalized_text = ? AND e.entity_type = 'date'
              LIMIT 1
            `
              )
              .get(entity.normalized_text) as { id: string } | undefined;
            dateNodeId = dateNodeRow?.id ?? null;
          } catch (err) {
            console.error(
              `[entity-analysis] timeline date KG node lookup failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }

          coLocatedWithRelationships = [];
          for (const entityName of coLocated) {
            const entry: { name: string; relationship_type?: string; weight?: number } = {
              name: entityName,
            };
            if (dateNodeId) {
              try {
                const entityNodeRow = conn
                  .prepare(
                    `
                  SELECT kn.id FROM knowledge_nodes kn
                  JOIN node_entity_links nel ON nel.node_id = kn.id
                  JOIN entities e ON nel.entity_id = e.id
                  WHERE e.normalized_text = ?
                  LIMIT 1
                `
                  )
                  .get(entityName) as { id: string } | undefined;
                if (entityNodeRow) {
                  const edge = conn
                    .prepare(
                      `
                    SELECT relationship_type, weight FROM knowledge_edges
                    WHERE (source_node_id = ? AND target_node_id = ?)
                       OR (source_node_id = ? AND target_node_id = ?)
                    LIMIT 1
                  `
                    )
                    .get(dateNodeId, entityNodeRow.id, entityNodeRow.id, dateNodeId) as
                    | { relationship_type: string; weight: number }
                    | undefined;
                  if (edge) {
                    entry.relationship_type = edge.relationship_type;
                    entry.weight = edge.weight;
                  }
                }
              } catch (err) {
                console.error(
                  `[entity-analysis] timeline KG edge lookup failed: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
            coLocatedWithRelationships.push(entry);
          }
        }
      }

      // Look up cluster membership for the source document
      let clusterInfo: { cluster_id?: string; cluster_label?: string } = {};
      if (clusterLookupStmt) {
        try {
          const clusterRow = clusterLookupStmt.get(entity.document_id) as
            | {
                cluster_id: string;
                label: string | null;
              }
            | undefined;
          if (clusterRow) {
            clusterInfo = {
              cluster_id: clusterRow.cluster_id,
              cluster_label: clusterRow.label ?? undefined,
            };
          }
        } catch (err) {
          console.error(
            `[entity-analysis] timeline cluster lookup failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      timelineEntries.push({
        date_iso: dateIso,
        date_display: dateDisplay,
        raw_text: entity.raw_text,
        confidence: entity.confidence,
        document_id: entity.document_id,
        document_name: document?.file_name ?? null,
        context: contextText,
        ...clusterInfo,
        ...(coLocatedWithRelationships ? { co_located_entities: coLocatedWithRelationships } : {}),
      });
    }

    // Sort chronologically
    timelineEntries.sort((a, b) => a.date_iso.localeCompare(b.date_iso));

    return formatResponse(
      successResult({
        total_entries: timelineEntries.length,
        date_format: input.date_format,
        document_filter: input.document_filter ?? null,
        entity_names: input.entity_names ?? null,
        entity_path_source: input.entity_path_source ?? null,
        entity_path_target: input.entity_path_target ?? null,
        ...(pathInfo ? { path_info: pathInfo } : {}),
        timeline: timelineEntries,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_legal_witness_analysis - Expert witness analysis using Gemini thinking mode
 */
async function handleWitnessAnalysis(params: Record<string, unknown>) {
  try {
    const input = validateInput(WitnessAnalysisInput, params);
    const { db } = requireDatabase();

    // Gather OCR text for all documents
    const docTexts: Array<{ id: string; name: string; text: string }> = [];
    const vlmDescriptions: string[] = [];

    for (const docId of input.document_ids) {
      const doc = db.getDocument(docId);
      if (!doc) {
        throw new Error(`Document not found: ${docId}`);
      }
      if (doc.status !== 'complete') {
        throw new Error(`Document "${doc.file_name}" not OCR processed (status: ${doc.status}).`);
      }

      const ocrResult = db.getOCRResultByDocumentId(docId);
      if (!ocrResult) {
        throw new Error(`No OCR result for document ${docId}`);
      }

      docTexts.push({
        id: docId,
        name: doc.file_name,
        text: ocrResult.extracted_text,
      });

      // Optionally include VLM descriptions
      if (input.include_images) {
        const embeddings = db.getEmbeddingsByDocumentId(docId);
        for (const emb of embeddings) {
          if (emb.image_id) {
            vlmDescriptions.push(
              `[Image from ${doc.file_name}, page ${emb.page_number ?? '?'}]: ${emb.original_text}`
            );
          }
        }
      }
    }

    // Build the analysis prompt
    const docSections = docTexts
      .map((d) => `=== Document: ${d.name} (ID: ${d.id}) ===\n${d.text.slice(0, 8000)}`)
      .join('\n\n');

    const vlmSection =
      vlmDescriptions.length > 0
        ? `\n\n=== Image Descriptions ===\n${vlmDescriptions.join('\n')}`
        : '';

    // Include existing comparison data between these documents
    let comparisonSection = '';
    if (input.document_ids.length >= 2) {
      const docIds = input.document_ids;
      const comparisons = db
        .getConnection()
        .prepare(
          `SELECT c.document_id_1, c.document_id_2, c.similarity_ratio, c.summary
         FROM comparisons c
         WHERE c.document_id_1 IN (${docIds.map(() => '?').join(',')})
           AND c.document_id_2 IN (${docIds.map(() => '?').join(',')})
         ORDER BY c.created_at DESC`
        )
        .all(...docIds, ...docIds) as Array<{
        document_id_1: string;
        document_id_2: string;
        similarity_ratio: number;
        summary: string;
      }>;
      if (comparisons.length > 0) {
        const compLines = comparisons.map(
          (c) =>
            `- ${c.document_id_1} vs ${c.document_id_2}: ${(c.similarity_ratio * 100).toFixed(1)}% similar. ${c.summary}`
        );
        comparisonSection = `\n\n=== Prior Document Comparisons ===\n${compLines.join('\n')}`;
      }
    }

    // Include cluster context for each document
    let clusterSection = '';
    const clusterLines: string[] = [];
    for (const docId of input.document_ids) {
      const memberships = getClusterSummariesForDocument(db.getConnection(), docId);
      if (memberships.length > 0) {
        for (const m of memberships) {
          const label = m.label ?? `Cluster ${m.cluster_index}`;
          const tag = m.classification_tag ? ` [${m.classification_tag}]` : '';
          clusterLines.push(
            `- ${docId}: ${label}${tag} (coherence: ${m.coherence_score ?? 'N/A'})`
          );
        }
      }
    }
    if (clusterLines.length > 0) {
      clusterSection = `\n\n=== Document Cluster Memberships ===\n${clusterLines.join('\n')}`;
    }

    // Cross-document entity connections from knowledge graph
    let knowledgeGraphSection = '';
    const kgLines: string[] = [];
    for (const docId of input.document_ids) {
      const kgNodes = getKnowledgeNodeSummariesByDocument(db.getConnection(), docId);
      const crossDocNodes = kgNodes.filter((n) => n.document_count > 1);
      if (crossDocNodes.length > 0) {
        for (const node of crossDocNodes) {
          kgLines.push(
            `  - "${node.canonical_name}" (${node.entity_type}) appears in ${node.document_count} documents, ${node.edge_count} relationships`
          );
        }
      }
    }
    if (kgLines.length > 0) {
      knowledgeGraphSection = `\n\n=== Cross-Document Entity Connections (Knowledge Graph) ===\n${kgLines.join('\n')}`;
    }

    const focusInstruction = input.focus_area
      ? `Focus your analysis specifically on: ${input.focus_area}.`
      : '';

    const prompt =
      `You are an expert witness analyst reviewing legal documents. ` +
      `Provide a structured expert witness analysis of the following documents. ` +
      `${focusInstruction}\n\n` +
      `Your analysis MUST include:\n` +
      `1. KEY FINDINGS: Important facts, claims, and evidence found\n` +
      `2. TIMELINE: Chronological sequence of events mentioned\n` +
      `3. PARTIES: All persons, organizations, and their roles\n` +
      `4. CONCLUSIONS: Expert conclusions based on the evidence\n` +
      `5. RELIABILITY ASSESSMENT: Assessment of document reliability and potential issues\n` +
      `6. CONTRADICTIONS: Any contradictions or inconsistencies between documents\n\n` +
      `Documents:\n${docSections}${vlmSection}${comparisonSection}${clusterSection}${knowledgeGraphSection}`;

    // Use Gemini thinking mode for structured analysis
    const client = getSharedClient();
    const startTime = Date.now();
    const response = await client.thinking(prompt, 'HIGH');
    const processingDurationMs = Date.now() - startTime;

    return formatResponse(
      successResult({
        document_ids: input.document_ids,
        document_count: docTexts.length,
        focus_area: input.focus_area ?? null,
        include_images: input.include_images,
        vlm_descriptions_included: vlmDescriptions.length,
        comparisons_included: comparisonSection.length > 0,
        analysis: response.text,
        usage: {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          thinking_tokens: response.usage.thinkingTokens,
          total_tokens: response.usage.totalTokens,
        },
        processing_duration_ms: processingDurationMs,
        model: response.model,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_entity_extract_from_vlm - Extract entities from VLM image descriptions
 */
async function handleEntityExtractFromVLM(params: Record<string, unknown>) {
  try {
    const input = validateInput(VLMEntityExtractInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    const entityProvId = createEntityExtractionProvenance(db, doc, 'vlm-entity-extraction', 'vlm');

    const startTime = Date.now();
    const result = await extractEntitiesFromVLM(conn, input.document_id, entityProvId);
    const processingDurationMs = Date.now() - startTime;

    // Auto-merge into knowledge graph if one exists
    const kgMergeResult = await autoMergeIntoKnowledgeGraph(db, input.document_id);

    return formatResponse(
      successResult({
        document_id: input.document_id,
        entities_created: result.entities_created,
        descriptions_processed: result.descriptions_processed,
        source: 'vlm',
        provenance_id: entityProvId,
        processing_duration_ms: processingDurationMs,
        ...kgMergeResult,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_entity_extract_from_extractions - Create entities from structured extraction fields
 */
async function handleEntityExtractFromExtractions(params: Record<string, unknown>) {
  try {
    const input = validateInput(ExtractionEntityExtractInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Verify document exists
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    const entityProvId = createEntityExtractionProvenance(
      db,
      doc,
      'extraction-entity-mapper',
      'extraction'
    );

    const startTime = Date.now();
    const result = mapExtractionEntitiesToDB(conn, input.document_id, entityProvId);
    const processingDurationMs = Date.now() - startTime;

    // Auto-merge into knowledge graph if one exists
    const kgMergeResult = await autoMergeIntoKnowledgeGraph(db, input.document_id);

    return formatResponse(
      successResult({
        document_id: input.document_id,
        entities_created: result.entities_created,
        extractions_processed: result.extractions_processed,
        source: 'extraction',
        provenance_id: entityProvId,
        processing_duration_ms: processingDurationMs,
        ...kgMergeResult,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_entity_extraction_stats - Entity extraction quality analytics
 */
async function handleEntityExtractionStats(params: Record<string, unknown>) {
  try {
    const input = validateInput(
      z.object({
        document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
        include_cross_doc_consistency: z
          .boolean()
          .default(false)
          .describe(
            'Include cross-document entity consistency analysis: flag KG nodes with >2 raw text variants across documents'
          ),
      }),
      params
    );
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const filterClause = input.document_filter?.length
      ? `WHERE document_id IN (${input.document_filter.map(() => '?').join(',')})`
      : '';
    const filterParams = input.document_filter || [];

    // Total entities and mentions
    const entityCount = (
      conn.prepare(`SELECT COUNT(*) as cnt FROM entities ${filterClause}`).get(...filterParams) as {
        cnt: number;
      }
    ).cnt;

    const mentionCount = (
      conn
        .prepare(
          `SELECT COUNT(*) as cnt FROM entity_mentions em ${filterClause.replace('document_id', 'em.document_id')}`
        )
        .get(...filterParams) as { cnt: number }
    ).cnt;

    // Entity type distribution
    const typeDistribution = conn
      .prepare(
        `SELECT entity_type, COUNT(*) as count FROM entities ${filterClause} GROUP BY entity_type ORDER BY count DESC`
      )
      .all(...filterParams) as Array<{ entity_type: string; count: number }>;

    // Confidence statistics
    const confidenceStats = conn
      .prepare(
        `SELECT
        MIN(confidence) as min_confidence,
        MAX(confidence) as max_confidence,
        AVG(confidence) as avg_confidence,
        COUNT(CASE WHEN confidence < 0.5 THEN 1 END) as low_confidence_count,
        COUNT(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 END) as medium_confidence_count,
        COUNT(CASE WHEN confidence >= 0.8 THEN 1 END) as high_confidence_count
      FROM entities ${filterClause}`
      )
      .get(...filterParams) as {
      min_confidence: number | null;
      max_confidence: number | null;
      avg_confidence: number | null;
      low_confidence_count: number;
      medium_confidence_count: number;
      high_confidence_count: number;
    };

    // Segment statistics (from entity_extraction_segments table)
    let segmentStats: Record<string, unknown> = {};
    try {
      const segTotal = (
        conn
          .prepare(`SELECT COUNT(*) as cnt FROM entity_extraction_segments ${filterClause}`)
          .get(...filterParams) as { cnt: number }
      ).cnt;

      const segByStatus = conn
        .prepare(
          `SELECT extraction_status, COUNT(*) as count FROM entity_extraction_segments ${filterClause} GROUP BY extraction_status`
        )
        .all(...filterParams) as Array<{ extraction_status: string; count: number }>;

      const segAvgEntities = conn
        .prepare(
          `SELECT AVG(entity_count) as avg_entities FROM entity_extraction_segments ${filterClause ? filterClause + ` AND extraction_status = 'complete'` : `WHERE extraction_status = 'complete'`}`
        )
        .get(...filterParams) as { avg_entities: number | null };

      segmentStats = {
        total_segments: segTotal,
        by_status: Object.fromEntries(segByStatus.map((s) => [s.extraction_status, s.count])),
        avg_entities_per_segment:
          segAvgEntities.avg_entities !== null
            ? Math.round(segAvgEntities.avg_entities * 100) / 100
            : 0,
      };
    } catch (err) {
      console.error(
        `[entity-analysis] segment stats query failed: ${err instanceof Error ? err.message : String(err)}`
      );
      segmentStats = { total_segments: 0, note: 'segments table not available' };
    }

    // Documents with entities vs without
    let docCoverage: Record<string, unknown> = {};
    try {
      const docsFilterClause = input.document_filter?.length
        ? `WHERE id IN (${input.document_filter.map(() => '?').join(',')})`
        : '';
      const filteredDocs = (
        conn
          .prepare(`SELECT COUNT(*) as cnt FROM documents ${docsFilterClause}`)
          .get(...filterParams) as { cnt: number }
      ).cnt;

      const docsWithEntities = (
        conn
          .prepare(
            `SELECT COUNT(DISTINCT document_id) as cnt FROM entity_mentions em ${filterClause.replace('document_id', 'em.document_id')}`
          )
          .get(...filterParams) as { cnt: number }
      ).cnt;

      docCoverage = {
        total_documents: filteredDocs,
        documents_with_entities: docsWithEntities,
        documents_without_entities: filteredDocs - docsWithEntities,
        coverage_percent:
          filteredDocs > 0 ? Math.round((docsWithEntities / filteredDocs) * 10000) / 100 : 0,
      };
    } catch (err) {
      console.error(
        `[entity-analysis] document coverage query failed: ${err instanceof Error ? err.message : String(err)}`
      );
      docCoverage = {};
    }

    // KG integration stats
    let kgStats: Record<string, unknown> = {};
    try {
      const linkedEntities = (
        conn.prepare(`SELECT COUNT(DISTINCT entity_id) as cnt FROM node_entity_links`).get() as {
          cnt: number;
        }
      ).cnt;

      kgStats = {
        entities_linked_to_kg: linkedEntities,
        kg_coverage_percent:
          entityCount > 0 ? Math.round((linkedEntities / entityCount) * 10000) / 100 : 0,
      };
    } catch (err) {
      console.error(
        `[entity-analysis] KG integration stats query failed: ${err instanceof Error ? err.message : String(err)}`
      );
      kgStats = { entities_linked_to_kg: 0, note: 'KG tables not available' };
    }

    // Agreement stats (entities with cross-segment agreement)
    let agreementStats: Record<string, unknown> = {};
    try {
      const withAgreement = (
        conn
          .prepare(
            `SELECT COUNT(*) as cnt FROM entities WHERE metadata IS NOT NULL AND metadata LIKE '%agreement_count%' ${filterClause ? 'AND ' + filterClause.replace('WHERE ', '') : ''}`
          )
          .get(...filterParams) as { cnt: number }
      ).cnt;

      agreementStats = {
        entities_with_cross_segment_agreement: withAgreement,
        agreement_percent:
          entityCount > 0 ? Math.round((withAgreement / entityCount) * 10000) / 100 : 0,
      };
    } catch (err) {
      console.error(
        `[entity-analysis] agreement stats query failed: ${err instanceof Error ? err.message : String(err)}`
      );
      agreementStats = {};
    }

    // Cross-document entity consistency validation
    let crossDocConsistency: Record<string, unknown> | undefined;
    if (input.include_cross_doc_consistency) {
      try {
        const consistencyRows = conn
          .prepare(
            `
          SELECT kn.canonical_name, kn.entity_type,
                 GROUP_CONCAT(DISTINCT e.raw_text) as raw_variants,
                 COUNT(DISTINCT e.document_id) as doc_count
          FROM knowledge_nodes kn
          JOIN node_entity_links nel ON nel.node_id = kn.id
          JOIN entities e ON nel.entity_id = e.id
          GROUP BY kn.id
          HAVING doc_count >= 2
          ORDER BY doc_count DESC
          LIMIT 50
        `
          )
          .all() as Array<{
          canonical_name: string;
          entity_type: string;
          raw_variants: string;
          doc_count: number;
        }>;

        const inconsistentNodes: Array<Record<string, unknown>> = [];
        let totalMultiDocNodes = 0;

        for (const row of consistencyRows) {
          totalMultiDocNodes++;
          const variants = row.raw_variants.split(',').map((v) => v.trim());
          const uniqueVariants = [...new Set(variants)];
          if (uniqueVariants.length > 2) {
            inconsistentNodes.push({
              canonical_name: row.canonical_name,
              entity_type: row.entity_type,
              document_count: row.doc_count,
              variant_count: uniqueVariants.length,
              raw_variants: uniqueVariants.slice(0, 10), // Limit to 10 variants
            });
          }
        }

        crossDocConsistency = {
          total_multi_doc_nodes: totalMultiDocNodes,
          inconsistent_nodes: inconsistentNodes.length,
          inconsistent_node_details: inconsistentNodes.slice(0, 20),
          consistency_percent:
            totalMultiDocNodes > 0
              ? Math.round(
                  ((totalMultiDocNodes - inconsistentNodes.length) / totalMultiDocNodes) * 10000
                ) / 100
              : 100,
        };
      } catch (err) {
        console.error(
          `[entity-analysis] cross-doc consistency query failed: ${err instanceof Error ? err.message : String(err)}`
        );
        crossDocConsistency = { note: 'KG tables not available for consistency check' };
      }
    }

    return formatResponse(
      successResult({
        total_entities: entityCount,
        total_mentions: mentionCount,
        mentions_per_entity:
          entityCount > 0 ? Math.round((mentionCount / entityCount) * 100) / 100 : 0,
        entity_type_distribution: typeDistribution,
        confidence: {
          min:
            confidenceStats.min_confidence !== null
              ? Math.round(confidenceStats.min_confidence * 1000) / 1000
              : null,
          max:
            confidenceStats.max_confidence !== null
              ? Math.round(confidenceStats.max_confidence * 1000) / 1000
              : null,
          avg:
            confidenceStats.avg_confidence !== null
              ? Math.round(confidenceStats.avg_confidence * 1000) / 1000
              : null,
          low_count: confidenceStats.low_confidence_count,
          medium_count: confidenceStats.medium_confidence_count,
          high_count: confidenceStats.high_confidence_count,
        },
        segments: segmentStats,
        document_coverage: docCoverage,
        knowledge_graph: kgStats,
        cross_segment_agreement: agreementStats,
        ...(crossDocConsistency ? { cross_document_consistency: crossDocConsistency } : {}),
        document_filter: input.document_filter || null,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_coreference_resolve - Resolve coreferences (pronouns, abbreviations, descriptions) to entities
 */
export async function handleCoreferenceResolve(params: Record<string, unknown>) {
  try {
    const input = validateInput(CoreferenceResolveInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }

    // Get entities for this document
    const entities = conn
      .prepare(
        `
      SELECT id, raw_text, normalized_text, entity_type, confidence
      FROM entities WHERE document_id = ?
      ORDER BY confidence DESC
    `
      )
      .all(input.document_id) as Array<{
      id: string;
      raw_text: string;
      normalized_text: string;
      entity_type: string;
      confidence: number;
    }>;

    if (entities.length === 0) {
      return formatResponse(
        successResult({
          document_id: input.document_id,
          message: 'No entities found. Run ocr_entity_extract first.',
          resolutions: [],
        })
      );
    }

    // Get chunks
    const chunks = conn
      .prepare(
        `
      SELECT id, text, page_number, chunk_index
      FROM chunks WHERE document_id = ?
      ORDER BY chunk_index ASC
      LIMIT ?
    `
      )
      .all(input.document_id, input.max_chunks) as Array<{
      id: string;
      text: string;
      page_number: number | null;
      chunk_index: number;
    }>;

    if (chunks.length === 0) {
      return formatResponse(
        successResult({
          document_id: input.document_id,
          message: 'No chunks found.',
          resolutions: [],
        })
      );
    }

    // Build entity list for Gemini prompt (top 50 by confidence)
    const entityList = entities
      .slice(0, 50)
      .map((e) => `- "${e.raw_text}" (${e.entity_type})`)
      .join('\n');

    // For document-level scope, build a comprehensive entity index with aliases
    let documentEntityIndex = '';
    if (input.resolution_scope === 'document') {
      const entityEntries: string[] = [];
      const seenNormalized = new Set<string>();
      for (const e of entities) {
        const key = `${e.entity_type}::${e.normalized_text}`;
        if (seenNormalized.has(key)) continue;
        seenNormalized.add(key);

        // Look up KG aliases if available
        let aliases: string[] = [];
        try {
          const aliasRow = conn
            .prepare(
              `
            SELECT kn.aliases FROM knowledge_nodes kn
            JOIN node_entity_links nel ON nel.node_id = kn.id
            WHERE nel.entity_id = ?
            LIMIT 1
          `
            )
            .get(e.id) as { aliases: string | null } | undefined;
          aliases = parseAliases(aliasRow?.aliases);
        } catch (err) {
          console.error(
            `[entity-analysis] coreference KG alias lookup failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const aliasStr = aliases.length > 0 ? ` [aliases: ${aliases.join(', ')}]` : '';
        entityEntries.push(
          `- "${e.raw_text}" (${e.entity_type}, confidence: ${e.confidence.toFixed(2)})${aliasStr}`
        );
      }
      documentEntityIndex = entityEntries.join('\n');
    }

    const gemini = getSharedClient();
    const resolutions: Array<{
      pronoun_or_description: string;
      resolved_to: string;
      entity_type: string;
      chunk_id: string;
      confidence: number;
    }> = [];

    const startTime = Date.now();

    // Track accumulated resolutions for document-level context propagation
    const accumulatedResolutions: string[] = [];

    // Process chunks sequentially with cooldown
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      let prompt: string;
      if (input.resolution_scope === 'document') {
        // Document-level: include full entity index and accumulated resolutions
        const priorContext =
          accumulatedResolutions.length > 0
            ? `\n\n## Previously Resolved References (from earlier chunks):\n${accumulatedResolutions.join('\n')}\nUse these as additional context for resolving references in the current text.`
            : '';

        prompt = `You are resolving coreferences in a document. The following entities have been identified across the entire document. Resolve any pronouns, abbreviations, or descriptions in the text below to these known entities.

## Full Document Entity Index:
${documentEntityIndex}
${priorContext}

## Current Text (chunk ${i + 1} of ${chunks.length}):
${chunk.text.slice(0, 3000)}

## Instructions:
Return a JSON array where each element has:
- "reference": the pronoun/description/abbreviation found in the text (e.g., "he", "the patient", "Dr. S")
- "resolved_to": the full entity name from the entity index
- "entity_type": the entity type
- "confidence": confidence score 0-1

Only include clear, unambiguous resolutions. Return [] if no resolutions found.
Return ONLY the JSON array, no other text.`;
      } else {
        // Chunk-level (original behavior): independent processing per chunk
        prompt = `Analyze this text and identify any pronouns, abbreviations, or descriptions that refer to the known entities listed below. Return ONLY a JSON array of resolutions.

## Known Entities:
${entityList}

## Text:
${chunk.text.slice(0, 3000)}

## Instructions:
Return a JSON array where each element has:
- "reference": the pronoun/description/abbreviation found in the text (e.g., "he", "the patient", "Dr. S")
- "resolved_to": the full entity name from the known entities list
- "entity_type": the entity type
- "confidence": confidence score 0-1

Only include clear, unambiguous resolutions. Return [] if no resolutions found.
Return ONLY the JSON array, no other text.`;
      }

      try {
        const result = await gemini.fast(prompt);
        const text = result.text || '[]';
        // Extract JSON array from response
        const jsonMatch = text.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Array<{
            reference: string;
            resolved_to: string;
            entity_type: string;
            confidence: number;
          }>;
          for (const r of parsed) {
            if (r.reference && r.resolved_to && r.confidence > 0.5) {
              resolutions.push({
                pronoun_or_description: r.reference,
                resolved_to: r.resolved_to,
                entity_type: r.entity_type || 'other',
                chunk_id: chunk.id,
                confidence: r.confidence,
              });

              // Accumulate for document-level context propagation
              if (input.resolution_scope === 'document') {
                accumulatedResolutions.push(
                  `- "${r.reference}" -> "${r.resolved_to}" (${r.entity_type})`
                );
              }
            }
          }
        }
      } catch (geminiError) {
        console.error(
          `[WARN] Coreference resolution failed for chunk ${chunk.id}: ${geminiError instanceof Error ? geminiError.message : String(geminiError)}`
        );
      }

      // Rate limiting handled by GeminiRateLimiter (FIX-P0-1)
    }

    // Optionally merge into KG by creating additional entity mentions
    let kgMergeResult: { mentions_created: number } | undefined;
    if (input.merge_into_kg && resolutions.length > 0) {
      let mentionsCreated = 0;
      const chunkPageStmt = conn.prepare(`SELECT page_number FROM chunks WHERE id = ?`);
      for (const res of resolutions) {
        // Find the entity this resolves to
        const entity = entities.find(
          (e) => e.normalized_text === res.resolved_to || e.raw_text === res.resolved_to
        );
        if (entity) {
          try {
            const mentionId = uuidv4();
            const chunkRow = chunkPageStmt.get(res.chunk_id) as
              | { page_number: number | null }
              | undefined;
            const pageNumber = chunkRow?.page_number ?? null;
            conn
              .prepare(
                `
              INSERT INTO entity_mentions (id, entity_id, document_id, chunk_id, page_number, character_start, character_end, context_text)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
            `
              )
              .run(
                mentionId,
                entity.id,
                input.document_id,
                res.chunk_id,
                pageNumber,
                `[coref: "${res.pronoun_or_description}" -> "${res.resolved_to}"]`
              );
            mentionsCreated++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[coreference] Failed to insert entity mention: ${msg}`);
          }
        }
      }
      kgMergeResult = { mentions_created: mentionsCreated };
    }

    return formatResponse(
      successResult({
        document_id: input.document_id,
        resolution_scope: input.resolution_scope,
        chunks_analyzed: chunks.length,
        entities_available: entities.length,
        total_resolutions: resolutions.length,
        resolutions,
        kg_merge: kgMergeResult ?? null,
        processing_duration_ms: Date.now() - startTime,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_entity_dossier - Comprehensive single-entity profile
 *
 * Gathers profile, mentions, relationships, documents, timeline, and related entities
 * for a single entity or KG node.
 */
async function handleEntityDossier(params: Record<string, unknown>) {
  try {
    const input = validateInput(EntityDossierInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Step 1: Resolve the entity to a KG node
    type KGNodeRow = {
      id: string;
      entity_type: string;
      canonical_name: string;
      aliases: string | null;
      document_count: number;
      mention_count: number;
      avg_confidence: number;
      importance_score: number | null;
    };

    let nodeId: string | null = input.node_id ?? null;
    let nodeRow: KGNodeRow | null = null;
    const maxMentions = input.max_mentions ?? 50;

    if (nodeId) {
      // Direct node_id lookup
      nodeRow =
        (conn
          .prepare(
            `
        SELECT id, entity_type, canonical_name, aliases, document_count, mention_count,
               avg_confidence, importance_score
        FROM knowledge_nodes WHERE id = ?
      `
          )
          .get(nodeId) as KGNodeRow | undefined) ?? null;
      if (!nodeRow) {
        throw new Error(`KG node not found: ${nodeId}`);
      }
    } else {
      // Search by entity_name: case-insensitive canonical_name first
      nodeRow =
        (conn
          .prepare(
            `
        SELECT id, entity_type, canonical_name, aliases, document_count, mention_count,
               avg_confidence, importance_score
        FROM knowledge_nodes WHERE LOWER(canonical_name) = LOWER(?)
      `
          )
          .get(input.entity_name) as KGNodeRow | undefined) ?? null;

      // FTS5 fallback
      if (!nodeRow) {
        try {
          const sanitized = input.entity_name.replace(/["*()\\+:^-]/g, ' ').trim();
          if (sanitized.length > 0) {
            nodeRow =
              (conn
                .prepare(
                  `
              SELECT kn.id, kn.entity_type, kn.canonical_name, kn.aliases,
                     kn.document_count, kn.mention_count, kn.avg_confidence, kn.importance_score
              FROM knowledge_nodes_fts fts
              JOIN knowledge_nodes kn ON kn.rowid = fts.rowid
              WHERE knowledge_nodes_fts MATCH ?
              ORDER BY rank
              LIMIT 1
            `
                )
                .get(sanitized) as KGNodeRow | undefined) ?? null;
          }
        } catch (err) {
          console.error(
            `[entity-analysis] dossier FTS5 lookup failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Alias LIKE fallback
      if (!nodeRow) {
        nodeRow =
          (conn
            .prepare(
              `
          SELECT id, entity_type, canonical_name, aliases, document_count, mention_count,
                 avg_confidence, importance_score
          FROM knowledge_nodes WHERE LOWER(aliases) LIKE ? ESCAPE '\\'
          LIMIT 1
        `
            )
            .get(`%${escapeLikePattern(input.entity_name.toLowerCase())}%`) as
            | KGNodeRow
            | undefined) ?? null;
      }

      if (nodeRow) {
        nodeId = nodeRow.id;
      }
    }

    // If no KG node found, fall back to entities table directly
    let entityFallback = false;
    let fallbackEntities: Array<{
      id: string;
      entity_type: string;
      raw_text: string;
      normalized_text: string;
      confidence: number;
      document_id: string;
    }> = [];

    if (!nodeRow) {
      entityFallback = true;
      const escapedEntityName = escapeLikePattern(input.entity_name.toLowerCase());
      fallbackEntities = conn
        .prepare(
          `
        SELECT id, entity_type, raw_text, normalized_text, confidence, document_id
        FROM entities
        WHERE LOWER(normalized_text) LIKE ? ESCAPE '\\' OR LOWER(raw_text) LIKE ? ESCAPE '\\'
        ORDER BY confidence DESC
        LIMIT 20
      `
        )
        .all(`%${escapedEntityName}%`, `%${escapedEntityName}%`) as typeof fallbackEntities;

      if (fallbackEntities.length === 0) {
        throw new Error(
          `Entity not found: "${input.entity_name}". No matching KG node or entity record found.`
        );
      }
    }

    // Build the dossier response
    const dossier: Record<string, unknown> = {};

    // -- Profile --
    if (nodeRow) {
      const aliases = parseAliases(nodeRow.aliases);

      dossier.profile = {
        node_id: nodeRow.id,
        canonical_name: nodeRow.canonical_name,
        entity_type: nodeRow.entity_type,
        aliases,
        document_count: nodeRow.document_count,
        mention_count: nodeRow.mention_count,
        avg_confidence: Math.round(nodeRow.avg_confidence * 1000) / 1000,
        importance_score:
          nodeRow.importance_score !== null
            ? Math.round(nodeRow.importance_score * 1000) / 1000
            : null,
        source: 'knowledge_graph',
      };
    } else {
      // Fallback profile from entities table
      const types = [...new Set(fallbackEntities.map((e) => e.entity_type))];
      const avgConf =
        fallbackEntities.reduce((s, e) => s + e.confidence, 0) / fallbackEntities.length;
      const docIds = [...new Set(fallbackEntities.map((e) => e.document_id))];
      dossier.profile = {
        entity_name: input.entity_name,
        entity_types: types,
        entity_count: fallbackEntities.length,
        document_count: docIds.length,
        avg_confidence: Math.round(avgConf * 1000) / 1000,
        source: 'entities_table',
      };
    }

    // -- Mentions --
    if (input.include_mentions) {
      const mentions: Array<Record<string, unknown>> = [];

      if (nodeRow && nodeId) {
        // Get entity IDs linked to this node
        const linkedEntityIds = conn
          .prepare('SELECT entity_id FROM node_entity_links WHERE node_id = ?')
          .all(nodeId) as Array<{ entity_id: string }>;

        if (linkedEntityIds.length > 0) {
          const entityIdList = linkedEntityIds.map((r) => r.entity_id);
          const placeholders = entityIdList.map(() => '?').join(',');
          const mentionRows = conn
            .prepare(
              `
            SELECT em.id, em.entity_id, em.document_id, em.chunk_id,
                   em.page_number, em.character_start, em.character_end, em.context_text,
                   e.raw_text, e.entity_type
            FROM entity_mentions em
            JOIN entities e ON em.entity_id = e.id
            WHERE em.entity_id IN (${placeholders})
            ORDER BY em.document_id, em.character_start
            LIMIT ?
          `
            )
            .all(...entityIdList, maxMentions) as Array<{
            id: string;
            entity_id: string;
            document_id: string;
            chunk_id: string | null;
            page_number: number | null;
            character_start: number | null;
            character_end: number | null;
            context_text: string | null;
            raw_text: string;
            entity_type: string;
          }>;

          for (const m of mentionRows) {
            mentions.push({
              mention_id: m.id,
              raw_text: m.raw_text,
              document_id: m.document_id,
              chunk_id: m.chunk_id,
              page_number: m.page_number,
              character_start: m.character_start,
              character_end: m.character_end,
              context_text: m.context_text,
            });
          }
        }
      } else {
        // Fallback: mentions from entities table matches
        for (const e of fallbackEntities) {
          const mentionRows = conn
            .prepare(
              `
            SELECT id, document_id, chunk_id, page_number,
                   character_start, character_end, context_text
            FROM entity_mentions WHERE entity_id = ?
            LIMIT ?
          `
            )
            .all(e.id, Math.ceil(maxMentions / fallbackEntities.length)) as Array<{
            id: string;
            document_id: string;
            chunk_id: string | null;
            page_number: number | null;
            character_start: number | null;
            character_end: number | null;
            context_text: string | null;
          }>;
          for (const m of mentionRows) {
            mentions.push({
              mention_id: m.id,
              raw_text: e.raw_text,
              document_id: m.document_id,
              chunk_id: m.chunk_id,
              page_number: m.page_number,
              character_start: m.character_start,
              character_end: m.character_end,
              context_text: m.context_text,
            });
          }
        }
      }

      dossier.mentions = mentions;
      dossier.mention_count = mentions.length;
    }

    // -- Relationships --
    if (input.include_relationships && nodeId) {
      const edgeRows = conn
        .prepare(
          `
        SELECT ke.id as edge_id, ke.relationship_type, ke.weight, ke.evidence_count,
               ke.valid_from, ke.valid_until,
               CASE WHEN ke.source_node_id = ? THEN ke.target_node_id ELSE ke.source_node_id END as partner_id,
               CASE WHEN ke.source_node_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
        FROM knowledge_edges ke
        WHERE ke.source_node_id = ? OR ke.target_node_id = ?
        ORDER BY ke.weight DESC
      `
        )
        .all(nodeId, nodeId, nodeId, nodeId) as Array<{
        edge_id: string;
        relationship_type: string;
        weight: number;
        evidence_count: number;
        valid_from: string | null;
        valid_until: string | null;
        partner_id: string;
        direction: string;
      }>;

      const relationships: Array<Record<string, unknown>> = [];
      for (const edge of edgeRows) {
        const partner = conn
          .prepare('SELECT canonical_name, entity_type FROM knowledge_nodes WHERE id = ?')
          .get(edge.partner_id) as { canonical_name: string; entity_type: string } | undefined;

        relationships.push({
          edge_id: edge.edge_id,
          partner_node_id: edge.partner_id,
          partner_name: partner?.canonical_name ?? 'unknown',
          partner_type: partner?.entity_type ?? 'unknown',
          relationship_type: edge.relationship_type,
          direction: edge.direction,
          weight: Math.round(edge.weight * 1000) / 1000,
          evidence_count: edge.evidence_count,
          valid_from: edge.valid_from,
          valid_until: edge.valid_until,
        });
      }

      dossier.relationships = relationships;
      dossier.relationship_count = relationships.length;
    }

    // -- Documents --
    if (input.include_documents) {
      const documents: Array<Record<string, unknown>> = [];

      if (nodeId) {
        // Documents via node_entity_links
        const docRows = conn
          .prepare(
            `
          SELECT d.id, d.file_name, d.page_count,
                 COUNT(em.id) as mention_count
          FROM node_entity_links nel
          JOIN entities e ON nel.entity_id = e.id
          JOIN entity_mentions em ON em.entity_id = e.id
          JOIN documents d ON d.id = em.document_id
          WHERE nel.node_id = ?
          GROUP BY d.id
          ORDER BY mention_count DESC
        `
          )
          .all(nodeId) as Array<{
          id: string;
          file_name: string;
          page_count: number | null;
          mention_count: number;
        }>;

        for (const d of docRows) {
          documents.push({
            document_id: d.id,
            file_name: d.file_name,
            page_count: d.page_count,
            entity_mention_count: d.mention_count,
          });
        }
      } else {
        // Fallback: documents from matched entities
        const docIds = [...new Set(fallbackEntities.map((e) => e.document_id))];
        for (const docId of docIds) {
          const docInfo = db.getDocument(docId);
          if (docInfo) {
            const mentionCount = fallbackEntities.filter((e) => e.document_id === docId).length;
            documents.push({
              document_id: docId,
              file_name: docInfo.file_name,
              page_count: docInfo.page_count,
              entity_mention_count: mentionCount,
            });
          }
        }
      }

      dossier.documents = documents;
      dossier.document_count = documents.length;
    }

    // -- Timeline --
    if (input.include_timeline && nodeId) {
      // Find date entities co-located in chunks with this entity
      const linkedEntityIds = conn
        .prepare('SELECT entity_id FROM node_entity_links WHERE node_id = ?')
        .all(nodeId) as Array<{ entity_id: string }>;

      const timeline: Array<Record<string, unknown>> = [];

      if (linkedEntityIds.length > 0) {
        const entityIdList = linkedEntityIds.map((r) => r.entity_id);
        const placeholders = entityIdList.map(() => '?').join(',');

        // Find chunk_ids containing this entity's mentions
        const chunkRows = conn
          .prepare(
            `
          SELECT DISTINCT chunk_id FROM entity_mentions
          WHERE entity_id IN (${placeholders}) AND chunk_id IS NOT NULL
        `
          )
          .all(...entityIdList) as Array<{ chunk_id: string }>;

        if (chunkRows.length > 0) {
          const chunkIds = chunkRows.map((r) => r.chunk_id);
          const chunkPlaceholders = chunkIds.map(() => '?').join(',');

          // Find date entities in those same chunks
          const dateRows = conn
            .prepare(
              `
            SELECT DISTINCT e.normalized_text, e.raw_text, e.confidence,
                   em.document_id, em.context_text
            FROM entity_mentions em
            JOIN entities e ON em.entity_id = e.id
            WHERE em.chunk_id IN (${chunkPlaceholders})
              AND e.entity_type = 'date'
            ORDER BY e.normalized_text ASC
          `
            )
            .all(...chunkIds) as Array<{
            normalized_text: string;
            raw_text: string;
            confidence: number;
            document_id: string;
            context_text: string | null;
          }>;

          for (const d of dateRows) {
            timeline.push({
              date_normalized: d.normalized_text,
              date_raw: d.raw_text,
              confidence: d.confidence,
              document_id: d.document_id,
              context: d.context_text,
            });
          }
        }
      }

      dossier.timeline = timeline;
      dossier.timeline_count = timeline.length;
    }

    // -- Clusters --
    if (input.include_clusters) {
      try {
        // Get entity's document IDs
        const entityDocIds: string[] = [];
        if (nodeId) {
          const docIdRows = conn
            .prepare(
              `
            SELECT DISTINCT nel.document_id FROM node_entity_links nel WHERE nel.node_id = ?
          `
            )
            .all(nodeId) as Array<{ document_id: string }>;
          for (const r of docIdRows) entityDocIds.push(r.document_id);
        } else {
          for (const e of fallbackEntities) {
            if (!entityDocIds.includes(e.document_id)) entityDocIds.push(e.document_id);
          }
        }

        if (entityDocIds.length > 0) {
          const docPlaceholders = entityDocIds.map(() => '?').join(',');
          const clusterRows = conn
            .prepare(
              `
            SELECT DISTINCT dc.cluster_id, c.label, c.classification_tag, c.run_id
            FROM document_clusters dc
            JOIN clusters c ON dc.cluster_id = c.id
            WHERE dc.document_id IN (${docPlaceholders})
          `
            )
            .all(...entityDocIds) as Array<{
            cluster_id: string;
            label: string | null;
            classification_tag: string | null;
            run_id: string;
          }>;

          if (clusterRows.length > 0) {
            const clusterIds = clusterRows.map((r) => r.cluster_id);
            const clusterPlaceholders = clusterIds.map(() => '?').join(',');
            const entityIdForExclusion = nodeId ?? fallbackEntities[0]?.id ?? '';

            // Get co-clustered entities
            let coClusteredEntities: Array<{ raw_text: string; entity_type: string }> = [];
            try {
              coClusteredEntities = conn
                .prepare(
                  `
                SELECT DISTINCT e.raw_text, e.entity_type FROM entities e
                JOIN entity_mentions em ON em.entity_id = e.id
                JOIN document_clusters dc ON dc.document_id = em.document_id
                WHERE dc.cluster_id IN (${clusterPlaceholders}) AND e.id != ?
                LIMIT 20
              `
                )
                .all(...clusterIds, entityIdForExclusion) as Array<{
                raw_text: string;
                entity_type: string;
              }>;
            } catch (err) {
              console.error(
                `[entity-analysis] dossier co-clustered entities query failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }

            dossier.clusters = {
              cluster_memberships: clusterRows.map((r) => ({
                cluster_id: r.cluster_id,
                label: r.label,
                classification_tag: r.classification_tag,
                run_id: r.run_id,
              })),
              co_clustered_entities: coClusteredEntities,
            };
          } else {
            dossier.clusters = { cluster_memberships: [], co_clustered_entities: [] };
          }
        } else {
          dossier.clusters = { cluster_memberships: [], co_clustered_entities: [] };
        }
      } catch (err) {
        console.error(
          `[entity-analysis] dossier cluster query failed: ${err instanceof Error ? err.message : String(err)}`
        );
        dossier.clusters = {
          cluster_memberships: [],
          co_clustered_entities: [],
          note: 'cluster tables not available',
        };
      }
    }

    // -- Related Entities (top 10 by edge weight) --
    if (nodeId) {
      const relatedRows = conn
        .prepare(
          `
        SELECT
          CASE WHEN ke.source_node_id = ? THEN ke.target_node_id ELSE ke.source_node_id END as related_id,
          SUM(ke.weight) as total_weight,
          COUNT(*) as edge_count
        FROM knowledge_edges ke
        WHERE ke.source_node_id = ? OR ke.target_node_id = ?
        GROUP BY related_id
        ORDER BY total_weight DESC
        LIMIT 10
      `
        )
        .all(nodeId, nodeId, nodeId) as Array<{
        related_id: string;
        total_weight: number;
        edge_count: number;
      }>;

      const relatedEntities: Array<Record<string, unknown>> = [];
      for (const r of relatedRows) {
        const partner = conn
          .prepare(
            'SELECT canonical_name, entity_type, document_count FROM knowledge_nodes WHERE id = ?'
          )
          .get(r.related_id) as
          | { canonical_name: string; entity_type: string; document_count: number }
          | undefined;
        if (partner) {
          relatedEntities.push({
            node_id: r.related_id,
            canonical_name: partner.canonical_name,
            entity_type: partner.entity_type,
            document_count: partner.document_count,
            total_edge_weight: Math.round(r.total_weight * 1000) / 1000,
            edge_count: r.edge_count,
          });
        }
      }

      dossier.related_entities = relatedEntities;
    }

    // -- Entity Roles (AI-Synthesized) --
    if (nodeId) {
      try {
        const roles = getEntityRolesForNode(conn, nodeId);
        if (roles.length > 0) {
          dossier.entity_roles = roles.map((r) => ({
            role: r.role,
            theme: r.theme,
            importance_rank: r.importance_rank,
            context_summary: r.context_summary,
            scope: r.scope,
            scope_id: r.scope_id,
          }));
        }
      } catch (roleErr) {
        console.error(
          `[entity-analysis] dossier entity roles query failed: ${roleErr instanceof Error ? roleErr.message : String(roleErr)}`
        );
      }
    }

    dossier.entity_fallback = entityFallback;

    return formatResponse(successResult(dossier));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * ocr_entity_update_confidence - Dynamically recalculate entity confidence based on accumulated evidence
 *
 * Applies boosts for:
 * - Cross-document KG presence: min(0.10, (N-1) * 0.02) where N = documents containing the KG node
 * - Mention frequency: min(0.05, log(mention_count/5) * 0.02) when mention_count > 5
 * - Multi-source extraction: 0.05 per additional source (OCR + VLM + extraction)
 */
async function handleEntityUpdateConfidence(params: Record<string, unknown>) {
  try {
    const input = validateInput(EntityUpdateConfidenceInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Scope filter
    const filterClause = input.document_id ? 'WHERE e.document_id = ?' : '';
    const filterParams = input.document_id ? [input.document_id] : [];

    // Get all entities in scope
    const entityRows = conn
      .prepare(
        `
      SELECT e.id, e.document_id, e.entity_type, e.normalized_text, e.confidence
      FROM entities e
      ${filterClause}
      ORDER BY e.document_id, e.entity_type
    `
      )
      .all(...filterParams) as Array<{
      id: string;
      document_id: string;
      entity_type: string;
      normalized_text: string;
      confidence: number;
    }>;

    if (entityRows.length === 0) {
      return formatResponse(
        successResult({
          message: 'No entities found in scope.',
          entities_updated: 0,
        })
      );
    }

    // Pre-compute mention counts per entity
    const mentionCountMap = new Map<string, number>();
    const mentionRows = conn
      .prepare(
        `
      SELECT entity_id, COUNT(*) as cnt FROM entity_mentions
      ${input.document_id ? 'WHERE document_id = ?' : ''}
      GROUP BY entity_id
    `
      )
      .all(...filterParams) as Array<{ entity_id: string; cnt: number }>;
    for (const r of mentionRows) {
      mentionCountMap.set(r.entity_id, r.cnt);
    }

    // Pre-compute KG node document counts per entity
    const kgDocCountMap = new Map<string, number>();
    try {
      const kgRows = conn
        .prepare(
          `
        SELECT nel.entity_id, kn.document_count
        FROM node_entity_links nel
        JOIN knowledge_nodes kn ON nel.node_id = kn.id
        ${input.document_id ? 'WHERE nel.document_id = ?' : ''}
      `
        )
        .all(...filterParams) as Array<{ entity_id: string; document_count: number }>;
      for (const r of kgRows) {
        kgDocCountMap.set(r.entity_id, r.document_count);
      }
    } catch (err) {
      console.error(
        `[entity-analysis] KG doc count query failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Pre-compute extraction source counts per entity
    const multiSourceMap = new Map<string, number>();
    try {
      const sourceRows = conn
        .prepare(
          `
        SELECT e.id as entity_id, COUNT(DISTINCT p.processor) as source_count
        FROM entities e
        JOIN provenance p ON e.provenance_id = p.id
        ${filterClause}
        GROUP BY e.id
      `
        )
        .all(...filterParams) as Array<{ entity_id: string; source_count: number }>;
      for (const r of sourceRows) {
        multiSourceMap.set(r.entity_id, r.source_count);
      }
    } catch (err) {
      console.error(
        `[entity-analysis] extraction source count query failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Check for entities with same normalized_text + type from different provenance sources
    const crossSourceMap = new Map<string, number>();
    try {
      const crossRows = conn
        .prepare(
          `
        SELECT e1.id as entity_id, COUNT(DISTINCT p2.processor) as cross_source_count
        FROM entities e1
        JOIN entities e2 ON e1.normalized_text = e2.normalized_text
          AND e1.entity_type = e2.entity_type
          AND e1.id != e2.id
        JOIN provenance p2 ON e2.provenance_id = p2.id
        ${filterClause.replace('e.document_id', 'e1.document_id')}
        GROUP BY e1.id
      `
        )
        .all(...filterParams) as Array<{ entity_id: string; cross_source_count: number }>;
      for (const r of crossRows) {
        crossSourceMap.set(r.entity_id, r.cross_source_count);
      }
    } catch (err) {
      console.error(
        `[entity-analysis] cross-source count query failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Pre-compute KG importance scores per entity if requested
    const kgImportanceMap = new Map<string, number>();
    if (input.factor_kg_importance) {
      try {
        const importanceRows = conn
          .prepare(
            `
          SELECT nel.entity_id, kn.importance_score
          FROM node_entity_links nel
          JOIN knowledge_nodes kn ON nel.node_id = kn.id
          WHERE kn.importance_score IS NOT NULL
          ${input.document_id ? 'AND nel.document_id = ?' : ''}
        `
          )
          .all(...filterParams) as Array<{ entity_id: string; importance_score: number }>;
        for (const r of importanceRows) {
          kgImportanceMap.set(r.entity_id, r.importance_score);
        }
      } catch (err) {
        console.error(
          `[entity-analysis] KG importance score query failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Calculate new confidence for each entity
    const updates: Array<{
      entity_id: string;
      old_confidence: number;
      new_confidence: number;
      cross_document_boost: number;
      mention_boost: number;
      multi_source_boost: number;
      kg_importance_factor?: number;
    }> = [];

    let totalOldConfidence = 0;
    let totalNewConfidence = 0;

    for (const entity of entityRows) {
      const baseConfidence = entity.confidence;
      totalOldConfidence += baseConfidence;

      // Cross-document boost
      const kgDocCount = kgDocCountMap.get(entity.id) ?? 1;
      const crossDocBoost = Math.min(0.1, Math.max(0, (kgDocCount - 1) * 0.02));

      // Mention frequency boost
      const mentionCount = mentionCountMap.get(entity.id) ?? 1;
      let mentionBoost = 0;
      if (mentionCount > 5) {
        mentionBoost = Math.min(0.05, Math.log(mentionCount / 5) * 0.02);
      }

      // Multi-source boost
      const directSourceCount = multiSourceMap.get(entity.id) ?? 1;
      const crossSourceCount = crossSourceMap.get(entity.id) ?? 0;
      const totalSources = Math.max(directSourceCount, 1 + crossSourceCount);
      const multiSourceBoost = Math.min(0.15, Math.max(0, (totalSources - 1) * 0.05));

      let intermediateConfidence = baseConfidence + crossDocBoost + mentionBoost + multiSourceBoost;

      // KG importance factor
      let kgImportanceFactor: number | undefined;
      if (input.factor_kg_importance) {
        const importance = kgImportanceMap.get(entity.id);
        if (importance !== null && importance !== undefined && importance > 0) {
          const factor = 1 + Math.min(importance, 10) * 0.02;
          kgImportanceFactor = Math.round(factor * 1000) / 1000;
          intermediateConfidence = intermediateConfidence * factor;
        }
      }

      const newConfidence = Math.min(1.0, intermediateConfidence);
      totalNewConfidence += newConfidence;

      if (Math.abs(newConfidence - baseConfidence) > 0.001) {
        updates.push({
          entity_id: entity.id,
          old_confidence: baseConfidence,
          new_confidence: Math.round(newConfidence * 1000) / 1000,
          cross_document_boost: Math.round(crossDocBoost * 1000) / 1000,
          mention_boost: Math.round(mentionBoost * 1000) / 1000,
          multi_source_boost: Math.round(multiSourceBoost * 1000) / 1000,
          ...(kgImportanceFactor !== null && kgImportanceFactor !== undefined
            ? { kg_importance_factor: kgImportanceFactor }
            : {}),
        });
      }
    }

    // Apply updates (unless dry_run)
    if (!input.dry_run && updates.length > 0) {
      const updateStmt = conn.prepare('UPDATE entities SET confidence = ? WHERE id = ?');
      const updateMany = conn.transaction(() => {
        for (const u of updates) {
          updateStmt.run(u.new_confidence, u.entity_id);
        }
      });
      updateMany();

      // Update KG node avg_confidence for affected nodes
      try {
        const affectedNodeIds = new Set<string>();
        const entityIds = updates.map((u) => u.entity_id);
        const placeholders = entityIds.map(() => '?').join(',');
        const linkRows = conn
          .prepare(
            `SELECT DISTINCT node_id FROM node_entity_links WHERE entity_id IN (${placeholders})`
          )
          .all(...entityIds) as Array<{ node_id: string }>;
        for (const r of linkRows) affectedNodeIds.add(r.node_id);

        for (const nid of affectedNodeIds) {
          const avgRow = conn
            .prepare(
              `
            SELECT AVG(e.confidence) as avg_conf
            FROM node_entity_links nel
            JOIN entities e ON nel.entity_id = e.id
            WHERE nel.node_id = ?
          `
            )
            .get(nid) as { avg_conf: number | null };
          if (avgRow?.avg_conf !== null && avgRow?.avg_conf !== undefined) {
            conn
              .prepare('UPDATE knowledge_nodes SET avg_confidence = ? WHERE id = ?')
              .run(Math.round(avgRow.avg_conf * 1000) / 1000, nid);
          }
        }

        console.error(`[INFO] Updated avg_confidence on ${affectedNodeIds.size} KG nodes`);
      } catch (err) {
        console.error(
          `[entity-analysis] KG avg_confidence update failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Confidence distribution (before/after)
    const beforeBuckets = { low: 0, medium: 0, high: 0 };
    const afterBuckets = { low: 0, medium: 0, high: 0 };
    const updateMap = new Map(updates.map((u) => [u.entity_id, u]));

    for (const entity of entityRows) {
      // Before
      if (entity.confidence < 0.5) beforeBuckets.low++;
      else if (entity.confidence < 0.8) beforeBuckets.medium++;
      else beforeBuckets.high++;

      // After
      const update = updateMap.get(entity.id);
      const newConf = update ? update.new_confidence : entity.confidence;
      if (newConf < 0.5) afterBuckets.low++;
      else if (newConf < 0.8) afterBuckets.medium++;
      else afterBuckets.high++;
    }

    const avgOld = entityRows.length > 0 ? totalOldConfidence / entityRows.length : 0;
    const avgNew = entityRows.length > 0 ? totalNewConfidence / entityRows.length : 0;

    return formatResponse(
      successResult({
        document_id: input.document_id ?? null,
        dry_run: input.dry_run,
        entities_in_scope: entityRows.length,
        entities_updated: updates.length,
        entities_unchanged: entityRows.length - updates.length,
        avg_confidence_before: Math.round(avgOld * 1000) / 1000,
        avg_confidence_after: Math.round(avgNew * 1000) / 1000,
        avg_confidence_change: Math.round((avgNew - avgOld) * 1000) / 1000,
        confidence_distribution: {
          before: beforeBuckets,
          after: afterBuckets,
        },
        sample_updates: updates.slice(0, 20),
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const entityAnalysisTools: Record<string, ToolDefinition> = {
  ocr_entity_extract: {
    description:
      'Extract named entities (people, organizations, dates, amounts, case numbers, locations, statutes, exhibits) from an OCR-processed document using Gemini AI. Returns extraction_quality score with metrics (density, diversity, noise_ratio, coverage) and recommendations. Reports entity_boundary_issues when entities span chunk boundaries. Returns related documents by shared entity overlap. Optionally reassigns document clusters after extraction.',
    inputSchema: EntityExtractInput.shape,
    handler: handleEntityExtract,
  },
  ocr_entity_search: {
    description: 'Search for entities across documents by name, type, or document filter',
    inputSchema: EntitySearchInput.shape,
    handler: handleEntitySearch,
  },
  ocr_timeline_build: {
    description:
      'Build a chronological timeline from date entities extracted from documents. Each entry includes cluster context (cluster_id, cluster_label) when clusters exist. Optionally filter by entity_names (co-located entities) or entity_path_source/entity_path_target (KG relationship path filtering).',
    inputSchema: TimelineBuildInput.shape,
    handler: handleTimelineBuild,
  },
  ocr_legal_witness_analysis: {
    description:
      'Generate expert witness analysis of documents using Gemini AI thinking mode, including findings, timeline, conclusions, and reliability assessment',
    inputSchema: WitnessAnalysisInput.shape,
    handler: handleWitnessAnalysis,
  },
  ocr_entity_extract_from_vlm: {
    description:
      'Extract named entities from VLM (Vision-Language Model) image descriptions for a document. Requires images to have been processed with VLM first.',
    inputSchema: VLMEntityExtractInput.shape,
    handler: handleEntityExtractFromVLM,
  },
  ocr_entity_extract_from_extractions: {
    description:
      'Create entities from structured extraction fields (e.g., vendor_name -> organization, filing_date -> date). Requires ocr_extract_structured to have been run first.',
    inputSchema: ExtractionEntityExtractInput.shape,
    handler: handleEntityExtractFromExtractions,
  },
  ocr_entity_extraction_stats: {
    description:
      'Get entity extraction quality analytics including type distribution, confidence stats, segment coverage, KG integration metrics, and optional cross-document entity consistency validation',
    inputSchema: {
      document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
      include_cross_doc_consistency: z
        .boolean()
        .default(false)
        .describe(
          'Include cross-document entity consistency analysis: flag KG nodes with >2 raw text variants across documents'
        ),
    },
    handler: handleEntityExtractionStats,
  },
  ocr_coreference_resolve: {
    description:
      'Resolve coreferences (pronouns, abbreviations, descriptions) to their corresponding entities using Gemini AI. Supports chunk-level (default) or document-level resolution scope for cross-chunk pronoun resolution.',
    inputSchema: CoreferenceResolveInput.shape,
    handler: handleCoreferenceResolve,
  },
  ocr_entity_dossier: {
    description:
      'Get a comprehensive profile for a single entity or KG node, including mentions, relationships, documents, timeline, cluster memberships, and related entities.',
    inputSchema: EntityDossierInput.shape,
    handler: handleEntityDossier,
  },
  ocr_entity_update_confidence: {
    description:
      'Dynamically recalculate entity confidence scores based on accumulated evidence: cross-document presence, mention frequency, multi-source extraction confirmation, and optionally KG node importance.',
    inputSchema: EntityUpdateConfidenceInput.shape,
    handler: handleEntityUpdateConfidence,
  },
};

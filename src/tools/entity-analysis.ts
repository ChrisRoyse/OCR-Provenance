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
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { GeminiClient } from '../services/gemini/client.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import { ENTITY_TYPES, type EntityType } from '../models/entity.js';
import {
  insertEntity,
  insertEntityMention,
  searchEntities,
  getEntityMentions,
  deleteEntitiesByDocument,
} from '../services/storage/database/entity-operations.js';
import { getChunksByDocumentId } from '../services/storage/database/chunk-operations.js';
import { getClusterSummariesForDocument } from '../services/storage/database/cluster-operations.js';
import { getKnowledgeNodeSummariesByDocument } from '../services/storage/database/knowledge-graph-operations.js';
import { extractEntitiesFromVLM } from '../services/knowledge-graph/vlm-entity-extractor.js';
import { mapExtractionEntitiesToDB } from '../services/knowledge-graph/extraction-entity-mapper.js';
import { incrementalBuildGraph } from '../services/knowledge-graph/incremental-builder.js';
import { findGraphPaths } from '../services/knowledge-graph/graph-service.js';
import {
  normalizeEntity,
  extractEntitiesFromText,
  mapEntityToChunk,
  MAX_CHARS_PER_CALL,
  SEGMENT_OVERLAP_CHARS,
} from '../utils/entity-extraction-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const EntityExtractInput = z.object({
  document_id: z.string().min(1).describe('Document ID (must be OCR processed)'),
  entity_types: z.array(z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'other',
  ])).optional().describe('Entity types to extract (default: all types)'),
});

const EntitySearchInput = z.object({
  query: z.string().min(1).max(500).describe('Search query for entity names'),
  entity_type: z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'other',
  ]).optional().describe('Filter by entity type'),
  document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
  limit: z.number().int().min(1).max(200).default(50).describe('Maximum results'),
});

const TimelineBuildInput = z.object({
  document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
  date_format: z.string().optional().default('iso').describe('Date format for output: iso, us, eu'),
  entity_names: z.array(z.string()).optional()
    .describe('Filter timeline to only show events involving these entities (searches entity mentions context)'),
  entity_path_source: z.string().optional()
    .describe('Show events along the KG path from this entity to entity_path_target'),
  entity_path_target: z.string().optional()
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

// Entity normalization, text splitting, Gemini extraction, and chunk mapping
// functions are imported from ../utils/entity-extraction-helpers.js above.

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
  documentId: string,
): Promise<Record<string, unknown> | null> {
  const conn = db.getConnection();

  // Check if knowledge graph exists (has any nodes)
  const row = conn.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number };
  if (row.cnt === 0) {
    return null;
  }

  console.error(`[INFO] Knowledge graph detected (${row.cnt} nodes), auto-merging entities for document ${documentId}`);

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
      return formatResponse({ error: `Document not found: ${input.document_id}` });
    }
    if (doc.status !== 'complete') {
      return formatResponse({
        error: `Document not OCR processed yet (status: ${doc.status}). Run ocr_process_pending first.`,
      });
    }

    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult) {
      return formatResponse({ error: `No OCR result found for document ${doc.id}` });
    }

    // Delete existing entities for this document before re-extracting
    const existingCount = deleteEntitiesByDocument(conn, doc.id);
    if (existingCount > 0) {
      console.error(`[INFO] Deleted ${existingCount} existing entities for document ${doc.id} before re-extraction`);
    }

    // Extract entities using single Gemini call (or adaptive batching for very large docs)
    const client = new GeminiClient();
    const startTime = Date.now();

    const allRawEntities = await extractEntitiesFromText(
      client,
      ocrResult.extracted_text,
      input.entity_types ?? [],
    );

    // Track how many API calls were made (1 for most docs, 2-3 for >500K chars)
    const textLength = ocrResult.extracted_text.length;
    const apiCalls = textLength <= MAX_CHARS_PER_CALL
      ? 1
      : Math.ceil((textLength - SEGMENT_OVERLAP_CHARS) / (MAX_CHARS_PER_CALL - SEGMENT_OVERLAP_CHARS));

    const processingDurationMs = Date.now() - startTime;

    // Deduplicate by normalized_text + entity_type
    const dedupMap = new Map<string, { type: string; raw_text: string; confidence: number }>();
    for (const entity of allRawEntities) {
      const normalized = normalizeEntity(entity.raw_text, entity.type);
      const key = `${entity.type}::${normalized}`;
      const existing = dedupMap.get(key);
      if (!existing || entity.confidence > existing.confidence) {
        dedupMap.set(key, entity);
      }
    }

    // Create ENTITY_EXTRACTION provenance record
    const now = new Date().toISOString();
    const entityProvId = uuidv4();
    const entityContent = JSON.stringify([...dedupMap.values()]);
    const entityHash = computeHash(entityContent);

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
      content_hash: entityHash,
      input_hash: ocrResult.content_hash,
      file_hash: doc.file_hash,
      processor: 'gemini-entity-extraction',
      processor_version: '1.0.0',
      processing_params: {
        entity_types: input.entity_types ?? ENTITY_TYPES,
        api_calls: apiCalls,
        text_length: textLength,
      },
      processing_duration_ms: processingDurationMs,
      processing_quality_score: null,
      parent_id: ocrResult.provenance_id,
      parent_ids: JSON.stringify([doc.provenance_id, ocrResult.provenance_id]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION']),
    });

    // Load DB chunks for chunk_id mapping (ordered by chunk_index)
    const dbChunks = getChunksByDocumentId(conn, doc.id);
    const ocrText = ocrResult.extracted_text;
    let chunkMappedCount = 0;

    // Store entities and mentions in DB
    const typeCounts: Record<string, number> = {};
    let totalInserted = 0;

    for (const [, entityData] of dedupMap) {
      const normalized = normalizeEntity(entityData.raw_text, entityData.type);
      const entityId = uuidv4();

      insertEntity(conn, {
        id: entityId,
        document_id: doc.id,
        entity_type: entityData.type as EntityType,
        raw_text: entityData.raw_text,
        normalized_text: normalized,
        confidence: entityData.confidence,
        metadata: null,
        provenance_id: entityProvId,
        created_at: now,
      });

      // Map entity to its DB chunk via text position in OCR text
      const mapping = mapEntityToChunk(entityData.raw_text, ocrText, dbChunks);
      if (mapping.chunk_id) {
        chunkMappedCount++;
      }

      // Create a mention record for the entity with chunk mapping
      const mentionId = uuidv4();
      insertEntityMention(conn, {
        id: mentionId,
        entity_id: entityId,
        document_id: doc.id,
        chunk_id: mapping.chunk_id,
        page_number: mapping.page_number,
        character_start: mapping.character_start,
        character_end: mapping.character_end,
        context_text: entityData.raw_text,
        created_at: now,
      });

      typeCounts[entityData.type] = (typeCounts[entityData.type] ?? 0) + 1;
      totalInserted++;
    }

    // Auto-merge into knowledge graph if one exists
    const kgMergeResult = await autoMergeIntoKnowledgeGraph(db, doc.id);

    return formatResponse({
      document_id: doc.id,
      total_entities: totalInserted,
      total_raw_extracted: allRawEntities.length,
      deduplicated: allRawEntities.length - totalInserted,
      entities_by_type: typeCounts,
      chunk_mapped: chunkMappedCount,
      chunk_unmapped: totalInserted - chunkMappedCount,
      total_db_chunks: dbChunks.length,
      provenance_id: entityProvId,
      processing_duration_ms: processingDurationMs,
      text_length: textLength,
      api_calls: apiCalls,
      ...kgMergeResult,
    });
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
    } catch {
      // Pre-v16 schema without knowledge graph tables - skip KG enrichment
    }

    // Enrich with mentions, document info, and KG context
    const results = entities.map(entity => {
      const mentions = getEntityMentions(conn, entity.id);
      const document = db.getDocument(entity.document_id);

      const result: Record<string, unknown> = {
        entity_id: entity.id,
        entity_type: entity.entity_type,
        raw_text: entity.raw_text,
        normalized_text: entity.normalized_text,
        confidence: entity.confidence,
        document: document ? {
          id: document.id,
          file_name: document.file_name,
          file_path: document.file_path,
        } : null,
        mentions: mentions.map(m => ({
          id: m.id,
          page_number: m.page_number,
          character_start: m.character_start,
          character_end: m.character_end,
          context_text: m.context_text,
        })),
        mention_count: mentions.length,
      };

      // ENH-5: Enrich with knowledge graph data if available
      if (kgNodeStmt) {
        try {
          const kgNode = kgNodeStmt.get(entity.id) as {
            node_id: string; canonical_name: string; aliases: string | null;
            document_count: number; edge_count: number;
          } | undefined;

          if (kgNode) {
            // Parse aliases JSON
            let aliases: string[] = [];
            if (kgNode.aliases) {
              try {
                const parsed = JSON.parse(kgNode.aliases);
                if (Array.isArray(parsed)) {
                  aliases = parsed.filter((a: unknown) => typeof a === 'string' && a.length > 0);
                }
              } catch {
                // Malformed aliases JSON
              }
            }

            result.kg_node_id = kgNode.node_id;
            result.kg_canonical_name = kgNode.canonical_name;
            result.kg_aliases = aliases;
            result.kg_document_count = kgNode.document_count;
            result.kg_edge_count = kgNode.edge_count;

            // Fetch top connected entities
            if (kgEdgesStmt) {
              try {
                const connectedRows = kgEdgesStmt.all({ nid: kgNode.node_id }) as Array<{
                  canonical_name: string; relationship_type: string; weight: number;
                }>;
                if (connectedRows.length > 0) {
                  result.kg_connected_entities = connectedRows.map(r => ({
                    name: r.canonical_name,
                    relationship_type: r.relationship_type,
                    weight: r.weight,
                  }));
                }
              } catch {
                // Edge query failed - skip connected entities
              }
            }
          }
        } catch {
          // KG lookup failed for this entity - skip enrichment
        }
      }

      return result;
    });

    return formatResponse({
      query: input.query,
      entity_type_filter: input.entity_type ?? null,
      total_results: results.length,
      results,
    });
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
      throw new Error('Both entity_path_source and entity_path_target must be provided for path-based filtering');
    }

    // If path filtering is requested, find documents along the KG path
    let pathDocumentIds: Set<string> | null = null;
    let pathInfo: Record<string, unknown> | null = null;

    if (input.entity_path_source && input.entity_path_target) {
      const pathResult = findGraphPaths(db, input.entity_path_source, input.entity_path_target, {
        max_hops: 4,
      });

      if (pathResult.total_paths === 0) {
        return formatResponse({
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
        });
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
      const docRows = conn.prepare(
        `SELECT DISTINCT document_id FROM node_entity_links WHERE node_id IN (${placeholders})`,
      ).all(...nodeIdList) as Array<{ document_id: string }>;

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

      console.error(`[INFO] Timeline path filter: ${pathNodeIds.size} nodes -> ${pathDocumentIds.size} documents`);
    }

    // Build effective document filter (intersection of document_filter and pathDocumentIds)
    let effectiveDocFilter: string[] | undefined = input.document_filter;
    if (pathDocumentIds) {
      if (effectiveDocFilter) {
        // Intersect: only keep documents in both filters
        effectiveDocFilter = effectiveDocFilter.filter(id => pathDocumentIds!.has(id));
      } else {
        effectiveDocFilter = [...pathDocumentIds];
      }
      // If intersection is empty, no results possible
      if (effectiveDocFilter.length === 0) {
        return formatResponse({
          total_entries: 0,
          date_format: input.date_format,
          document_filter: input.document_filter ?? null,
          entity_names: input.entity_names ?? null,
          entity_path_source: input.entity_path_source ?? null,
          entity_path_target: input.entity_path_target ?? null,
          path_info: pathInfo,
          timeline: [],
        });
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
        const likePattern = `%${name}%`;
        const rows = conn.prepare(`
          SELECT DISTINCT em.chunk_id
          FROM entity_mentions em
          JOIN entities e ON em.entity_id = e.id
          WHERE em.chunk_id IS NOT NULL
            AND (e.normalized_text LIKE ? COLLATE NOCASE OR e.raw_text LIKE ? COLLATE NOCASE)
        `).all(likePattern, likePattern) as Array<{ chunk_id: string }>;
        for (const row of rows) {
          entityNameChunkIds.add(row.chunk_id);
        }
      }
      console.error(`[INFO] Timeline entity_names filter: ${input.entity_names.length} names -> ${entityNameChunkIds.size} matching chunks`);
    }

    // Parse dates and build timeline entries
    const timelineEntries: Array<{
      date_iso: string;
      date_display: string;
      raw_text: string;
      confidence: number;
      document_id: string;
      document_name: string | null;
      context: string | null;
      co_located_entities?: string[];
    }> = [];

    for (const entity of dateEntities) {
      const mentions = getEntityMentions(conn, entity.id);

      // If entity_names filter is active, check co-location via chunk_id
      if (entityNameChunkIds) {
        // Check if any mention of this date entity shares a chunk with the target entities
        const hasCoLocated = mentions.some(m => m.chunk_id && entityNameChunkIds!.has(m.chunk_id));
        if (!hasCoLocated) {
          // Also check context_text as fallback for entities without chunk mappings
          const contextMatch = mentions.some(m => {
            if (!m.context_text) return false;
            const ctx = m.context_text.toLowerCase();
            return input.entity_names!.some(name => ctx.includes(name.toLowerCase()));
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
      let coLocatedEntities: string[] | undefined;
      if (entityNameChunkIds && mentions.length > 0) {
        const coLocated = new Set<string>();
        for (const m of mentions) {
          if (!m.chunk_id) continue;
          // Find other entity mentions in the same chunk
          const coRows = conn.prepare(`
            SELECT DISTINCT e.normalized_text
            FROM entity_mentions em
            JOIN entities e ON em.entity_id = e.id
            WHERE em.chunk_id = ?
              AND e.entity_type != 'date'
          `).all(m.chunk_id) as Array<{ normalized_text: string }>;
          for (const row of coRows) {
            // Only include entities that match the requested entity_names
            if (input.entity_names!.some(name =>
              row.normalized_text.toLowerCase().includes(name.toLowerCase()),
            )) {
              coLocated.add(row.normalized_text);
            }
          }
        }
        if (coLocated.size > 0) {
          coLocatedEntities = [...coLocated];
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
        ...(coLocatedEntities ? { co_located_entities: coLocatedEntities } : {}),
      });
    }

    // Sort chronologically
    timelineEntries.sort((a, b) => a.date_iso.localeCompare(b.date_iso));

    return formatResponse({
      total_entries: timelineEntries.length,
      date_format: input.date_format,
      document_filter: input.document_filter ?? null,
      entity_names: input.entity_names ?? null,
      entity_path_source: input.entity_path_source ?? null,
      entity_path_target: input.entity_path_target ?? null,
      ...(pathInfo ? { path_info: pathInfo } : {}),
      timeline: timelineEntries,
    });
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
        return formatResponse({ error: `Document not found: ${docId}` });
      }
      if (doc.status !== 'complete') {
        return formatResponse({
          error: `Document "${doc.file_name}" not OCR processed (status: ${doc.status}).`,
        });
      }

      const ocrResult = db.getOCRResultByDocumentId(docId);
      if (!ocrResult) {
        return formatResponse({ error: `No OCR result for document ${docId}` });
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
            vlmDescriptions.push(`[Image from ${doc.file_name}, page ${emb.page_number ?? '?'}]: ${emb.original_text}`);
          }
        }
      }
    }

    // Build the analysis prompt
    const docSections = docTexts.map(d =>
      `=== Document: ${d.name} (ID: ${d.id}) ===\n${d.text.slice(0, 8000)}`
    ).join('\n\n');

    const vlmSection = vlmDescriptions.length > 0
      ? `\n\n=== Image Descriptions ===\n${vlmDescriptions.join('\n')}`
      : '';

    // Include existing comparison data between these documents
    let comparisonSection = '';
    if (input.document_ids.length >= 2) {
      const docIds = input.document_ids;
      const comparisons = db.getConnection().prepare(
        `SELECT c.document_id_1, c.document_id_2, c.similarity_ratio, c.summary
         FROM comparisons c
         WHERE c.document_id_1 IN (${docIds.map(() => '?').join(',')})
           AND c.document_id_2 IN (${docIds.map(() => '?').join(',')})
         ORDER BY c.created_at DESC`
      ).all(...docIds, ...docIds) as Array<{
        document_id_1: string; document_id_2: string;
        similarity_ratio: number; summary: string;
      }>;
      if (comparisons.length > 0) {
        const compLines = comparisons.map(c =>
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
          clusterLines.push(`- ${docId}: ${label}${tag} (coherence: ${m.coherence_score ?? 'N/A'})`);
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
      const crossDocNodes = kgNodes.filter(n => n.document_count > 1);
      if (crossDocNodes.length > 0) {
        for (const node of crossDocNodes) {
          kgLines.push(`  - "${node.canonical_name}" (${node.entity_type}) appears in ${node.document_count} documents, ${node.edge_count} relationships`);
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
    const client = new GeminiClient();
    const startTime = Date.now();
    const response = await client.thinking(prompt, 'HIGH');
    const processingDurationMs = Date.now() - startTime;

    return formatResponse({
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
    });
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
      return formatResponse({ error: `Document not found: ${input.document_id}` });
    }

    // Create provenance record for VLM entity extraction
    const now = new Date().toISOString();
    const entityProvId = uuidv4();
    const entityHash = computeHash(JSON.stringify({ document_id: input.document_id, source: 'vlm' }));

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
      input_hash: computeHash(input.document_id),
      file_hash: doc.file_hash,
      processor: 'vlm-entity-extraction',
      processor_version: '1.0.0',
      processing_params: { source: 'vlm' },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: doc.provenance_id,
      parent_ids: JSON.stringify([doc.provenance_id]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION']),
    });

    const startTime = Date.now();
    const result = await extractEntitiesFromVLM(conn, input.document_id, entityProvId);
    const processingDurationMs = Date.now() - startTime;

    // Auto-merge into knowledge graph if one exists
    const kgMergeResult = await autoMergeIntoKnowledgeGraph(db, input.document_id);

    return formatResponse({
      document_id: input.document_id,
      entities_created: result.entities_created,
      descriptions_processed: result.descriptions_processed,
      source: 'vlm',
      provenance_id: entityProvId,
      processing_duration_ms: processingDurationMs,
      ...kgMergeResult,
    });
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
      return formatResponse({ error: `Document not found: ${input.document_id}` });
    }

    // Create provenance record for extraction entity mapping
    const now = new Date().toISOString();
    const entityProvId = uuidv4();
    const entityHash = computeHash(JSON.stringify({ document_id: input.document_id, source: 'extraction' }));

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
      input_hash: computeHash(input.document_id),
      file_hash: doc.file_hash,
      processor: 'extraction-entity-mapper',
      processor_version: '1.0.0',
      processing_params: { source: 'extraction' },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: doc.provenance_id,
      parent_ids: JSON.stringify([doc.provenance_id]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION']),
    });

    const startTime = Date.now();
    const result = mapExtractionEntitiesToDB(conn, input.document_id, entityProvId);
    const processingDurationMs = Date.now() - startTime;

    // Auto-merge into knowledge graph if one exists
    const kgMergeResult = await autoMergeIntoKnowledgeGraph(db, input.document_id);

    return formatResponse({
      document_id: input.document_id,
      entities_created: result.entities_created,
      extractions_processed: result.extractions_processed,
      source: 'extraction',
      provenance_id: entityProvId,
      processing_duration_ms: processingDurationMs,
      ...kgMergeResult,
    });
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const entityAnalysisTools: Record<string, ToolDefinition> = {
  'ocr_entity_extract': {
    description: 'Extract named entities (people, organizations, dates, amounts, case numbers, locations, statutes, exhibits) from an OCR-processed document using Gemini AI',
    inputSchema: EntityExtractInput.shape,
    handler: handleEntityExtract,
  },
  'ocr_entity_search': {
    description: 'Search for entities across documents by name, type, or document filter',
    inputSchema: EntitySearchInput.shape,
    handler: handleEntitySearch,
  },
  'ocr_timeline_build': {
    description: 'Build a chronological timeline from date entities extracted from documents. Optionally filter by entity_names (co-located entities) or entity_path_source/entity_path_target (KG relationship path filtering).',
    inputSchema: TimelineBuildInput.shape,
    handler: handleTimelineBuild,
  },
  'ocr_legal_witness_analysis': {
    description: 'Generate expert witness analysis of documents using Gemini AI thinking mode, including findings, timeline, conclusions, and reliability assessment',
    inputSchema: WitnessAnalysisInput.shape,
    handler: handleWitnessAnalysis,
  },
  'ocr_entity_extract_from_vlm': {
    description: 'Extract named entities from VLM (Vision-Language Model) image descriptions for a document. Requires images to have been processed with VLM first.',
    inputSchema: VLMEntityExtractInput.shape,
    handler: handleEntityExtractFromVLM,
  },
  'ocr_entity_extract_from_extractions': {
    description: 'Create entities from structured extraction fields (e.g., vendor_name -> organization, filing_date -> date). Requires ocr_extract_structured to have been run first.',
    inputSchema: ExtractionEntityExtractInput.shape,
    handler: handleEntityExtractFromExtractions,
  },
};

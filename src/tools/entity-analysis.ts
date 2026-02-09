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
});

const WitnessAnalysisInput = z.object({
  document_ids: z.array(z.string().min(1)).min(1).describe('Document IDs to analyze'),
  focus_area: z.string().optional().describe('Specific area to focus analysis on'),
  include_images: z.boolean().default(false).describe('Include VLM image descriptions in analysis'),
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize entity text based on type
 */
function normalizeEntity(rawText: string, entityType: string): string {
  const trimmed = rawText.trim();

  switch (entityType) {
    case 'date': {
      // Try to parse to ISO format
      const parsed = Date.parse(trimmed);
      if (!isNaN(parsed)) {
        const d = new Date(parsed);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      return trimmed.toLowerCase();
    }
    case 'amount': {
      // Strip $, commas, convert to number string
      const cleaned = trimmed.replace(/[$,]/g, '').trim();
      const num = parseFloat(cleaned);
      if (!isNaN(num)) {
        return String(num);
      }
      return trimmed.toLowerCase();
    }
    case 'case_number': {
      // Strip # prefix, lowercase
      return trimmed.replace(/^#/, '').toLowerCase().trim();
    }
    default:
      return trimmed.toLowerCase();
  }
}

/**
 * Chunk text into segments of approximately maxChars characters
 */
function splitTextIntoSegments(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    // Try to break at a sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      if (lastPeriod > start + maxChars * 0.5) {
        end = lastPeriod + 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI ENTITY EXTRACTION SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

const ENTITY_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          raw_text: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['type', 'raw_text', 'confidence'],
      },
    },
  },
  required: ['entities'],
};

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

    // Chunk OCR text into ~4000 char segments for Gemini
    const textChunks = splitTextIntoSegments(ocrResult.extracted_text, 4000);

    // Build type filter instruction
    const typeFilter = input.entity_types && input.entity_types.length > 0
      ? `Only extract entities of these types: ${input.entity_types.join(', ')}.`
      : `Extract all entity types: ${ENTITY_TYPES.join(', ')}.`;

    // Call Gemini for each chunk
    const client = new GeminiClient();
    const allRawEntities: Array<{ type: string; raw_text: string; confidence: number }> = [];
    const startTime = Date.now();

    for (const chunk of textChunks) {
      const prompt =
        `Extract all named entities from this text. Return a JSON object with an "entities" array. ` +
        `Each entity should have: type (one of: ${ENTITY_TYPES.join(', ')}), raw_text (exact text from document), ` +
        `and confidence (0-1 indicating certainty). ${typeFilter}\n\nText:\n${chunk}`;

      const response = await client.fast(prompt, ENTITY_SCHEMA);

      try {
        const parsed = JSON.parse(response.text) as { entities?: Array<{ type: string; raw_text: string; confidence: number }> };
        if (parsed.entities && Array.isArray(parsed.entities)) {
          for (const entity of parsed.entities) {
            // Validate entity type
            if (ENTITY_TYPES.includes(entity.type as EntityType)) {
              allRawEntities.push(entity);
            }
          }
        }
      } catch (parseError) {
        const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
        console.error(`[WARN] Failed to parse Gemini entity response: ${errMsg}`);
      }
    }

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
        text_chunks: textChunks.length,
      },
      processing_duration_ms: processingDurationMs,
      processing_quality_score: null,
      parent_id: ocrResult.provenance_id,
      parent_ids: JSON.stringify([doc.provenance_id, ocrResult.provenance_id]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'ENTITY_EXTRACTION']),
    });

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

      // Create a mention record for the entity
      const mentionId = uuidv4();
      insertEntityMention(conn, {
        id: mentionId,
        entity_id: entityId,
        document_id: doc.id,
        chunk_id: null,
        page_number: null,
        character_start: null,
        character_end: null,
        context_text: entityData.raw_text,
        created_at: now,
      });

      typeCounts[entityData.type] = (typeCounts[entityData.type] ?? 0) + 1;
      totalInserted++;
    }

    return formatResponse({
      document_id: doc.id,
      total_entities: totalInserted,
      total_raw_extracted: allRawEntities.length,
      deduplicated: allRawEntities.length - totalInserted,
      entities_by_type: typeCounts,
      provenance_id: entityProvId,
      processing_duration_ms: processingDurationMs,
      text_chunks_processed: textChunks.length,
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

    // Enrich with mentions and document info
    const results = entities.map(entity => {
      const mentions = getEntityMentions(conn, entity.id);
      const document = db.getDocument(entity.document_id);

      return {
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
 */
async function handleTimelineBuild(params: Record<string, unknown>) {
  try {
    const input = validateInput(TimelineBuildInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Query date entities, optionally filtered by documents
    const dateEntities = searchEntities(conn, '', {
      entityType: 'date',
      documentFilter: input.document_filter,
      limit: 500,
    });

    // Parse dates and build timeline entries
    const timelineEntries: Array<{
      date_iso: string;
      date_display: string;
      raw_text: string;
      confidence: number;
      document_id: string;
      document_name: string | null;
      context: string | null;
    }> = [];

    for (const entity of dateEntities) {
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
      const mentions = getEntityMentions(conn, entity.id);
      const contextText = mentions.length > 0 ? mentions[0].context_text : null;

      timelineEntries.push({
        date_iso: dateIso,
        date_display: dateDisplay,
        raw_text: entity.raw_text,
        confidence: entity.confidence,
        document_id: entity.document_id,
        document_name: document?.file_name ?? null,
        context: contextText,
      });
    }

    // Sort chronologically
    timelineEntries.sort((a, b) => a.date_iso.localeCompare(b.date_iso));

    return formatResponse({
      total_entries: timelineEntries.length,
      date_format: input.date_format,
      document_filter: input.document_filter ?? null,
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
      const docIdSet = input.document_ids;
      const comparisons = db.getConnection().prepare(
        `SELECT c.document_id_1, c.document_id_2, c.similarity_ratio, c.summary
         FROM comparisons c
         WHERE c.document_id_1 IN (${docIdSet.map(() => '?').join(',')})
           AND c.document_id_2 IN (${docIdSet.map(() => '?').join(',')})
         ORDER BY c.created_at DESC`
      ).all(...docIdSet, ...docIdSet) as Array<{
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
      `Documents:\n${docSections}${vlmSection}${comparisonSection}`;

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
    description: 'Build a chronological timeline from date entities extracted from documents',
    inputSchema: TimelineBuildInput.shape,
    handler: handleTimelineBuild,
  },
  'ocr_legal_witness_analysis': {
    description: 'Generate expert witness analysis of documents using Gemini AI thinking mode, including findings, timeline, conclusions, and reliability assessment',
    inputSchema: WitnessAnalysisInput.shape,
    handler: handleWitnessAnalysis,
  },
};

/**
 * Shared entity extraction helpers
 *
 * Functions and constants used by both entity-analysis.ts (manual extraction)
 * and ingestion.ts (auto-pipeline extraction). Extracted to avoid duplication.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module utils/entity-extraction-helpers
 */

import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { GeminiClient } from '../services/gemini/client.js';
import { ENTITY_TYPES, type EntityType } from '../models/entity.js';
import type { Chunk } from '../models/chunk.js';
import {
  insertEntity,
  insertEntityMention,
} from '../services/storage/database/entity-operations.js';
import { getChunksByDocumentId } from '../services/storage/database/chunk-operations.js';
import { RELATIONSHIP_TYPES, type RelationshipType, computeImportanceScore } from '../models/knowledge-graph.js';
import {
  insertKnowledgeNode,
  insertKnowledgeEdge,
  insertNodeEntityLink,
} from '../services/storage/database/knowledge-graph-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Output token limit for entity extraction.
 * 50K char segments produce ~200-400 entities = ~5-10K tokens of JSON.
 * 16K is generous; 65K caused API throttling (reserved capacity). */
export const ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS = 16_384;

/**
 * JSON schema for Gemini entity extraction response.
 * Using responseMimeType: 'application/json' with a schema guarantees
 * clean JSON output — no markdown code blocks, no parsing failures.
 * Same pattern as RERANK_SCHEMA in reranker.ts.
 */
export const ENTITY_EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    entities: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          type: { type: 'string' as const },
          raw_text: { type: 'string' as const },
          confidence: { type: 'number' as const },
        },
        required: ['type', 'raw_text', 'confidence'],
      },
    },
  },
  required: ['entities'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// JOINT EXTRACTION CONSTANTS & SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum chars before falling back to 2-chunk extraction (750K ~ 187K tokens, well within 1M limit) */
export const MAX_SINGLE_CALL_CHARS = 750_000;

/** Output token budget for joint extraction */
export const JOINT_EXTRACTION_MAX_OUTPUT_TOKENS = 65_536;

/** JSON response schema for joint entity + relationship extraction */
export const JOINT_EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    entities: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const },
          canonical_name: { type: 'string' as const },
          type: { type: 'string' as const },
          aliases: { type: 'array' as const, items: { type: 'string' as const } },
          confidence: { type: 'number' as const },
        },
        required: ['id', 'canonical_name', 'type', 'confidence'] as const,
      },
    },
    relationships: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          source_id: { type: 'string' as const },
          target_id: { type: 'string' as const },
          relationship_type: { type: 'string' as const },
          confidence: { type: 'number' as const },
          evidence: { type: 'string' as const },
          temporal: { type: 'string' as const },
        },
        required: ['source_id', 'target_id', 'relationship_type', 'confidence'] as const,
      },
    },
  },
  required: ['entities', 'relationships'] as const,
};

/** Entity-only schema for 2-pass fallback (pass 1) */
const ENTITY_ONLY_SCHEMA = {
  type: 'object' as const,
  properties: {
    entities: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const },
          canonical_name: { type: 'string' as const },
          type: { type: 'string' as const },
          aliases: { type: 'array' as const, items: { type: 'string' as const } },
          confidence: { type: 'number' as const },
        },
        required: ['id', 'canonical_name', 'type', 'confidence'] as const,
      },
    },
  },
  required: ['entities'] as const,
};

/** Relationship-only schema for 2-pass fallback (pass 2) */
const RELATIONSHIP_ONLY_SCHEMA = {
  type: 'object' as const,
  properties: {
    relationships: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          source_id: { type: 'string' as const },
          target_id: { type: 'string' as const },
          relationship_type: { type: 'string' as const },
          confidence: { type: 'number' as const },
          evidence: { type: 'string' as const },
          temporal: { type: 'string' as const },
        },
        required: ['source_id', 'target_id', 'relationship_type', 'confidence'] as const,
      },
    },
  },
  required: ['relationships'] as const,
};

/** Result type for joint extraction */
export interface JointExtractionResult {
  entities: Array<{
    id: string;
    canonical_name: string;
    type: string;
    aliases?: string[];
    confidence: number;
  }>;
  relationships: Array<{
    source_id: string;
    target_id: string;
    relationship_type: string;
    confidence: number;
    evidence?: string;
    temporal?: string;
  }>;
  token_usage: { inputTokens: number; outputTokens: number };
  processing_time_ms: number;
  was_chunked: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize entity text based on type
 */
export function normalizeEntity(rawText: string, entityType: string): string {
  const trimmed = rawText.trim();

  switch (entityType) {
    case 'date': {
      const parsed = Date.parse(trimmed);
      if (!isNaN(parsed)) {
        const d = new Date(parsed);
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      return trimmed.toLowerCase();
    }
    case 'amount': {
      const cleaned = trimmed.replace(/[$,]/g, '').trim();
      const num = parseFloat(cleaned);
      if (!isNaN(num)) {
        return String(num);
      }
      return trimmed.toLowerCase();
    }
    case 'case_number': {
      return trimmed.replace(/^#/, '').toLowerCase().trim();
    }
    case 'medication':
    case 'diagnosis':
    case 'medical_device': {
      return trimmed.toLowerCase().replace(/\s+/g, ' ').trim();
    }
    default:
      return trimmed.toLowerCase();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI ENTITY EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a Gemini entity extraction response, filtering to valid entity types.
 * Handles truncated JSON by recovering valid entities from partial output.
 */
function parseEntityResponse(
  responseText: string
): Array<{ type: string; raw_text: string; confidence: number }> {
  // Try clean parse first
  try {
    const parsed = JSON.parse(responseText) as {
      entities?: Array<{ type: string; raw_text: string; confidence: number }>;
    };
    if (parsed.entities && Array.isArray(parsed.entities)) {
      return parsed.entities.filter((entity) => ENTITY_TYPES.includes(entity.type as EntityType));
    }
    return [];
  } catch (error) {
    console.error(
      '[EntityExtractionHelpers] JSON parse failed, attempting partial entity recovery:',
      error instanceof Error ? error.message : String(error)
    );
    // JSON truncated or malformed - recover partial entities via regex
    return recoverPartialEntities(responseText);
  }
}

/**
 * Recover valid entities from truncated/malformed JSON output.
 * Extracts complete entity objects using regex matching.
 */
function recoverPartialEntities(
  text: string
): Array<{ type: string; raw_text: string; confidence: number }> {
  const entities: Array<{ type: string; raw_text: string; confidence: number }> = [];
  // Match complete entity objects: {"type":"...","raw_text":"...","confidence":N}
  const pattern =
    /\{\s*"type"\s*:\s*"([^"]+)"\s*,\s*"raw_text"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*,\s*"confidence"\s*:\s*([\d.]+)\s*\}/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, type, rawText, conf] = match;
    if (ENTITY_TYPES.includes(type as EntityType)) {
      entities.push({
        type,
        raw_text: rawText.replace(/\\"/g, '"').replace(/\\n/g, '\n'),
        confidence: parseFloat(conf),
      });
    }
  }
  if (entities.length > 0) {
    console.error(`[INFO] Recovered ${entities.length} entities from truncated JSON`);
  }
  return entities;
}

/** Maximum character budget for KG entity hints in the Gemini prompt */
const KG_HINT_MAX_CHARS = 5000;

/** Maximum number of KG nodes to query for hints */
const KG_HINT_MAX_NODES = 200;

/** Entity types where aliases are valuable for OCR variant recognition */
const ALIAS_WORTHY_TYPES = new Set([
  'person',
  'organization',
  'medication',
  'diagnosis',
  'medical_device',
]);

/** Display labels for entity types in grouped hint output */
const TYPE_LABELS: Record<string, string> = {
  person: 'PERSONS',
  organization: 'ORGANIZATIONS',
  date: 'DATES',
  amount: 'AMOUNTS',
  case_number: 'CASE_NUMBERS',
  location: 'LOCATIONS',
  statute: 'STATUTES',
  exhibit: 'EXHIBITS',
  medication: 'MEDICATIONS',
  diagnosis: 'DIAGNOSES',
  medical_device: 'MEDICAL_DEVICES',
};

/** Row shape returned by the KG hints query */
interface KGHintRow {
  canonical_name: string;
  entity_type: string;
  aliases: string | null;
  mention_count: number;
}

/**
 * Build a compact, grouped hint string from Knowledge Graph nodes.
 *
 * Queries top KG nodes (by mention_count DESC), groups by entity_type,
 * includes aliases for types where OCR variant recognition matters
 * (persons, organizations, medications, diagnoses, medical_devices),
 * and caps total output at KG_HINT_MAX_CHARS.
 *
 * Format example:
 *   Known entities from other documents:
 *   PERSONS: John Smith (aka J. Smith, Mr. Smith), Jane Doe
 *   ORGANIZATIONS: Acme Corp (aka Acme Corporation, ACME)
 *   DATES: 2024-03-15, 2024-01-01
 *
 * @param conn - Database connection
 * @returns Formatted hint string, or undefined if no KG exists or is empty
 */
export function buildKGEntityHints(conn: Database.Database): string | undefined {
  let hintRows: KGHintRow[];
  try {
    hintRows = conn
      .prepare(
        `SELECT canonical_name, entity_type, aliases, mention_count
       FROM knowledge_nodes
       ORDER BY mention_count DESC
       LIMIT ?`
      )
      .all(KG_HINT_MAX_NODES) as KGHintRow[];
  } catch (err) {
    console.error(
      `[entity-extraction-helpers] KG hints query failed: ${err instanceof Error ? err.message : String(err)}`
    );
    // KG tables may not exist yet
    return undefined;
  }

  if (hintRows.length === 0) {
    return undefined;
  }

  // Group rows by entity_type, preserving mention_count ordering within each group
  const grouped = new Map<string, KGHintRow[]>();
  for (const row of hintRows) {
    const existing = grouped.get(row.entity_type);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.entity_type, [row]);
    }
  }

  // Build the hint string with character budget tracking
  const header = 'Known entities from other documents:';
  let result = header;
  let currentLength = result.length;

  // Process types in a stable order: types with most total mentions first
  const sortedTypes = [...grouped.entries()].sort((a, b) => {
    const totalA = a[1].reduce((sum, r) => sum + r.mention_count, 0);
    const totalB = b[1].reduce((sum, r) => sum + r.mention_count, 0);
    return totalB - totalA;
  });

  for (const [entityType, rows] of sortedTypes) {
    const label = TYPE_LABELS[entityType] ?? entityType.toUpperCase();
    const linePrefix = `\n${label}: `;

    // Check if we have budget for at least the prefix + one entity
    if (currentLength + linePrefix.length + 10 > KG_HINT_MAX_CHARS) {
      break;
    }

    const includeAliases = ALIAS_WORTHY_TYPES.has(entityType);
    let lineContent = '';

    for (const row of rows) {
      let entry = row.canonical_name;

      // Add aliases for types where variant recognition matters
      if (includeAliases && row.aliases) {
        try {
          const aliasArr = JSON.parse(row.aliases) as string[];
          if (Array.isArray(aliasArr) && aliasArr.length > 0) {
            // Filter out aliases identical to canonical_name (case-insensitive)
            const canonical = row.canonical_name.toLowerCase();
            const uniqueAliases = aliasArr.filter(
              (a) => typeof a === 'string' && a.toLowerCase() !== canonical
            );
            if (uniqueAliases.length > 0) {
              entry += ` (aka ${uniqueAliases.join(', ')})`;
            }
          }
        } catch (error) {
          console.error(
            `[EntityExtractionHelpers] Failed to parse aliases JSON for KG hint: ${String(error)}`
          );
        }
      }

      // Check budget before adding this entry
      const separator = lineContent.length > 0 ? ', ' : '';
      const candidate = lineContent + separator + entry;
      if (currentLength + linePrefix.length + candidate.length > KG_HINT_MAX_CHARS) {
        break;
      }

      lineContent = candidate;
    }

    if (lineContent.length > 0) {
      const line = linePrefix + lineContent;
      result += line;
      currentLength = result.length;
    }
  }

  // Only return if we actually added entities beyond the header
  if (result.length <= header.length) {
    return undefined;
  }

  console.error(
    `[INFO] buildKGEntityHints: ${hintRows.length} nodes, ${result.length} chars hint string`
  );

  return result;
}

/**
 * Make a single Gemini API call to extract entities from text.
 *
 * Uses fast() with ENTITY_EXTRACTION_SCHEMA for guaranteed clean JSON output.
 * If the primary model fails after all retries, the error is propagated.
 */
export async function callGeminiForEntities(
  client: GeminiClient,
  text: string,
  typeFilter: string,
  entityHints?: string
): Promise<Array<{ type: string; raw_text: string; confidence: number }>> {
  const hintsSection = entityHints ? `\n${entityHints}\n\n` : '';
  const prompt =
    `Extract named entities from the following text. ${typeFilter}\n` +
    `IMPORTANT: Use 'medication' for drug names, prescriptions, and pharmaceutical products. ` +
    `Use 'diagnosis' for medical conditions, diseases, symptoms, and clinical diagnoses. ` +
    `Use 'medical_device' for medical devices and equipment (e.g., G-tube, PEG tube, catheter, ventilator, pacemaker, insulin pump, CPAP machine). ` +
    `Do NOT classify medications, diagnoses, or medical devices as 'other'.\n` +
    hintsSection +
    `${text}`;

  // Primary attempt - the robust parseEntityResponse recovers entities
  // from truncated JSON, so a single attempt is usually sufficient.
  try {
    const response = await client.fast(prompt, ENTITY_EXTRACTION_SCHEMA, {
      maxOutputTokens: ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS,
    });
    return parseEntityResponse(response.text);
  } catch (primaryError) {
    const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    console.error(`[WARN] Primary entity extraction failed: ${errMsg}`);
    throw new Error(`Entity extraction failed: ${errMsg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOINT ENTITY + RELATIONSHIP EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the joint extraction prompt for combined entity + relationship extraction.
 */
function buildJointExtractionPrompt(ocrText: string, entityHints?: string): string {
  const hintsSection = entityHints
    ? `\n## Known Entities (from other documents in this corpus)\n${entityHints}\n`
    : '';

  return (
    `You are an expert entity and relationship extractor for document analysis.\n` +
    `Extract ALL entities and their relationships from the provided text.\n\n` +
    `## Entity Types\n` +
    `person, organization, date, amount, case_number, location, statute,\n` +
    `exhibit, medication, diagnosis, medical_device\n\n` +
    `## Relationship Types\n` +
    `treated_with, diagnosed_with, administered_via, managed_by, interacts_with,\n` +
    `works_at, located_in, filed_in, party_to, represents, cites, references,\n` +
    `occurred_at, precedes, related_to, supervised_by, prescribed_by, admitted_to,\n` +
    `filed_by, contraindicated_with\n\n` +
    `## Coreference Resolution\n` +
    `If the same entity appears with different names, abbreviations, or pronouns,\n` +
    `group them under ONE canonical entry with the MOST COMPLETE name form.\n` +
    `List ALL name variants as aliases.\n` +
    `Example: "Dr. Robert Smith" / "Dr. Smith" / "R. Smith"\n` +
    `→ canonical: "Dr. Robert Smith", aliases: ["Dr. Smith", "R. Smith"]\n\n` +
    `## Rules\n` +
    `1. Extract EVERY named entity with its type and confidence (0.0-1.0)\n` +
    `2. Normalize dates to YYYY-MM-DD format\n` +
    `3. Do NOT extract noise: bare numbers, time patterns (HH:MM), phone numbers,\n` +
    `   SSN patterns (XXX-XX-XXXX), blood pressure readings (120/80)\n` +
    `4. Identify ALL relationships between extracted entities\n` +
    `5. Include brief evidence quote (max 15 words) for each relationship\n` +
    `6. Use entity IDs (e1, e2, ...) to reference entities in relationships\n` +
    `7. Medications with different salt forms are DIFFERENT entities\n` +
    `   (Metoprolol Tartrate ≠ Metoprolol Succinate)\n` +
    `8. Only use relationship types from the list above\n` +
    hintsSection +
    `\n## Document Text:\n${ocrText}`
  );
}

/**
 * Split text into 2 roughly equal chunks at a sentence boundary, with overlap.
 * Used for documents exceeding MAX_SINGLE_CALL_CHARS.
 */
function splitIntoTwoChunks(text: string, overlapChars: number = 20_000): string[] {
  const midpoint = Math.floor(text.length / 2);
  // Search for a sentence boundary near the midpoint
  let splitAt = text.lastIndexOf('. ', midpoint + 5000);
  if (splitAt < midpoint - 50_000 || splitAt < 0) {
    splitAt = text.lastIndexOf('.', midpoint + 5000);
  }
  if (splitAt < midpoint - 50_000 || splitAt < 0) {
    splitAt = midpoint; // Fallback: split at midpoint
  } else {
    splitAt += 1; // Include the period
  }

  const chunk1End = splitAt;
  const chunk2Start = Math.max(0, splitAt - overlapChars);

  return [text.slice(0, chunk1End), text.slice(chunk2Start)];
}

/**
 * Recover valid entities and relationships from truncated/malformed JSON output.
 * Uses regex to extract complete entity and relationship objects.
 */
function recoverPartialJointExtraction(text: string): JointExtractionResult {
  const entities: JointExtractionResult['entities'] = [];
  const relationships: JointExtractionResult['relationships'] = [];

  // Find balanced JSON objects by tracking brace depth.
  // This handles arbitrary field order from the model.
  const objects: string[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 1) objStart = i; // top-level array items start at depth 1
      if (depth === 2) objStart = i; // entities/relationships array items at depth 2
      depth++;
    } else if (ch === '}') {
      depth--;
      if ((depth === 1 || depth === 2) && objStart >= 0) {
        objects.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
    }
  }

  // Try parsing each complete object as entity or relationship
  for (const objStr of objects) {
    try {
      const obj = JSON.parse(objStr);
      if (obj.id && obj.canonical_name && obj.type && typeof obj.confidence === 'number') {
        const normalizedType = String(obj.type).toLowerCase();
        if (ENTITY_TYPES.includes(normalizedType as EntityType)) {
          entities.push({
            id: obj.id,
            canonical_name: obj.canonical_name,
            type: normalizedType,
            aliases: Array.isArray(obj.aliases) ? obj.aliases : undefined,
            confidence: obj.confidence,
          });
        }
      } else if (obj.source_id && obj.target_id && obj.relationship_type) {
        relationships.push({
          source_id: obj.source_id,
          target_id: obj.target_id,
          relationship_type: String(obj.relationship_type).toLowerCase(),
          confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
          evidence: obj.evidence,
          temporal: obj.temporal,
        });
      }
    } catch {
      // Skip malformed objects (e.g. truncated at end)
    }
  }

  if (entities.length > 0 || relationships.length > 0) {
    console.error(
      `[INFO] Recovered ${entities.length} entities and ${relationships.length} relationships from truncated JSON`
    );
  }

  return {
    entities,
    relationships,
    token_usage: { inputTokens: 0, outputTokens: 0 },
    processing_time_ms: 0,
    was_chunked: false,
  };
}

/**
 * Two-pass extraction fallback: entities first, then relationships.
 * Used when single-call extraction produces suspicious premature stop.
 */
async function twoPassExtraction(
  client: GeminiClient,
  ocrText: string,
  entityHints?: string
): Promise<JointExtractionResult> {
  const startTime = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Pass 1: Extract entities only
  const hintsSection = entityHints
    ? `\n## Known Entities (from other documents)\n${entityHints}\n`
    : '';

  const entityPrompt =
    `You are an expert entity extractor for document analysis.\n` +
    `Extract ALL entities from the provided text.\n\n` +
    `## Entity Types\n` +
    `person, organization, date, amount, case_number, location, statute,\n` +
    `exhibit, medication, diagnosis, medical_device\n\n` +
    `## Coreference Resolution\n` +
    `Group same-entity variants under ONE canonical entry with the MOST COMPLETE name.\n` +
    `List ALL name variants as aliases.\n\n` +
    `## Rules\n` +
    `1. Extract EVERY named entity with its type and confidence (0.0-1.0)\n` +
    `2. Normalize dates to YYYY-MM-DD format\n` +
    `3. Do NOT extract noise: bare numbers, time patterns, phone numbers, SSNs, blood pressure\n` +
    `4. Use sequential IDs (e1, e2, ...)\n` +
    `5. Medications with different salt forms are DIFFERENT entities\n` +
    hintsSection +
    `\n## Document Text:\n${ocrText}`;

  let entities: JointExtractionResult['entities'] = [];
  try {
    const entityResponse = await client.fast(entityPrompt, ENTITY_ONLY_SCHEMA, {
      maxOutputTokens: JOINT_EXTRACTION_MAX_OUTPUT_TOKENS,
    });
    totalInputTokens += entityResponse.usage.inputTokens;
    totalOutputTokens += entityResponse.usage.outputTokens;

    try {
      const parsed = JSON.parse(entityResponse.text) as { entities?: JointExtractionResult['entities'] };
      entities = parsed.entities ?? [];
    } catch {
      const recovered = recoverPartialJointExtraction(entityResponse.text);
      entities = recovered.entities;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WARN] Two-pass entity extraction (pass 1) failed: ${errMsg}`);
    throw new Error(`Two-pass entity extraction failed on pass 1: ${errMsg}`);
  }

  // Filter entities to valid types
  entities = entities.filter((e) => ENTITY_TYPES.includes(e.type as EntityType));

  // Pass 2: Extract relationships given entity context
  let relationships: JointExtractionResult['relationships'] = [];
  if (entities.length > 0) {
    const entityListJson = JSON.stringify(
      entities.map((e) => ({ id: e.id, canonical_name: e.canonical_name, type: e.type }))
    );

    const relPrompt =
      `You are an expert relationship extractor for document analysis.\n` +
      `Given the following entities extracted from the document, identify ALL relationships between them.\n\n` +
      `## Extracted Entities\n${entityListJson}\n\n` +
      `## Relationship Types\n` +
      `treated_with, diagnosed_with, administered_via, managed_by, interacts_with,\n` +
      `works_at, located_in, filed_in, party_to, represents, cites, references,\n` +
      `occurred_at, precedes, related_to, supervised_by, prescribed_by, admitted_to,\n` +
      `filed_by, contraindicated_with\n\n` +
      `## Rules\n` +
      `1. Use entity IDs from the list above to reference source and target\n` +
      `2. Include brief evidence quote (max 15 words) for each relationship\n` +
      `3. Only use relationship types from the list above\n` +
      `4. Set confidence 0.0-1.0 based on evidence strength\n` +
      `\n## Document Text:\n${ocrText}`;

    try {
      const relResponse = await client.fast(relPrompt, RELATIONSHIP_ONLY_SCHEMA, {
        maxOutputTokens: JOINT_EXTRACTION_MAX_OUTPUT_TOKENS,
      });
      totalInputTokens += relResponse.usage.inputTokens;
      totalOutputTokens += relResponse.usage.outputTokens;

      try {
        const parsed = JSON.parse(relResponse.text) as { relationships?: JointExtractionResult['relationships'] };
        relationships = parsed.relationships ?? [];
      } catch {
        const recovered = recoverPartialJointExtraction(relResponse.text);
        relationships = recovered.relationships;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[WARN] Two-pass relationship extraction (pass 2) failed: ${errMsg}`);
      // Relationships are best-effort; return entities without relationships
    }
  }

  return {
    entities,
    relationships,
    token_usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    processing_time_ms: Date.now() - startTime,
    was_chunked: true,
  };
}

/**
 * Extract entities AND relationships in a single Gemini call (or 2 chunks for large docs).
 *
 * For documents <= MAX_SINGLE_CALL_CHARS: single call with JOINT_EXTRACTION_SCHEMA.
 * For larger documents: split into 2 overlapping chunks, call twice, merge results.
 * Falls back to twoPassExtraction() if suspicious premature stop is detected.
 */
export async function extractEntitiesAndRelationships(
  client: GeminiClient,
  ocrText: string,
  entityHints?: string
): Promise<JointExtractionResult> {
  const startTime = Date.now();

  if (ocrText.length <= MAX_SINGLE_CALL_CHARS) {
    // Single-call path
    const prompt = buildJointExtractionPrompt(ocrText, entityHints);

    // Always use max output tokens — thinking tokens share the output budget in
    // gemini-3-flash-preview, so lower values cause truncated responses.
    console.error(
      `[INFO] Joint extraction: ${ocrText.length} chars, maxOutputTokens=${JOINT_EXTRACTION_MAX_OUTPUT_TOKENS}`
    );

    try {
      const response = await client.fast(prompt, JOINT_EXTRACTION_SCHEMA, {
        maxOutputTokens: JOINT_EXTRACTION_MAX_OUTPUT_TOKENS,
      });

      // Check for suspicious premature stop (very little output for large input)
      if (response.usage.outputTokens < 2000 && ocrText.length > 50_000) {
        console.error(
          `[WARN] Suspicious premature stop: ${response.usage.outputTokens} output tokens ` +
            `for ${ocrText.length} char input. Falling back to two-pass extraction.`
        );
        return twoPassExtraction(client, ocrText, entityHints);
      }

      let result: JointExtractionResult;

      // Clean response text: strip markdown code fences if model wraps JSON
      let responseText = response.text;
      if (responseText.startsWith('```')) {
        responseText = responseText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      responseText = responseText.trim();

      try {
        const parsed = JSON.parse(responseText) as {
          entities?: JointExtractionResult['entities'];
          relationships?: JointExtractionResult['relationships'];
        };
        result = {
          entities: parsed.entities ?? [],
          relationships: parsed.relationships ?? [],
          token_usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          },
          processing_time_ms: Date.now() - startTime,
          was_chunked: false,
        };
      } catch (parseErr) {
        console.error(
          `[WARN] Joint extraction JSON parse failed: ${parseErr instanceof Error ? parseErr.message : parseErr}. ` +
          `Response length=${responseText.length}, attempting recovery`
        );
        result = recoverPartialJointExtraction(responseText);
        result.token_usage = {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        };
        result.processing_time_ms = Date.now() - startTime;
      }

      // Normalize entity types to lowercase (model may return "Person" instead of "person")
      for (const e of result.entities) {
        e.type = e.type.toLowerCase();
      }

      // Filter entities to valid types
      result.entities = result.entities.filter((e) =>
        ENTITY_TYPES.includes(e.type as EntityType)
      );

      // Apply noise filter (map canonical_name to raw_text for compatibility)
      const noiseInput = result.entities.map((e) => ({
        type: e.type,
        raw_text: e.canonical_name,
        confidence: e.confidence,
      }));
      const filtered = filterNoiseEntities(noiseInput);
      const filteredNames = new Set(filtered.map((f) => f.raw_text));
      result.entities = result.entities.filter((e) => filteredNames.has(e.canonical_name));

      // Build valid entity ID set
      const validEntityIds = new Set(result.entities.map((e) => e.id));

      // Normalize relationship types to lowercase (model may return "LOCATED_AT" etc.)
      for (const rel of result.relationships) {
        rel.relationship_type = rel.relationship_type.toLowerCase();
      }

      // Validate relationships: reference valid entity IDs and valid types
      const validRelTypes = new Set<string>(RELATIONSHIP_TYPES);
      result.relationships = result.relationships.filter((rel) => {
        if (!validEntityIds.has(rel.source_id)) {
          console.error(
            `[WARN] Dropping relationship: invalid source_id "${rel.source_id}"`
          );
          return false;
        }
        if (!validEntityIds.has(rel.target_id)) {
          console.error(
            `[WARN] Dropping relationship: invalid target_id "${rel.target_id}"`
          );
          return false;
        }
        if (!validRelTypes.has(rel.relationship_type)) {
          console.error(
            `[WARN] Dropping relationship: invalid type "${rel.relationship_type}"`
          );
          return false;
        }
        return true;
      });

      console.error(
        `[INFO] Joint extraction complete: ${result.entities.length} entities, ` +
          `${result.relationships.length} relationships, ${result.processing_time_ms}ms`
      );

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[ERROR] Single-call joint extraction failed: ${errMsg}`
      );
      throw new Error(`Entity extraction failed: ${errMsg}`);
    }
  } else {
    // Large document: split into 2 overlapping chunks
    console.error(
      `[INFO] Document exceeds MAX_SINGLE_CALL_CHARS (${ocrText.length} > ${MAX_SINGLE_CALL_CHARS}), ` +
        `splitting into 2 chunks`
    );
    const chunks = splitIntoTwoChunks(ocrText);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const chunkResults: JointExtractionResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPrompt = buildJointExtractionPrompt(chunks[i], entityHints);
      try {
        const response = await client.fast(chunkPrompt, JOINT_EXTRACTION_SCHEMA, {
          maxOutputTokens: JOINT_EXTRACTION_MAX_OUTPUT_TOKENS,
        });
        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;

        let parsed: { entities?: JointExtractionResult['entities']; relationships?: JointExtractionResult['relationships'] };
        try {
          parsed = JSON.parse(response.text);
        } catch {
          const recovered = recoverPartialJointExtraction(response.text);
          parsed = { entities: recovered.entities, relationships: recovered.relationships };
        }

        chunkResults.push({
          entities: parsed.entities ?? [],
          relationships: parsed.relationships ?? [],
          token_usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
          processing_time_ms: 0,
          was_chunked: true,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[WARN] Chunk ${i + 1} extraction failed: ${errMsg}`);
        // Continue with remaining chunks
      }
    }

    // Merge chunk results, deduplicating entities by canonical_name + type
    const entityMap = new Map<string, JointExtractionResult['entities'][0]>();
    const entityIdRemap = new Map<string, string>(); // old chunk ID -> merged ID
    let nextId = 1;

    for (const chunkResult of chunkResults) {
      for (const entity of chunkResult.entities) {
        if (!ENTITY_TYPES.includes(entity.type as EntityType)) continue;
        const key = `${entity.type}::${entity.canonical_name.toLowerCase()}`;
        if (!entityMap.has(key)) {
          const newId = `e${nextId++}`;
          entityIdRemap.set(entity.id, newId);
          entityMap.set(key, { ...entity, id: newId });
        } else {
          const existing = entityMap.get(key)!;
          entityIdRemap.set(entity.id, existing.id);
          // Merge aliases
          if (entity.aliases) {
            const existingAliases = new Set(existing.aliases ?? []);
            for (const alias of entity.aliases) {
              existingAliases.add(alias);
            }
            existing.aliases = [...existingAliases];
          }
          // Keep higher confidence
          if (entity.confidence > existing.confidence) {
            existing.confidence = entity.confidence;
          }
        }
      }
    }

    // Merge relationships, remapping entity IDs and deduplicating
    const relSet = new Set<string>();
    const mergedRelationships: JointExtractionResult['relationships'] = [];
    const validRelTypes = new Set<string>(RELATIONSHIP_TYPES);
    const mergedEntityIds = new Set([...entityMap.values()].map((e) => e.id));

    for (const chunkResult of chunkResults) {
      for (const rel of chunkResult.relationships) {
        const mappedSource = entityIdRemap.get(rel.source_id) ?? rel.source_id;
        const mappedTarget = entityIdRemap.get(rel.target_id) ?? rel.target_id;
        const relKey = `${mappedSource}::${mappedTarget}::${rel.relationship_type}`;

        if (relSet.has(relKey)) continue;
        if (!mergedEntityIds.has(mappedSource)) continue;
        if (!mergedEntityIds.has(mappedTarget)) continue;
        if (!validRelTypes.has(rel.relationship_type)) continue;

        relSet.add(relKey);
        mergedRelationships.push({
          ...rel,
          source_id: mappedSource,
          target_id: mappedTarget,
        });
      }
    }

    // Apply noise filter
    const mergedEntities = [...entityMap.values()];
    const noiseInput = mergedEntities.map((e) => ({
      type: e.type,
      raw_text: e.canonical_name,
      confidence: e.confidence,
    }));
    const filtered = filterNoiseEntities(noiseInput);
    const filteredNames = new Set(filtered.map((f) => f.raw_text));
    const finalEntities = mergedEntities.filter((e) => filteredNames.has(e.canonical_name));

    // Re-validate relationships after noise filtering
    const finalEntityIds = new Set(finalEntities.map((e) => e.id));
    const finalRelationships = mergedRelationships.filter(
      (r) => finalEntityIds.has(r.source_id) && finalEntityIds.has(r.target_id)
    );

    const result: JointExtractionResult = {
      entities: finalEntities,
      relationships: finalRelationships,
      token_usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      processing_time_ms: Date.now() - startTime,
      was_chunked: true,
    };

    console.error(
      `[INFO] Chunked joint extraction complete: ${result.entities.length} entities, ` +
        `${result.relationships.length} relationships, ${result.processing_time_ms}ms (2 chunks)`
    );

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOISE FILTERING
// ═══════════════════════════════════════════════════════════════════════════════

/** Allowlist of valid short entities (2 chars or less) that should NOT be filtered */
const ALLOWED_SHORT_ENTITIES = new Set([
  // Medical
  'iv', 'ad', 'pt', 'or', 'bp', 'hr', 'rr', 'o2', 'gi', 'gu',
  'ct', 'mr',
  // Legal
  'jd', 'pc', 'pa',
]);

/** Time pattern: HH:MM (24h or 12h) */
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/** Bare number: digits with optional decimal, no currency/unit */
const BARE_NUMBER_PATTERN = /^\d+\.?\d*$/;

/** Blood pressure: digits/digits with optional spaces around slash */
const BP_PATTERN = /^\d+\s*\/\s*\d+$/;

/** SSN: NNN-NN-NNNN */
const SSN_PATTERN = /^\d{3}-\d{2}-\d{4}$/;

/** Phone: (NNN) NNN-NNNN or NNN-NNN-NNNN or NNN.NNN.NNNN or NNNNNNNNNN */
const PHONE_PATTERN = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;

/**
 * ICD-10 code pattern: letter + digits, optionally with a dot (e.g., I48.91, J96.10, I69.398)
 * ICD-10 chapters: A-T = diseases/injuries, V-Y = external causes, Z = factors
 */
const ICD10_PATTERN = /^[A-Z]\d{2,}\.?\d*$/i;

/**
 * Filter noise entities from Gemini extraction output.
 *
 * Removes common false positives: bare numbers misclassified as amounts,
 * time patterns, blood pressure readings, SSNs classified as case numbers,
 * phone numbers classified as amounts, and very short strings.
 *
 * @param entities - Raw entity array from Gemini extraction
 * @returns Filtered entity array with noise removed
 */
export function filterNoiseEntities(
  entities: Array<{ type: string; raw_text: string; confidence: number }>
): Array<{ type: string; raw_text: string; confidence: number }> {
  const filtered: Array<{ type: string; raw_text: string; confidence: number }> = [];

  for (const entity of entities) {
    const raw = entity.raw_text.trim();

    // Type-aware short entity handling
    // Medical/legal abbreviations like "IV", "AD", "PT", "OR" are valid
    if (raw.length <= 2) {
      const isAllowedShort = ALLOWED_SHORT_ENTITIES.has(raw.toLowerCase());
      const isMedicalType = ['medication', 'medical_device', 'diagnosis'].includes(entity.type);

      if (!isAllowedShort && !isMedicalType) {
        console.error(`[NOISE] Filtered "${raw}" (${entity.type}): too short (length ${raw.length}), not in allowlist`);
        continue;
      }
      console.error(`[KEEP] Short entity "${raw}" (${entity.type}): allowed by type-aware filter`);
    }

    // Reject time patterns (any type) - "14:00", "8:30", "19:00"
    if (TIME_PATTERN.test(raw)) {
      console.error(`[NOISE] Filtered "${raw}" (${entity.type}): time pattern`);
      continue;
    }

    // Reject SSN patterns (any type - Gemini may classify as case_number, other, amount)
    if (SSN_PATTERN.test(raw)) {
      console.error(
        `[NOISE] Filtered "${raw}" (${entity.type}): SSN pattern detected — filtered for privacy`
      );
      continue;
    }

    // Reject phone numbers (any type - Gemini may classify as amount, other, case_number)
    if (PHONE_PATTERN.test(raw)) {
      console.error(`[NOISE] Filtered "${raw}" (${entity.type}): phone number`);
      continue;
    }

    // Reject blood pressure readings (any type)
    if (BP_PATTERN.test(raw)) {
      console.error(`[NOISE] Filtered "${raw}" (${entity.type}): blood pressure reading`);
      continue;
    }

    // Amount-specific noise filters
    if (entity.type === 'amount') {
      // Reject bare numbers without currency/unit context
      if (BARE_NUMBER_PATTERN.test(raw)) {
        console.error(
          `[NOISE] Filtered "${raw}" (${entity.type}): bare number without currency/unit`
        );
        continue;
      }
    }

    // Reclassify ICD-10 codes from case_number to diagnosis
    if (entity.type === 'case_number' && ICD10_PATTERN.test(raw)) {
      console.error(`[RECLASSIFY] "${raw}" case_number -> diagnosis (ICD-10 code)`);
      filtered.push({ ...entity, type: 'diagnosis' });
      continue;
    }

    // Filter pure-digit case_numbers (likely MRNs/patient IDs, not legal case numbers)
    // Real case numbers have structure: dashes, slashes, letters (e.g., "2024-CV-12345")
    if (entity.type === 'case_number' && /^\d+$/.test(raw)) {
      console.error(
        `[NOISE] Filtered "${raw}" (${entity.type}): pure-digit case_number (likely MRN/patient ID)`
      );
      continue;
    }

    filtered.push(entity);
  }

  const removedCount = entities.length - filtered.length;
  if (removedCount > 0) {
    console.error(
      `[INFO] filterNoiseEntities: removed ${removedCount} noise entities from ${entities.length} total`
    );
  }

  return filtered;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHUNK MAPPING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find the chunk that contains the given start position.
 * Entity mentions are assigned to the chunk where they START -- if the mention
 * extends a few characters past the chunk boundary, that's expected behavior
 * at chunk edges and the verifier accounts for it.
 */
function findChunkForPosition(dbChunks: Chunk[], position: number): Chunk | null {
  for (const chunk of dbChunks) {
    if (position >= chunk.character_start && position < chunk.character_end) {
      return chunk;
    }
  }
  return null;
}

/** Result for a single entity occurrence found in OCR text */
export interface EntityOccurrence {
  chunk_id: string | null;
  character_start: number;
  character_end: number;
  page_number: number | null;
  context_text: string;
}

/**
 * Find ALL occurrences of an entity's raw_text in the OCR text and map each to its
 * containing DB chunk. Returns an array of occurrences with chunk mapping and context.
 * Scans the entire OCR text for every match using case-insensitive search.
 */
export function findAllEntityOccurrences(
  entityRawText: string,
  ocrText: string,
  dbChunks: Chunk[]
): EntityOccurrence[] {
  if (!entityRawText || entityRawText.trim().length === 0 || !ocrText) {
    return [];
  }

  const lowerOcr = ocrText.toLowerCase();
  const lowerEntity = entityRawText.toLowerCase().trim();
  const entityLen = entityRawText.trim().length;
  const occurrences: EntityOccurrence[] = [];
  const contextRadius = 100; // ~200 chars total context window

  let searchFrom = 0;
  while (searchFrom < lowerOcr.length) {
    const pos = lowerOcr.indexOf(lowerEntity, searchFrom);
    if (pos === -1) break;

    const charStart = pos;
    const charEnd = pos + entityLen;

    // Find containing chunk (assigned by start position)
    const chunk = dbChunks.length > 0 ? findChunkForPosition(dbChunks, charStart) : null;

    // Extract context: ~100 chars before and after the occurrence
    const ctxStart = Math.max(0, pos - contextRadius);
    const ctxEnd = Math.min(ocrText.length, charEnd + contextRadius);
    let contextText = ocrText.slice(ctxStart, ctxEnd).trim();

    // Trim to word boundaries for cleanliness
    if (ctxStart > 0) {
      const firstSpace = contextText.indexOf(' ');
      if (firstSpace > 0 && firstSpace < 30) {
        contextText = contextText.slice(firstSpace + 1);
      }
    }
    if (ctxEnd < ocrText.length) {
      const lastSpace = contextText.lastIndexOf(' ');
      if (lastSpace > 0 && lastSpace > contextText.length - 30) {
        contextText = contextText.slice(0, lastSpace);
      }
    }

    occurrences.push({
      chunk_id: chunk?.id ?? null,
      character_start: charStart,
      character_end: charEnd,
      page_number: chunk?.page_number ?? null,
      context_text: contextText,
    });

    searchFrom = pos + entityLen;
  }

  return occurrences;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOINT EXTRACTION STORAGE (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Store joint extraction results: entities, mentions, KG nodes, KG edges.
 * Idempotent: deletes existing entities/mentions/segments for the document first.
 * All DB operations run in a single transaction for atomicity.
 *
 * @param conn - Database connection
 * @param documentId - Document ID
 * @param ocrResultId - OCR result ID (for segment tracking)
 * @param ocrText - Full OCR text (for mention occurrence scanning)
 * @param result - Joint extraction result from extractEntitiesAndRelationships()
 * @param entityProvId - Provenance ID for entity extraction operations
 * @param kgProvId - Provenance ID for knowledge graph operations
 * @returns Counts of stored items
 */
export function storeJointExtractionResults(
  conn: Database.Database,
  documentId: string,
  ocrResultId: string,
  ocrText: string,
  result: JointExtractionResult,
  entityProvId: string,
  kgProvId: string
): {
  totalEntities: number;
  totalMentions: number;
  totalNodes: number;
  totalEdges: number;
  entitiesByType: Record<string, number>;
} {
  const now = new Date().toISOString();
  const dbChunks = getChunksByDocumentId(conn, documentId);

  let totalEntities = 0;
  let totalMentions = 0;
  let totalNodes = 0;
  let totalEdges = 0;
  const entitiesByType: Record<string, number> = {};

  // Maps from Gemini entity IDs (e1, e2, ...) to database UUIDs
  const entityIdToDbId = new Map<string, string>();
  const entityIdToNodeId = new Map<string, string>();

  const runInTransaction = conn.transaction(() => {
    // (a) Delete existing entities/mentions for this document (idempotent re-extraction)
    // Must delete mentions before entities due to FK constraint
    conn.prepare('DELETE FROM entity_mentions WHERE document_id = ?').run(documentId);
    conn.prepare('DELETE FROM entities WHERE document_id = ?').run(documentId);

    // (b) Delete existing extraction segments for this document
    conn.prepare('DELETE FROM entity_extraction_segments WHERE document_id = ?').run(documentId);

    // (c) Store entities and their mentions
    for (const entity of result.entities) {
      const entityId = uuidv4();
      const normalized = normalizeEntity(entity.canonical_name, entity.type);

      insertEntity(conn, {
        id: entityId,
        document_id: documentId,
        entity_type: entity.type as EntityType,
        raw_text: entity.canonical_name,
        normalized_text: normalized,
        confidence: entity.confidence,
        metadata: entity.aliases && entity.aliases.length > 0
          ? JSON.stringify({ aliases: entity.aliases })
          : null,
        provenance_id: entityProvId,
        created_at: now,
      });

      entityIdToDbId.set(entity.id, entityId);
      entitiesByType[entity.type] = (entitiesByType[entity.type] ?? 0) + 1;
      totalEntities++;

      // Find all occurrences of canonical_name AND aliases in the OCR text
      const allSearchTerms = [entity.canonical_name];
      if (entity.aliases) {
        for (const alias of entity.aliases) {
          if (alias && alias.trim().length > 0) {
            allSearchTerms.push(alias);
          }
        }
      }

      const seenPositions = new Set<number>();
      let entityMentionCount = 0;

      for (const searchTerm of allSearchTerms) {
        const occurrences = findAllEntityOccurrences(searchTerm, ocrText, dbChunks);
        for (const occ of occurrences) {
          // Deduplicate by character_start to avoid double-counting overlapping alias matches
          if (seenPositions.has(occ.character_start)) continue;
          seenPositions.add(occ.character_start);

          insertEntityMention(conn, {
            id: uuidv4(),
            entity_id: entityId,
            document_id: documentId,
            chunk_id: occ.chunk_id,
            page_number: occ.page_number,
            character_start: occ.character_start,
            character_end: occ.character_end,
            context_text: occ.context_text,
            created_at: now,
          });
          entityMentionCount++;
          totalMentions++;
        }
      }

      // Fallback: if no occurrences found at all, create 1 mention with null positions
      if (entityMentionCount === 0) {
        insertEntityMention(conn, {
          id: uuidv4(),
          entity_id: entityId,
          document_id: documentId,
          chunk_id: null,
          page_number: null,
          character_start: null,
          character_end: null,
          context_text: entity.canonical_name,
          created_at: now,
        });
        totalMentions++;
        entityMentionCount = 1;
      }

      // (d) Create KG node for this entity
      const nodeId = uuidv4();
      const importanceScore = computeImportanceScore(
        entity.confidence,
        1, // document_count = 1 (single document extraction)
        entityMentionCount
      );

      insertKnowledgeNode(conn, {
        id: nodeId,
        entity_type: entity.type as EntityType,
        canonical_name: entity.canonical_name,
        normalized_name: normalized,
        aliases: entity.aliases && entity.aliases.length > 0
          ? JSON.stringify(entity.aliases)
          : null,
        document_count: 1,
        mention_count: entityMentionCount,
        edge_count: 0, // Will be incremented by insertKnowledgeEdge
        avg_confidence: entity.confidence,
        importance_score: importanceScore,
        metadata: null,
        provenance_id: kgProvId,
        created_at: now,
        updated_at: now,
      });

      entityIdToNodeId.set(entity.id, nodeId);
      totalNodes++;

      // Link entity to KG node
      insertNodeEntityLink(conn, {
        id: uuidv4(),
        node_id: nodeId,
        entity_id: entityId,
        document_id: documentId,
        similarity_score: 1.0,
        resolution_method: 'gemini_coreference',
        created_at: now,
      });
    }

    // (e) Store relationships as KG edges
    for (const rel of result.relationships) {
      const sourceNodeId = entityIdToNodeId.get(rel.source_id);
      const targetNodeId = entityIdToNodeId.get(rel.target_id);

      if (!sourceNodeId) {
        console.error(
          `[WARN] storeJointExtractionResults: skipping relationship - ` +
            `source_id "${rel.source_id}" not found in node mapping`
        );
        continue;
      }
      if (!targetNodeId) {
        console.error(
          `[WARN] storeJointExtractionResults: skipping relationship - ` +
            `target_id "${rel.target_id}" not found in node mapping`
        );
        continue;
      }

      // Validate relationship type
      if (!RELATIONSHIP_TYPES.includes(rel.relationship_type as RelationshipType)) {
        console.error(
          `[WARN] storeJointExtractionResults: skipping relationship - ` +
            `invalid type "${rel.relationship_type}"`
        );
        continue;
      }

      // Direction convention: sort node IDs alphabetically, lower = source
      const [edgeSource, edgeTarget] =
        sourceNodeId < targetNodeId
          ? [sourceNodeId, targetNodeId]
          : [targetNodeId, sourceNodeId];

      const edgeMetadata: Record<string, unknown> = {};
      if (rel.evidence) {
        edgeMetadata.evidence = rel.evidence;
      }

      // Parse temporal bounds if present
      let validFrom: string | null = null;
      let validUntil: string | null = null;
      if (rel.temporal) {
        // Try to parse temporal as a date or date range
        const rangeMatch = rel.temporal.match(
          /(\d{4}-\d{2}-\d{2})\s*(?:to|—|–|-)\s*(\d{4}-\d{2}-\d{2})/
        );
        if (rangeMatch) {
          validFrom = rangeMatch[1];
          validUntil = rangeMatch[2];
        } else {
          const dateMatch = rel.temporal.match(/(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            validFrom = dateMatch[1];
          }
        }
        edgeMetadata.temporal_raw = rel.temporal;
      }

      insertKnowledgeEdge(conn, {
        id: uuidv4(),
        source_node_id: edgeSource,
        target_node_id: edgeTarget,
        relationship_type: rel.relationship_type as RelationshipType,
        weight: rel.confidence,
        evidence_count: 1,
        document_ids: JSON.stringify([documentId]),
        metadata: Object.keys(edgeMetadata).length > 0
          ? JSON.stringify(edgeMetadata)
          : null,
        provenance_id: kgProvId,
        created_at: now,
        valid_from: validFrom,
        valid_until: validUntil,
      });

      totalEdges++;
    }

    // (f) Store ONE entity_extraction_segments record for tracking
    const segId = uuidv4();
    conn
      .prepare(
        `INSERT INTO entity_extraction_segments (
          id, document_id, ocr_result_id, segment_index, text,
          character_start, character_end, text_length,
          overlap_previous, overlap_next,
          extraction_status, entity_count, extracted_at, error_message,
          provenance_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        segId,
        documentId,
        ocrResultId,
        0, // segment_index
        ocrText, // full text
        0, // character_start
        ocrText.length, // character_end
        ocrText.length, // text_length
        0, // overlap_previous
        0, // overlap_next
        'complete', // extraction_status
        result.entities.length, // entity_count
        now, // extracted_at
        null, // error_message
        entityProvId, // provenance_id
        now // created_at
      );
  });

  // Execute the transaction
  runInTransaction();

  console.error(
    `[INFO] storeJointExtractionResults: stored ${totalEntities} entities, ` +
      `${totalMentions} mentions, ${totalNodes} nodes, ${totalEdges} edges ` +
      `for document ${documentId}`
  );

  return {
    totalEntities,
    totalMentions,
    totalNodes,
    totalEdges,
    entitiesByType,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION QUALITY FEEDBACK
// ═══════════════════════════════════════════════════════════════════════════════

/** Total number of standard entity types supported by the extraction pipeline */
export const TOTAL_ENTITY_TYPES = 11;

/**
 * Compute a quality score for entity extraction results with actionable recommendations.
 *
 * Evaluates extraction quality across four dimensions:
 * - entity_density: entities per 1K chars (ideal range: 5-50)
 * - type_diversity: fraction of entity types found (ideal: > 0.3)
 * - noise_ratio: fraction of entities filtered as noise (ideal: < 0.3)
 * - coverage: fraction of pages with at least one entity (ideal: > 0.5)
 *
 * Score = weighted average: density 30%, diversity 20%, noise_ratio 20% (inverted), coverage 30%
 * Each dimension is normalized to 0-1 before weighting.
 *
 * @param totalEntities - Number of unique entities after deduplication
 * @param textLength - Total character length of source text
 * @param uniqueTypes - Number of distinct entity types found
 * @param totalTypes - Total number of standard entity types (typically 11)
 * @param noiseFiltered - Number of entities removed by noise filter
 * @param totalExtracted - Total entities extracted before filtering
 * @param pagesWithEntities - Number of pages that have at least one entity mention
 * @param totalPages - Total number of pages in the document
 * @returns Quality score (0-1), per-metric breakdown, and recommendations
 */
export function computeExtractionQualityScore(
  totalEntities: number,
  textLength: number,
  uniqueTypes: number,
  totalTypes: number,
  noiseFiltered: number,
  totalExtracted: number,
  pagesWithEntities: number,
  totalPages: number
): { score: number; metrics: Record<string, number>; recommendations: string[] } {
  const recommendations: string[] = [];

  // Entity density: entities per 1K chars, normalized to 0-1
  // Ideal range 5-50 per 1K chars; clamp at edges
  const rawDensity = textLength > 0 ? (totalEntities / textLength) * 1000 : 0;
  let densityScore: number;
  if (rawDensity < 1) {
    densityScore = rawDensity / 5; // 0-0.2 for very sparse
  } else if (rawDensity <= 5) {
    densityScore = 0.2 + ((rawDensity - 1) / 4) * 0.4; // 0.2-0.6
  } else if (rawDensity <= 50) {
    densityScore = 0.6 + ((rawDensity - 5) / 45) * 0.4; // 0.6-1.0
  } else {
    densityScore = Math.max(0.5, 1.0 - (rawDensity - 50) / 100); // Penalize extreme density
  }
  densityScore = Math.min(1.0, Math.max(0, densityScore));

  if (rawDensity < 2) {
    recommendations.push('Low entity density detected. Consider documents with richer content.');
  }

  // Type diversity: uniqueTypes / totalTypes
  const typeDiversity = totalTypes > 0 ? uniqueTypes / totalTypes : 0;
  const diversityScore = Math.min(1.0, typeDiversity / 0.6); // 0.6+ diversity = full score
  if (typeDiversity < 0.3) {
    recommendations.push(
      `Limited entity type diversity. Only ${uniqueTypes} of ${totalTypes} types found.`
    );
  }

  // Noise ratio: inverted (lower noise = better)
  const noiseRatio = totalExtracted > 0 ? noiseFiltered / totalExtracted : 0;
  const noiseScore = Math.max(0, 1.0 - noiseRatio); // 0% noise = 1.0, 100% noise = 0.0
  if (noiseRatio > 0.3) {
    const pct = Math.round(noiseRatio * 100);
    recommendations.push(`High noise ratio (${pct}%). Many extracted entities were filtered.`);
  }

  // Coverage: pagesWithEntities / totalPages
  const coverageRatio = totalPages > 0 ? pagesWithEntities / totalPages : totalEntities > 0 ? 1 : 0;
  const coverageScore = Math.min(1.0, coverageRatio / 0.8); // 80%+ coverage = full score
  if (totalPages > 0 && coverageRatio < 0.5) {
    const pct = Math.round(coverageRatio * 100);
    recommendations.push(
      `Low extraction coverage (${pct}%). Only ${pagesWithEntities}/${totalPages} pages have entities.`
    );
  }

  // Weighted average: density 30%, diversity 20%, noise 20%, coverage 30%
  const score =
    Math.round(
      (densityScore * 0.3 + diversityScore * 0.2 + noiseScore * 0.2 + coverageScore * 0.3) * 100
    ) / 100;

  return {
    score,
    metrics: {
      entity_density: Math.round(rawDensity * 100) / 100,
      type_diversity: Math.round(typeDiversity * 100) / 100,
      noise_ratio: Math.round(noiseRatio * 100) / 100,
      coverage: Math.round(coverageRatio * 100) / 100,
      density_score: Math.round(densityScore * 100) / 100,
      diversity_score: Math.round(diversityScore * 100) / 100,
      noise_score: Math.round(noiseScore * 100) / 100,
      coverage_score: Math.round(coverageScore * 100) / 100,
    },
    recommendations,
  };
}

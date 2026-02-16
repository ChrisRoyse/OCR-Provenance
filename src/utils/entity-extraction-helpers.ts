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
import { computeHash } from './hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum characters per single Gemini call for entity extraction.
 * Tested: 50K works in ~18s, 100K+ times out with schema-constrained JSON. */
export const MAX_CHARS_PER_CALL = 50_000;

/** Output token limit for entity extraction.
 * 50K char segments produce ~200-400 entities = ~5-10K tokens of JSON.
 * 16K is generous; 65K caused API throttling (reserved capacity). */
export const ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS = 16_384;

/** Overlap characters between segments (5% of MAX_CHARS_PER_CALL) */
export const SEGMENT_OVERLAP_CHARS = 2_500;

/** Maximum parallel Gemini API calls for segment processing. */
const MAX_PARALLEL_SEGMENTS = parseInt(process.env.GEMINI_PARALLEL_SEGMENTS ?? '3', 10);

/** Request timeout for entity extraction per segment.
 * 50K segments complete in ~18s; 60s allows for API latency spikes. */
export const ENTITY_EXTRACTION_TIMEOUT_MS = 60_000;

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
// TEXT SPLITTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Split text into overlapping segments for adaptive batching.
 * Used only for very large documents (> maxCharsPerCall) that exceed
 * a single Gemini call. Splits at sentence boundaries with overlap
 * to avoid losing entities at segment borders.
 *
 * @param text - Full document text
 * @param maxChars - Maximum characters per segment
 * @param overlapChars - Characters of overlap between segments
 * @returns Array of text segments
 */
export function splitWithOverlap(text: string, maxChars: number, overlapChars: number): string[] {
  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      if (lastPeriod > start + maxChars * 0.5) {
        end = lastPeriod + 1;
      }
    }
    segments.push(text.slice(start, end));
    start = end - overlapChars;
    if (start <= end - maxChars + overlapChars) {
      start = end;
    }
  }
  return segments;
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
      requestTimeout: ENTITY_EXTRACTION_TIMEOUT_MS,
    });
    return parseEntityResponse(response.text);
  } catch (primaryError) {
    const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    console.error(`[WARN] Primary entity extraction failed: ${errMsg}`);
    throw new Error(`Entity extraction failed: ${errMsg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOISE FILTERING
// ═══════════════════════════════════════════════════════════════════════════════

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

    // Reject very short entities (2 chars or less)
    // 2-char abbreviations like "AD" (Advance Directive) create massive noise
    if (raw.length <= 2) {
      console.error(`[NOISE] Filtered "${raw}" (${entity.type}): too short (length ${raw.length})`);
      continue;
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
// SEGMENT-BASED EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Record representing one extraction segment stored in the database */
export interface SegmentRecord {
  id: string;
  document_id: string;
  ocr_result_id: string;
  segment_index: number;
  text: string;
  character_start: number;
  character_end: number;
  text_length: number;
  overlap_previous: number;
  overlap_next: number;
  extraction_status: 'pending' | 'processing' | 'complete' | 'failed';
  entity_count: number;
  extracted_at: string | null;
  error_message: string | null;
  provenance_id: string;
  created_at: string;
}

/**
 * Create extraction segments from OCR text and store them in the database.
 * Each segment records its exact character range in the original OCR text
 * for provenance tracing.
 */
export function createExtractionSegments(
  conn: Database.Database,
  documentId: string,
  ocrResultId: string,
  ocrText: string,
  provenanceId: string
): SegmentRecord[] {
  conn.prepare('DELETE FROM entity_extraction_segments WHERE document_id = ?').run(documentId);

  const segmentTexts = splitWithOverlap(ocrText, MAX_CHARS_PER_CALL, SEGMENT_OVERLAP_CHARS);
  const now = new Date().toISOString();
  const segments: SegmentRecord[] = [];

  const insertStmt = conn.prepare(`
    INSERT INTO entity_extraction_segments (
      id, document_id, ocr_result_id, segment_index, text,
      character_start, character_end, text_length,
      overlap_previous, overlap_next,
      extraction_status, entity_count, extracted_at, error_message,
      provenance_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let currentStart = 0;
  for (let i = 0; i < segmentTexts.length; i++) {
    const segText = segmentTexts[i];

    // Locate this segment's start in the original text.
    // For segment 0 it's always 0; for subsequent segments, search near the overlap region.
    let charStart: number;
    if (i === 0) {
      charStart = 0;
    } else {
      const searchFrom = Math.max(0, currentStart - SEGMENT_OVERLAP_CHARS - 100);
      const pos = ocrText.indexOf(segText.slice(0, Math.min(200, segText.length)), searchFrom);
      charStart = pos >= 0 ? pos : currentStart;
    }

    const charEnd = charStart + segText.length;
    const overlapPrevious = i > 0 ? Math.max(0, segments[i - 1].character_end - charStart) : 0;
    const overlapNext = i < segmentTexts.length - 1 ? SEGMENT_OVERLAP_CHARS : 0;

    const segId = uuidv4();
    const segment: SegmentRecord = {
      id: segId,
      document_id: documentId,
      ocr_result_id: ocrResultId,
      segment_index: i,
      text: segText,
      character_start: charStart,
      character_end: charEnd,
      text_length: segText.length,
      overlap_previous: overlapPrevious,
      overlap_next: overlapNext,
      extraction_status: 'pending',
      entity_count: 0,
      extracted_at: null,
      error_message: null,
      provenance_id: provenanceId,
      created_at: now,
    };

    insertStmt.run(
      segment.id,
      segment.document_id,
      segment.ocr_result_id,
      segment.segment_index,
      segment.text,
      segment.character_start,
      segment.character_end,
      segment.text_length,
      segment.overlap_previous,
      segment.overlap_next,
      segment.extraction_status,
      segment.entity_count,
      segment.extracted_at,
      segment.error_message,
      segment.provenance_id,
      segment.created_at
    );

    segments.push(segment);
    currentStart = charEnd - (overlapNext > 0 ? SEGMENT_OVERLAP_CHARS : 0);
  }

  console.error(
    `[INFO] Created ${segments.length} extraction segments for document ${documentId} ` +
      `(total text: ${ocrText.length} chars, segment size: ${MAX_CHARS_PER_CALL}, overlap: ${SEGMENT_OVERLAP_CHARS})`
  );

  return segments;
}

/**
 * Update a segment's status after extraction attempt.
 */
export function updateSegmentStatus(
  conn: Database.Database,
  segmentId: string,
  status: 'processing' | 'complete' | 'failed',
  entityCount?: number,
  errorMessage?: string
): void {
  const now = new Date().toISOString();
  conn
    .prepare(
      `
    UPDATE entity_extraction_segments
    SET extraction_status = ?,
        entity_count = COALESCE(?, entity_count),
        extracted_at = CASE WHEN ? IN ('complete', 'failed') THEN ? ELSE extracted_at END,
        error_message = ?
    WHERE id = ?
  `
    )
    .run(status, entityCount ?? null, status, now, errorMessage ?? null, segmentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHUNK MAPPING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find which DB chunk contains a given character position in the OCR text.
 * Chunks have character_start (inclusive) and character_end (exclusive).
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

    // Find containing chunk
    const chunk = dbChunks.length > 0 ? findChunkForPosition(dbChunks, pos) : null;

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
// FULL EXTRACTION PIPELINE (shared by entity-analysis.ts and ingestion.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/** Result of a full segment-based entity extraction run */
export interface SegmentExtractionResult {
  totalEntities: number;
  totalMentions: number;
  totalRawExtracted: number;
  noiseFiltered: number;
  deduplicated: number;
  entitiesByType: Record<string, number>;
  chunkMapped: number;
  processingDurationMs: number;
  segmentsTotal: number;
  segmentsComplete: number;
  segmentsFailed: number;
  apiCalls: number;
}

/**
 * Run the full segment-based entity extraction pipeline:
 * create segments, call Gemini per segment, filter noise,
 * deduplicate, store entities + mentions in DB, and update provenance.
 *
 * Shared core used by both manual extraction (entity-analysis.ts)
 * and auto-pipeline extraction (ingestion.ts).
 */
export async function processSegmentsAndStoreEntities(
  conn: Database.Database,
  client: GeminiClient,
  documentId: string,
  ocrResultId: string,
  ocrText: string,
  entityProvId: string,
  typeFilter: string,
  entityTypes: readonly string[],
  startTime: number,
  source?: string
): Promise<SegmentExtractionResult> {
  const textLength = ocrText.length;
  const now = new Date().toISOString();

  const segments = createExtractionSegments(conn, documentId, ocrResultId, ocrText, entityProvId);

  // Build grouped KG entity hints with aliases for better extraction recall
  const entityHints = buildKGEntityHints(conn);

  // Process segments in parallel batches. Rate limiting handled by GeminiRateLimiter.
  const allRawEntities: Array<{ type: string; raw_text: string; confidence: number }> = [];
  let segmentsComplete = 0;
  let segmentsFailed = 0;

  for (let i = 0; i < segments.length; i += MAX_PARALLEL_SEGMENTS) {
    const batch = segments.slice(i, i + MAX_PARALLEL_SEGMENTS);

    // Mark batch as processing
    for (const seg of batch) {
      updateSegmentStatus(conn, seg.id, 'processing');
    }

    const results = await Promise.allSettled(
      batch.map(async (segment) => {
        const entities = await callGeminiForEntities(client, segment.text, typeFilter, entityHints);
        return { segment, entities };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { segment, entities } = result.value;
        allRawEntities.push(...entities);
        updateSegmentStatus(conn, segment.id, 'complete', entities.length);
        segmentsComplete++;
      } else {
        // Find which segment failed by index in batch
        const failedIndex = results.indexOf(result);
        const failedSegment = batch[failedIndex];
        const segMsg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(
          `[WARN] Segment ${failedSegment.segment_index} failed for ${documentId}: ${segMsg}`
        );
        updateSegmentStatus(conn, failedSegment.id, 'failed', 0, segMsg);
        segmentsFailed++;
      }
    }
  }

  const apiCalls = segments.length;
  const processingDurationMs = Date.now() - startTime;

  const filteredEntities = filterNoiseEntities(allRawEntities);
  const noiseFilteredCount = allRawEntities.length - filteredEntities.length;

  const mergedEntities = filteredEntities;

  // Deduplicate by type::normalized_text, keeping highest confidence per key
  // Also count segment occurrences for cross-segment agreement boosting
  const dedupMap = new Map<
    string,
    { type: string; raw_text: string; confidence: number; segment_count: number }
  >();
  for (const entity of mergedEntities) {
    const normalized = normalizeEntity(entity.raw_text, entity.type);
    const key = `${entity.type}::${normalized}`;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, { ...entity, segment_count: 1 });
    } else {
      existing.segment_count++;
      if (entity.confidence > existing.confidence) {
        existing.raw_text = entity.raw_text;
        existing.confidence = entity.confidence;
      }
    }
  }

  // Cross-segment agreement boosting: entities found in multiple segments
  // get a confidence boost (capped at 0.15 total boost, 0.05 per additional segment)
  for (const [, entityData] of dedupMap) {
    if (entityData.segment_count > 1) {
      const boost = Math.min(0.15, (entityData.segment_count - 1) * 0.05);
      entityData.confidence = Math.min(1.0, entityData.confidence + boost);
    }
  }

  const entityContent = JSON.stringify([...dedupMap.values()]);
  const entityHash = computeHash(entityContent);
  const processingParams: Record<string, unknown> = {
    entity_types: entityTypes,
    api_calls: apiCalls,
    text_length: textLength,
    segment_size: MAX_CHARS_PER_CALL,
    segment_overlap: SEGMENT_OVERLAP_CHARS,
    segments_total: segments.length,
    segments_complete: segmentsComplete,
    segments_failed: segmentsFailed,
  };
  if (source) {
    processingParams.source = source;
  }

  conn
    .prepare(
      `
    UPDATE provenance SET content_hash = ?, processed_at = ?, processing_duration_ms = ?,
      processing_params = ?
    WHERE id = ?
  `
    )
    .run(
      entityHash,
      new Date().toISOString(),
      processingDurationMs,
      JSON.stringify(processingParams),
      entityProvId
    );

  const dbChunks = getChunksByDocumentId(conn, documentId);
  let chunkMappedCount = 0;
  const typeCounts: Record<string, number> = {};
  let totalInserted = 0;
  let totalMentions = 0;

  for (const [, entityData] of dedupMap) {
    const normalized = normalizeEntity(entityData.raw_text, entityData.type);
    const entityId = uuidv4();

    insertEntity(conn, {
      id: entityId,
      document_id: documentId,
      entity_type: entityData.type as EntityType,
      raw_text: entityData.raw_text,
      normalized_text: normalized,
      confidence: entityData.confidence,
      metadata:
        entityData.segment_count > 1
          ? JSON.stringify({ agreement_count: entityData.segment_count })
          : null,
      provenance_id: entityProvId,
      created_at: now,
    });

    const occurrences = findAllEntityOccurrences(entityData.raw_text, ocrText, dbChunks);

    if (occurrences.length > 0) {
      let entityHasChunkMapping = false;

      for (const occ of occurrences) {
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
        totalMentions++;
        if (occ.chunk_id) {
          entityHasChunkMapping = true;
        }
      }

      if (entityHasChunkMapping) {
        chunkMappedCount++;
      }
    } else {
      // No occurrences found -- create 1 fallback mention with null positions
      insertEntityMention(conn, {
        id: uuidv4(),
        entity_id: entityId,
        document_id: documentId,
        chunk_id: null,
        page_number: null,
        character_start: null,
        character_end: null,
        context_text: entityData.raw_text,
        created_at: now,
      });
      totalMentions++;
    }

    typeCounts[entityData.type] = (typeCounts[entityData.type] ?? 0) + 1;
    totalInserted++;
  }

  return {
    totalEntities: totalInserted,
    totalMentions,
    totalRawExtracted: allRawEntities.length,
    noiseFiltered: noiseFilteredCount,
    deduplicated: mergedEntities.length - totalInserted,
    entitiesByType: typeCounts,
    chunkMapped: chunkMappedCount,
    processingDurationMs,
    segmentsTotal: segments.length,
    segmentsComplete,
    segmentsFailed,
    apiCalls,
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

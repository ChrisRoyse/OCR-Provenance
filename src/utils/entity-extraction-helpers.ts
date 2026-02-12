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

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum characters per single Gemini call for entity extraction */
export const MAX_CHARS_PER_CALL = 250_000;

/** Output token limit for entity extraction (Flash 3 supports 65K) */
export const ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS = 65_536;

/** Overlap characters between segments (10% of MAX_CHARS_PER_CALL) */
export const SEGMENT_OVERLAP_CHARS = 25_000;

/** Request timeout for entity extraction (large docs + 65K output tokens) */
export const ENTITY_EXTRACTION_TIMEOUT_MS = 300_000;

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
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
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
    if (start <= (end - maxChars + overlapChars)) {
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
 */
function parseEntityResponse(
  responseText: string,
): Array<{ type: string; raw_text: string; confidence: number }> {
  const parsed = JSON.parse(responseText) as {
    entities?: Array<{ type: string; raw_text: string; confidence: number }>;
  };
  if (parsed.entities && Array.isArray(parsed.entities)) {
    return parsed.entities.filter(
      entity => ENTITY_TYPES.includes(entity.type as EntityType)
    );
  }
  return [];
}

/**
 * Make a single Gemini API call to extract entities from text.
 *
 * Uses fast() with ENTITY_EXTRACTION_SCHEMA for guaranteed clean JSON output.
 * If the primary model fails after all retries, falls back to gemini-2.0-flash.
 */
export async function callGeminiForEntities(
  client: GeminiClient,
  text: string,
  typeFilter: string,
): Promise<Array<{ type: string; raw_text: string; confidence: number }>> {
  const prompt =
    `Extract named entities from the following text. ${typeFilter}\n` +
    `IMPORTANT: Use 'medication' for drug names, prescriptions, and pharmaceutical products. ` +
    `Use 'diagnosis' for medical conditions, diseases, symptoms, and clinical diagnoses. ` +
    `Use 'medical_device' for medical devices and equipment (e.g., G-tube, PEG tube, catheter, ventilator, pacemaker, insulin pump, CPAP machine). ` +
    `Do NOT classify medications, diagnoses, or medical devices as 'other'.\n\n` +
    `${text}`;

  // Primary attempt with the provided client
  try {
    const response = await client.fast(prompt, ENTITY_EXTRACTION_SCHEMA, {
      maxOutputTokens: ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS,
      requestTimeout: ENTITY_EXTRACTION_TIMEOUT_MS,
    });
    return parseEntityResponse(response.text);
  } catch (primaryError) {
    const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    console.error(`[WARN] Primary entity extraction failed: ${errMsg}`);
  }

  // Fallback to gemini-2.0-flash
  try {
    console.error(`[INFO] Falling back to gemini-2.0-flash for entity extraction`);
    const fallbackClient = new GeminiClient({ model: 'gemini-2.0-flash' });
    const response = await fallbackClient.fast(prompt, ENTITY_EXTRACTION_SCHEMA, {
      maxOutputTokens: ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS,
      requestTimeout: ENTITY_EXTRACTION_TIMEOUT_MS,
    });
    console.error(`[INFO] Fallback model gemini-2.0-flash succeeded`);
    return parseEntityResponse(response.text);
  } catch (fallbackError) {
    const errMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    console.error(`[WARN] Fallback entity extraction also failed: ${errMsg}`);
  }

  return [];
}

/**
 * Extract entities from text using a single Gemini call (or adaptive batching
 * for very large documents). Most documents fit in one call since Gemini Flash 3
 * has a 1M token (~4M char) context window.
 *
 * @param client - GeminiClient instance
 * @param text - Full OCR extracted text
 * @param entityTypes - Entity types to extract (empty = all)
 * @returns Array of raw extracted entities
 */
export async function extractEntitiesFromText(
  client: GeminiClient,
  text: string,
  entityTypes: string[],
): Promise<Array<{ type: string; raw_text: string; confidence: number }>> {
  const typeFilter = entityTypes.length > 0
    ? `Only extract entities of these types: ${entityTypes.join(', ')}.`
    : `Extract all entity types: ${ENTITY_TYPES.join(', ')}.`;

  if (text.length <= MAX_CHARS_PER_CALL) {
    return callGeminiForEntities(client, text, typeFilter);
  }

  console.error(`[INFO] Document too large for single call (${text.length} chars), using adaptive batching`);
  const batches = splitWithOverlap(text, MAX_CHARS_PER_CALL, SEGMENT_OVERLAP_CHARS);
  const allEntities: Array<{ type: string; raw_text: string; confidence: number }> = [];
  for (const batch of batches) {
    const entities = await callGeminiForEntities(client, batch, typeFilter);
    allEntities.push(...entities);
  }
  return allEntities;
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
const PHONE_PATTERN = /^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/;

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
  entities: Array<{ type: string; raw_text: string; confidence: number }>,
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
      console.error(`[NOISE] Filtered "${raw}" (${entity.type}): SSN pattern detected — filtered for privacy`);
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
        console.error(`[NOISE] Filtered "${raw}" (${entity.type}): bare number without currency/unit`);
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
      console.error(`[NOISE] Filtered "${raw}" (${entity.type}): pure-digit case_number (likely MRN/patient ID)`);
      continue;
    }

    filtered.push(entity);
  }

  const removedCount = entities.length - filtered.length;
  if (removedCount > 0) {
    console.error(`[INFO] filterNoiseEntities: removed ${removedCount} noise entities from ${entities.length} total`);
  }

  return filtered;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGEX DATE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAME_PATTERN = Object.keys(MONTH_NAMES).join('|');

/**
 * Validate that month (1-12) and day (1-31) are in valid ranges.
 */
function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Extract dates from OCR text using regex patterns that Gemini often misses.
 *
 * Scans for common date formats: MM/DD/YYYY, MM/DD/YY, MM/DD, Month DD YYYY,
 * DD Month YYYY, and YYYY-MM-DD (ISO). Validates month/day ranges and
 * deduplicates by raw_text.
 *
 * @param ocrText - Full OCR extracted text
 * @returns Array of date entities with type, raw_text, and confidence
 */
export function extractDatesWithRegex(
  ocrText: string,
): Array<{ type: 'date'; raw_text: string; confidence: number }> {
  if (!ocrText) {
    return [];
  }

  const seen = new Set<string>();
  const results: Array<{ type: 'date'; raw_text: string; confidence: number }> = [];

  function addDate(rawText: string, confidence: number): void {
    const trimmed = rawText.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      results.push({ type: 'date', raw_text: trimmed, confidence });
    }
  }

  // Pattern 1: MM/DD/YYYY (e.g., "04/10/2024", "11/17/1952")
  const mmddyyyy = /\b(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{4})\b/g;
  for (const match of ocrText.matchAll(mmddyyyy)) {
    const m = parseInt(match.groups!.month, 10);
    const d = parseInt(match.groups!.day, 10);
    if (isValidMonthDay(m, d)) {
      addDate(match[0], 0.85);
    }
  }

  // Pattern 2: MM/DD/YY (e.g., "04/10/24")
  const mmddyy = /\b(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{2})\b/g;
  for (const match of ocrText.matchAll(mmddyy)) {
    const m = parseInt(match.groups!.month, 10);
    const d = parseInt(match.groups!.day, 10);
    if (isValidMonthDay(m, d)) {
      addDate(match[0], 0.85);
    }
  }

  // Pattern 3 (MM/DD without year) removed: too ambiguous without year context.
  // Partial dates like "4/1", "4/18" normalize to wrong year and create KG noise.

  // Pattern 4: Month DD, YYYY (e.g., "April 10, 2024")
  const monthDDYYYY = new RegExp(
    `\\b(?<monthName>${MONTH_NAME_PATTERN})\\s+(?<day>\\d{1,2}),?\\s+(?<year>\\d{4})\\b`,
    'gi',
  );
  for (const match of ocrText.matchAll(monthDDYYYY)) {
    const m = MONTH_NAMES[match.groups!.monthName.toLowerCase()];
    const d = parseInt(match.groups!.day, 10);
    if (m && isValidMonthDay(m, d)) {
      addDate(match[0], 0.85);
    }
  }

  // Pattern 5: DD Month YYYY (e.g., "10 April 2024")
  const ddMonthYYYY = new RegExp(
    `\\b(?<day>\\d{1,2})\\s+(?<monthName>${MONTH_NAME_PATTERN})\\s+(?<year>\\d{4})\\b`,
    'gi',
  );
  for (const match of ocrText.matchAll(ddMonthYYYY)) {
    const m = MONTH_NAMES[match.groups!.monthName.toLowerCase()];
    const d = parseInt(match.groups!.day, 10);
    if (m && isValidMonthDay(m, d)) {
      addDate(match[0], 0.85);
    }
  }

  // Pattern 6: YYYY-MM-DD (ISO format, e.g., "2024-04-10")
  const isoDate = /\b(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})\b/g;
  for (const match of ocrText.matchAll(isoDate)) {
    const m = parseInt(match.groups!.month, 10);
    const d = parseInt(match.groups!.day, 10);
    if (isValidMonthDay(m, d)) {
      addDate(match[0], 0.85);
    }
  }

  if (results.length > 0) {
    console.error(`[INFO] extractDatesWithRegex: found ${results.length} dates via regex`);
  }

  return results;
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
 *
 * Uses splitWithOverlap to compute segment boundaries, then inserts each segment
 * into entity_extraction_segments with full provenance tracking. Each segment
 * records its exact character_start/character_end position in the original OCR text
 * so that entities can always be traced back to their source location.
 *
 * @param conn - Database connection (better-sqlite3)
 * @param documentId - Document ID
 * @param ocrResultId - OCR result ID
 * @param ocrText - Full OCR extracted text
 * @param provenanceId - Provenance ID for the extraction run
 * @returns Array of SegmentRecord objects
 */
export function createExtractionSegments(
  conn: Database.Database,
  documentId: string,
  ocrResultId: string,
  ocrText: string,
  provenanceId: string,
): SegmentRecord[] {
  // Delete any existing segments for this document (re-extraction case)
  conn.prepare('DELETE FROM entity_extraction_segments WHERE document_id = ?').run(documentId);

  // Split the text into overlapping segments
  const segmentTexts = splitWithOverlap(ocrText, MAX_CHARS_PER_CALL, SEGMENT_OVERLAP_CHARS);

  const now = new Date().toISOString();
  const segments: SegmentRecord[] = [];

  // Track character positions in the original OCR text
  // splitWithOverlap returns text slices; we need to find their exact offsets
  const insertStmt = conn.prepare(`
    INSERT INTO entity_extraction_segments (
      id, document_id, ocr_result_id, segment_index, text,
      character_start, character_end, text_length,
      overlap_previous, overlap_next,
      extraction_status, entity_count, extracted_at, error_message,
      provenance_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Compute exact character positions by tracing through the text
  let currentStart = 0;
  for (let i = 0; i < segmentTexts.length; i++) {
    const segText = segmentTexts[i];

    // Find where this segment starts in the original text
    // For the first segment, start is 0. For subsequent segments,
    // find the segment text's actual position starting from expected overlap region.
    let charStart: number;
    if (i === 0) {
      charStart = 0;
    } else {
      // The overlap means this segment starts somewhere before the previous end.
      // Find the exact position by searching for the segment's first unique content.
      const searchFrom = Math.max(0, currentStart - SEGMENT_OVERLAP_CHARS - 100);
      const pos = ocrText.indexOf(segText.slice(0, Math.min(200, segText.length)), searchFrom);
      charStart = pos >= 0 ? pos : currentStart;
    }

    const charEnd = charStart + segText.length;

    // Calculate overlap amounts
    const overlapPrevious = i > 0 ? Math.max(0, (segments[i - 1].character_end) - charStart) : 0;
    const overlapNext = (i < segmentTexts.length - 1) ? SEGMENT_OVERLAP_CHARS : 0;

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
      segment.created_at,
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
 *
 * @param conn - Database connection
 * @param segmentId - Segment ID
 * @param status - New status
 * @param entityCount - Number of entities extracted (for 'complete' status)
 * @param errorMessage - Error message (for 'failed' status)
 */
export function updateSegmentStatus(
  conn: Database.Database,
  segmentId: string,
  status: 'processing' | 'complete' | 'failed',
  entityCount?: number,
  errorMessage?: string,
): void {
  const now = new Date().toISOString();
  conn.prepare(`
    UPDATE entity_extraction_segments
    SET extraction_status = ?,
        entity_count = COALESCE(?, entity_count),
        extracted_at = CASE WHEN ? IN ('complete', 'failed') THEN ? ELSE extracted_at END,
        error_message = ?
    WHERE id = ?
  `).run(status, entityCount ?? null, status, now, errorMessage ?? null, segmentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHUNK MAPPING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find which DB chunk contains a given character position in the OCR text.
 * Chunks have character_start (inclusive) and character_end (exclusive).
 *
 * @param dbChunks - Chunks ordered by chunk_index (from getChunksByDocumentId)
 * @param position - Character offset in the OCR text
 * @returns The matching chunk, or null if no chunk covers that position
 */
export function findChunkForPosition(dbChunks: Chunk[], position: number): Chunk | null {
  for (const chunk of dbChunks) {
    if (position >= chunk.character_start && position < chunk.character_end) {
      return chunk;
    }
  }
  return null;
}

/**
 * Find the position of an entity's raw_text in the OCR text, then map to a DB chunk.
 * Uses case-insensitive search. Returns chunk info including chunk_id, character offsets,
 * and page_number.
 *
 * @param entityRawText - The raw entity text from Gemini extraction
 * @param ocrText - The full OCR extracted text
 * @param dbChunks - DB chunks ordered by chunk_index
 * @returns Object with chunk_id, character_start, character_end, page_number or nulls
 */
export function mapEntityToChunk(
  entityRawText: string,
  ocrText: string,
  dbChunks: Chunk[],
): { chunk_id: string | null; character_start: number | null; character_end: number | null; page_number: number | null } {
  if (dbChunks.length === 0 || !entityRawText || entityRawText.trim().length === 0) {
    return { chunk_id: null, character_start: null, character_end: null, page_number: null };
  }

  const lowerOcr = ocrText.toLowerCase();
  const lowerEntity = entityRawText.toLowerCase().trim();
  const pos = lowerOcr.indexOf(lowerEntity);

  if (pos === -1) {
    return { chunk_id: null, character_start: null, character_end: null, page_number: null };
  }

  const charEnd = pos + entityRawText.trim().length;

  const chunk = findChunkForPosition(dbChunks, pos);
  if (!chunk) {
    return { chunk_id: null, character_start: pos, character_end: charEnd, page_number: null };
  }

  return {
    chunk_id: chunk.id,
    character_start: pos,
    character_end: charEnd,
    page_number: chunk.page_number,
  };
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
 *
 * Unlike mapEntityToChunk which only finds the first occurrence, this scans the entire
 * OCR text for every match using case-insensitive search.
 *
 * @param entityRawText - The raw entity text from Gemini extraction
 * @param ocrText - The full OCR extracted text
 * @param dbChunks - DB chunks ordered by chunk_index
 * @returns Array of EntityOccurrence for ALL matches (empty if none found)
 */
export function findAllEntityOccurrences(
  entityRawText: string,
  ocrText: string,
  dbChunks: Chunk[],
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

    // Advance past this match to find the next one
    searchFrom = pos + entityLen;
  }

  return occurrences;
}

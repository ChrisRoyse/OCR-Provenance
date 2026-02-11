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

import { GeminiClient } from '../services/gemini/client.js';
import { ENTITY_TYPES, type EntityType } from '../models/entity.js';
import type { Chunk } from '../models/chunk.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum characters per single Gemini call for entity extraction */
export const MAX_CHARS_PER_CALL = 500_000;

/** Output token limit for entity extraction (Flash 3 supports 65K) */
export const ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS = 65_536;

/** Overlap characters between segments for adaptive batching */
export const SEGMENT_OVERLAP_CHARS = 2_000;

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
 * Make a single Gemini API call to extract entities from text.
 *
 * Uses fastText() (no JSON schema constraint) because Gemini 3's thinking mode
 * combined with responseMimeType:'application/json' causes excessive latency
 * on prompts over ~3K chars. Prompt-based JSON with manual parsing is 5-10x faster.
 */
export async function callGeminiForEntities(
  client: GeminiClient,
  text: string,
  typeFilter: string,
): Promise<Array<{ type: string; raw_text: string; confidence: number }>> {
  const prompt =
    `Extract named entities as JSON. ${typeFilter} ` +
    `Format: {"entities":[{"type":"...","raw_text":"exact text","confidence":0.0-1.0}]}\n\n` +
    `${text}`;

  const response = await client.fastText(prompt, {
    maxOutputTokens: ENTITY_EXTRACTION_MAX_OUTPUT_TOKENS,
  });

  try {
    let jsonText = response.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const parsed = JSON.parse(jsonText) as { entities?: Array<{ type: string; raw_text: string; confidence: number }> };
    if (parsed.entities && Array.isArray(parsed.entities)) {
      return parsed.entities.filter(
        entity => ENTITY_TYPES.includes(entity.type as EntityType)
      );
    }
  } catch (parseError) {
    const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
    console.error(`[WARN] Failed to parse Gemini entity response: ${errMsg}`);
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

  const charStart = pos;
  const charEnd = pos + entityRawText.trim().length;

  const chunk = findChunkForPosition(dbChunks, pos);
  if (!chunk) {
    return { chunk_id: null, character_start: charStart, character_end: charEnd, page_number: null };
  }

  return {
    chunk_id: chunk.id,
    character_start: charStart,
    character_end: charEnd,
    page_number: chunk.page_number,
  };
}

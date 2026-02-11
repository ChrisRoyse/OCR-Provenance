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
    `Extract named entities from the following text. ${typeFilter}\n\n` +
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

/**
 * Extract entities from VLM image descriptions
 *
 * VLM descriptions contain rich text about image content including
 * names, dates, amounts, and organizations. This module runs entity
 * extraction on those descriptions using the shared extraction pipeline
 * (same schema, noise filtering, and date regex as OCR text extraction).
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module services/knowledge-graph/vlm-entity-extractor
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { GeminiClient } from '../gemini/client.js';
import type { EntityType } from '../../models/entity.js';
import { ENTITY_TYPES } from '../../models/entity.js';
import {
  insertEntity,
  insertEntityMention,
} from '../storage/database/entity-operations.js';
import {
  callGeminiForEntities,
  filterNoiseEntities,
  extractDatesWithRegex,
  normalizeEntity,
} from '../../utils/entity-extraction-helpers.js';

interface VLMDescription {
  embedding_id: string;
  document_id: string;
  image_id: string;
  original_text: string;
}

/**
 * Extract entities from VLM descriptions for a document.
 *
 * VLM descriptions are stored as embeddings where image_id IS NOT NULL.
 * This function extracts named entities from those descriptions using
 * the shared Gemini extraction pipeline (schema-constrained JSON, noise
 * filtering, regex date extraction) and stores them in entities/entity_mentions.
 *
 * @param db - Database connection
 * @param documentId - Document to extract from
 * @param provenanceId - Provenance ID to associate with created entities
 * @returns Number of entities created and descriptions processed
 */
export async function extractEntitiesFromVLM(
  db: Database.Database,
  documentId: string,
  provenanceId: string,
): Promise<{ entities_created: number; descriptions_processed: number }> {
  // Get VLM descriptions for this document
  const descriptions = db.prepare(`
    SELECT e.id as embedding_id, e.document_id, e.image_id, e.original_text
    FROM embeddings e
    WHERE e.document_id = ? AND e.image_id IS NOT NULL AND e.original_text IS NOT NULL
  `).all(documentId) as VLMDescription[];

  if (descriptions.length === 0) {
    throw new Error(`No VLM descriptions found for document ${documentId}. Process images with VLM first.`);
  }

  const client = new GeminiClient();
  const typeFilter = `Return types: ${ENTITY_TYPES.join(', ')}. Return ONLY valid entity types.`;
  let totalCreated = 0;

  for (const desc of descriptions) {
    if (!desc.original_text || desc.original_text.trim().length < 10) continue;

    // Use shared extraction pipeline: schema-constrained JSON + robust recovery
    let rawEntities: Array<{ type: string; raw_text: string; confidence: number }>;
    try {
      rawEntities = await callGeminiForEntities(
        client,
        desc.original_text.slice(0, 2000),
        typeFilter,
      );
    } catch (error) {
      console.error(`[vlm-entity-extractor] Gemini extraction failed for image ${desc.image_id}: ${(error as Error).message}`);
      continue;
    }

    // Apply shared noise filtering
    const filteredEntities = filterNoiseEntities(rawEntities);

    // Add regex-extracted dates from VLM description
    const regexDates = extractDatesWithRegex(desc.original_text);
    const allEntities = [...filteredEntities, ...regexDates];

    // Cap VLM confidence at 0.85 (VLM descriptions are secondary sources)
    for (const entity of allEntities) {
      entity.confidence = Math.min(0.85, Math.max(0.50, entity.confidence));
    }

    // Get page number from the image record
    const image = db.prepare('SELECT page_number FROM images WHERE id = ?').get(desc.image_id) as { page_number: number | null } | undefined;

    for (const entity of allEntities) {
      if (!ENTITY_TYPES.includes(entity.type as EntityType)) continue;

      const normalizedText = normalizeEntity(entity.raw_text, entity.type);

      // Check for duplicate entity in this document
      const existing = db.prepare(
        'SELECT id FROM entities WHERE document_id = ? AND entity_type = ? AND normalized_text = ?',
      ).get(documentId, entity.type, normalizedText) as { id: string } | undefined;

      if (existing) continue;

      const entityId = uuidv4();
      const now = new Date().toISOString();

      insertEntity(db, {
        id: entityId,
        document_id: documentId,
        entity_type: entity.type as EntityType,
        raw_text: entity.raw_text,
        normalized_text: normalizedText,
        confidence: entity.confidence,
        metadata: JSON.stringify({ source: 'vlm', image_id: desc.image_id }),
        provenance_id: provenanceId,
        created_at: now,
      });

      // Create entity mention linked to the VLM description context
      const mentionId = uuidv4();
      insertEntityMention(db, {
        id: mentionId,
        entity_id: entityId,
        document_id: documentId,
        chunk_id: null,
        page_number: image?.page_number ?? null,
        character_start: null,
        character_end: null,
        context_text: desc.original_text.slice(0, 500),
        provenance_id: provenanceId,
        created_at: now,
      });

      totalCreated++;
    }
  }

  return { entities_created: totalCreated, descriptions_processed: descriptions.length };
}

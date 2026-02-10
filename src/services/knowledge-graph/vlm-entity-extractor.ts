/**
 * Extract entities from VLM image descriptions
 *
 * VLM descriptions contain rich text about image content including
 * names, dates, amounts, and organizations. This module runs entity
 * extraction on those descriptions to feed into the knowledge graph.
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

interface VLMDescription {
  embedding_id: string;
  document_id: string;
  image_id: string;
  original_text: string;
}

interface ExtractedEntity {
  entity_type: EntityType;
  text: string;
  normalized_text: string;
  confidence: number;
}

/**
 * Extract entities from VLM descriptions for a document.
 *
 * VLM descriptions are stored as embeddings where image_id IS NOT NULL.
 * This function extracts named entities from those descriptions using Gemini
 * and stores them in the entities/entity_mentions tables.
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
  let totalCreated = 0;

  for (const desc of descriptions) {
    const entities = await extractEntitiesFromText(client, desc.original_text);

    // Get page number from the image record
    const image = db.prepare('SELECT page_number FROM images WHERE id = ?').get(desc.image_id) as { page_number: number | null } | undefined;

    for (const entity of entities) {
      // Check for duplicate entity in this document
      const existing = db.prepare(
        'SELECT id FROM entities WHERE document_id = ? AND entity_type = ? AND normalized_text = ?',
      ).get(documentId, entity.entity_type, entity.normalized_text) as { id: string } | undefined;

      if (existing) continue; // Skip duplicates

      const entityId = uuidv4();
      const now = new Date().toISOString();

      insertEntity(db, {
        id: entityId,
        document_id: documentId,
        entity_type: entity.entity_type,
        raw_text: entity.text,
        normalized_text: entity.normalized_text,
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
        created_at: now,
      });

      totalCreated++;
    }
  }

  return { entities_created: totalCreated, descriptions_processed: descriptions.length };
}

/**
 * Extract entities from a text string using Gemini.
 *
 * @param client - GeminiClient instance
 * @param text - Text to extract entities from
 * @returns Array of extracted entities
 */
async function extractEntitiesFromText(client: GeminiClient, text: string): Promise<ExtractedEntity[]> {
  if (!text || text.trim().length < 10) return [];

  const prompt = `Extract named entities from this VLM image description. Return a JSON array of objects with: entity_type (one of: ${ENTITY_TYPES.join(', ')}), text (exact text), normalized_text (normalized form), confidence (0.0-1.0).

Only extract entities you are confident about. For VLM descriptions, use confidence 0.70-0.85.

Text:
${text.slice(0, 2000)}

Return ONLY a JSON array, no other text.`;

  try {
    const response = await client.fast(prompt);
    // Parse JSON from response - handle markdown code blocks
    let jsonStr = response.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((e: Record<string, unknown>) =>
      e.entity_type && ENTITY_TYPES.includes(e.entity_type as EntityType) &&
      typeof e.text === 'string' && (e.text as string).length > 0 &&
      typeof e.normalized_text === 'string' &&
      typeof e.confidence === 'number',
    ).map((e: Record<string, unknown>) => ({
      entity_type: e.entity_type as EntityType,
      text: e.text as string,
      normalized_text: (e.normalized_text as string).toLowerCase().trim(),
      confidence: Math.min(0.85, Math.max(0.50, e.confidence as number)), // Cap at VLM confidence range
    }));
  } catch (error) {
    console.error(`[vlm-entity-extractor] Failed to extract entities: ${(error as Error).message}`);
    return [];
  }
}

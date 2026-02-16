/**
 * Map structured extraction fields to entities
 *
 * When structured data extraction has been performed (via ocr_extract_structured),
 * the JSON results contain typed fields that map directly to entity types.
 * This module creates entities from those fields with high confidence (0.92).
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module services/knowledge-graph/extraction-entity-mapper
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { EntityType } from '../../models/entity.js';
import type { Chunk } from '../../models/chunk.js';
import { insertEntity, insertEntityMention } from '../storage/database/entity-operations.js';
import { getChunksByDocumentId } from '../storage/database/chunk-operations.js';

/** Mapping from extraction field names to entity types */
const FIELD_TO_ENTITY_TYPE: Record<string, EntityType> = {
  // Organization fields
  vendor_name: 'organization',
  company: 'organization',
  company_name: 'organization',
  employer: 'organization',
  client: 'organization',
  organization: 'organization',
  firm: 'organization',

  // Person fields
  name: 'person',
  full_name: 'person',
  party_a: 'person',
  party_b: 'person',
  plaintiff: 'person',
  defendant: 'person',
  witness: 'person',
  attorney: 'person',
  judge: 'person',

  // Amount fields
  amount: 'amount',
  total: 'amount',
  subtotal: 'amount',
  tax: 'amount',
  price: 'amount',
  fee: 'amount',

  // Date fields
  date: 'date',
  invoice_date: 'date',
  due_date: 'date',
  filing_date: 'date',
  effective_date: 'date',
  expiration_date: 'date',

  // Case number fields
  case_number: 'case_number',
  docket_number: 'case_number',
  file_number: 'case_number',
  reference_number: 'case_number',

  // Location fields
  address: 'location',
  city: 'location',
  state: 'location',
  country: 'location',
  location: 'location',
  jurisdiction: 'location',

  // Medication fields
  medication: 'medication',
  drug: 'medication',
  drug_name: 'medication',
  prescription: 'medication',
  medicine: 'medication',

  // Diagnosis fields
  diagnosis: 'diagnosis',
  condition: 'diagnosis',
  disease: 'diagnosis',
  medical_condition: 'diagnosis',

  // Medical device fields
  medical_device: 'medical_device',
  device: 'medical_device',
  device_name: 'medical_device',
  equipment: 'medical_device',
};

/**
 * Create entities from structured extraction results for a document.
 *
 * Reads the extractions table, parses the JSON extraction_json, and maps
 * known field names to entity types using the FIELD_TO_ENTITY_TYPE mapping.
 * Entities are stored with confidence 0.92 (schema-driven extraction).
 *
 * @param db - Database connection
 * @param documentId - Document ID to process extractions for
 * @param provenanceId - Provenance ID to associate with created entities
 * @returns Number of entities created and extractions processed
 */
export function mapExtractionEntitiesToDB(
  db: Database.Database,
  documentId: string,
  provenanceId: string
): { entities_created: number; extractions_processed: number } {
  // Get extractions for this document
  const extractions = db
    .prepare(
      `
    SELECT id, extraction_json FROM extractions WHERE document_id = ?
  `
    )
    .all(documentId) as Array<{ id: string; extraction_json: string }>;

  if (extractions.length === 0) {
    throw new Error(
      `No structured extractions found for document ${documentId}. Run ocr_extract_structured first.`
    );
  }

  // Load OCR text and DB chunks for chunk_id mapping
  const ocrRow = db
    .prepare('SELECT extracted_text FROM ocr_results WHERE document_id = ?')
    .get(documentId) as { extracted_text: string } | undefined;

  const ocrText = ocrRow?.extracted_text ?? '';
  const lowerOcrText = ocrText.toLowerCase();
  const dbChunks = getChunksByDocumentId(db, documentId);

  let totalCreated = 0;

  for (const extraction of extractions) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(extraction.extraction_json);
    } catch (error) {
      console.error(
        `[extraction-entity-mapper] Malformed extraction data for ${extraction.id}:`,
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    // Recursively extract entities from the JSON
    const entities = extractFieldEntities(data, extraction.id);

    for (const entity of entities) {
      // Skip empty values
      if (!entity.text || entity.text.trim().length === 0) continue;

      // Check for duplicate entity in this document
      const existing = db
        .prepare(
          'SELECT id FROM entities WHERE document_id = ? AND entity_type = ? AND normalized_text = ?'
        )
        .get(documentId, entity.entity_type, entity.normalized_text) as { id: string } | undefined;

      if (existing) continue;

      const entityId = uuidv4();
      const now = new Date().toISOString();

      insertEntity(db, {
        id: entityId,
        document_id: documentId,
        entity_type: entity.entity_type,
        raw_text: entity.text,
        normalized_text: entity.normalized_text,
        confidence: 0.92, // High confidence for schema-driven extraction
        metadata: JSON.stringify({
          source: 'extraction',
          extraction_id: entity.extraction_id,
          field_name: entity.field_name,
        }),
        provenance_id: provenanceId,
        created_at: now,
      });

      // Map entity text to chunk via position in OCR text
      const chunkMapping = findEntityChunkMapping(entity.text, lowerOcrText, dbChunks);

      // Create entity mention with chunk mapping
      const mentionId = uuidv4();
      insertEntityMention(db, {
        id: mentionId,
        entity_id: entityId,
        document_id: documentId,
        chunk_id: chunkMapping.chunk_id,
        page_number: chunkMapping.page_number,
        character_start: chunkMapping.character_start,
        character_end: chunkMapping.character_end,
        context_text: `Extracted from field "${entity.field_name}"`,
        created_at: now,
      });

      totalCreated++;
    }
  }

  return { entities_created: totalCreated, extractions_processed: extractions.length };
}

/**
 * Find chunk mapping for an entity's raw text by searching the OCR text.
 * Uses case-insensitive search to find position, then maps to the DB chunk
 * that covers that position.
 *
 * @param entityText - The entity's raw text value
 * @param lowerOcrText - The full OCR text, pre-lowercased
 * @param dbChunks - DB chunks ordered by chunk_index
 * @returns Object with chunk_id, character_start, character_end, page_number or nulls
 */
function findEntityChunkMapping(
  entityText: string,
  lowerOcrText: string,
  dbChunks: Chunk[]
): {
  chunk_id: string | null;
  character_start: number | null;
  character_end: number | null;
  page_number: number | null;
} {
  if (dbChunks.length === 0 || !entityText || lowerOcrText.length === 0) {
    return { chunk_id: null, character_start: null, character_end: null, page_number: null };
  }

  const lowerEntity = entityText.toLowerCase().trim();
  const pos = lowerOcrText.indexOf(lowerEntity);

  if (pos === -1) {
    return { chunk_id: null, character_start: null, character_end: null, page_number: null };
  }

  const charStart = pos;
  const charEnd = pos + entityText.trim().length;

  // Find the chunk that contains this position
  for (const chunk of dbChunks) {
    if (pos >= chunk.character_start && pos < chunk.character_end) {
      return {
        chunk_id: chunk.id,
        character_start: charStart,
        character_end: charEnd,
        page_number: chunk.page_number,
      };
    }
  }

  // Position found but no chunk covers it (edge case)
  return { chunk_id: null, character_start: charStart, character_end: charEnd, page_number: null };
}

interface FieldEntity {
  entity_type: EntityType;
  text: string;
  normalized_text: string;
  field_name: string;
  extraction_id: string;
}

/**
 * Recursively extract entities from a JSON object by matching field names
 * to the FIELD_TO_ENTITY_TYPE mapping.
 *
 * @param data - JSON object from extraction_json
 * @param extractionId - ID of the extraction record
 * @param prefix - Dot-separated prefix for nested keys
 * @returns Array of field entities found
 */
function extractFieldEntities(
  data: Record<string, unknown>,
  extractionId: string,
  prefix = ''
): FieldEntity[] {
  const entities: FieldEntity[] = [];

  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const lowerKey = key.toLowerCase();

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      entities.push(
        ...extractFieldEntities(value as Record<string, unknown>, extractionId, fullKey)
      );
      continue;
    }

    if (Array.isArray(value)) {
      // Handle arrays of values
      for (const item of value) {
        if (typeof item === 'string' && item.trim().length > 0) {
          const entityType = FIELD_TO_ENTITY_TYPE[lowerKey];
          if (entityType) {
            entities.push({
              entity_type: entityType,
              text: item.trim(),
              normalized_text: item.trim().toLowerCase(),
              field_name: fullKey,
              extraction_id: extractionId,
            });
          }
        }
      }
      continue;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const entityType = FIELD_TO_ENTITY_TYPE[lowerKey];
      if (entityType) {
        entities.push({
          entity_type: entityType,
          text: value.trim(),
          normalized_text: value.trim().toLowerCase(),
          field_name: fullKey,
          extraction_id: extractionId,
        });
      }
    }
  }

  return entities;
}

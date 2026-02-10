/**
 * Entity operations for DatabaseService
 *
 * Handles all CRUD operations for entities and entity_mentions tables.
 * Entities are named items (people, organizations, dates, amounts, etc.)
 * extracted from OCR text via Gemini analysis.
 */

import Database from 'better-sqlite3';
import { Entity, EntityMention, EntityType } from '../../../models/entity.js';
import { runWithForeignKeyCheck } from './helpers.js';

/**
 * Insert an entity record
 *
 * @param db - Database connection
 * @param entity - Entity data
 * @returns string - The entity ID
 */
export function insertEntity(
  db: Database.Database,
  entity: Entity,
): string {
  const stmt = db.prepare(`
    INSERT INTO entities (id, document_id, entity_type, raw_text, normalized_text, confidence, metadata, provenance_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      entity.id,
      entity.document_id,
      entity.entity_type,
      entity.raw_text,
      entity.normalized_text,
      entity.confidence,
      entity.metadata,
      entity.provenance_id,
      entity.created_at,
    ],
    `inserting entity: FK violation for document_id="${entity.document_id}"`
  );

  return entity.id;
}

/**
 * Insert an entity mention record
 *
 * @param db - Database connection
 * @param mention - EntityMention data
 * @returns string - The mention ID
 */
export function insertEntityMention(
  db: Database.Database,
  mention: EntityMention,
): string {
  const stmt = db.prepare(`
    INSERT INTO entity_mentions (id, entity_id, document_id, chunk_id, page_number, character_start, character_end, context_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runWithForeignKeyCheck(
    stmt,
    [
      mention.id,
      mention.entity_id,
      mention.document_id,
      mention.chunk_id,
      mention.page_number,
      mention.character_start,
      mention.character_end,
      mention.context_text,
      mention.created_at,
    ],
    `inserting entity mention: FK violation for entity_id="${mention.entity_id}"`
  );

  return mention.id;
}

/**
 * Get all entities for a document
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns Entity[] - Array of entities
 */
export function getEntitiesByDocument(db: Database.Database, documentId: string): Entity[] {
  return db.prepare(
    'SELECT * FROM entities WHERE document_id = ? ORDER BY entity_type, normalized_text'
  ).all(documentId) as Entity[];
}

/**
 * Get all mentions of an entity
 *
 * @param db - Database connection
 * @param entityId - Entity ID
 * @returns EntityMention[] - Array of mentions
 */
export function getEntityMentions(db: Database.Database, entityId: string): EntityMention[] {
  return db.prepare(
    'SELECT * FROM entity_mentions WHERE entity_id = ? ORDER BY page_number, character_start'
  ).all(entityId) as EntityMention[];
}

/**
 * Search entities by normalized text with optional type filter
 *
 * @param db - Database connection
 * @param query - Search query (uses LIKE matching)
 * @param options - Optional filters
 * @returns Entity[] - Matching entities
 */
export function searchEntities(
  db: Database.Database,
  query: string,
  options?: { entityType?: EntityType; documentFilter?: string[]; limit?: number }
): Entity[] {
  const conditions: string[] = ['normalized_text LIKE ?'];
  const params: (string | number)[] = [`%${query.toLowerCase()}%`];

  if (options?.entityType) {
    conditions.push('entity_type = ?');
    params.push(options.entityType);
  }

  if (options?.documentFilter && options.documentFilter.length > 0) {
    const placeholders = options.documentFilter.map(() => '?').join(',');
    conditions.push(`document_id IN (${placeholders})`);
    params.push(...options.documentFilter);
  }

  const limit = options?.limit ?? 50;
  params.push(limit);

  const sql = `SELECT * FROM entities WHERE ${conditions.join(' AND ')} ORDER BY confidence DESC LIMIT ?`;
  return db.prepare(sql).all(...params) as Entity[];
}

/**
 * Delete all entities and their mentions for a document
 *
 * Cascade order:
 *   1. entity_mentions (entity_mentions.entity_id -> entities.id)
 *   2. entities
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns number - Number of entities deleted
 */
export function deleteEntitiesByDocument(db: Database.Database, documentId: string): number {
  // Step 1: Delete mentions for all entities of this document
  db.prepare(
    'DELETE FROM entity_mentions WHERE entity_id IN (SELECT id FROM entities WHERE document_id = ?)'
  ).run(documentId);

  // Step 2: Delete the entities themselves
  const result = db.prepare('DELETE FROM entities WHERE document_id = ?').run(documentId);
  return result.changes;
}


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
import { escapeLikePattern } from '../../../utils/validation.js';

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
  const conditions: string[] = ["normalized_text LIKE ? ESCAPE '\\'"];
  const params: (string | number)[] = [`%${escapeLikePattern(query.toLowerCase())}%`];

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
 *   1. node_entity_links (node_entity_links.entity_id -> entities.id)
 *   2. entity_mentions (entity_mentions.entity_id -> entities.id)
 *   3. entities
 *
 * Note: Knowledge graph nodes/edges are NOT deleted here — they persist as
 * the KG may reference entities from other documents. Use cleanupGraphForDocument()
 * for full document deletion cleanup.
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns number - Number of entities deleted
 */
export function deleteEntitiesByDocument(db: Database.Database, documentId: string): number {
  const deleteAll = db.transaction(() => {
    // Step 0: Decrement document_count on linked KG nodes before removing links
    db.prepare(`
      UPDATE knowledge_nodes SET document_count = MAX(0, document_count - 1)
      WHERE id IN (
        SELECT DISTINCT nel.node_id FROM node_entity_links nel
        JOIN entities e ON nel.entity_id = e.id
        WHERE e.document_id = ?
      )
    `).run(documentId);

    // Step 1: Delete KG node-entity links for entities of this document
    db.prepare(
      'DELETE FROM node_entity_links WHERE entity_id IN (SELECT id FROM entities WHERE document_id = ?)'
    ).run(documentId);

    // Step 2: Delete mentions for all entities of this document
    db.prepare(
      'DELETE FROM entity_mentions WHERE entity_id IN (SELECT id FROM entities WHERE document_id = ?)'
    ).run(documentId);

    // Step 3: Delete the entities themselves
    const result = db.prepare('DELETE FROM entities WHERE document_id = ?').run(documentId);
    return result.changes;
  });

  return deleteAll();
}

/**
 * Get all entities for a document as a Map keyed by "type::normalized_text".
 * Used for incremental re-extraction diffing.
 *
 * @param db - Database connection
 * @param documentId - Document ID
 * @returns Map<string, Entity> - Keyed entity map
 */
export function getEntitiesByDocumentKeyed(db: Database.Database, documentId: string): Map<string, Entity> {
  const entities = getEntitiesByDocument(db, documentId);
  const map = new Map<string, Entity>();
  for (const e of entities) {
    map.set(`${e.entity_type}::${e.normalized_text}`, e);
  }
  return map;
}

/**
 * Delete a single entity and its mentions + KG node_entity_links.
 * Does NOT delete the KG node itself (it may be linked to other entities).
 *
 * @param db - Database connection
 * @param entityId - Entity ID to delete
 */
export function deleteEntity(db: Database.Database, entityId: string): void {
  db.prepare('DELETE FROM node_entity_links WHERE entity_id = ?').run(entityId);
  db.prepare('DELETE FROM entity_mentions WHERE entity_id = ?').run(entityId);
  db.prepare('DELETE FROM entities WHERE id = ?').run(entityId);
}

/**
 * Update entity confidence and metadata.
 *
 * @param db - Database connection
 * @param entityId - Entity ID
 * @param confidence - New confidence value
 * @param metadata - New metadata JSON string (or null)
 */
export function updateEntityConfidence(
  db: Database.Database,
  entityId: string,
  confidence: number,
  metadata: string | null,
): void {
  db.prepare('UPDATE entities SET confidence = ?, metadata = ? WHERE id = ?').run(confidence, metadata, entityId);
}


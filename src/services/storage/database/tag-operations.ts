/**
 * Tag Operations for DatabaseService
 *
 * Provides CRUD operations for tags and entity_tags tables.
 * Tags are user-defined annotations for cross-entity tagging.
 *
 * @module database/tag-operations
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Tag {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
}

export interface TagWithCount extends Tag {
  usage_count: number;
}

export interface EntityTagResult {
  entity_id: string;
  entity_type: string;
  tags: string[];
}

// Valid entity types for tagging
export const VALID_ENTITY_TYPES = ['document', 'chunk', 'image', 'extraction', 'cluster'] as const;
export type EntityType = (typeof VALID_ENTITY_TYPES)[number];

// ═══════════════════════════════════════════════════════════════════════════════
// TAG CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new tag
 * @throws Error if tag name already exists
 */
export function createTag(
  db: Database.Database,
  tag: { name: string; description?: string; color?: string }
): Tag {
  const id = uuidv4();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO tags (id, name, description, color, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, tag.name, tag.description ?? null, tag.color ?? null, now);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new Error(`Tag with name "${tag.name}" already exists`);
    }
    throw error;
  }

  return {
    id,
    name: tag.name,
    description: tag.description ?? null,
    color: tag.color ?? null,
    created_at: now,
  };
}

/**
 * Get a tag by its name
 */
export function getTagByName(db: Database.Database, name: string): Tag | null {
  const row = db.prepare('SELECT * FROM tags WHERE name = ?').get(name) as Tag | undefined;
  return row ?? null;
}

/**
 * Get all tags
 */
export function getAllTags(db: Database.Database): Tag[] {
  return db.prepare('SELECT * FROM tags ORDER BY name LIMIT 10000').all() as Tag[];
}

/**
 * Get all tags with usage counts
 */
export function getTagsWithCounts(db: Database.Database): TagWithCount[] {
  return db
    .prepare(
      `SELECT t.*, COUNT(et.id) as usage_count
       FROM tags t
       LEFT JOIN entity_tags et ON et.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name
       LIMIT 10000`
    )
    .all() as TagWithCount[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY TAG OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply a tag to an entity
 * @returns The entity_tags record ID
 * @throws Error if tag/entity_tag combination already exists
 */
export function applyTag(
  db: Database.Database,
  tagId: string,
  entityId: string,
  entityType: string
): string {
  const id = uuidv4();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO entity_tags (id, tag_id, entity_id, entity_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, tagId, entityId, entityType, now);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new Error(
        `Tag is already applied to this ${entityType} (entity_id: ${entityId})`
      );
    }
    throw error;
  }

  return id;
}

/**
 * Remove a tag from an entity
 * @returns true if a row was deleted, false if nothing to remove
 */
export function removeTag(
  db: Database.Database,
  tagId: string,
  entityId: string,
  entityType: string
): boolean {
  const result = db
    .prepare(
      `DELETE FROM entity_tags WHERE tag_id = ? AND entity_id = ? AND entity_type = ?`
    )
    .run(tagId, entityId, entityType);
  return result.changes > 0;
}

/**
 * Get all tags for an entity
 */
export function getTagsForEntity(
  db: Database.Database,
  entityId: string,
  entityType: string
): Tag[] {
  return db
    .prepare(
      `SELECT t.*
       FROM tags t
       INNER JOIN entity_tags et ON et.tag_id = t.id
       WHERE et.entity_id = ? AND et.entity_type = ?
       ORDER BY t.name`
    )
    .all(entityId, entityType) as Tag[];
}

/**
 * Search for entities that have specified tags
 *
 * @param tagNames - Array of tag names to search for
 * @param entityType - Optional filter by entity type
 * @param matchAll - If true, entity must have ALL tags. If false, ANY tag matches.
 */
export function searchByTags(
  db: Database.Database,
  tagNames: string[],
  entityType?: string,
  matchAll?: boolean
): EntityTagResult[] {
  if (tagNames.length === 0) {
    return [];
  }

  const placeholders = tagNames.map(() => '?').join(',');
  const params: (string | number)[] = [...tagNames];

  let entityTypeClause = '';
  if (entityType) {
    entityTypeClause = 'AND et.entity_type = ?';
    params.push(entityType);
  }

  const havingClause = matchAll
    ? `HAVING COUNT(DISTINCT t.name) = ?`
    : '';

  if (matchAll) {
    params.push(tagNames.length);
  }

  const sql = `
    SELECT et.entity_id, et.entity_type,
      (SELECT JSON_GROUP_ARRAY(sub.name) FROM (
        SELECT DISTINCT t2.name
        FROM tags t2
        INNER JOIN entity_tags et2 ON et2.tag_id = t2.id
        WHERE et2.entity_id = et.entity_id AND et2.entity_type = et.entity_type
        AND t2.name IN (${placeholders})
      ) sub) as tag_names
    FROM entity_tags et
    INNER JOIN tags t ON t.id = et.tag_id
    WHERE t.name IN (${placeholders})
    ${entityTypeClause}
    GROUP BY et.entity_id, et.entity_type
    ${havingClause}
    ORDER BY et.entity_id
    LIMIT 10000
  `;

  // Parameters: tagNames for subquery IN, then tagNames + entityType? + matchCount? for outer query
  const allParams: (string | number)[] = [...tagNames, ...params];

  const rows = db.prepare(sql).all(...allParams) as Array<{
    entity_id: string;
    entity_type: string;
    tag_names: string;
  }>;
  return rows.map((row) => ({
    entity_id: row.entity_id,
    entity_type: row.entity_type,
    tags: JSON.parse(row.tag_names) as string[],
  }));
}

/**
 * Delete a tag and all its entity associations (CASCADE)
 * @returns The number of entity_tag associations that were removed
 */
export function deleteTag(db: Database.Database, tagId: string): number {
  // Count associations before delete (CASCADE will remove them)
  const countRow = db
    .prepare('SELECT COUNT(*) as cnt FROM entity_tags WHERE tag_id = ?')
    .get(tagId) as { cnt: number };
  const associationCount = countRow.cnt;

  const result = db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
  if (result.changes === 0) {
    throw new Error(`Tag not found: ${tagId}`);
  }

  return associationCount;
}

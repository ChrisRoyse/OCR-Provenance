/**
 * Cross-Entity Tagging Tools
 *
 * Provides 6 MCP tools for creating, applying, searching, and deleting
 * user-defined tags across documents, chunks, images, extractions, and clusters.
 *
 * Tags are user annotations - no provenance records are created.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 *
 * @module tools/tags
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';
import { VALID_ENTITY_TYPES } from '../services/storage/database/tag-operations.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY TYPE SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

const entityTypeSchema = z.enum(['document', 'chunk', 'image', 'extraction', 'cluster']);

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 9.1: ocr_tag_create
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTagCreate(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(500).optional(),
        color: z.string().max(50).optional(),
      }),
      params
    );

    const { db } = requireDatabase();
    const tag = db.createTag({
      name: input.name,
      description: input.description,
      color: input.color,
    });

    return formatResponse(
      successResult({
        tag,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 9.2: ocr_tag_list
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTagList(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    validateInput(z.object({}), params);

    const { db } = requireDatabase();
    const tags = db.getTagsWithCounts();

    return formatResponse(
      successResult({
        tags,
        total: tags.length,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 9.3: ocr_tag_apply
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTagApply(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        tag_name: z.string().min(1),
        entity_id: z.string().min(1),
        entity_type: entityTypeSchema,
      }),
      params
    );

    const { db } = requireDatabase();

    // Look up tag by name
    const tag = db.getTagByName(input.tag_name);
    if (!tag) {
      throw new Error(`Tag not found: "${input.tag_name}"`);
    }

    // Verify entity exists
    verifyEntityExists(db, input.entity_id, input.entity_type);

    // Apply tag
    const entityTagId = db.applyTag(tag.id, input.entity_id, input.entity_type);

    return formatResponse(
      successResult({
        entity_tag_id: entityTagId,
        tag_id: tag.id,
        tag_name: tag.name,
        entity_id: input.entity_id,
        entity_type: input.entity_type,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 9.4: ocr_tag_remove
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTagRemove(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        tag_name: z.string().min(1),
        entity_id: z.string().min(1),
        entity_type: entityTypeSchema,
      }),
      params
    );

    const { db } = requireDatabase();

    // Look up tag by name
    const tag = db.getTagByName(input.tag_name);
    if (!tag) {
      throw new Error(`Tag not found: "${input.tag_name}"`);
    }

    const removed = db.removeTag(tag.id, input.entity_id, input.entity_type);
    if (!removed) {
      throw new Error(
        `Tag "${input.tag_name}" is not applied to ${input.entity_type} ${input.entity_id}`
      );
    }

    return formatResponse(
      successResult({
        removed: true,
        tag_name: input.tag_name,
        entity_id: input.entity_id,
        entity_type: input.entity_type,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 9.5: ocr_tag_search
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTagSearch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        tags: z.array(z.string().min(1)).min(1),
        entity_type: entityTypeSchema.optional(),
        match_all: z.boolean().default(false),
      }),
      params
    );

    const { db } = requireDatabase();

    const results = db.searchByTags(input.tags, input.entity_type, input.match_all);

    return formatResponse(
      successResult({
        results,
        total: results.length,
        query: {
          tags: input.tags,
          entity_type: input.entity_type ?? null,
          match_all: input.match_all,
        },
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 9.6: ocr_tag_delete
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTagDelete(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(
      z.object({
        tag_name: z.string().min(1),
        confirm: z.literal(true),
      }),
      params
    );

    const { db } = requireDatabase();

    // Look up tag by name
    const tag = db.getTagByName(input.tag_name);
    if (!tag) {
      throw new Error(`Tag not found: "${input.tag_name}"`);
    }

    const deletedCount = db.deleteTag(tag.id);

    return formatResponse(
      successResult({
        deleted: true,
        tag_name: input.tag_name,
        tag_id: tag.id,
        associations_removed: deletedCount,
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify that the entity referenced by entity_id and entity_type actually exists.
 * Throws an error if the entity does not exist.
 */
function verifyEntityExists(
  db: ReturnType<typeof requireDatabase>['db'],
  entityId: string,
  entityType: string
): void {
  const conn = db.getConnection();

  const tableMap: Record<string, string> = {
    document: 'documents',
    chunk: 'chunks',
    image: 'images',
    extraction: 'extractions',
    cluster: 'clusters',
  };

  const tableName = tableMap[entityType];
  if (!tableName) {
    throw new Error(`Invalid entity type: ${entityType}. Valid types: ${VALID_ENTITY_TYPES.join(', ')}`);
  }

  const row = conn.prepare(`SELECT id FROM ${tableName} WHERE id = ?`).get(entityId);
  if (!row) {
    throw new Error(`${entityType} not found: ${entityId}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const tagTools: Record<string, ToolDefinition> = {
  ocr_tag_create: {
    description:
      'Create a new tag for cross-entity annotation. Tags can be applied to documents, chunks, images, extractions, and clusters.',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Tag name (must be unique)'),
      description: z.string().max(500).optional().describe('Tag description'),
      color: z.string().max(50).optional().describe('Tag color (e.g., "#ff0000", "red")'),
    },
    handler: handleTagCreate,
  },

  ocr_tag_list: {
    description: 'List all tags with usage counts showing how many entities each tag is applied to.',
    inputSchema: {},
    handler: handleTagList,
  },

  ocr_tag_apply: {
    description:
      'Apply a tag to an entity (document, chunk, image, extraction, or cluster). The tag must exist and the entity must exist.',
    inputSchema: {
      tag_name: z.string().min(1).describe('Name of the tag to apply'),
      entity_id: z.string().min(1).describe('ID of the entity to tag'),
      entity_type: entityTypeSchema.describe(
        'Type of entity: document, chunk, image, extraction, or cluster'
      ),
    },
    handler: handleTagApply,
  },

  ocr_tag_remove: {
    description: 'Remove a tag from an entity.',
    inputSchema: {
      tag_name: z.string().min(1).describe('Name of the tag to remove'),
      entity_id: z.string().min(1).describe('ID of the entity to untag'),
      entity_type: entityTypeSchema.describe(
        'Type of entity: document, chunk, image, extraction, or cluster'
      ),
    },
    handler: handleTagRemove,
  },

  ocr_tag_search: {
    description:
      'Find entities that have specified tags. Use match_all=true to require ALL tags, or false (default) for ANY tag.',
    inputSchema: {
      tags: z
        .array(z.string().min(1))
        .min(1)
        .describe('Tag names to search for'),
      entity_type: entityTypeSchema
        .optional()
        .describe('Filter by entity type: document, chunk, image, extraction, or cluster'),
      match_all: z
        .boolean()
        .default(false)
        .describe('If true, entity must have ALL specified tags. If false, ANY tag matches.'),
    },
    handler: handleTagSearch,
  },

  ocr_tag_delete: {
    description:
      'Delete a tag and remove all its entity associations. Requires confirm=true.',
    inputSchema: {
      tag_name: z.string().min(1).describe('Name of the tag to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleTagDelete,
  },
};

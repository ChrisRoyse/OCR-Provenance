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
import { logAudit } from '../services/audit.js';

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

    logAudit({
      action: 'tag_create',
      entityType: 'tag',
      entityId: tag.id,
      details: { tag_name: input.name },
    });

    return formatResponse(
      successResult({
        tag,
        next_steps: [
          { tool: 'ocr_tag_apply', description: 'Apply this tag to a document, chunk, or image' },
        ],
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
        next_steps:
          tags.length === 0
            ? [
                { tool: 'ocr_tag_create', description: 'Create a tag to organize documents' },
                { tool: 'ocr_document_list', description: 'Browse documents to tag' },
              ]
            : [
                { tool: 'ocr_tag_apply', description: 'Apply a tag to an entity' },
                { tool: 'ocr_tag_search', description: 'Find entities by tag' },
                { tool: 'ocr_tag_create', description: 'Create a new tag' },
              ],
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

    logAudit({
      action: 'tag_apply',
      entityType: input.entity_type,
      entityId: input.entity_id,
      details: { tag_name: input.tag_name, tag_id: tag.id },
    });

    return formatResponse(
      successResult({
        entity_tag_id: entityTagId,
        tag_id: tag.id,
        tag_name: tag.name,
        entity_id: input.entity_id,
        entity_type: input.entity_type,
        next_steps: [{ tool: 'ocr_tag_search', description: 'Find all entities with this tag' }],
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

    logAudit({
      action: 'tag_remove',
      entityType: input.entity_type,
      entityId: input.entity_id,
      details: { tag_name: input.tag_name, tag_id: tag.id },
    });

    return formatResponse(
      successResult({
        removed: true,
        tag_name: input.tag_name,
        entity_id: input.entity_id,
        entity_type: input.entity_type,
        next_steps: [
          { tool: 'ocr_tag_list', description: 'View remaining tags and their usage' },
          { tool: 'ocr_tag_search', description: 'Find other entities with this tag' },
        ],
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
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum results (default 50)'),
        offset: z.number().int().min(0).default(0).describe('Number of results to skip for pagination'),
      }),
      params
    );

    const { db } = requireDatabase();

    const allResults = db.searchByTags(input.tags, input.entity_type, input.match_all);

    // Apply pagination
    const tagOffset = input.offset ?? 0;
    const tagLimit = input.limit ?? 50;
    const totalCount = allResults.length;
    const paginated = allResults.slice(tagOffset, tagOffset + tagLimit);
    const hasMore = tagOffset + tagLimit < totalCount;

    const nextSteps: Array<{ tool: string; description: string }> = [];
    if (hasMore) {
      nextSteps.push({
        tool: 'ocr_tag_search',
        description: `Get next page (offset=${tagOffset + tagLimit})`,
      });
    }
    nextSteps.push(
      { tool: 'ocr_document_get', description: 'Get details for a tagged document' },
      { tool: 'ocr_tag_apply', description: 'Apply another tag to results' },
    );

    return formatResponse(
      successResult({
        results: paginated,
        total: totalCount,
        returned: paginated.length,
        offset: tagOffset,
        limit: tagLimit,
        has_more: hasMore,
        query: {
          tags: input.tags,
          entity_type: input.entity_type ?? null,
          match_all: input.match_all,
        },
        next_steps: nextSteps,
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
        next_steps: [{ tool: 'ocr_tag_list', description: 'List remaining tags' }],
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
    throw new Error(
      `Invalid entity type: ${entityType}. Valid types: ${VALID_ENTITY_TYPES.join(', ')}`
    );
  }

  // Table name from hardcoded whitelist (tableMap) - safe from injection
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
      '[ANALYSIS] Use to create a reusable tag for annotating documents, chunks, images, extractions, or clusters. Returns the new tag ID. Follow with ocr_tag_apply to attach it to entities.',
    inputSchema: {
      name: z.string().min(1).max(200).describe('Tag name (must be unique)'),
      description: z.string().max(500).optional().describe('Tag description'),
      color: z.string().max(50).optional().describe('Tag color (e.g., "#ff0000", "red")'),
    },
    handler: handleTagCreate,
  },

  ocr_tag_list: {
    description:
      '[ANALYSIS] Use to see all available tags and how many entities each is applied to. Returns tag names, descriptions, colors, and usage counts.',
    inputSchema: {},
    handler: handleTagList,
  },

  ocr_tag_apply: {
    description:
      '[MANAGE] Use to attach a tag to an entity (document, chunk, image, extraction, or cluster). Returns the association ID. Tag must exist (use ocr_tag_create first).',
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
    description:
      '[MANAGE] Use to detach a tag from an entity. Returns confirmation. Does not delete the tag itself.',
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
      '[ANALYSIS] Find entities by tag. Paginated (default 50). Set match_all=true to require ALL tags, or false for ANY tag.',
    inputSchema: {
      tags: z.array(z.string().min(1)).min(1).describe('Tag names to search for'),
      entity_type: entityTypeSchema
        .optional()
        .describe('Filter by entity type: document, chunk, image, extraction, or cluster'),
      match_all: z
        .boolean()
        .default(false)
        .describe('If true, entity must have ALL specified tags. If false, ANY tag matches.'),
      limit: z.number().int().min(1).max(200).default(50).describe('Maximum results (default 50)'),
      offset: z.number().int().min(0).default(0).describe('Number of results to skip for pagination'),
    },
    handler: handleTagSearch,
  },

  ocr_tag_delete: {
    description:
      '[ANALYSIS] Use to permanently delete a tag and all its entity associations. Returns count of removed associations. Requires confirm=true.',
    inputSchema: {
      tag_name: z.string().min(1).describe('Name of the tag to delete'),
      confirm: z.literal(true).describe('Must be true to confirm deletion'),
    },
    handler: handleTagDelete,
  },
};

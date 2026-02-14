/**
 * Form Fill MCP Tools
 *
 * Tools for filling forms using Datalab API.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/form-fill
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse, handleError, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { FormFillClient } from '../services/ocr/form-fill.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import {
  listKnowledgeNodes,
} from '../services/storage/database/knowledge-graph-operations.js';

const FormFillInput = z.object({
  file_path: z.string().min(1).describe('Path to form file (PDF or image)'),
  field_data: z.record(z.object({
    value: z.string(),
    description: z.string().optional(),
  })).describe('Field names mapped to values and descriptions'),
  context: z.string().optional().describe('Additional context for field matching'),
  confidence_threshold: z.number().min(0).max(1).default(0.5).describe('Confidence threshold (0-1)'),
  page_range: z.string().optional().describe('Page range, 0-indexed'),
  output_path: z.string().optional().describe('Path to save filled form PDF'),
});

const FormFillStatusInput = z.object({
  form_fill_id: z.string().optional().describe('Specific form fill ID to retrieve'),
  status_filter: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('all'),
  search_query: z.string().optional().describe('Search form fills by field values, file path (LIKE match)'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
});

async function handleFormFill(params: Record<string, unknown>) {
  try {
    const input = validateInput(FormFillInput, params);
    const { db } = requireDatabase();

    const client = new FormFillClient();

    const result = await client.fillForm(input.file_path, {
      fieldData: input.field_data,
      context: input.context,
      confidenceThreshold: input.confidence_threshold,
      pageRange: input.page_range,
    });

    // Save PDF to disk if output_path provided and we have output
    if (input.output_path && result.outputBase64) {
      const { writeFileSync, mkdirSync } = await import('fs');
      const { dirname: dirPath } = await import('path');
      mkdirSync(dirPath(input.output_path), { recursive: true });
      writeFileSync(input.output_path, Buffer.from(result.outputBase64, 'base64'));
      console.error(`[INFO] Saved filled form to ${input.output_path}`);
    }

    // Create provenance record
    const provId = uuidv4();
    const now = new Date().toISOString();
    const contentHash = computeHash(JSON.stringify({
      fields_filled: result.fieldsFilled,
      fields_not_found: result.fieldsNotFound,
    }));

    db.insertProvenance({
      id: provId,
      type: ProvenanceType.FORM_FILL,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'FORM_FILL',
      source_path: input.file_path,
      source_id: null,
      root_document_id: provId, // Self-referencing for standalone form fills
      location: null,
      content_hash: contentHash,
      input_hash: result.sourceFileHash,
      file_hash: result.sourceFileHash,
      processor: 'datalab-form-fill',
      processor_version: '1.0.0',
      processing_params: {
        field_count: Object.keys(input.field_data).length,
        confidence_threshold: input.confidence_threshold,
        has_context: !!input.context,
      },
      processing_duration_ms: result.processingDurationMs,
      processing_quality_score: null,
      parent_id: null,
      parent_ids: JSON.stringify([]),
      chain_depth: 0,
      chain_path: JSON.stringify(['FORM_FILL']),
    });

    // Store in database
    db.insertFormFill({
      id: result.id,
      source_file_path: result.sourceFilePath,
      source_file_hash: result.sourceFileHash,
      field_data_json: JSON.stringify(input.field_data),
      context: input.context ?? null,
      confidence_threshold: input.confidence_threshold ?? 0.5,
      output_file_path: input.output_path ?? null,
      output_base64: result.outputBase64,
      fields_filled: JSON.stringify(result.fieldsFilled),
      fields_not_found: JSON.stringify(result.fieldsNotFound),
      page_count: result.pageCount,
      cost_cents: result.costCents,
      status: result.status,
      error_message: result.error,
      provenance_id: provId,
      created_at: now,
    });

    return formatResponse({
      id: result.id,
      status: result.status,
      fields_filled: result.fieldsFilled,
      fields_not_found: result.fieldsNotFound,
      page_count: result.pageCount,
      cost_cents: result.costCents,
      output_saved: input.output_path ? true : false,
      provenance_id: provId,
      processing_duration_ms: result.processingDurationMs,
    });
  } catch (error) {
    return handleError(error);
  }
}

async function handleFormFillStatus(params: Record<string, unknown>) {
  try {
    const input = validateInput(FormFillStatusInput, params);
    const { db } = requireDatabase();

    if (input.form_fill_id) {
      const formFill = db.getFormFill(input.form_fill_id);
      if (!formFill) {
        return formatResponse({ error: `Form fill not found: ${input.form_fill_id}` });
      }
      return formatResponse({
        form_fill: {
          ...formFill,
          // Parse JSON strings for display
          fields_filled: JSON.parse(formFill.fields_filled || '[]'),
          fields_not_found: JSON.parse(formFill.fields_not_found || '[]'),
          field_data: JSON.parse(formFill.field_data_json || '{}'),
          // Don't include base64 in status response
          output_base64: formFill.output_base64 ? '[base64 data available]' : null,
        },
      });
    }

    // If search_query is provided, use search instead of list
    if (input.search_query) {
      const searchResults = db.searchFormFills(input.search_query, { limit: input.limit, offset: input.offset });
      return formatResponse({
        total: searchResults.length,
        search_query: input.search_query,
        form_fills: searchResults.map(ff => ({
          id: ff.id,
          source_file_path: ff.source_file_path,
          status: ff.status,
          fields_filled: JSON.parse(ff.fields_filled || '[]').length,
          fields_not_found: JSON.parse(ff.fields_not_found || '[]').length,
          cost_cents: ff.cost_cents,
          created_at: ff.created_at,
          error_message: ff.error_message,
        })),
      });
    }

    const statusFilter = input.status_filter === 'all' ? undefined : input.status_filter;
    const formFills = db.listFormFills({ status: statusFilter, limit: input.limit, offset: input.offset });

    return formatResponse({
      total: formFills.length,
      form_fills: formFills.map(ff => ({
        id: ff.id,
        source_file_path: ff.source_file_path,
        status: ff.status,
        fields_filled: JSON.parse(ff.fields_filled || '[]').length,
        fields_not_found: JSON.parse(ff.fields_not_found || '[]').length,
        cost_cents: ff.cost_cents,
        created_at: ff.created_at,
        error_message: ff.error_message,
      })),
    });
  } catch (error) {
    return handleError(error);
  }
}

const FormFillSuggestFieldsInput = z.object({
  document_id: z.string().min(1).describe('Document ID to suggest field values from'),
  field_names: z.array(z.string().min(1)).min(1)
    .describe('Field names to find entity values for (e.g., ["patient_name", "date_of_birth", "address"])'),
  entity_types: z.array(z.enum([
    'person', 'organization', 'date', 'amount', 'case_number',
    'location', 'statute', 'exhibit', 'medication', 'diagnosis', 'medical_device', 'other',
  ])).optional().describe('Limit suggestions to specific entity types'),
});

function inferEntityTypeFromFieldName(fieldName: string): string | null {
  const lower = fieldName.toLowerCase().replace(/[_-]/g, ' ');
  if (/name|patient|client|attorney|doctor|nurse|physician|guardian/.test(lower)) return 'person';
  if (/org|company|employer|hospital|clinic|facility|institution|firm/.test(lower)) return 'organization';
  if (/date|dob|birth|effective|filed|admitted|discharged|signed/.test(lower)) return 'date';
  if (/amount|total|fee|cost|price|balance|payment|charge/.test(lower)) return 'amount';
  if (/case|docket|file|claim|number|mrn|id/.test(lower)) return 'case_number';
  if (/address|city|state|zip|county|location|place/.test(lower)) return 'location';
  if (/statute|law|code|regulation|section/.test(lower)) return 'statute';
  if (/exhibit|attachment|appendix/.test(lower)) return 'exhibit';
  if (/medication|drug|prescription|rx/.test(lower)) return 'medication';
  if (/diagnosis|condition|icd|disease/.test(lower)) return 'diagnosis';
  return null;
}

async function handleFormFillSuggestFields(params: Record<string, unknown>) {
  try {
    const input = validateInput(FormFillSuggestFieldsInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const entities = conn.prepare(`
      SELECT e.id, e.raw_text, e.entity_type, e.confidence, e.normalized_text,
             COUNT(em.id) as mention_count
      FROM entities e
      LEFT JOIN entity_mentions em ON em.entity_id = e.id
      WHERE e.document_id = ?
      GROUP BY e.id
      ORDER BY e.confidence DESC, mention_count DESC
    `).all(input.document_id) as Array<{
      id: string; raw_text: string; entity_type: string;
      confidence: number; normalized_text: string; mention_count: number;
    }>;

    if (entities.length === 0) {
      return formatResponse(successResult({
        document_id: input.document_id,
        suggestions: {},
        message: 'No entities found for this document. Run ocr_entity_extract first.',
      }));
    }

    let kgNodes: Array<{ canonical_name: string; entity_type: string; document_count: number; avg_confidence: number }> = [];
    try {
      kgNodes = listKnowledgeNodes(conn, {
        document_filter: [input.document_id],
        limit: 200,
      }).map(n => ({
        canonical_name: n.canonical_name,
        entity_type: n.entity_type,
        document_count: n.document_count,
        avg_confidence: n.avg_confidence,
      }));
    } catch {
      // KG may not exist yet
    }

    const suggestions: Record<string, Array<{
      value: string; entity_type: string; confidence: number;
      source: 'entity' | 'knowledge_graph';
      mention_count?: number; document_count?: number;
    }>> = {};

    const entityTypeFilter = input.entity_types ? new Set<string>(input.entity_types) : null;

    for (const fieldName of input.field_names) {
      const inferredType = inferEntityTypeFromFieldName(fieldName);
      const candidates: Array<{
        value: string; entity_type: string; confidence: number;
        source: 'entity' | 'knowledge_graph';
        mention_count?: number; document_count?: number;
      }> = [];

      for (const entity of entities) {
        if (entityTypeFilter && !entityTypeFilter.has(entity.entity_type)) continue;
        if (inferredType && entity.entity_type !== inferredType) continue;
        candidates.push({
          value: entity.raw_text,
          entity_type: entity.entity_type,
          confidence: entity.confidence,
          source: 'entity',
          mention_count: entity.mention_count,
        });
      }

      for (const node of kgNodes) {
        if (entityTypeFilter && !entityTypeFilter.has(node.entity_type)) continue;
        if (inferredType && node.entity_type !== inferredType) continue;
        if (!candidates.some(c => c.value === node.canonical_name)) {
          candidates.push({
            value: node.canonical_name,
            entity_type: node.entity_type,
            confidence: node.avg_confidence,
            source: 'knowledge_graph',
            document_count: node.document_count,
          });
        }
      }

      candidates.sort((a, b) => b.confidence - a.confidence);
      suggestions[fieldName] = candidates.slice(0, 5);
    }

    return formatResponse(successResult({
      document_id: input.document_id,
      total_entities: entities.length,
      total_kg_nodes: kgNodes.length,
      suggestions,
    }));
  } catch (error) {
    return handleError(error);
  }
}

export const formFillTools: Record<string, ToolDefinition> = {
  'ocr_form_fill': {
    description: 'Fill a PDF or image form using Datalab API. Provide field names and values, optionally save filled form to disk.',
    inputSchema: FormFillInput.shape,
    handler: handleFormFill,
  },
  'ocr_form_fill_status': {
    description: 'Get status and details of form fill operations',
    inputSchema: FormFillStatusInput.shape,
    handler: handleFormFillStatus,
  },
  'ocr_form_fill_suggest_fields': {
    description: 'Suggest field values for form filling from extracted entities and knowledge graph. Maps field names to entity types and returns ranked suggestions.',
    inputSchema: FormFillSuggestFieldsInput.shape,
    handler: handleFormFillSuggestFields,
  },
};

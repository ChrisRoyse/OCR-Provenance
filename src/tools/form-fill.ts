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
import {
  formatResponse,
  handleError,
  fetchProvenanceChain,
  type ToolDefinition,
} from './shared.js';
import { validateInput, sanitizePath } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { FormFillClient } from '../services/ocr/form-fill.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';

/**
 * Safely parse JSON from stored form fill data. Returns fallback on corrupt data
 * instead of crashing the entire tool handler.
 */
function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    console.error(
      `[form-fill] Failed to parse stored JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    return fallback;
  }
}

const FormFillInput = z.object({
  file_path: z.string().min(1).describe('Path to form file (PDF or image)'),
  field_data: z
    .record(
      z.object({
        value: z.string(),
        description: z.string().optional(),
      })
    )
    .describe('Field names mapped to values and descriptions'),
  context: z.string().optional().describe('Additional context for field matching'),
  confidence_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Confidence threshold (0-1)'),
  page_range: z.string().optional().describe('Page range, 0-indexed'),
  output_path: z.string().optional().describe('Path to save filled form PDF'),
});

const FormFillStatusInput = z.object({
  form_fill_id: z.string().optional().describe('Specific form fill ID to retrieve'),
  status_filter: z.enum(['pending', 'processing', 'complete', 'failed', 'all']).default('all'),
  search_query: z
    .string()
    .optional()
    .describe('Search form fills by field values, file path (LIKE match)'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
  include_provenance: z
    .boolean()
    .default(false)
    .describe('Include provenance chain when retrieving a specific form fill'),
});

async function handleFormFill(params: Record<string, unknown>) {
  try {
    const input = validateInput(FormFillInput, params);
    const { db } = requireDatabase();

    const client = new FormFillClient();

    const safeFilePath = sanitizePath(input.file_path);
    const result = await client.fillForm(safeFilePath, {
      fieldData: input.field_data,
      context: input.context,
      confidenceThreshold: input.confidence_threshold,
      pageRange: input.page_range,
    });

    // Save PDF to disk if output_path provided and we have output
    if (input.output_path && result.outputBase64) {
      const { writeFileSync, mkdirSync } = await import('fs');
      const { dirname: dirPath } = await import('path');
      const safeOutputPath = sanitizePath(input.output_path);
      mkdirSync(dirPath(safeOutputPath), { recursive: true });
      writeFileSync(safeOutputPath, Buffer.from(result.outputBase64, 'base64'));
      console.error(`[INFO] Saved filled form to ${safeOutputPath}`);
    }

    // Create provenance record
    const provId = uuidv4();
    const now = new Date().toISOString();
    const contentHash = computeHash(
      JSON.stringify({
        fields_filled: result.fieldsFilled,
        fields_not_found: result.fieldsNotFound,
      })
    );

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

    const response: Record<string, unknown> = {
      id: result.id,
      status: result.status,
      fields_filled: result.fieldsFilled,
      fields_not_found: result.fieldsNotFound,
      page_count: result.pageCount,
      cost_cents: result.costCents,
      output_saved: !!input.output_path,
      provenance_id: provId,
      processing_duration_ms: result.processingDurationMs,
    };

    return formatResponse(successResult({
      ...response,
      next_steps: [{ tool: 'ocr_form_fill_status', description: 'Check the form fill result' }],
    }));
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
        throw new Error(`Form fill not found: ${input.form_fill_id}`);
      }
      const formFillResponse: Record<string, unknown> = {
        form_fill: {
          ...formFill,
          // Parse JSON strings for display (safe parse handles corrupt stored data)
          fields_filled: safeJsonParse(formFill.fields_filled, []),
          fields_not_found: safeJsonParse(formFill.fields_not_found, []),
          field_data: safeJsonParse(formFill.field_data_json, {}),
          // Don't include base64 in status response
          output_base64: formFill.output_base64 ? '[base64 data available]' : null,
        },
      };

      if (input.include_provenance) {
        formFillResponse.provenance_chain = fetchProvenanceChain(
          db,
          formFill.provenance_id,
          'form-fill'
        );
      }

      return formatResponse(successResult({
        ...formFillResponse,
        next_steps: [{ tool: 'ocr_form_fill', description: 'Submit another form fill operation' }, { tool: 'ocr_document_get', description: 'View the source document' }],
      }));
    }

    // If search_query is provided, use search instead of list
    if (input.search_query) {
      const searchResults = db.searchFormFills(input.search_query, {
        limit: input.limit,
        offset: input.offset,
      });
      return formatResponse(
        successResult({
          total: searchResults.length,
          search_query: input.search_query,
          form_fills: searchResults.map((ff) => ({
            id: ff.id,
            source_file_path: ff.source_file_path,
            status: ff.status,
            fields_filled: safeJsonParse<unknown[]>(ff.fields_filled, []).length,
            fields_not_found: safeJsonParse<unknown[]>(ff.fields_not_found, []).length,
            cost_cents: ff.cost_cents,
            created_at: ff.created_at,
            error_message: ff.error_message,
          })),
          next_steps: [{ tool: 'ocr_form_fill', description: 'Submit another form fill operation' }, { tool: 'ocr_document_get', description: 'View the source document' }],
        })
      );
    }

    const statusFilter = input.status_filter === 'all' ? undefined : input.status_filter;
    const formFills = db.listFormFills({
      status: statusFilter,
      limit: input.limit,
      offset: input.offset,
    });

    return formatResponse(
      successResult({
        total: formFills.length,
        form_fills: formFills.map((ff) => ({
          id: ff.id,
          source_file_path: ff.source_file_path,
          status: ff.status,
          fields_filled: safeJsonParse<unknown[]>(ff.fields_filled, []).length,
          fields_not_found: safeJsonParse<unknown[]>(ff.fields_not_found, []).length,
          cost_cents: ff.cost_cents,
          created_at: ff.created_at,
          error_message: ff.error_message,
        })),
        next_steps: [{ tool: 'ocr_form_fill', description: 'Submit another form fill operation' }, { tool: 'ocr_document_get', description: 'View the source document' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

export const formFillTools: Record<string, ToolDefinition> = {
  ocr_form_fill: {
    description:
      '[PROCESSING] Extract/fill key-value form fields via Datalab API. For forms, invoices, applications. Use ocr_extract_structured for page-schema extraction instead.',
    inputSchema: FormFillInput.shape,
    handler: handleFormFill,
  },
  ocr_form_fill_status: {
    description:
      '[STATUS] Use to check status or retrieve details of past form fill operations. Returns form fill records with field data and status. Use after ocr_form_fill.',
    inputSchema: FormFillStatusInput.shape,
    handler: handleFormFillStatus,
  },
};

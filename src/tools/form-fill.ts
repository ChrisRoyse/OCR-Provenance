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
import { FormFillClient } from '../services/ocr/form-fill.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';

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
  limit: z.number().int().min(1).max(100).default(50),
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

    const statusFilter = input.status_filter === 'all' ? undefined : input.status_filter;
    const formFills = db.listFormFills({ status: statusFilter, limit: input.limit });

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
};

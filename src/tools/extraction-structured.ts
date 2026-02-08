/**
 * Structured Extraction MCP Tools
 *
 * Tools for structured data extraction using Datalab page_schema.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/extraction-structured
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse, handleError, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { DatalabClient } from '../services/ocr/datalab.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';

const ExtractStructuredInput = z.object({
  document_id: z.string().min(1).describe('Document ID (must be OCR processed)'),
  page_schema: z.string().min(1).describe('JSON schema string for structured extraction per page'),
});

const ExtractionListInput = z.object({
  document_id: z.string().min(1).describe('Document ID to list extractions for'),
});

async function handleExtractStructured(params: Record<string, unknown>) {
  try {
    const input = validateInput(ExtractStructuredInput, params);
    const { db } = requireDatabase();

    // Get document - must exist and be OCR processed
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      return formatResponse({ error: `Document not found: ${input.document_id}` });
    }
    if (doc.status !== 'complete') {
      return formatResponse({ error: `Document not OCR processed yet (status: ${doc.status}). Run ocr_process_pending first.` });
    }

    // Get the OCR result for provenance chaining
    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult) {
      return formatResponse({ error: `No OCR result found for document ${doc.id}` });
    }

    // Call Datalab with page_schema to get structured extraction
    const client = new DatalabClient();

    const tempProvId = uuidv4();
    const response = await client.processDocument(
      doc.file_path,
      doc.id,
      tempProvId,
      'accurate',
      { pageSchema: input.page_schema }
    );

    if (!response.extractionJson) {
      return formatResponse({
        error: 'No extraction data returned. Verify page_schema is valid JSON schema.',
        document_id: doc.id,
      });
    }

    // Store extraction with provenance
    const extractionContent = JSON.stringify(response.extractionJson);
    const extractionHash = computeHash(extractionContent);
    const extractionProvId = uuidv4();
    const now = new Date().toISOString();

    // Create EXTRACTION provenance
    db.insertProvenance({
      id: extractionProvId,
      type: ProvenanceType.EXTRACTION,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EXTRACTION',
      source_path: doc.file_path,
      source_id: ocrResult.provenance_id,
      root_document_id: doc.provenance_id,
      location: null,
      content_hash: extractionHash,
      input_hash: ocrResult.content_hash,
      file_hash: doc.file_hash,
      processor: 'datalab-extraction',
      processor_version: '1.0.0',
      processing_params: { page_schema: input.page_schema },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: ocrResult.provenance_id,
      parent_ids: JSON.stringify([doc.provenance_id, ocrResult.provenance_id]),
      chain_depth: 2,
      chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'EXTRACTION']),
    });

    const extractionId = uuidv4();
    db.insertExtraction({
      id: extractionId,
      document_id: doc.id,
      ocr_result_id: ocrResult.id,
      schema_json: input.page_schema,
      extraction_json: extractionContent,
      content_hash: extractionHash,
      provenance_id: extractionProvId,
      created_at: now,
    });

    return formatResponse({
      extraction_id: extractionId,
      document_id: doc.id,
      extraction_data: response.extractionJson,
      content_hash: extractionHash,
      provenance_id: extractionProvId,
    });
  } catch (error) {
    return handleError(error);
  }
}

async function handleExtractionList(params: Record<string, unknown>) {
  try {
    const input = validateInput(ExtractionListInput, params);
    const { db } = requireDatabase();

    const extractions = db.getExtractionsByDocument(input.document_id);

    return formatResponse({
      document_id: input.document_id,
      total: extractions.length,
      extractions: extractions.map(ext => ({
        id: ext.id,
        schema_json: ext.schema_json,
        extraction_json: JSON.parse(ext.extraction_json),
        content_hash: ext.content_hash,
        provenance_id: ext.provenance_id,
        created_at: ext.created_at,
      })),
    });
  } catch (error) {
    return handleError(error);
  }
}

export const structuredExtractionTools: Record<string, ToolDefinition> = {
  'ocr_extract_structured': {
    description: 'Run structured extraction on an already-OCR\'d document using a JSON page_schema',
    inputSchema: ExtractStructuredInput.shape,
    handler: handleExtractStructured,
  },
  'ocr_extraction_list': {
    description: 'List all structured extractions for a document',
    inputSchema: ExtractionListInput.shape,
    handler: handleExtractionList,
  },
};

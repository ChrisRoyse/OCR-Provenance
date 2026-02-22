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

import path from 'path';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  formatResponse,
  handleError,
  fetchProvenanceChain,
  type ToolResponse,
  type ToolDefinition,
} from './shared.js';
import { successResult } from '../server/types.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { DatalabClient } from '../services/ocr/datalab.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import {
  getEmbeddingClient,
  MODEL_NAME,
  MODEL_VERSION,
  EMBEDDING_DIM,
} from '../services/embedding/nomic.js';

const ExtractStructuredInput = z.object({
  document_id: z.string().min(1).describe('Document ID (must be OCR processed)'),
  page_schema: z.string().min(1).describe('JSON schema string for structured extraction per page'),
});

const ExtractionListInput = z.object({
  document_id: z.string().min(1).describe('Document ID to list extractions for'),
});

const ExtractionGetInput = z.object({
  extraction_id: z.string().min(1).describe('Extraction ID to retrieve'),
  include_provenance: z.boolean().default(false).describe('Include provenance chain'),
});

const ExtractionSearchInput = z.object({
  query: z.string().min(1).describe('Search query to match within extraction JSON content'),
  document_filter: z.array(z.string()).optional().describe('Filter by document IDs'),
  limit: z.number().min(1).max(100).default(10).describe('Maximum results'),
  include_provenance: z.boolean().default(false).describe('Include provenance chain for each result'),
});

async function handleExtractStructured(params: Record<string, unknown>) {
  try {
    const input = validateInput(ExtractStructuredInput, params);
    const { db, vector } = requireDatabase();

    // Get document - must exist and be OCR processed
    const doc = db.getDocument(input.document_id);
    if (!doc) {
      throw new Error(`Document not found: ${input.document_id}`);
    }
    if (doc.status !== 'complete') {
      throw new Error(
        `Document not OCR processed yet (status: ${doc.status}). Run ocr_process_pending first.`
      );
    }

    // Get the OCR result for provenance chaining
    const ocrResult = db.getOCRResultByDocumentId(doc.id);
    if (!ocrResult) {
      throw new Error(`No OCR result found for document ${doc.id}`);
    }

    // Call Datalab with page_schema to get structured extraction
    const client = new DatalabClient();

    const tempProvId = uuidv4();
    const response = await client.processDocument(doc.file_path, doc.id, tempProvId, 'accurate', {
      pageSchema: input.page_schema,
    });

    if (!response.extractionJson) {
      throw new Error('No extraction data returned. Verify page_schema is valid JSON schema.');
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

    // Generate embedding for extraction content (semantic search)
    // Provenance chain: DOCUMENT(0) -> OCR_RESULT(1) -> EXTRACTION(2) -> EMBEDDING(3)
    let embeddingId: string | null = null;
    let embeddingProvId: string | null = null;
    try {
      const embeddingClient = getEmbeddingClient();
      const vectors = await embeddingClient.embedChunks([extractionContent], 1);

      if (vectors.length === 0) {
        throw new Error('Embedding generation returned empty result');
      }

      embeddingId = uuidv4();
      embeddingProvId = uuidv4();

      // EMBEDDING provenance (depth 3, parent = EXTRACTION)
      db.insertProvenance({
        id: embeddingProvId,
        type: ProvenanceType.EMBEDDING,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'EMBEDDING',
        source_path: doc.file_path,
        source_id: extractionProvId,
        root_document_id: doc.provenance_id,
        location: null,
        content_hash: extractionHash,
        input_hash: extractionHash,
        file_hash: doc.file_hash,
        processor: MODEL_NAME,
        processor_version: MODEL_VERSION,
        processing_params: { task_type: 'search_document', dimensions: EMBEDDING_DIM },
        processing_duration_ms: null,
        processing_quality_score: null,
        parent_id: extractionProvId,
        parent_ids: JSON.stringify([doc.provenance_id, ocrResult.provenance_id, extractionProvId]),
        chain_depth: 3,
        chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'EXTRACTION', 'EMBEDDING']),
      });

      // Insert embedding record
      db.insertEmbedding({
        id: embeddingId,
        chunk_id: null,
        image_id: null,
        extraction_id: extractionId,
        document_id: doc.id,
        original_text: extractionContent,
        original_text_length: extractionContent.length,
        source_file_path: doc.file_path,
        source_file_name: path.basename(doc.file_path),
        source_file_hash: doc.file_hash,
        page_number: null,
        page_range: null,
        character_start: 0,
        character_end: extractionContent.length,
        chunk_index: 0,
        total_chunks: 1,
        model_name: MODEL_NAME,
        model_version: MODEL_VERSION,
        task_type: 'search_document',
        inference_mode: 'local',
        gpu_device: 'cuda:0',
        provenance_id: embeddingProvId,
        content_hash: extractionHash,
        generation_duration_ms: null,
      });

      // Store vector in vec_embeddings
      vector.storeVector(embeddingId, vectors[0]);
    } catch (embError) {
      // Log embedding failure but don't fail the extraction itself
      // The extraction was already stored successfully
      const errMsg = embError instanceof Error ? embError.message : String(embError);
      console.error(
        `[WARN] Extraction embedding generation failed for extraction ${extractionId}: ${errMsg}`
      );
      embeddingId = null;
      embeddingProvId = null;
    }

    // Echo the schema back (parse to object if valid JSON, keep as string otherwise)
    let parsedSchema: unknown = input.page_schema;
    try {
      parsedSchema = JSON.parse(input.page_schema);
    } catch (error) {
      console.error(
        '[extraction-structured] page_schema JSON parse failed, keeping as string:',
        error instanceof Error ? error.message : String(error)
      );
      /* keep as string */
    }

    return formatResponse(
      successResult({
        extraction_id: extractionId,
        document_id: doc.id,
        schema_json: parsedSchema,
        extraction_data: response.extractionJson,
        content_hash: extractionHash,
        provenance_id: extractionProvId,
        embedding_id: embeddingId,
        embedding_provenance_id: embeddingProvId,
        next_steps: [{ tool: 'ocr_extraction_list', description: 'List all extractions for the document' }, { tool: 'ocr_extraction_get', description: 'View the extraction results in detail' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

async function handleExtractionList(params: Record<string, unknown>) {
  try {
    const input = validateInput(ExtractionListInput, params);
    const { db } = requireDatabase();

    const extractions = db.getExtractionsByDocument(input.document_id);

    return formatResponse(
      successResult({
        document_id: input.document_id,
        total: extractions.length,
        extractions: extractions.map((ext) => ({
          id: ext.id,
          schema_json: ext.schema_json,
          extraction_json: JSON.parse(ext.extraction_json),
          content_hash: ext.content_hash,
          provenance_id: ext.provenance_id,
          created_at: ext.created_at,
        })),
        next_steps: [{ tool: 'ocr_extraction_get', description: 'View a specific extraction in detail' }, { tool: 'ocr_extract_structured', description: 'Run a new structured extraction' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

async function handleExtractionGet(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ExtractionGetInput, params);
    const { db } = requireDatabase();

    const extraction = db.getExtraction(input.extraction_id);
    if (!extraction) {
      throw new Error(`Extraction not found: ${input.extraction_id}`);
    }

    // Get document for context
    const doc = db.getDocument(extraction.document_id);

    // Check if an embedding exists for this extraction
    const embedding = db.getEmbeddingByExtractionId(extraction.id);
    const hasEmbedding = embedding !== null;

    // Parse the stored JSON string back to object
    let parsedExtractionJson: unknown;
    try {
      parsedExtractionJson = JSON.parse(extraction.extraction_json);
    } catch {
      parsedExtractionJson = extraction.extraction_json;
    }

    // Parse schema_json
    let parsedSchemaJson: unknown;
    try {
      parsedSchemaJson = JSON.parse(extraction.schema_json);
    } catch {
      parsedSchemaJson = extraction.schema_json;
    }

    // Optionally fetch provenance chain
    const provenanceChain = input.include_provenance
      ? fetchProvenanceChain(db, extraction.provenance_id, '[extraction-get]')
      : undefined;

    return formatResponse(
      successResult({
        id: extraction.id,
        document_id: extraction.document_id,
        document_file_path: doc?.file_path ?? null,
        document_file_name: doc?.file_name ?? null,
        ocr_result_id: extraction.ocr_result_id,
        schema_json: parsedSchemaJson,
        extraction_json: parsedExtractionJson,
        content_hash: extraction.content_hash,
        provenance_id: extraction.provenance_id,
        created_at: extraction.created_at,
        has_embedding: hasEmbedding,
        embedding_id: embedding?.id ?? null,
        provenance_chain: provenanceChain,
        next_steps: [{ tool: 'ocr_extraction_search', description: 'Search across all extractions' }, { tool: 'ocr_document_get', description: 'View the source document' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

async function handleExtractionSearch(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(ExtractionSearchInput, params);
    const { db } = requireDatabase();

    const results = db.searchExtractions(input.query, {
      document_filter: input.document_filter,
      limit: input.limit,
    });

    // Enrich each result with document context and parsed JSON
    const enrichedResults = results.map((ext) => {
      const doc = db.getDocument(ext.document_id);

      let parsedExtractionJson: unknown;
      try {
        parsedExtractionJson = JSON.parse(ext.extraction_json);
      } catch {
        parsedExtractionJson = ext.extraction_json;
      }

      let parsedSchemaJson: unknown;
      try {
        parsedSchemaJson = JSON.parse(ext.schema_json);
      } catch {
        parsedSchemaJson = ext.schema_json;
      }

      const provenanceChain = input.include_provenance
        ? fetchProvenanceChain(db, ext.provenance_id, '[extraction-search]')
        : undefined;

      return {
        id: ext.id,
        document_id: ext.document_id,
        document_file_path: doc?.file_path ?? null,
        document_file_name: doc?.file_name ?? null,
        schema_json: parsedSchemaJson,
        extraction_json: parsedExtractionJson,
        content_hash: ext.content_hash,
        provenance_id: ext.provenance_id,
        created_at: ext.created_at,
        provenance_chain: provenanceChain,
      };
    });

    return formatResponse(
      successResult({
        query: input.query,
        total: enrichedResults.length,
        results: enrichedResults,
        next_steps: [{ tool: 'ocr_extraction_get', description: 'View a specific matched extraction' }, { tool: 'ocr_extract_structured', description: 'Run a new extraction with different schema' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

export const structuredExtractionTools: Record<string, ToolDefinition> = {
  ocr_extract_structured: {
    description:
      '[PROCESSING] Use when you need custom structured data from document pages (tables, lists, specific fields). Provide a JSON page_schema defining the expected structure. Different from ocr_form_fill which handles key-value form filling. Document must have status "complete".',
    inputSchema: ExtractStructuredInput.shape,
    handler: handleExtractStructured,
  },
  ocr_extraction_list: {
    description:
      '[STATUS] Use to list all structured extractions previously run on a document. Returns extraction IDs, schemas, and results.',
    inputSchema: ExtractionListInput.shape,
    handler: handleExtractionList,
  },
  ocr_extraction_get: {
    description:
      '[STATUS] Use to retrieve full results of a specific structured extraction by ID. Returns parsed extraction JSON, schema, embedding status, and optional provenance chain.',
    inputSchema: ExtractionGetInput.shape,
    handler: handleExtractionGet,
  },
  ocr_extraction_search: {
    description:
      '[STATUS] Use to search across structured extraction results by text matching within JSON content. Returns matching extractions with document context.',
    inputSchema: ExtractionSearchInput.shape,
    handler: handleExtractionSearch,
  },
};

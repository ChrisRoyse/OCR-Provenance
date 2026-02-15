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
import { formatResponse, handleError, buildClusterReassignmentHint, type ToolDefinition } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { DatalabClient } from '../services/ocr/datalab.js';
import { ProvenanceType } from '../models/provenance.js';
import { computeHash } from '../utils/hash.js';
import { getEmbeddingClient, MODEL_NAME, MODEL_VERSION, EMBEDDING_DIM } from '../services/embedding/nomic.js';
import { mapExtractionEntitiesToDB } from '../services/knowledge-graph/extraction-entity-mapper.js';
import { createEntityExtractionProvenance } from './entity-analysis.js';

const ExtractStructuredInput = z.object({
  document_id: z.string().min(1).describe('Document ID (must be OCR processed)'),
  page_schema: z.string().min(1).describe('JSON schema string for structured extraction per page'),
  auto_extract_entities: z.boolean().default(false).describe(
    'Automatically create entities from extracted fields (maps field names like vendor_name->organization, invoice_date->date, etc.)'
  ),
  auto_reassign_clusters: z.boolean().default(false)
    .describe('Hint that document clusters may need updating after structured extraction'),
});

const ExtractionListInput = z.object({
  document_id: z.string().min(1).describe('Document ID to list extractions for'),
});

async function handleExtractStructured(params: Record<string, unknown>) {
  try {
    const input = validateInput(ExtractStructuredInput, params);
    const { db, vector } = requireDatabase();

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
      console.error(`[WARN] Extraction embedding generation failed for extraction ${extractionId}: ${errMsg}`);
      embeddingId = null;
      embeddingProvId = null;
    }

    // Auto-extract entities from structured fields if requested
    let entityResult: { entities_created: number; extractions_processed: number; entity_provenance_id: string } | null = null;
    if (input.auto_extract_entities) {
      try {
        const entityProvId = createEntityExtractionProvenance(
          db, doc, 'structured-extraction-entity-mapper', 'structured_extraction'
        );
        const conn = db.getConnection();
        const mapped = mapExtractionEntitiesToDB(conn, doc.id, entityProvId);
        entityResult = {
          entities_created: mapped.entities_created,
          extractions_processed: mapped.extractions_processed,
          entity_provenance_id: entityProvId,
        };
        console.error(
          `[INFO] auto_extract_entities: created ${mapped.entities_created} entities from ${mapped.extractions_processed} extractions for document ${doc.id}`
        );
      } catch (entityError) {
        const errMsg = entityError instanceof Error ? entityError.message : String(entityError);
        console.error(`[WARN] auto_extract_entities failed for document ${doc.id}: ${errMsg}`);
        // Don't fail the extraction itself -- entity extraction is a best-effort add-on
      }
    }

    // Echo the schema back (parse to object if valid JSON, keep as string otherwise)
    let parsedSchema: unknown = input.page_schema;
    try { parsedSchema = JSON.parse(input.page_schema); } catch { /* keep as string */ }

    const clusterHint = input.auto_reassign_clusters
      ? buildClusterReassignmentHint(db.getConnection(), doc.id, 'extraction-structured')
      : undefined;

    return formatResponse({
      extraction_id: extractionId,
      document_id: doc.id,
      schema_json: parsedSchema,
      extraction_data: response.extractionJson,
      content_hash: extractionHash,
      provenance_id: extractionProvId,
      embedding_id: embeddingId,
      embedding_provenance_id: embeddingProvId,
      ...(entityResult ? {
        auto_extract_entities: true,
        entities_created: entityResult.entities_created,
        extractions_processed: entityResult.extractions_processed,
        entity_provenance_id: entityResult.entity_provenance_id,
      } : {}),
      ...(clusterHint ?? {}),
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

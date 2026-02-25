/**
 * Tests for Extraction MCP Tools: ocr_extraction_get, ocr_extraction_search
 *
 * Uses real database instances with temp databases - NO MOCKS.
 *
 * @module tests/unit/tools/extraction-tools
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestEmbedding,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  computeHash,
} from '../../integration/server/helpers.js';
import { structuredExtractionTools } from '../../../src/tools/extraction-structured.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseResponse<T = unknown>(response: {
  content: Array<{ type: string; text: string }>;
}): { success: boolean; data?: T; error?: { category: string; message: string } } {
  return JSON.parse(response.content[0].text);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Extraction Tools', () => {
  let tempDir: string;
  const dbName = createUniqueName('test-ext-tools');

  // Test data IDs
  let docProvId: string;
  let ocrProvId: string;
  let docId: string;
  let ocrId: string;
  let doc2ProvId: string;
  let doc2Id: string;
  let ocrProv2Id: string;
  let ocr2Id: string;

  const extractionIds: string[] = [];
  const extractionProvIds: string[] = [];
  let embeddingId: string;

  beforeAll(() => {
    tempDir = createTempDir('test-ext-tools-');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);

    const { db } = requireDatabase();

    // ---- Document 1 ----
    docProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: docProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: docProvId,
        chain_depth: 0,
      })
    );

    docId = uuidv4();
    db.insertDocument(
      createTestDocument(docProvId, {
        id: docId,
        file_path: '/test/report.pdf',
        file_name: 'report.pdf',
        status: 'complete',
      })
    );

    ocrProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProvId,
        type: ProvenanceType.OCR_RESULT,
        parent_id: docProvId,
        root_document_id: docProvId,
        chain_depth: 1,
      })
    );

    ocrId = uuidv4();
    db.insertOCRResult(createTestOCRResult(docId, ocrProvId, { id: ocrId }));

    // ---- Document 2 ----
    doc2ProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: doc2ProvId,
        type: ProvenanceType.DOCUMENT,
        root_document_id: doc2ProvId,
        chain_depth: 0,
      })
    );

    doc2Id = uuidv4();
    db.insertDocument(
      createTestDocument(doc2ProvId, {
        id: doc2Id,
        file_path: '/test/memo.pdf',
        file_name: 'memo.pdf',
        status: 'complete',
      })
    );

    ocrProv2Id = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: ocrProv2Id,
        type: ProvenanceType.OCR_RESULT,
        parent_id: doc2ProvId,
        root_document_id: doc2ProvId,
        chain_depth: 1,
      })
    );

    ocr2Id = uuidv4();
    db.insertOCRResult(createTestOCRResult(doc2Id, ocrProv2Id, { id: ocr2Id }));

    // ---- Extractions ----
    const extractionData = [
      {
        document_id: docId,
        ocr_result_id: ocrId,
        schema_json: '{"type":"object","properties":{"revenue":{"type":"number"}}}',
        extraction_json: JSON.stringify({ revenue: 50000, quarter: 'Q4', fiscal_year: 2025 }),
        parentProvId: ocrProvId,
        rootDocId: docProvId,
      },
      {
        document_id: docId,
        ocr_result_id: ocrId,
        schema_json: '{"type":"object","properties":{"employees":{"type":"array"}}}',
        extraction_json: JSON.stringify({
          employees: ['Alice', 'Bob', 'Charlie'],
          department: 'Engineering',
        }),
        parentProvId: ocrProvId,
        rootDocId: docProvId,
      },
      {
        document_id: doc2Id,
        ocr_result_id: ocr2Id,
        schema_json: '{"type":"object","properties":{"action_items":{"type":"array"}}}',
        extraction_json: JSON.stringify({
          action_items: ['Review budget', 'Hire contractor'],
          priority: 'high',
        }),
        parentProvId: ocrProv2Id,
        rootDocId: doc2ProvId,
      },
    ];

    for (const data of extractionData) {
      const extProvId = uuidv4();
      db.insertProvenance(
        createTestProvenance({
          id: extProvId,
          type: ProvenanceType.EXTRACTION,
          parent_id: data.parentProvId,
          root_document_id: data.rootDocId,
          chain_depth: 2,
        })
      );
      extractionProvIds.push(extProvId);

      const extId = uuidv4();
      db.insertExtraction({
        id: extId,
        document_id: data.document_id,
        ocr_result_id: data.ocr_result_id,
        schema_json: data.schema_json,
        extraction_json: data.extraction_json,
        content_hash: computeHash(data.extraction_json),
        provenance_id: extProvId,
        created_at: new Date().toISOString(),
      });
      extractionIds.push(extId);
    }

    // Create an embedding for extraction[0] to test has_embedding
    const embProvId = uuidv4();
    db.insertProvenance(
      createTestProvenance({
        id: embProvId,
        type: ProvenanceType.EMBEDDING,
        parent_id: extractionProvIds[0],
        root_document_id: docProvId,
        chain_depth: 3,
      })
    );

    embeddingId = uuidv4();
    db.insertEmbedding(
      createTestEmbedding(null as unknown as string, docId, embProvId, {
        id: embeddingId,
        chunk_id: null,
        image_id: null,
        extraction_id: extractionIds[0],
        source_file_path: '/test/report.pdf',
        source_file_name: 'report.pdf',
      })
    );
  });

  afterAll(() => {
    cleanupTempDir(tempDir);
  });

  // Verify tool count
  it('should export 3 tools', () => {
    expect(Object.keys(structuredExtractionTools)).toHaveLength(3);
    expect(structuredExtractionTools.ocr_extraction_get).toBeDefined();
    expect(structuredExtractionTools.ocr_extraction_list).toBeDefined();
  });

  // ==================== ocr_extraction_get ====================

  describe('ocr_extraction_get', () => {
    const handler = structuredExtractionTools.ocr_extraction_get.handler;

    it('should return full extraction details', async () => {
      const response = await handler({ extraction_id: extractionIds[0] });
      const parsed = parseResponse<{
        id: string;
        document_id: string;
        document_file_path: string;
        document_file_name: string;
        ocr_result_id: string;
        schema_json: unknown;
        extraction_json: unknown;
        content_hash: string;
        provenance_id: string;
        created_at: string;
        has_embedding: boolean;
        embedding_id: string | null;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.id).toBe(extractionIds[0]);
      expect(parsed.data!.document_id).toBe(docId);
      expect(parsed.data!.document_file_path).toBe('/test/report.pdf');
      expect(parsed.data!.document_file_name).toBe('report.pdf');
      expect(parsed.data!.ocr_result_id).toBe(ocrId);
      expect(parsed.data!.extraction_json).toEqual({
        revenue: 50000,
        quarter: 'Q4',
        fiscal_year: 2025,
      });
      expect(parsed.data!.content_hash).toBeTruthy();
      expect(parsed.data!.provenance_id).toBe(extractionProvIds[0]);
      expect(parsed.data!.created_at).toBeTruthy();
    });

    it('should show has_embedding=true and embedding_id when embedding exists', async () => {
      const response = await handler({ extraction_id: extractionIds[0] });
      const parsed = parseResponse<{
        has_embedding: boolean;
        embedding_id: string | null;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.has_embedding).toBe(true);
      expect(parsed.data!.embedding_id).toBe(embeddingId);
    });

    it('should show has_embedding=false when no embedding exists', async () => {
      const response = await handler({ extraction_id: extractionIds[1] });
      const parsed = parseResponse<{
        has_embedding: boolean;
        embedding_id: string | null;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.has_embedding).toBe(false);
      expect(parsed.data!.embedding_id).toBeNull();
    });

    it('should include provenance chain when requested', async () => {
      const response = await handler({
        extraction_id: extractionIds[0],
        include_provenance: true,
      });
      const parsed = parseResponse<{
        provenance_chain: unknown[];
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.provenance_chain).toBeDefined();
      expect(Array.isArray(parsed.data!.provenance_chain)).toBe(true);
      expect(parsed.data!.provenance_chain.length).toBeGreaterThan(0);
    });

    it('should not include provenance_chain when not requested', async () => {
      const response = await handler({ extraction_id: extractionIds[0] });
      const parsed = parseResponse<{
        provenance_chain: unknown;
      }>(response);

      expect(parsed.success).toBe(true);
      // fetchProvenanceChain returns undefined when not requested, which becomes absent in JSON
      expect(parsed.data!.provenance_chain).toBeUndefined();
    });

    it('should return error for non-existent extraction', async () => {
      const response = await handler({ extraction_id: 'nonexistent-id' });
      const parsed = parseResponse(response);

      expect(parsed.success).toBe(false);
      expect(parsed.error!.message).toContain('Extraction not found');
    });

    it('should return error when db not selected', async () => {
      resetState();
      const response = await handler({ extraction_id: extractionIds[0] });
      const parsed = parseResponse(response);

      expect(parsed.success).toBe(false);

      // Restore state
      selectDatabase(dbName, tempDir);
    });

    it('should parse schema_json as object', async () => {
      const response = await handler({ extraction_id: extractionIds[0] });
      const parsed = parseResponse<{
        schema_json: { type: string; properties: Record<string, unknown> };
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.schema_json).toEqual({
        type: 'object',
        properties: { revenue: { type: 'number' } },
      });
    });
  });

  // ==================== ocr_extraction_search ====================

  describe('ocr_extraction_list search mode', () => {
    const handler = structuredExtractionTools.ocr_extraction_list.handler;

    it('should find extraction matching query', async () => {
      const response = await handler({ query: 'revenue' });
      const parsed = parseResponse<{
        query: string;
        total: number;
        results: Array<{
          id: string;
          document_id: string;
          extraction_json: unknown;
        }>;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.query).toBe('revenue');
      expect(parsed.data!.total).toBe(1);
      expect(parsed.data!.results[0].id).toBe(extractionIds[0]);
      expect(parsed.data!.results[0].extraction_json).toEqual({
        revenue: 50000,
        quarter: 'Q4',
        fiscal_year: 2025,
      });
    });

    it('should return no results for non-matching query', async () => {
      const response = await handler({ query: 'zzz_no_match_zzz' });
      const parsed = parseResponse<{
        total: number;
        results: unknown[];
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(0);
      expect(parsed.data!.results).toEqual([]);
    });

    it('should filter by document_filter', async () => {
      const response = await handler({
        query: 'action_items',
        document_filter: [doc2Id],
      });
      const parsed = parseResponse<{
        total: number;
        results: Array<{ document_id: string }>;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(1);
      expect(parsed.data!.results[0].document_id).toBe(doc2Id);
    });

    it('should exclude results when document_filter does not match', async () => {
      const response = await handler({
        query: 'revenue',
        document_filter: [doc2Id], // revenue is in doc1, not doc2
      });
      const parsed = parseResponse<{
        total: number;
        results: unknown[];
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.total).toBe(0);
    });

    it('should respect limit parameter', async () => {
      // Search for a broad term that matches multiple
      const response = await handler({ query: 'e', limit: 1 });
      const parsed = parseResponse<{
        total: number;
        results: unknown[];
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.results.length).toBeLessThanOrEqual(1);
    });

    it('should include document context in results', async () => {
      const response = await handler({ query: 'contractor' });
      const parsed = parseResponse<{
        results: Array<{
          document_file_path: string;
          document_file_name: string;
        }>;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.results[0].document_file_path).toBe('/test/memo.pdf');
      expect(parsed.data!.results[0].document_file_name).toBe('memo.pdf');
    });

    it('should include provenance chain when requested', async () => {
      const response = await handler({
        query: 'revenue',
        include_provenance: true,
      });
      const parsed = parseResponse<{
        results: Array<{
          provenance_chain: unknown[];
        }>;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.results[0].provenance_chain).toBeDefined();
      expect(Array.isArray(parsed.data!.results[0].provenance_chain)).toBe(true);
    });

    it('should not include provenance_chain when not requested', async () => {
      const response = await handler({ query: 'revenue' });
      const parsed = parseResponse<{
        results: Array<{
          provenance_chain: unknown;
        }>;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.results[0].provenance_chain).toBeUndefined();
    });

    it('should return error when db not selected', async () => {
      resetState();
      const response = await handler({ query: 'test' });
      const parsed = parseResponse(response);

      expect(parsed.success).toBe(false);

      // Restore state
      selectDatabase(dbName, tempDir);
    });

    it('should return parsed schema_json in results', async () => {
      const response = await handler({ query: 'action_items' });
      const parsed = parseResponse<{
        results: Array<{
          schema_json: { type: string; properties: Record<string, unknown> };
        }>;
      }>(response);

      expect(parsed.success).toBe(true);
      expect(parsed.data!.results[0].schema_json).toEqual({
        type: 'object',
        properties: { action_items: { type: 'array' } },
      });
    });
  });
});

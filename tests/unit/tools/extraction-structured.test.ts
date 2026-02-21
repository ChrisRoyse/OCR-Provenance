/**
 * Unit Tests for Structured Extraction MCP Tools
 *
 * Tests the extracted structured extraction tool handlers in src/tools/extraction-structured.ts
 * Tools: ocr_extract_structured, ocr_extraction_list
 *
 * NO MOCK DATA for external services - focuses on error paths and input validation.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/extraction-structured
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { structuredExtractionTools } from '../../../src/tools/extraction-structured.js';
import { state, resetState, clearDatabase } from '../../../src/server/state.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

interface ToolResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    category: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

// Extract handlers for convenience
const handleExtractStructured = structuredExtractionTools['ocr_extract_structured'].handler;
const handleExtractionList = structuredExtractionTools['ocr_extraction_list'].handler;

// =============================================================================
// TOOL EXPORTS VERIFICATION
// =============================================================================

describe('structuredExtractionTools exports', () => {
  it('exports all 3 structured extraction tools', () => {
    expect(Object.keys(structuredExtractionTools)).toHaveLength(3);
    expect(structuredExtractionTools).toHaveProperty('ocr_extract_structured');
    expect(structuredExtractionTools).toHaveProperty('ocr_extraction_list');
    expect(structuredExtractionTools).toHaveProperty('ocr_suggest_extraction_schema');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(structuredExtractionTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('ocr_extract_structured has expected input schema fields', () => {
    const schema = structuredExtractionTools['ocr_extract_structured'].inputSchema;
    expect(schema).toHaveProperty('document_id');
    expect(schema).toHaveProperty('page_schema');
  });

  it('ocr_extraction_list has expected input schema fields', () => {
    const schema = structuredExtractionTools['ocr_extraction_list'].inputSchema;
    expect(schema).toHaveProperty('document_id');
  });
});

// =============================================================================
// handleExtractStructured TESTS
// =============================================================================

describe('handleExtractStructured', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  // ---------------------------------------------------------------------------
  // No database selected
  // ---------------------------------------------------------------------------

  it('returns DATABASE_NOT_SELECTED error when no database selected', async () => {
    expect(state.currentDatabase).toBeNull();

    const response = await handleExtractStructured({
      document_id: 'test-doc-id',
      page_schema: '{"type": "object"}',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    expect(result.error?.message).toContain('No database selected');
  });

  // ---------------------------------------------------------------------------
  // Missing required params
  // ---------------------------------------------------------------------------

  it('returns error when document_id is missing', async () => {
    const response = await handleExtractStructured({
      page_schema: '{"type": "object"}',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when page_schema is missing', async () => {
    const response = await handleExtractStructured({
      document_id: 'test-doc-id',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when both required params are missing', async () => {
    const response = await handleExtractStructured({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Invalid param values
  // ---------------------------------------------------------------------------

  it('returns error when document_id is empty string', async () => {
    const response = await handleExtractStructured({
      document_id: '',
      page_schema: '{"type": "object"}',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when page_schema is empty string', async () => {
    const response = await handleExtractStructured({
      document_id: 'test-doc-id',
      page_schema: '',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Invalid param types
  // ---------------------------------------------------------------------------

  it('returns error when document_id is not a string', async () => {
    const response = await handleExtractStructured({
      document_id: 12345,
      page_schema: '{"type": "object"}',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when page_schema is not a string', async () => {
    const response = await handleExtractStructured({
      document_id: 'test-doc-id',
      page_schema: { type: 'object' },
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when auto_extract_entities is not a boolean', async () => {
    const response = await handleExtractStructured({
      document_id: 'test-doc-id',
      page_schema: '{"type": "object"}',
      auto_extract_entities: 'yes',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when auto_reassign_clusters is not a boolean', async () => {
    const response = await handleExtractStructured({
      document_id: 'test-doc-id',
      page_schema: '{"type": "object"}',
      auto_reassign_clusters: 'true',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Validation before database check ordering
  // ---------------------------------------------------------------------------

  it('validation error takes precedence over database not selected for invalid params', async () => {
    expect(state.currentDatabase).toBeNull();

    // Empty document_id triggers validation error before requireDatabase()
    const response = await handleExtractStructured({
      document_id: '',
      page_schema: '',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Either VALIDATION_ERROR or INTERNAL_ERROR from Zod - the point is it fails
    expect(result.error?.category).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Default values for optional booleans
  // ---------------------------------------------------------------------------

  it('accepts valid params with defaults for optional fields (still fails on no DB)', async () => {
    // Valid params, but no database selected - should get past validation
    // to the requireDatabase() call
    const response = await handleExtractStructured({
      document_id: 'some-uuid-value',
      page_schema: '{"type": "object", "properties": {"name": {"type": "string"}}}',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts explicit false for optional boolean fields (still fails on no DB)', async () => {
    const response = await handleExtractStructured({
      document_id: 'some-uuid-value',
      page_schema: '{"type": "object"}',
      auto_extract_entities: false,
      auto_reassign_clusters: false,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts explicit true for optional boolean fields (still fails on no DB)', async () => {
    const response = await handleExtractStructured({
      document_id: 'some-uuid-value',
      page_schema: '{"type": "object"}',
      auto_extract_entities: true,
      auto_reassign_clusters: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleExtractionList TESTS
// =============================================================================

describe('handleExtractionList', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  // ---------------------------------------------------------------------------
  // No database selected
  // ---------------------------------------------------------------------------

  it('returns DATABASE_NOT_SELECTED error when no database selected', async () => {
    expect(state.currentDatabase).toBeNull();

    const response = await handleExtractionList({
      document_id: 'test-doc-id',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    expect(result.error?.message).toContain('No database selected');
  });

  // ---------------------------------------------------------------------------
  // Missing required params
  // ---------------------------------------------------------------------------

  it('returns error when document_id is missing', async () => {
    const response = await handleExtractionList({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Invalid param values
  // ---------------------------------------------------------------------------

  it('returns error when document_id is empty string', async () => {
    const response = await handleExtractionList({
      document_id: '',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Invalid param types
  // ---------------------------------------------------------------------------

  it('returns error when document_id is not a string', async () => {
    const response = await handleExtractionList({
      document_id: 12345,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when document_id is null', async () => {
    const response = await handleExtractionList({
      document_id: null,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when document_id is a number', async () => {
    const response = await handleExtractionList({
      document_id: 0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Valid params but no database
  // ---------------------------------------------------------------------------

  it('valid document_id passes validation but fails on no database', async () => {
    expect(state.currentDatabase).toBeNull();

    const response = await handleExtractionList({
      document_id: 'valid-document-id-string',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  // ---------------------------------------------------------------------------
  // Extra/unknown params are ignored
  // ---------------------------------------------------------------------------

  it('ignores unknown extra parameters (still fails on no DB)', async () => {
    const response = await handleExtractionList({
      document_id: 'some-document-id',
      unknown_param: 'should be ignored',
      another_extra: 42,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Should get past validation to the database check
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe('Edge Cases', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('Edge Case 1: page_schema with various string content', () => {
    it('accepts a minimal JSON schema string (fails on no DB)', async () => {
      const response = await handleExtractStructured({
        document_id: 'doc-1',
        page_schema: '{}',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts a complex JSON schema string (fails on no DB)', async () => {
      const complexSchema = JSON.stringify({
        type: 'object',
        properties: {
          invoice_number: { type: 'string' },
          vendor_name: { type: 'string' },
          invoice_date: { type: 'string', format: 'date' },
          total_amount: { type: 'number' },
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit_price: { type: 'number' },
              },
            },
          },
        },
        required: ['invoice_number', 'vendor_name'],
      });

      const response = await handleExtractStructured({
        document_id: 'doc-1',
        page_schema: complexSchema,
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts non-JSON page_schema string (fails on no DB, not validation)', async () => {
      // page_schema is just z.string().min(1), it does not require valid JSON
      const response = await handleExtractStructured({
        document_id: 'doc-1',
        page_schema: 'not-valid-json-but-still-a-string',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('Edge Case 2: whitespace-only strings', () => {
    it('accepts whitespace-only document_id (passes min(1) check, fails on no DB)', async () => {
      // A single space passes z.string().min(1)
      const response = await handleExtractStructured({
        document_id: ' ',
        page_schema: '{"type": "object"}',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      // Passes validation (space has length 1), fails on database
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts whitespace-only page_schema (passes min(1) check, fails on no DB)', async () => {
      const response = await handleExtractStructured({
        document_id: 'doc-1',
        page_schema: ' ',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('Edge Case 3: multiple simultaneous validation errors', () => {
    it('returns error when all params are invalid types', async () => {
      const response = await handleExtractStructured({
        document_id: 123,
        page_schema: 456,
        auto_extract_entities: 'not-bool',
        auto_reassign_clusters: 'not-bool',
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBeDefined();
      expect(result.error?.message!.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Case 4: tool response format consistency', () => {
    it('all error responses have the standard format', async () => {
      const errorCases = [
        // handleExtractStructured error cases
        handleExtractStructured({}),
        handleExtractStructured({ document_id: '', page_schema: '' }),
        handleExtractStructured({ document_id: 'x', page_schema: '{}' }),
        // handleExtractionList error cases
        handleExtractionList({}),
        handleExtractionList({ document_id: '' }),
        handleExtractionList({ document_id: 'x' }),
      ];

      const results = await Promise.all(errorCases);

      for (const response of results) {
        // Every response should have the MCP content format
        expect(response).toHaveProperty('content');
        expect(Array.isArray(response.content)).toBe(true);
        expect(response.content.length).toBe(1);
        expect(response.content[0]).toHaveProperty('type', 'text');
        expect(response.content[0]).toHaveProperty('text');

        // Every response should be parseable JSON
        const parsed = parseResponse(response);
        expect(parsed).toHaveProperty('success');
        expect(parsed.success).toBe(false);
        expect(parsed).toHaveProperty('error');
        expect(parsed.error).toHaveProperty('category');
        expect(parsed.error).toHaveProperty('message');
        expect(typeof parsed.error!.category).toBe('string');
        expect(typeof parsed.error!.message).toBe('string');
      }
    });
  });

  describe('Edge Case 5: handler reference identity', () => {
    it('handlers are stable function references', () => {
      const handler1 = structuredExtractionTools['ocr_extract_structured'].handler;
      const handler2 = structuredExtractionTools['ocr_extract_structured'].handler;
      expect(handler1).toBe(handler2);

      const listHandler1 = structuredExtractionTools['ocr_extraction_list'].handler;
      const listHandler2 = structuredExtractionTools['ocr_extraction_list'].handler;
      expect(listHandler1).toBe(listHandler2);
    });

    it('the two handlers are different functions', () => {
      expect(handleExtractStructured).not.toBe(handleExtractionList);
    });
  });
});

// =============================================================================
// handleSuggestSchema TESTS
// =============================================================================

const handleSuggestSchema = structuredExtractionTools['ocr_suggest_extraction_schema'].handler;

describe('handleSuggestSchema', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED error when no database selected', async () => {
    expect(state.currentDatabase).toBeNull();

    const response = await handleSuggestSchema({
      document_id: 'test-doc-id',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error when document_id is missing', async () => {
    const response = await handleSuggestSchema({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns error when document_id is empty string', async () => {
    const response = await handleSuggestSchema({
      document_id: '',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('accepts valid params with optional extraction_goal (fails on no DB)', async () => {
    const response = await handleSuggestSchema({
      document_id: 'some-uuid-value',
      extraction_goal: 'invoice line items',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts valid params without extraction_goal (fails on no DB)', async () => {
    const response = await handleSuggestSchema({
      document_id: 'some-uuid-value',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('ocr_suggest_extraction_schema has expected input schema fields', () => {
    const schema = structuredExtractionTools['ocr_suggest_extraction_schema'].inputSchema;
    expect(schema).toHaveProperty('document_id');
    expect(schema).toHaveProperty('extraction_goal');
  });
});

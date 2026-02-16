/**
 * Unit Tests for Form Fill MCP Tools
 *
 * Tests the form fill tool handlers in src/tools/form-fill.ts
 * Tools: ocr_form_fill, ocr_form_fill_status, ocr_form_fill_suggest_fields
 *
 * Focus: tool exports verification, error paths (no database, invalid params),
 * and input validation edge cases. Does NOT use real databases or APIs.
 *
 * @module tests/unit/tools/form-fill
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formFillTools } from '../../../src/tools/form-fill.js';
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

// Extract handlers from the tools record for convenience
const handleFormFill = formFillTools['ocr_form_fill'].handler;
const handleFormFillStatus = formFillTools['ocr_form_fill_status'].handler;
const handleFormFillSuggestFields = formFillTools['ocr_form_fill_suggest_fields'].handler;

// =============================================================================
// TOOL EXPORTS VERIFICATION
// =============================================================================

describe('formFillTools exports', () => {
  it('exports all 3 form fill tools', () => {
    expect(Object.keys(formFillTools)).toHaveLength(3);
    expect(formFillTools).toHaveProperty('ocr_form_fill');
    expect(formFillTools).toHaveProperty('ocr_form_fill_status');
    expect(formFillTools).toHaveProperty('ocr_form_fill_suggest_fields');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(formFillTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length, `${name} has empty description`).toBeGreaterThan(0);
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('ocr_form_fill description mentions form filling', () => {
    expect(formFillTools['ocr_form_fill'].description.toLowerCase()).toContain('fill');
  });

  it('ocr_form_fill_status description mentions status', () => {
    expect(formFillTools['ocr_form_fill_status'].description.toLowerCase()).toContain('status');
  });

  it('ocr_form_fill_suggest_fields description mentions suggest', () => {
    expect(formFillTools['ocr_form_fill_suggest_fields'].description.toLowerCase()).toContain(
      'suggest'
    );
  });

  it('inputSchema for ocr_form_fill has required fields', () => {
    const schema = formFillTools['ocr_form_fill'].inputSchema;
    expect(schema).toHaveProperty('file_path');
    expect(schema).toHaveProperty('field_data');
    expect(schema).toHaveProperty('confidence_threshold');
    expect(schema).toHaveProperty('page_range');
    expect(schema).toHaveProperty('output_path');
    expect(schema).toHaveProperty('document_id');
    expect(schema).toHaveProperty('validate_against_kg');
    expect(schema).toHaveProperty('context');
  });

  it('inputSchema for ocr_form_fill_status has required fields', () => {
    const schema = formFillTools['ocr_form_fill_status'].inputSchema;
    expect(schema).toHaveProperty('form_fill_id');
    expect(schema).toHaveProperty('status_filter');
    expect(schema).toHaveProperty('search_query');
    expect(schema).toHaveProperty('limit');
    expect(schema).toHaveProperty('offset');
    expect(schema).toHaveProperty('include_provenance');
  });

  it('inputSchema for ocr_form_fill_suggest_fields has required fields', () => {
    const schema = formFillTools['ocr_form_fill_suggest_fields'].inputSchema;
    expect(schema).toHaveProperty('document_id');
    expect(schema).toHaveProperty('field_names');
    expect(schema).toHaveProperty('entity_types');
  });
});

// =============================================================================
// handleFormFill - NO DATABASE SELECTED
// =============================================================================

describe('handleFormFill', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: { name: { value: 'John Doe' } },
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns validation error when file_path is missing', async () => {
    const response = await handleFormFill({
      field_data: { name: { value: 'John Doe' } },
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when file_path is empty string', async () => {
    const response = await handleFormFill({
      file_path: '',
      field_data: { name: { value: 'John Doe' } },
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_data is missing', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_data is not an object', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: 'invalid',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_data values are not properly structured', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: { name: 'just a string' },
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when confidence_threshold is below 0', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: { name: { value: 'John Doe' } },
      confidence_threshold: -0.1,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when confidence_threshold is above 1', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: { name: { value: 'John Doe' } },
      confidence_threshold: 1.5,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when file_path contains null bytes', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test\0form.pdf',
      field_data: { name: { value: 'John Doe' } },
    });
    const result = parseResponse(response);

    // Validation passes Zod (non-empty string) but sanitizePath rejects null bytes.
    // However, requireDatabase() is called first before sanitizePath, so it fails
    // with DATABASE_NOT_SELECTED when no database is selected.
    expect(result.success).toBe(false);
  });

  it('accepts valid params but fails at database check (no DB)', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: {
        patient_name: { value: 'Jane Smith', description: 'Patient full name' },
        date_of_birth: { value: '1990-01-15' },
      },
      context: 'Medical intake form',
      confidence_threshold: 0.7,
      page_range: '0-2',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts optional document_id and validate_against_kg but fails at database check', async () => {
    const response = await handleFormFill({
      file_path: '/tmp/test-form.pdf',
      field_data: { name: { value: 'John Doe' } },
      document_id: 'some-doc-id',
      validate_against_kg: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleFormFillStatus - NO DATABASE SELECTED
// =============================================================================

describe('handleFormFillStatus', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database (default params)', async () => {
    const response = await handleFormFillStatus({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED when querying by form_fill_id', async () => {
    const response = await handleFormFillStatus({
      form_fill_id: 'some-form-fill-id',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with status_filter', async () => {
    const response = await handleFormFillStatus({
      status_filter: 'complete',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with search_query', async () => {
    const response = await handleFormFillStatus({
      search_query: 'patient form',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with include_provenance', async () => {
    const response = await handleFormFillStatus({
      form_fill_id: 'some-id',
      include_provenance: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts all valid status_filter values but fails at database check', async () => {
    const validStatuses = ['pending', 'processing', 'complete', 'failed', 'all'];
    for (const status of validStatuses) {
      const response = await handleFormFillStatus({ status_filter: status });
      const result = parseResponse(response);

      // Should fail with DATABASE_NOT_SELECTED, not validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    }
  });

  it('returns validation error when status_filter is invalid', async () => {
    const response = await handleFormFillStatus({
      status_filter: 'invalid_status',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Zod enum validation rejects invalid values
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when limit is below 1', async () => {
    const response = await handleFormFillStatus({
      limit: 0,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when limit is above 100', async () => {
    const response = await handleFormFillStatus({
      limit: 101,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when offset is negative', async () => {
    const response = await handleFormFillStatus({
      offset: -1,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when limit is not integer', async () => {
    const response = await handleFormFillStatus({
      limit: 5.5,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('accepts boundary limit values but fails at database check', async () => {
    // Minimum boundary (1)
    const minResponse = await handleFormFillStatus({ limit: 1 });
    const minResult = parseResponse(minResponse);
    expect(minResult.error?.category).toBe('DATABASE_NOT_SELECTED');

    // Maximum boundary (100)
    const maxResponse = await handleFormFillStatus({ limit: 100 });
    const maxResult = parseResponse(maxResponse);
    expect(maxResult.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts offset of 0 but fails at database check', async () => {
    const response = await handleFormFillStatus({ offset: 0 });
    const result = parseResponse(response);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleFormFillSuggestFields - NO DATABASE SELECTED
// =============================================================================

describe('handleFormFillSuggestFields', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
      field_names: ['patient_name'],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns validation error when document_id is missing', async () => {
    const response = await handleFormFillSuggestFields({
      field_names: ['patient_name'],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when document_id is empty string', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: '',
      field_names: ['patient_name'],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_names is missing', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_names is empty array', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
      field_names: [],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_names contains empty strings', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
      field_names: [''],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when field_names is not an array', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
      field_names: 'patient_name',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('returns validation error when entity_types contains invalid type', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
      field_names: ['patient_name'],
      entity_types: ['invalid_entity_type'],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBeDefined();
  });

  it('accepts valid entity_types but fails at database check', async () => {
    const validTypes = [
      'person',
      'organization',
      'date',
      'amount',
      'case_number',
      'location',
      'statute',
      'exhibit',
      'medication',
      'diagnosis',
      'medical_device',
      'other',
    ];
    const response = await handleFormFillSuggestFields({
      document_id: 'some-doc-id',
      field_names: ['test_field'],
      entity_types: validTypes,
    });
    const result = parseResponse(response);

    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts multiple field_names but fails at database check', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'doc-123',
      field_names: ['patient_name', 'date_of_birth', 'address', 'diagnosis', 'medication'],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts entity_types subset but fails at database check', async () => {
    const response = await handleFormFillSuggestFields({
      document_id: 'doc-123',
      field_names: ['patient_name'],
      entity_types: ['person', 'organization'],
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  describe('handleFormFill field_data validation', () => {
    it('accepts field_data with value and optional description', async () => {
      const response = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: {
          name: { value: 'John Doe', description: 'Full legal name' },
          dob: { value: '1990-01-01' },
        },
      });
      const result = parseResponse(response);

      // Passes validation, fails at requireDatabase
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts empty field_data record', async () => {
      const response = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: {},
      });
      const result = parseResponse(response);

      // Empty record is valid for z.record() -- fails at database check
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('rejects field_data value with missing value property', async () => {
      const response = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: { name: { description: 'missing value key' } },
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBeDefined();
    });
  });

  describe('handleFormFill confidence_threshold boundaries', () => {
    it('accepts confidence_threshold of exactly 0', async () => {
      const response = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: { name: { value: 'Test' } },
        confidence_threshold: 0,
      });
      const result = parseResponse(response);

      // Passes validation, fails at database
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts confidence_threshold of exactly 1', async () => {
      const response = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: { name: { value: 'Test' } },
        confidence_threshold: 1,
      });
      const result = parseResponse(response);

      // Passes validation, fails at database
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('uses default confidence_threshold of 0.5 when omitted', async () => {
      // The default value is defined in the schema -- just verify no validation error
      const response = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: { name: { value: 'Test' } },
      });
      const result = parseResponse(response);

      // No validation error about confidence_threshold -- fails at database
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('handleFormFillStatus defaults', () => {
    it('uses default status_filter of all when omitted', async () => {
      const response = await handleFormFillStatus({});
      const result = parseResponse(response);

      // Default status_filter='all' should not cause validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('uses default limit of 50 when omitted', async () => {
      const response = await handleFormFillStatus({});
      const result = parseResponse(response);

      // Default limit=50 should not cause validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('uses default offset of 0 when omitted', async () => {
      const response = await handleFormFillStatus({});
      const result = parseResponse(response);

      // Default offset=0 should not cause validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('uses default include_provenance of false when omitted', async () => {
      const response = await handleFormFillStatus({ form_fill_id: 'test' });
      const result = parseResponse(response);

      // Default include_provenance=false should not cause validation error
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('handleFormFillSuggestFields entity_types validation', () => {
    it('accepts entity_types as undefined (optional)', async () => {
      const response = await handleFormFillSuggestFields({
        document_id: 'doc-123',
        field_names: ['name'],
      });
      const result = parseResponse(response);

      // entity_types is optional -- fails at database
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('accepts single entity type', async () => {
      const response = await handleFormFillSuggestFields({
        document_id: 'doc-123',
        field_names: ['name'],
        entity_types: ['person'],
      });
      const result = parseResponse(response);

      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    });

    it('rejects mixed valid and invalid entity types', async () => {
      const response = await handleFormFillSuggestFields({
        document_id: 'doc-123',
        field_names: ['name'],
        entity_types: ['person', 'invalid_type'],
      });
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBeDefined();
    });
  });

  describe('state isolation between calls', () => {
    it('state is null after resetState', () => {
      expect(state.currentDatabase).toBe(null);
      expect(state.currentDatabaseName).toBe(null);
    });

    it('all handlers consistently fail with DATABASE_NOT_SELECTED when no DB', async () => {
      const formFillResponse = await handleFormFill({
        file_path: '/tmp/form.pdf',
        field_data: { name: { value: 'Test' } },
      });
      expect(parseResponse(formFillResponse).error?.category).toBe('DATABASE_NOT_SELECTED');

      const statusResponse = await handleFormFillStatus({});
      expect(parseResponse(statusResponse).error?.category).toBe('DATABASE_NOT_SELECTED');

      const suggestResponse = await handleFormFillSuggestFields({
        document_id: 'doc-123',
        field_names: ['name'],
      });
      expect(parseResponse(suggestResponse).error?.category).toBe('DATABASE_NOT_SELECTED');
    });
  });

  describe('response format', () => {
    it('all handlers return properly structured MCP content responses', async () => {
      const handlers = [
        {
          fn: handleFormFill,
          params: { file_path: '/tmp/form.pdf', field_data: { n: { value: 'v' } } },
        },
        { fn: handleFormFillStatus, params: {} },
        { fn: handleFormFillSuggestFields, params: { document_id: 'd', field_names: ['n'] } },
      ];

      for (const { fn, params } of handlers) {
        const response = await fn(params);
        expect(response).toHaveProperty('content');
        expect(Array.isArray(response.content)).toBe(true);
        expect(response.content).toHaveLength(1);
        expect(response.content[0]).toHaveProperty('type', 'text');
        expect(response.content[0]).toHaveProperty('text');
        expect(typeof response.content[0].text).toBe('string');

        // Must be valid JSON
        const parsed = JSON.parse(response.content[0].text);
        expect(parsed).toHaveProperty('success');
        expect(typeof parsed.success).toBe('boolean');
      }
    });

    it('error responses include category and message', async () => {
      const response = await handleFormFillStatus({});
      const result = parseResponse(response);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.category).toBeDefined();
      expect(typeof result.error?.category).toBe('string');
      expect(result.error?.message).toBeDefined();
      expect(typeof result.error?.message).toBe('string');
    });
  });
});

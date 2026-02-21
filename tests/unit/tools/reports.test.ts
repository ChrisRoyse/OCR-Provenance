/**
 * Unit Tests for Report MCP Tools
 *
 * Tests the extracted report tool handlers in src/tools/reports.ts
 * Tools: handleEvaluationReport, handleDocumentReport, handleQualitySummary
 * (handleCostSummary is tested separately in reports-cost.test.ts)
 *
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * Note on error categories:
 * - DATABASE_NOT_SELECTED: thrown by requireDatabase() as MCPError (preserved)
 * - VALIDATION_ERROR: Zod ValidationError from validateInput() has error.name === 'ValidationError',
 *   so MCPError.fromUnknown() maps it to VALIDATION_ERROR category
 *
 * @module tests/unit/tools/reports
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleEvaluationReport,
  handleDocumentReport,
  handleQualitySummary,
  handlePipelineAnalytics,
  handleCorpusProfile,
  handleErrorAnalytics,
  handleProvenanceBottlenecks,
  reportTools,
} from '../../../src/tools/reports.js';
import { state, resetState, clearDatabase } from '../../../src/server/state.js';

// ===============================================================================
// TEST HELPERS
// ===============================================================================

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

// ===============================================================================
// TOOL EXPORTS VERIFICATION
// ===============================================================================

describe('reportTools exports', () => {
  it('exports all 8 report tools', () => {
    expect(Object.keys(reportTools)).toHaveLength(8);
    expect(reportTools).toHaveProperty('ocr_evaluation_report');
    expect(reportTools).toHaveProperty('ocr_document_report');
    expect(reportTools).toHaveProperty('ocr_quality_summary');
    expect(reportTools).toHaveProperty('ocr_cost_summary');
    expect(reportTools).toHaveProperty('ocr_pipeline_analytics');
    expect(reportTools).toHaveProperty('ocr_corpus_profile');
    expect(reportTools).toHaveProperty('ocr_error_analytics');
    expect(reportTools).toHaveProperty('ocr_provenance_bottlenecks');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(reportTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length, `${name} description is empty`).toBeGreaterThan(0);
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('tool descriptions contain relevant keywords', () => {
    expect(reportTools['ocr_evaluation_report'].description).toContain('evaluation');
    expect(reportTools['ocr_document_report'].description).toContain('document');
    expect(reportTools['ocr_quality_summary'].description).toContain('quality');
    expect(reportTools['ocr_cost_summary'].description).toContain('cost');
    expect(reportTools['ocr_pipeline_analytics'].description).toContain('pipeline');
    expect(reportTools['ocr_corpus_profile'].description).toContain('corpus');
    expect(reportTools['ocr_error_analytics'].description).toContain('error');
    expect(reportTools['ocr_provenance_bottlenecks'].description).toContain('bottleneck');
  });

  it('ocr_evaluation_report has correct inputSchema keys', () => {
    const schema = reportTools['ocr_evaluation_report'].inputSchema;
    expect(schema).toHaveProperty('output_path');
    expect(schema).toHaveProperty('confidence_threshold');
  });

  it('ocr_document_report has correct inputSchema keys', () => {
    const schema = reportTools['ocr_document_report'].inputSchema;
    expect(schema).toHaveProperty('document_id');
  });

  it('ocr_quality_summary has empty inputSchema', () => {
    const schema = reportTools['ocr_quality_summary'].inputSchema;
    expect(Object.keys(schema)).toHaveLength(0);
  });

  it('ocr_cost_summary has correct inputSchema keys', () => {
    const schema = reportTools['ocr_cost_summary'].inputSchema;
    expect(schema).toHaveProperty('group_by');
  });

  it('ocr_pipeline_analytics has correct inputSchema keys', () => {
    const schema = reportTools['ocr_pipeline_analytics'].inputSchema;
    expect(schema).toHaveProperty('group_by');
    expect(schema).toHaveProperty('limit');
  });

  it('ocr_corpus_profile has correct inputSchema keys', () => {
    const schema = reportTools['ocr_corpus_profile'].inputSchema;
    expect(schema).toHaveProperty('include_section_frequency');
    expect(schema).toHaveProperty('include_content_type_distribution');
    expect(schema).toHaveProperty('limit');
  });

  it('ocr_error_analytics has correct inputSchema keys', () => {
    const schema = reportTools['ocr_error_analytics'].inputSchema;
    expect(schema).toHaveProperty('include_error_messages');
    expect(schema).toHaveProperty('limit');
  });
});

// ===============================================================================
// handleEvaluationReport TESTS
// ===============================================================================

describe('handleEvaluationReport', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleEvaluationReport({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with output_path param when no database', async () => {
    const response = await handleEvaluationReport({ output_path: '/tmp/report.md' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with confidence_threshold param when no database', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: 0.5 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error for confidence_threshold below 0', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: -0.1 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // ValidationError from validateInput() maps to VALIDATION_ERROR via MCPError.fromUnknown()
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('greater than or equal to 0');
  });

  it('returns error for confidence_threshold above 1', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: 1.5 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('less than or equal to 1');
  });

  it('returns error for confidence_threshold as string', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: 'high' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Expected number');
  });

  it('returns error for output_path as number', async () => {
    const response = await handleEvaluationReport({ output_path: 123 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Expected string');
  });

  it('accepts valid confidence_threshold boundary values without database', async () => {
    // Boundary value 0 should pass validation, then fail on database check
    const response0 = await handleEvaluationReport({ confidence_threshold: 0 });
    const result0 = parseResponse(response0);
    expect(result0.success).toBe(false);
    expect(result0.error?.category).toBe('DATABASE_NOT_SELECTED');

    // Boundary value 1 should pass validation, then fail on database check
    const response1 = await handleEvaluationReport({ confidence_threshold: 1 });
    const result1 = parseResponse(response1);
    expect(result1.success).toBe(false);
    expect(result1.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts empty params with default confidence_threshold without database', async () => {
    const response = await handleEvaluationReport({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Should pass validation (defaults applied) and fail on database check
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('validation fails before database check for invalid confidence_threshold', async () => {
    // No database is selected, but validation should fail first
    expect(state.currentDatabase).toBeNull();
    const response = await handleEvaluationReport({ confidence_threshold: -1 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Validation error comes first, not DATABASE_NOT_SELECTED
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('confidence_threshold');
  });
});

// ===============================================================================
// handleDocumentReport TESTS
// ===============================================================================

describe('handleDocumentReport', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns error when document_id is missing', async () => {
    const response = await handleDocumentReport({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Required');
  });

  it('returns error when document_id is empty string', async () => {
    const response = await handleDocumentReport({ document_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('at least 1 character');
  });

  it('returns error when document_id is not a string', async () => {
    const response = await handleDocumentReport({ document_id: 123 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Expected string');
  });

  it('returns error when document_id is null', async () => {
    const response = await handleDocumentReport({ document_id: null });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Expected string');
  });

  it('returns DATABASE_NOT_SELECTED when no database with valid document_id', async () => {
    const response = await handleDocumentReport({ document_id: 'some-valid-id' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with UUID document_id when no database', async () => {
    const response = await handleDocumentReport({
      document_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('validation error precedes database check for empty document_id', async () => {
    // Even though no database is selected, validation should fail first
    expect(state.currentDatabase).toBeNull();
    const response = await handleDocumentReport({ document_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Validation error (VALIDATION_ERROR) comes first, not DATABASE_NOT_SELECTED
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('at least 1 character');
  });

  it('validation error precedes database check for missing document_id', async () => {
    expect(state.currentDatabase).toBeNull();
    const response = await handleDocumentReport({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('Required');
  });
});

// ===============================================================================
// handleQualitySummary TESTS
// ===============================================================================

describe('handleQualitySummary', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleQualitySummary({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with extra params (ignored by z.object({}))', async () => {
    // QualitySummaryInput is z.object({}) which strips extra keys
    const response = await handleQualitySummary({ extra_param: 'ignored' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with null param values', async () => {
    const response = await handleQualitySummary({ something: null });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with numeric param values (ignored)', async () => {
    const response = await handleQualitySummary({ count: 42 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// ===============================================================================
// HANDLER-TOOL WIRING VERIFICATION
// ===============================================================================

describe('handler-tool wiring', () => {
  it('ocr_evaluation_report handler is handleEvaluationReport', () => {
    expect(reportTools['ocr_evaluation_report'].handler).toBe(handleEvaluationReport);
  });

  it('ocr_document_report handler is handleDocumentReport', () => {
    expect(reportTools['ocr_document_report'].handler).toBe(handleDocumentReport);
  });

  it('ocr_quality_summary handler is handleQualitySummary', () => {
    expect(reportTools['ocr_quality_summary'].handler).toBe(handleQualitySummary);
  });

  it('ocr_cost_summary handler exists and is a function', () => {
    expect(reportTools['ocr_cost_summary'].handler).toBeDefined();
    expect(typeof reportTools['ocr_cost_summary'].handler).toBe('function');
  });

  it('ocr_pipeline_analytics handler is handlePipelineAnalytics', () => {
    expect(reportTools['ocr_pipeline_analytics'].handler).toBe(handlePipelineAnalytics);
  });

  it('ocr_corpus_profile handler is handleCorpusProfile', () => {
    expect(reportTools['ocr_corpus_profile'].handler).toBe(handleCorpusProfile);
  });

  it('ocr_error_analytics handler is handleErrorAnalytics', () => {
    expect(reportTools['ocr_error_analytics'].handler).toBe(handleErrorAnalytics);
  });
});

// ===============================================================================
// handlePipelineAnalytics TESTS
// ===============================================================================

describe('handlePipelineAnalytics', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handlePipelineAnalytics({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with valid params when no database', async () => {
    const response = await handlePipelineAnalytics({ group_by: 'mode', limit: 10 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns VALIDATION_ERROR for invalid group_by', async () => {
    const response = await handlePipelineAnalytics({ group_by: 'invalid' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR for limit below 1', async () => {
    const response = await handlePipelineAnalytics({ limit: 0 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR for limit above 100', async () => {
    const response = await handlePipelineAnalytics({ limit: 101 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});

// ===============================================================================
// handleCorpusProfile TESTS
// ===============================================================================

describe('handleCorpusProfile', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleCorpusProfile({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with valid params when no database', async () => {
    const response = await handleCorpusProfile({
      include_section_frequency: false,
      include_content_type_distribution: false,
      limit: 5,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns VALIDATION_ERROR for limit below 1', async () => {
    const response = await handleCorpusProfile({ limit: 0 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR for non-boolean include_section_frequency', async () => {
    const response = await handleCorpusProfile({ include_section_frequency: 'yes' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});

// ===============================================================================
// handleErrorAnalytics TESTS
// ===============================================================================

describe('handleErrorAnalytics', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    const response = await handleErrorAnalytics({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns DATABASE_NOT_SELECTED with valid params when no database', async () => {
    const response = await handleErrorAnalytics({ include_error_messages: false, limit: 5 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns VALIDATION_ERROR for limit below 1', async () => {
    const response = await handleErrorAnalytics({ limit: 0 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR for limit above 50', async () => {
    const response = await handleErrorAnalytics({ limit: 51 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR for non-boolean include_error_messages', async () => {
    const response = await handleErrorAnalytics({ include_error_messages: 'true' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
  });
});

// ===============================================================================
// RESPONSE FORMAT VERIFICATION
// ===============================================================================

describe('response format', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('error responses have correct MCP content structure', async () => {
    const response = await handleEvaluationReport({});

    // Verify MCP response envelope
    expect(response).toHaveProperty('content');
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]).toHaveProperty('type', 'text');
    expect(response.content[0]).toHaveProperty('text');
    expect(typeof response.content[0].text).toBe('string');

    // Verify parseable JSON
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed).toHaveProperty('success', false);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toHaveProperty('category');
    expect(parsed.error).toHaveProperty('message');
  });

  it('all three handlers return consistent error format for no database', async () => {
    const responses = await Promise.all([
      handleEvaluationReport({}),
      handleDocumentReport({ document_id: 'test-id' }),
      handleQualitySummary({}),
    ]);

    for (const response of responses) {
      const result = parseResponse(response);
      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
      expect(typeof result.error?.message).toBe('string');
      expect(result.error!.message.length).toBeGreaterThan(0);
    }
  });

  it('validation error responses include descriptive messages', async () => {
    const response = await handleDocumentReport({ document_id: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // ValidationError maps to VALIDATION_ERROR via MCPError.fromUnknown()
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error!.message.length).toBeGreaterThan(0);
    expect(result.error!.message).toContain('at least 1 character');
  });

  it('validation error details include originalName', async () => {
    const response = await handleDocumentReport({ document_id: 123 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    // MCPError.fromUnknown() detects ValidationError and includes original error name in details
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });
});

// ===============================================================================
// EDGE CASES
// ===============================================================================

describe('edge cases', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('handleEvaluationReport handles undefined params gracefully', async () => {
    // validateInput receives undefined -- Zod should reject
    const response = await handleEvaluationReport(undefined as unknown as Record<string, unknown>);
    const result = parseResponse(response);

    // Should fail (either validation or database check)
    expect(result.success).toBe(false);
  });

  it('handleDocumentReport handles undefined params gracefully', async () => {
    const response = await handleDocumentReport(undefined as unknown as Record<string, unknown>);
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it('handleQualitySummary handles undefined params gracefully', async () => {
    const response = await handleQualitySummary(undefined as unknown as Record<string, unknown>);
    const result = parseResponse(response);

    expect(result.success).toBe(false);
  });

  it('handleDocumentReport rejects boolean document_id', async () => {
    const response = await handleDocumentReport({ document_id: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });

  it('handleDocumentReport rejects array document_id', async () => {
    const response = await handleDocumentReport({ document_id: ['id1', 'id2'] });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });

  it('handleDocumentReport rejects object document_id', async () => {
    const response = await handleDocumentReport({ document_id: { id: 'test' } });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });

  it('handleEvaluationReport rejects confidence_threshold as boolean', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: true });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });

  it('handleEvaluationReport rejects confidence_threshold as array', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: [0.5] });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });

  it('handleEvaluationReport rejects confidence_threshold as object', async () => {
    const response = await handleEvaluationReport({ confidence_threshold: { value: 0.5 } });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('VALIDATION_ERROR');
    expect(result.error?.details?.originalName).toBe('ValidationError');
  });

  it('state is null after resetState', () => {
    expect(state.currentDatabase).toBeNull();
    expect(state.currentDatabaseName).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleProvenanceBottlenecks TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleProvenanceBottlenecks', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database', async () => {
    expect(state.currentDatabase).toBeNull();

    const response = await handleProvenanceBottlenecks({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts empty params (no required fields)', async () => {
    // Should pass validation and fail only on database not selected
    const response = await handleProvenanceBottlenecks({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('ignores unknown extra parameters', async () => {
    const response = await handleProvenanceBottlenecks({ unknown_param: 42 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

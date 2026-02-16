/**
 * Unit Tests for Question-Answer MCP Tools
 *
 * Tests the question-answer tool handlers in src/tools/question-answer.ts
 * Tools: ocr_question_answer
 *
 * NO MOCK DATA - Tests error paths and input validation only.
 * FAIL FAST - Tests verify errors throw immediately with correct error categories.
 *
 * @module tests/unit/tools/question-answer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { questionAnswerTools } from '../../../src/tools/question-answer.js';
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

// =============================================================================
// TOOL EXPORTS VERIFICATION
// =============================================================================

describe('questionAnswerTools exports', () => {
  it('exports exactly 1 tool', () => {
    expect(Object.keys(questionAnswerTools)).toHaveLength(1);
    expect(questionAnswerTools).toHaveProperty('ocr_question_answer');
  });

  it('each tool has description, inputSchema, and handler', () => {
    for (const [name, tool] of Object.entries(questionAnswerTools)) {
      expect(tool.description, `${name} missing description`).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema, `${name} missing inputSchema`).toBeDefined();
      expect(tool.handler, `${name} missing handler`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('ocr_question_answer description mentions RAG and search modes', () => {
    const desc = questionAnswerTools.ocr_question_answer.description;
    expect(desc).toContain('RAG');
    expect(desc).toContain('hybrid');
    expect(desc).toContain('BM25');
    expect(desc).toContain('semantic');
  });

  it('ocr_question_answer inputSchema has expected fields', () => {
    const schema = questionAnswerTools.ocr_question_answer.inputSchema;
    expect(schema).toHaveProperty('question');
    expect(schema).toHaveProperty('document_filter');
    expect(schema).toHaveProperty('include_sources');
    expect(schema).toHaveProperty('include_entity_context');
    expect(schema).toHaveProperty('include_kg_paths');
    expect(schema).toHaveProperty('max_context_length');
    expect(schema).toHaveProperty('limit');
    expect(schema).toHaveProperty('temperature');
    expect(schema).toHaveProperty('search_mode');
    expect(schema).toHaveProperty('entity_filter');
    expect(schema).toHaveProperty('semantic_weight');
    expect(schema).toHaveProperty('include_cluster_context');
    expect(schema).toHaveProperty('include_contradictions');
    expect(schema).toHaveProperty('prefer_recent');
  });
});

// =============================================================================
// handleQuestionAnswer - No Database Selected
// =============================================================================

describe('handleQuestionAnswer - no database selected', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns DATABASE_NOT_SELECTED when no database is selected', async () => {
    expect(state.currentDatabase).toBeNull();

    const response = await handler({ question: 'What is the diagnosis?' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
    expect(result.error?.message).toContain('No database selected');
  });

  it('returns DATABASE_NOT_SELECTED even with all optional params', async () => {
    const response = await handler({
      question: 'What happened on January 5th?',
      document_filter: ['doc-1', 'doc-2'],
      include_sources: true,
      include_entity_context: true,
      include_kg_paths: true,
      max_context_length: 4000,
      limit: 3,
      temperature: 0.5,
      search_mode: 'bm25',
      semantic_weight: 0.7,
      include_cluster_context: true,
      include_contradictions: true,
      prefer_recent: true,
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleQuestionAnswer - Input Validation
// =============================================================================

describe('handleQuestionAnswer - input validation', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns error when question is missing', async () => {
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
    expect(result.error?.message).toContain('question');
  });

  it('returns error when question is empty string', async () => {
    const response = await handler({ question: '' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
    expect(result.error?.message).toContain('question');
  });

  it('returns error when question exceeds 2000 characters', async () => {
    const longQuestion = 'a'.repeat(2001);
    const response = await handler({ question: longQuestion });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
    expect(result.error?.message).toContain('question');
  });

  it('accepts question at max length boundary (2000 chars) - fails at DB level not validation', async () => {
    const maxQuestion = 'a'.repeat(2000);
    const response = await handler({ question: maxQuestion });
    const result = parseResponse(response);

    // Should fail with DATABASE_NOT_SELECTED, not validation error
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts question at min length boundary (1 char) - fails at DB level not validation', async () => {
    const response = await handler({ question: 'x' });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error when question is wrong type (number)', async () => {
    const response = await handler({ question: 42 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// handleQuestionAnswer - search_mode validation
// =============================================================================

describe('handleQuestionAnswer - search_mode validation', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns error for invalid search_mode', async () => {
    const response = await handler({ question: 'test', search_mode: 'invalid_mode' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
    expect(result.error?.message).toContain('search_mode');
  });

  it('returns error for numeric search_mode', async () => {
    const response = await handler({ question: 'test', search_mode: 123 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts hybrid search_mode - fails at DB level', async () => {
    const response = await handler({ question: 'test', search_mode: 'hybrid' });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts bm25 search_mode - fails at DB level', async () => {
    const response = await handler({ question: 'test', search_mode: 'bm25' });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts semantic search_mode - fails at DB level', async () => {
    const response = await handler({ question: 'test', search_mode: 'semantic' });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleQuestionAnswer - numeric param validation
// =============================================================================

describe('handleQuestionAnswer - numeric param validation', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  // --- limit ---

  it('returns error when limit is below minimum (0)', async () => {
    const response = await handler({ question: 'test', limit: 0 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error when limit exceeds maximum (21)', async () => {
    const response = await handler({ question: 'test', limit: 21 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error when limit is not an integer', async () => {
    const response = await handler({ question: 'test', limit: 3.5 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts limit at min boundary (1) - fails at DB level', async () => {
    const response = await handler({ question: 'test', limit: 1 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts limit at max boundary (20) - fails at DB level', async () => {
    const response = await handler({ question: 'test', limit: 20 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  // --- temperature ---

  it('returns error when temperature is below 0', async () => {
    const response = await handler({ question: 'test', temperature: -0.1 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error when temperature exceeds 1', async () => {
    const response = await handler({ question: 'test', temperature: 1.1 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts temperature at boundary (0) - fails at DB level', async () => {
    const response = await handler({ question: 'test', temperature: 0 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts temperature at boundary (1) - fails at DB level', async () => {
    const response = await handler({ question: 'test', temperature: 1 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  // --- max_context_length ---

  it('returns error when max_context_length is below 500', async () => {
    const response = await handler({ question: 'test', max_context_length: 499 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error when max_context_length exceeds 50000', async () => {
    const response = await handler({ question: 'test', max_context_length: 50001 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error when max_context_length is not an integer', async () => {
    const response = await handler({ question: 'test', max_context_length: 1000.5 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts max_context_length at min boundary (500) - fails at DB level', async () => {
    const response = await handler({ question: 'test', max_context_length: 500 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts max_context_length at max boundary (50000) - fails at DB level', async () => {
    const response = await handler({ question: 'test', max_context_length: 50000 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  // --- semantic_weight ---

  it('returns error when semantic_weight is below 0', async () => {
    const response = await handler({ question: 'test', semantic_weight: -0.01 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('returns error when semantic_weight exceeds 1', async () => {
    const response = await handler({ question: 'test', semantic_weight: 1.01 });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('accepts semantic_weight at boundary (0) - fails at DB level', async () => {
    const response = await handler({ question: 'test', semantic_weight: 0 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts semantic_weight at boundary (1) - fails at DB level', async () => {
    const response = await handler({ question: 'test', semantic_weight: 1 });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleQuestionAnswer - boolean param validation
// =============================================================================

describe('handleQuestionAnswer - boolean param defaults', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('accepts all boolean params as true - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      include_sources: true,
      include_entity_context: true,
      include_kg_paths: true,
      include_cluster_context: true,
      include_contradictions: true,
      prefer_recent: true,
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts all boolean params as false - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      include_sources: false,
      include_entity_context: false,
      include_kg_paths: false,
      include_cluster_context: false,
      include_contradictions: false,
      prefer_recent: false,
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });
});

// =============================================================================
// handleQuestionAnswer - document_filter validation
// =============================================================================

describe('handleQuestionAnswer - document_filter validation', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('accepts document_filter as string array - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      document_filter: ['doc-1', 'doc-2'],
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts document_filter as empty array - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      document_filter: [],
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error when document_filter is not an array', async () => {
    const response = await handler({
      question: 'test',
      document_filter: 'not-an-array',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// handleQuestionAnswer - entity_filter validation
// =============================================================================

describe('handleQuestionAnswer - entity_filter validation', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('accepts entity_filter with entity_names - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      entity_filter: { entity_names: ['John Doe'] },
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts entity_filter with entity_types - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      entity_filter: { entity_types: ['person', 'organization'] },
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts entity_filter with include_related - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      entity_filter: {
        entity_names: ['Aspirin'],
        include_related: true,
      },
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('accepts entity_filter as empty object - fails at DB level', async () => {
    const response = await handler({
      question: 'test',
      entity_filter: {},
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error when entity_filter is not an object', async () => {
    const response = await handler({
      question: 'test',
      entity_filter: 'invalid',
    });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// handleQuestionAnswer - response format verification
// =============================================================================

describe('handleQuestionAnswer - response format', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('returns content array with text type on error', async () => {
    const response = await handler({ question: 'test' });

    expect(response).toHaveProperty('content');
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
  });

  it('error response is valid parseable JSON', async () => {
    const response = await handler({ question: 'test' });

    expect(() => JSON.parse(response.content[0].text)).not.toThrow();
  });

  it('error response has success=false and error object', async () => {
    const response = await handler({ question: 'test' });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toHaveProperty('category');
    expect(result.error).toHaveProperty('message');
  });

  it('validation error response has success=false and error with category', async () => {
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error?.category).toBe('string');
    expect(typeof result.error?.message).toBe('string');
  });
});

// =============================================================================
// handleQuestionAnswer - combined edge cases
// =============================================================================

describe('handleQuestionAnswer - edge cases', () => {
  const handler = questionAnswerTools.ocr_question_answer.handler;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    clearDatabase();
    resetState();
  });

  it('handles unicode question text - fails at DB level', async () => {
    const response = await handler({
      question: 'What about the patient record for Muller?',
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('handles question with special characters - fails at DB level', async () => {
    const response = await handler({
      question: "What's the patient's O'Brien diagnosis (ICD-10: A01.0)?",
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('handles question with newlines - fails at DB level', async () => {
    const response = await handler({
      question: 'First line\nSecond line',
    });
    const result = parseResponse(response);

    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('handles null question', async () => {
    const response = await handler({ question: null });
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });

  it('handles undefined params gracefully', async () => {
    const response = await handler({
      question: 'test',
      limit: undefined,
      temperature: undefined,
      search_mode: undefined,
    });
    const result = parseResponse(response);

    // undefined values should be treated as absent, using defaults
    // Should pass validation and fail at DB level
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('rejects extra unknown fields gracefully - passes through to DB check', async () => {
    // Zod .object() in passthrough mode (default) typically allows extra fields
    const response = await handler({
      question: 'test',
      unknown_field: 'some_value',
    });
    const result = parseResponse(response);

    // Zod strips unknown fields by default, so this should pass validation
    // and fail at the database level
    expect(result.error?.category).toBe('DATABASE_NOT_SELECTED');
  });

  it('returns error for completely empty params', async () => {
    const response = await handler({});
    const result = parseResponse(response);

    expect(result.success).toBe(false);
    // Missing required 'question' field
    expect(result.error?.category).toBe('INTERNAL_ERROR');
  });
});

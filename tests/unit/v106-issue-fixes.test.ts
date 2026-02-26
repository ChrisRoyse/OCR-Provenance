/**
 * V1.0.6 Issue Fix Verification Tests
 *
 * Issue 1: MCPError.fromUnknown preserves custom error details,
 *          handleRagContext/handleFTSManage/handleSearchSaved wrapped in withDatabaseOperation
 * Issue 2: VLM parseVLMJson content-type diagnostics,
 *          VLMPipeline processImage error context,
 *          GeminiClient last-attempt JSON validation logging
 *
 * Uses REAL error classes and source code inspection. NO mocks for core logic.
 * @module tests/unit/v106-issue-fixes
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MCPError } from '../../src/server/errors.js';
import { VectorError } from '../../src/services/storage/vector.js';
import { EmbeddingError } from '../../src/services/embedding/nomic.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 1: MCPError.fromUnknown preserves custom error details
// ═══════════════════════════════════════════════════════════════════════════════

describe('MCPError.fromUnknown preserves custom error details', () => {
  it('should preserve VectorError code and details', () => {
    const vectorError = new VectorError(
      'Vector search failed: SQL error near "SELECT"',
      'SEARCH_FAILED' as never, // VectorErrorCode is an enum, but we pass the string value
      { error: 'some SQL error', hasFilter: true, queryLength: 42 }
    );

    const mcpError = MCPError.fromUnknown(vectorError);

    expect(mcpError).toBeInstanceOf(MCPError);
    expect(mcpError.category).toBe('INTERNAL_ERROR'); // VectorError maps to INTERNAL_ERROR
    expect(mcpError.message).toBe('Vector search failed: SQL error near "SELECT"');
    expect(mcpError.details).toBeDefined();
    expect(mcpError.details!.errorCode).toBe('SEARCH_FAILED');
    expect(mcpError.details!.errorDetails).toEqual({
      error: 'some SQL error',
      hasFilter: true,
      queryLength: 42,
    });
    expect(mcpError.details!.originalName).toBe('VectorError');
    expect(mcpError.details!.stack).toBeDefined();
  });

  it('should preserve EmbeddingError code and details', () => {
    const embeddingError = new EmbeddingError(
      'GPU memory exhausted during batch embedding',
      'EMBEDDING_FAILED',
      { batchSize: 512, vramUsed: 7.8, device: 'cuda:0' }
    );

    const mcpError = MCPError.fromUnknown(embeddingError);

    expect(mcpError).toBeInstanceOf(MCPError);
    expect(mcpError.category).toBe('EMBEDDING_FAILED'); // EmbeddingError maps to EMBEDDING_FAILED
    expect(mcpError.message).toBe('GPU memory exhausted during batch embedding');
    expect(mcpError.details).toBeDefined();
    expect(mcpError.details!.errorCode).toBe('EMBEDDING_FAILED');
    expect(mcpError.details!.errorDetails).toEqual({
      batchSize: 512,
      vramUsed: 7.8,
      device: 'cuda:0',
    });
    expect(mcpError.details!.originalName).toBe('EmbeddingError');
  });

  it('should handle VectorError with INVALID_VECTOR_DIMENSIONS code', () => {
    const vectorError = new VectorError(
      'Expected 768 dimensions, got 384',
      'INVALID_VECTOR_DIMENSIONS' as never,
      { expected: 768, actual: 384 }
    );

    const mcpError = MCPError.fromUnknown(vectorError);

    expect(mcpError.details!.errorCode).toBe('INVALID_VECTOR_DIMENSIONS');
    expect(mcpError.details!.errorDetails).toEqual({ expected: 768, actual: 384 });
  });

  it('should handle regular Error without details or code', () => {
    const plainError = new Error('Something went wrong');

    const mcpError = MCPError.fromUnknown(plainError);

    expect(mcpError).toBeInstanceOf(MCPError);
    expect(mcpError.category).toBe('INTERNAL_ERROR');
    expect(mcpError.message).toBe('Something went wrong');
    expect(mcpError.details).toBeDefined();
    expect(mcpError.details!.originalName).toBe('Error');
    expect(mcpError.details!.stack).toBeDefined();
    // No errorCode or errorDetails for plain Error
    expect(mcpError.details!.errorCode).toBeUndefined();
    expect(mcpError.details!.errorDetails).toBeUndefined();
  });

  it('should pass through MCPError unchanged', () => {
    const original = new MCPError('DATABASE_NOT_FOUND', 'Database "test" not found', {
      databaseName: 'test',
    });

    const result = MCPError.fromUnknown(original);

    // Should return the exact same instance
    expect(result).toBe(original);
    expect(result.category).toBe('DATABASE_NOT_FOUND');
    expect(result.message).toBe('Database "test" not found');
    expect(result.details).toEqual({ databaseName: 'test' });
  });

  it('should handle non-Error values', () => {
    const mcpError = MCPError.fromUnknown('raw string error');

    expect(mcpError).toBeInstanceOf(MCPError);
    expect(mcpError.category).toBe('INTERNAL_ERROR');
    expect(mcpError.message).toBe('raw string error');
    expect(mcpError.details).toEqual({ originalValue: 'raw string error' });
  });

  it('should handle null and undefined values', () => {
    const fromNull = MCPError.fromUnknown(null);
    expect(fromNull.message).toBe('null');
    expect(fromNull.details).toEqual({ originalValue: null });

    const fromUndef = MCPError.fromUnknown(undefined);
    expect(fromUndef.message).toBe('undefined');
    expect(fromUndef.details).toEqual({ originalValue: undefined });
  });

  it('should handle VectorError with no details (details=undefined)', () => {
    const vectorError = new VectorError(
      'Extension not loaded',
      'VEC_EXTENSION_NOT_LOADED' as never
      // no details argument
    );

    const mcpError = MCPError.fromUnknown(vectorError);

    expect(mcpError.details!.errorCode).toBe('VEC_EXTENSION_NOT_LOADED');
    // When details is undefined, it should not be spread into the MCPError details
    expect(mcpError.details!.errorDetails).toBeUndefined();
    expect(mcpError.details!.originalName).toBe('VectorError');
  });

  it('should handle EmbeddingError with empty details', () => {
    const embeddingError = new EmbeddingError(
      'Worker crashed',
      'WORKER_ERROR',
      {} // empty details object
    );

    const mcpError = MCPError.fromUnknown(embeddingError);

    expect(mcpError.details!.errorCode).toBe('WORKER_ERROR');
    // Empty object is truthy, so it should be included
    expect(mcpError.details!.errorDetails).toEqual({});
  });

  it('should use defaultCategory when error name is not in mapping', () => {
    // Create a custom error not in the ERROR_NAME_TO_CATEGORY map
    class UnknownCustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'UnknownCustomError';
      }
    }

    const error = new UnknownCustomError('Something unknown');
    const mcpError = MCPError.fromUnknown(error, 'VALIDATION_ERROR');

    expect(mcpError.category).toBe('VALIDATION_ERROR');
    expect(mcpError.details!.originalName).toBe('UnknownCustomError');
  });

  it('should handle error with code but no details', () => {
    // Simulate an error that has .code but no .details
    class CodeOnlyError extends Error {
      public readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = 'CodeOnlyError';
        this.code = code;
      }
    }

    const error = new CodeOnlyError('Some failure', 'CUSTOM_CODE');
    const mcpError = MCPError.fromUnknown(error);

    expect(mcpError.details!.errorCode).toBe('CUSTOM_CODE');
    expect(mcpError.details!.errorDetails).toBeUndefined();
  });

  it('should handle error with empty string code', () => {
    class EmptyCodeError extends Error {
      public readonly code = '';
      constructor(message: string) {
        super(message);
        this.name = 'EmptyCodeError';
      }
    }

    const error = new EmptyCodeError('Failure with empty code');
    const mcpError = MCPError.fromUnknown(error);

    // Empty string is falsy, so errorCode should NOT be included
    expect(mcpError.details!.errorCode).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 2: handleRagContext, handleFTSManage, handleSearchSaved
//               are wrapped in withDatabaseOperation for race condition protection
// ═══════════════════════════════════════════════════════════════════════════════

describe('Race condition protection (withDatabaseOperation wrapping)', () => {
  // Structural test: read source code and verify the pattern is applied
  const searchSourcePath = join(process.cwd(), 'src', 'tools', 'search.ts');
  let searchSource: string;

  try {
    searchSource = readFileSync(searchSourcePath, 'utf-8');
  } catch {
    searchSource = '';
  }

  it('should have readable search.ts source', () => {
    expect(searchSource.length).toBeGreaterThan(0);
  });

  it('handleRagContext should be wrapped in withDatabaseOperation', () => {
    // Find the handleRagContext function and verify it uses withDatabaseOperation
    const ragFnMatch = searchSource.match(
      /function handleRagContext\([\s\S]*?return await withDatabaseOperation/
    );
    expect(ragFnMatch).not.toBeNull();
  });

  it('handleFTSManage should be wrapped in withDatabaseOperation', () => {
    const ftsFnMatch = searchSource.match(
      /function handleFTSManage\([\s\S]*?return await withDatabaseOperation/
    );
    expect(ftsFnMatch).not.toBeNull();
  });

  it('handleSearchSaved should be wrapped in withDatabaseOperation', () => {
    const savedFnMatch = searchSource.match(
      /function handleSearchSaved\([\s\S]*?return await withDatabaseOperation/
    );
    expect(savedFnMatch).not.toBeNull();
  });

  it('withDatabaseOperation should be imported from state.ts', () => {
    expect(searchSource).toContain('withDatabaseOperation');
    const importMatch = searchSource.match(/import\s*\{[^}]*withDatabaseOperation[^}]*\}\s*from/);
    expect(importMatch).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 3: VLM parseVLMJson error diagnostics
// ═══════════════════════════════════════════════════════════════════════════════

describe('VLM parseVLMJson error diagnostics', () => {
  // Since parseVLMJson is private, we test it indirectly by creating a VLMService
  // and calling its public methods that delegate to parseVLMJson.
  // However, creating a VLMService requires GeminiClient which needs an API key.
  // Instead we test the source code logic patterns and verify the error messages
  // match the expected diagnostic format by inspecting the source.

  const vlmServicePath = join(process.cwd(), 'src', 'services', 'vlm', 'service.ts');
  let vlmSource: string;

  try {
    vlmSource = readFileSync(vlmServicePath, 'utf-8');
  } catch {
    vlmSource = '';
  }

  it('should have readable VLM service source', () => {
    expect(vlmSource.length).toBeGreaterThan(0);
  });

  it('parseVLMJson should reject empty responses with clear error message', () => {
    // Verify the empty check pattern exists
    const emptyCheck = vlmSource.includes("if (!text || text.trim().length === 0)");
    expect(emptyCheck).toBe(true);

    // Verify the error message includes 'empty response'
    const emptyError = vlmSource.includes('Gemini returned an empty response');
    expect(emptyError).toBe(true);
  });

  it('parseVLMJson should detect HTML content type in diagnostics', () => {
    // Verify HTML detection: <html or <HTML
    const htmlDetection = vlmSource.includes("<html") && vlmSource.includes("<HTML");
    expect(htmlDetection).toBe(true);

    // Verify it maps to 'HTML' contentHint
    const htmlHint = vlmSource.includes("hasHtml ? 'HTML'");
    expect(htmlHint).toBe(true);
  });

  it('parseVLMJson should detect partial-JSON content type', () => {
    const partialJsonHint = vlmSource.includes("hasBraces ? 'partial-JSON'");
    expect(partialJsonHint).toBe(true);
  });

  it('parseVLMJson should detect plain-text content type', () => {
    const plainTextHint = vlmSource.includes("'plain-text'");
    expect(plainTextHint).toBe(true);
  });

  it('parseVLMJson should include contentType in error message', () => {
    // Verify the error message includes contentType
    const contentTypeInError = vlmSource.includes('contentType=${contentHint}');
    expect(contentTypeInError).toBe(true);
  });

  it('parseVLMJson should include responseLength in error message', () => {
    const responseLengthInError = vlmSource.includes('responseLength=${text.length}');
    expect(responseLengthInError).toBe(true);
  });

  it('parseVLMJson should include raw response preview in error', () => {
    const rawPreview = vlmSource.includes('text.slice(0, 500)');
    expect(rawPreview).toBe(true);
  });

  it('parseVLMJson should strip markdown code fences before parsing', () => {
    const stripFences = vlmSource.includes("```json");
    expect(stripFences).toBe(true);
  });

  it('parseVLMJson should extract JSON from mixed text (reasoning preamble)', () => {
    // Verify the brace extraction logic
    const firstBrace = vlmSource.includes("clean.indexOf('{')");
    const lastBrace = vlmSource.includes("clean.lastIndexOf('}')");
    expect(firstBrace).toBe(true);
    expect(lastBrace).toBe(true);
  });

  it('parseVLMJson Step 4 diagnostics should log firstBrace and lastBrace positions', () => {
    const diagLog = vlmSource.includes("firstBrace=${text.indexOf('{')}");
    expect(diagLog).toBe(true);
    const lastBraceDiag = vlmSource.includes("lastBrace=${text.lastIndexOf('}')}");
    expect(lastBraceDiag).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 4: VLMPipeline processImage error context
// ═══════════════════════════════════════════════════════════════════════════════

describe('VLMPipeline processImage error context', () => {
  const pipelinePath = join(process.cwd(), 'src', 'services', 'vlm', 'pipeline.ts');
  let pipelineSource: string;

  try {
    pipelineSource = readFileSync(pipelinePath, 'utf-8');
  } catch {
    pipelineSource = '';
  }

  it('should have readable VLM pipeline source', () => {
    expect(pipelineSource.length).toBeGreaterThan(0);
  });

  it('processImage error handler should include image_id in context', () => {
    const hasImageId = pipelineSource.includes('image_id=${image.id}');
    expect(hasImageId).toBe(true);
  });

  it('processImage error handler should include page number in context', () => {
    const hasPage = pipelineSource.includes('page=${image.page_number');
    expect(hasPage).toBe(true);
  });

  it('processImage error handler should include block_type in context', () => {
    const hasBlockType = pipelineSource.includes('block_type=${image.block_type');
    expect(hasBlockType).toBe(true);
  });

  it('processImage error handler should include dimensions in context', () => {
    const hasDimensions = pipelineSource.includes('dimensions=${image.dimensions');
    expect(hasDimensions).toBe(true);
  });

  it('processImage should construct imageContext string for error messages', () => {
    // Verify the imageContext pattern is built and used in the error message
    const imageContextPattern = pipelineSource.match(
      /const imageContext = [`']image_id=\$\{image\.id\}/
    );
    expect(imageContextPattern).not.toBeNull();
  });

  it('processImage should include imageContext in failure message stored to DB', () => {
    // The failureMessage should incorporate imageContext
    const failureWithContext = pipelineSource.includes('`${errorMessage} [${imageContext}]`');
    expect(failureWithContext).toBe(true);
  });

  it('processImage should log full imageContext on VLM analysis failure', () => {
    // console.error log should include imageContext
    const logPattern = pipelineSource.includes(
      'VLM analysis failed for ${imageContext}'
    );
    expect(logPattern).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 5: GeminiClient last-attempt JSON validation logging
// ═══════════════════════════════════════════════════════════════════════════════

describe('GeminiClient last-attempt JSON validation logging', () => {
  const clientPath = join(process.cwd(), 'src', 'services', 'gemini', 'client.ts');
  let clientSource: string;

  try {
    clientSource = readFileSync(clientPath, 'utf-8');
  } catch {
    clientSource = '';
  }

  it('should have readable Gemini client source', () => {
    expect(clientSource.length).toBeGreaterThan(0);
  });

  it('should validate JSON on last attempt (maxAttempts - 1)', () => {
    // Verify the last-attempt check: `attempt === maxAttempts - 1`
    const lastAttemptCheck = clientSource.includes('attempt === maxAttempts - 1');
    expect(lastAttemptCheck).toBe(true);
  });

  it('should log responseLength on last-attempt JSON failure', () => {
    const logResponseLength = clientSource.includes(
      'responseLength=${text.length}'
    );
    expect(logResponseLength).toBe(true);
  });

  it('should log parseError on last-attempt JSON failure', () => {
    const logParseError = clientSource.includes(
      'parseError=${parseError instanceof Error ? parseError.message : String(parseError)}'
    );
    expect(logParseError).toBe(true);
  });

  it('should log responsePreview on last-attempt JSON failure', () => {
    const logPreview = clientSource.includes('responsePreview=${JSON.stringify(text.slice(0, 200))}');
    expect(logPreview).toBe(true);
  });

  it('should include "Final attempt" label in last-attempt log', () => {
    const finalAttemptLabel = clientSource.includes('Final attempt');
    expect(finalAttemptLabel).toBe(true);
  });

  it('should not retry on last attempt - let caller handle extraction', () => {
    // After the last-attempt JSON validation, there should be a comment about not retrying
    const noRetryComment = clientSource.includes(
      "Don't retry, let caller's parser attempt more robust extraction"
    );
    expect(noRetryComment).toBe(true);
  });

  it('should validate JSON mid-attempt and retry on malformed response', () => {
    // Verify mid-attempt JSON validation exists (non-last attempts)
    const midAttemptRetry = clientSource.includes('Malformed JSON response from Gemini');
    expect(midAttemptRetry).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 6: MCPError.fromUnknown with OCR error subclasses
// ═══════════════════════════════════════════════════════════════════════════════

describe('MCPError.fromUnknown with OCR error subclasses', () => {
  it('should prefer OCR error .category over default mapping', () => {
    // Simulate an OCRRateLimitError (has name and category)
    class OCRRateLimitError extends Error {
      public readonly category = 'OCR_RATE_LIMIT';
      constructor(message: string) {
        super(message);
        this.name = 'OCRRateLimitError';
      }
    }

    const ocrError = new OCRRateLimitError('Rate limited by Datalab API');
    const mcpError = MCPError.fromUnknown(ocrError);

    // Should use the error's own .category, not the mapping default
    expect(mcpError.category).toBe('OCR_RATE_LIMIT');
    expect(mcpError.details!.originalName).toBe('OCRRateLimitError');
  });

  it('should fall back to mapped category for OCR errors with invalid category', () => {
    class OCRError extends Error {
      public readonly category = 'INVALID_CATEGORY';
      constructor(message: string) {
        super(message);
        this.name = 'OCRError';
      }
    }

    const ocrError = new OCRError('Some OCR error');
    const mcpError = MCPError.fromUnknown(ocrError);

    // Invalid category should fall back to ERROR_NAME_TO_CATEGORY mapping
    expect(mcpError.category).toBe('OCR_API_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP 7: End-to-end error detail preservation (integration-style)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Error detail preservation end-to-end', () => {
  it('should preserve nested details through MCPError conversion', () => {
    const complexDetails = {
      query: 'SELECT * FROM chunks WHERE ...',
      filters: {
        document_filter: 'doc-123',
        page_range: { start: 1, end: 5 },
      },
      timing: { parseMs: 12, searchMs: 340 },
    };

    const vectorError = new VectorError(
      'Search failed with complex query',
      'SEARCH_FAILED' as never,
      complexDetails
    );

    const mcpError = MCPError.fromUnknown(vectorError);

    // Nested details should be fully preserved
    const details = mcpError.details!.errorDetails as Record<string, unknown>;
    expect(details.query).toBe('SELECT * FROM chunks WHERE ...');
    expect(details.filters).toEqual({
      document_filter: 'doc-123',
      page_range: { start: 1, end: 5 },
    });
    expect(details.timing).toEqual({ parseMs: 12, searchMs: 340 });
  });

  it('should serialize MCPError with preserved details to JSON correctly', () => {
    const embeddingError = new EmbeddingError(
      'Model not found at expected path',
      'MODEL_NOT_FOUND',
      { path: '/opt/models/nomic', expectedVersion: '1.5' }
    );

    const mcpError = MCPError.fromUnknown(embeddingError);
    const json = mcpError.toJSON();

    expect(json.name).toBe('MCPError');
    expect(json.category).toBe('EMBEDDING_FAILED');
    expect(json.message).toBe('Model not found at expected path');
    const jsonDetails = json.details as Record<string, unknown>;
    expect(jsonDetails.errorCode).toBe('MODEL_NOT_FOUND');
    expect(jsonDetails.errorDetails).toEqual({
      path: '/opt/models/nomic',
      expectedVersion: '1.5',
    });
  });

  it('should handle number value passed to fromUnknown', () => {
    const mcpError = MCPError.fromUnknown(42);
    expect(mcpError.message).toBe('42');
    expect(mcpError.details).toEqual({ originalValue: 42 });
  });

  it('should handle object value passed to fromUnknown', () => {
    const mcpError = MCPError.fromUnknown({ custom: 'value' });
    expect(mcpError.message).toBe('[object Object]');
    expect(mcpError.details).toEqual({ originalValue: { custom: 'value' } });
  });
});

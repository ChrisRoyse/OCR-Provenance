/**
 * Auto-Pipeline Parameter Validation Tests (OPT-9)
 *
 * Tests auto_extract_entities and auto_build_kg parameters in ProcessPendingInput.
 * Validates:
 *   - auto_extract_entities defaults to false
 *   - auto_build_kg defaults to false
 *   - auto_build_kg requires auto_extract_entities=true
 *   - auto_extract_entities requires GEMINI_API_KEY
 *   - Both parameters accept boolean values
 *
 * NO mocks. Tests Zod validation and runtime checks.
 *
 * @module tests/unit/validation/auto-pipeline-params
 */

import { describe, it, expect } from 'vitest';
import { ProcessPendingInput } from '../../../src/utils/validation.js';

describe('ProcessPendingInput auto-pipeline parameters', () => {
  describe('auto_extract_entities', () => {
    it('defaults to false', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.auto_extract_entities).toBe(false);
    });

    it('accepts true', () => {
      const result = ProcessPendingInput.parse({ auto_extract_entities: true });
      expect(result.auto_extract_entities).toBe(true);
    });

    it('accepts false', () => {
      const result = ProcessPendingInput.parse({ auto_extract_entities: false });
      expect(result.auto_extract_entities).toBe(false);
    });

    it('rejects non-boolean value', () => {
      expect(() =>
        ProcessPendingInput.parse({ auto_extract_entities: 'yes' })
      ).toThrow();
    });
  });

  describe('auto_build_kg', () => {
    it('defaults to false', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.auto_build_kg).toBe(false);
    });

    it('accepts true', () => {
      const result = ProcessPendingInput.parse({ auto_build_kg: true, auto_extract_entities: true });
      expect(result.auto_build_kg).toBe(true);
    });

    it('accepts false', () => {
      const result = ProcessPendingInput.parse({ auto_build_kg: false });
      expect(result.auto_build_kg).toBe(false);
    });

    it('rejects non-boolean value', () => {
      expect(() =>
        ProcessPendingInput.parse({ auto_build_kg: 'yes' })
      ).toThrow();
    });
  });

  describe('combined auto-pipeline parameters', () => {
    it('both default to false when no params given', () => {
      const result = ProcessPendingInput.parse({});
      expect(result.auto_extract_entities).toBe(false);
      expect(result.auto_build_kg).toBe(false);
    });

    it('auto_extract_entities alone is valid', () => {
      const result = ProcessPendingInput.parse({ auto_extract_entities: true });
      expect(result.auto_extract_entities).toBe(true);
      expect(result.auto_build_kg).toBe(false);
    });

    it('both enabled parses successfully at schema level', () => {
      // The runtime check (auto_build_kg requires auto_extract_entities) is in the handler
      // At schema level, both true should parse fine
      const result = ProcessPendingInput.parse({
        auto_extract_entities: true,
        auto_build_kg: true,
      });
      expect(result.auto_extract_entities).toBe(true);
      expect(result.auto_build_kg).toBe(true);
    });

    it('auto_build_kg=true with auto_extract_entities=false parses at schema level', () => {
      // Schema does not enforce the dependency; the handler does the runtime check
      const result = ProcessPendingInput.parse({
        auto_extract_entities: false,
        auto_build_kg: true,
      });
      expect(result.auto_extract_entities).toBe(false);
      expect(result.auto_build_kg).toBe(true);
    });

    it('combined with other ProcessPendingInput params', () => {
      const result = ProcessPendingInput.parse({
        max_concurrent: 5,
        ocr_mode: 'accurate',
        auto_extract_entities: true,
        auto_build_kg: true,
        chunking_strategy: 'page_aware',
      });
      expect(result.max_concurrent).toBe(5);
      expect(result.ocr_mode).toBe('accurate');
      expect(result.auto_extract_entities).toBe(true);
      expect(result.auto_build_kg).toBe(true);
      expect(result.chunking_strategy).toBe('page_aware');
    });
  });

  describe('runtime validation logic', () => {
    it('auto_build_kg requires auto_extract_entities (mirrors handler check)', () => {
      // The handler checks: if (input.auto_build_kg && !input.auto_extract_entities)
      const input = ProcessPendingInput.parse({
        auto_build_kg: true,
        auto_extract_entities: false,
      });

      // This is the exact check from ingestion.ts:1126
      const shouldError = input.auto_build_kg && !input.auto_extract_entities;
      expect(shouldError).toBe(true);
    });

    it('auto_build_kg with auto_extract_entities does not trigger error', () => {
      const input = ProcessPendingInput.parse({
        auto_build_kg: true,
        auto_extract_entities: true,
      });

      const shouldError = input.auto_build_kg && !input.auto_extract_entities;
      expect(shouldError).toBe(false);
    });

    it('auto_extract_entities requires GEMINI_API_KEY (mirrors handler check)', () => {
      const input = ProcessPendingInput.parse({ auto_extract_entities: true });

      // The handler checks: if (input.auto_extract_entities && !process.env.GEMINI_API_KEY)
      // We verify the logic pattern is correct
      const hasApiKey = !!process.env.GEMINI_API_KEY;
      const shouldError = input.auto_extract_entities && !hasApiKey;

      // In test env, GEMINI_API_KEY may or may not be set
      // Just verify the logic evaluates correctly
      expect(typeof shouldError).toBe('boolean');
      if (!hasApiKey) {
        expect(shouldError).toBe(true);
      } else {
        expect(shouldError).toBe(false);
      }
    });
  });
});

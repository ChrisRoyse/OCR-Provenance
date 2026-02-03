/**
 * Unit Tests for Document Management Schemas
 *
 * Tests DocumentListInput, DocumentGetInput, DocumentDeleteInput
 */

import { describe, it, expect } from 'vitest';
import {
  DocumentListInput,
  DocumentGetInput,
  DocumentDeleteInput,
  VALID_UUID,
  INVALID_UUID,
} from './fixtures.js';

describe('Document Management Schemas', () => {
  describe('DocumentListInput', () => {
    it('should provide defaults', () => {
      const result = DocumentListInput.parse({});
      expect(result.sort_by).toBe('created_at');
      expect(result.sort_order).toBe('desc');
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should accept valid status filter', () => {
      const result = DocumentListInput.parse({ status_filter: 'complete' });
      expect(result.status_filter).toBe('complete');
    });

    it('should reject invalid sort_by', () => {
      expect(() => DocumentListInput.parse({ sort_by: 'invalid' })).toThrow();
    });

    it('should reject limit above maximum', () => {
      expect(() => DocumentListInput.parse({ limit: 1001 })).toThrow();
    });

    it('should reject negative offset', () => {
      expect(() => DocumentListInput.parse({ offset: -1 })).toThrow();
    });
  });

  describe('DocumentGetInput', () => {
    it('should accept valid UUID', () => {
      const result = DocumentGetInput.parse({
        document_id: VALID_UUID,
      });
      expect(result.document_id).toBe(VALID_UUID);
    });

    it('should reject invalid UUID', () => {
      expect(() => DocumentGetInput.parse({ document_id: INVALID_UUID })).toThrow(
        'Invalid document ID'
      );
    });

    it('should provide defaults', () => {
      const result = DocumentGetInput.parse({
        document_id: VALID_UUID,
      });
      expect(result.include_text).toBe(false);
      expect(result.include_chunks).toBe(false);
      expect(result.include_full_provenance).toBe(false);
    });
  });

  describe('DocumentDeleteInput', () => {
    it('should accept valid input', () => {
      const result = DocumentDeleteInput.parse({
        document_id: VALID_UUID,
        confirm: true,
      });
      expect(result.confirm).toBe(true);
    });

    it('should reject invalid UUID', () => {
      expect(() => DocumentDeleteInput.parse({ document_id: 'invalid', confirm: true })).toThrow(
        'Invalid document ID'
      );
    });

    it('should reject confirm=false', () => {
      expect(() =>
        DocumentDeleteInput.parse({
          document_id: VALID_UUID,
          confirm: false,
        })
      ).toThrow('Confirm must be true');
    });
  });
});

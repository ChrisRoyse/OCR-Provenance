/**
 * Unit Tests for Provenance Schemas
 *
 * Tests ProvenanceGetInput, ProvenanceVerifyInput, ProvenanceExportInput
 */

import { describe, it, expect } from 'vitest';
import {
  ProvenanceGetInput,
  ProvenanceVerifyInput,
  ProvenanceExportInput,
} from './fixtures.js';

describe('Provenance Schemas', () => {
  describe('ProvenanceGetInput', () => {
    it('should accept valid input', () => {
      const result = ProvenanceGetInput.parse({ item_id: 'prov_abc123' });
      expect(result.item_id).toBe('prov_abc123');
    });

    it('should provide defaults', () => {
      const result = ProvenanceGetInput.parse({ item_id: 'prov_abc123' });
      expect(result.item_type).toBe('auto');
      expect(result.format).toBe('chain');
    });

    it('should reject empty item_id', () => {
      expect(() => ProvenanceGetInput.parse({ item_id: '' })).toThrow('required');
    });

    it('should accept different formats', () => {
      expect(ProvenanceGetInput.parse({ item_id: 'test', format: 'tree' }).format).toBe('tree');
      expect(ProvenanceGetInput.parse({ item_id: 'test', format: 'flat' }).format).toBe('flat');
    });
  });

  describe('ProvenanceVerifyInput', () => {
    it('should accept valid input', () => {
      const result = ProvenanceVerifyInput.parse({ item_id: 'prov_abc123' });
      expect(result.item_id).toBe('prov_abc123');
      expect(result.verify_content).toBe(true);
      expect(result.verify_chain).toBe(true);
    });

    it('should allow disabling verification options', () => {
      const result = ProvenanceVerifyInput.parse({
        item_id: 'prov_abc123',
        verify_content: false,
        verify_chain: false,
      });
      expect(result.verify_content).toBe(false);
      expect(result.verify_chain).toBe(false);
    });
  });

  describe('ProvenanceExportInput', () => {
    it('should accept valid document scope with document_id', () => {
      const result = ProvenanceExportInput.parse({
        scope: 'document',
        document_id: 'doc_123',
      });
      expect(result.scope).toBe('document');
      expect(result.document_id).toBe('doc_123');
    });

    it('should reject document scope without document_id', () => {
      expect(() => ProvenanceExportInput.parse({ scope: 'document' })).toThrow(
        'document_id is required'
      );
    });

    it('should accept database scope without document_id', () => {
      const result = ProvenanceExportInput.parse({ scope: 'database' });
      expect(result.scope).toBe('database');
    });

    it('should accept all scope without document_id', () => {
      const result = ProvenanceExportInput.parse({ scope: 'all' });
      expect(result.scope).toBe('all');
    });

    it('should provide default format', () => {
      const result = ProvenanceExportInput.parse({ scope: 'all' });
      expect(result.format).toBe('json');
    });

    it('should accept different export formats', () => {
      expect(ProvenanceExportInput.parse({ scope: 'all', format: 'csv' }).format).toBe('csv');
      expect(ProvenanceExportInput.parse({ scope: 'all', format: 'w3c-prov' }).format).toBe(
        'w3c-prov'
      );
    });
  });
});

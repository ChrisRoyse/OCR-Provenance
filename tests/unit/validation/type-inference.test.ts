/**
 * Unit Tests for Type Inference
 *
 * Tests that TypeScript type inference works correctly with validation schemas
 */

import { describe, it, expect } from 'vitest';
import {
  DatabaseCreateInput,
  SearchSemanticInput,
  ProvenanceExportInput,
} from './fixtures.js';

describe('Type Inference', () => {
  it('should infer correct types from schemas', () => {
    // These tests verify TypeScript type inference at compile time
    // If they compile, the types are correct

    const dbCreate: { name: string; description?: string; storage_path?: string } =
      DatabaseCreateInput.parse({ name: 'test' });
    expect(dbCreate.name).toBe('test');

    const search: { query: string; limit: number } = SearchSemanticInput.parse({
      query: 'test',
    });
    expect(search.limit).toBe(10);

    const provExport: { scope: 'document' | 'database' } = ProvenanceExportInput.parse({
      scope: 'database',
    });
    expect(provExport.scope).toBe('database');
  });
});

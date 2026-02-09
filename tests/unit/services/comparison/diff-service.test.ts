/**
 * Diff Service Tests
 *
 * Tests the pure diff functions in src/services/comparison/diff-service.ts.
 * No database required - these are pure function tests.
 *
 * Uses REAL data, NO mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  compareText,
  compareStructure,
  compareEntities,
  generateSummary,
} from '../../../../src/services/comparison/diff-service.js';
import type { Entity } from '../../../../src/models/entity.js';
import type { TextDiffResult, StructuralDiff, EntityDiff } from '../../../../src/models/comparison.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function makeEntity(type: string, normalized: string, docId: string = 'doc-1'): Entity {
  return {
    id: `ent-${Math.random().toString(36).slice(2, 10)}`,
    document_id: docId,
    entity_type: type as Entity['entity_type'],
    raw_text: normalized,
    normalized_text: normalized.toLowerCase(),
    confidence: 0.9,
    metadata: null,
    provenance_id: 'prov-test',
    created_at: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// compareText TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('compareText', () => {
  it('identical texts -> similarity_ratio=1.0, insertions=0, deletions=0', () => {
    const text = 'Line one.\nLine two.\nLine three.\n';
    const result = compareText(text, text);

    expect(result.similarity_ratio).toBe(1.0);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.unchanged).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.doc1_length).toBe(text.length);
    expect(result.doc2_length).toBe(text.length);
  });

  it('completely different texts -> similarity_ratio=0.0, 1 deletion + 1 insertion', () => {
    const text1 = 'Alpha bravo charlie.\n';
    const text2 = 'Delta echo foxtrot.\n';
    const result = compareText(text1, text2);

    expect(result.similarity_ratio).toBe(0.0);
    expect(result.deletions).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it('single line inserted -> insertions=1, unchanged sections correct', () => {
    const text1 = 'Line one.\nLine two.\n';
    const text2 = 'Line one.\nInserted line.\nLine two.\n';
    const result = compareText(text1, text2);

    expect(result.insertions).toBeGreaterThanOrEqual(1);
    // The unchanged count should reflect that common parts are preserved
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
    expect(result.doc1_length).toBe(text1.length);
    expect(result.doc2_length).toBe(text2.length);
  });

  it('single line deleted -> deletions=1, unchanged sections correct', () => {
    const text1 = 'Line one.\nRemoved line.\nLine two.\n';
    const text2 = 'Line one.\nLine two.\n';
    const result = compareText(text1, text2);

    expect(result.deletions).toBeGreaterThanOrEqual(1);
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
    expect(result.doc1_length).toBe(text1.length);
    expect(result.doc2_length).toBe(text2.length);
  });

  it('line replaced -> deletions=1, insertions=1', () => {
    const text1 = 'Line one.\nOriginal line.\nLine three.\n';
    const text2 = 'Line one.\nReplaced line.\nLine three.\n';
    const result = compareText(text1, text2);

    expect(result.deletions).toBeGreaterThanOrEqual(1);
    expect(result.insertions).toBeGreaterThanOrEqual(1);
    // Common lines (Line one. and Line three.) should be unchanged
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
  });

  it('empty text1 -> insertions count, similarity_ratio=0.0', () => {
    const text2 = 'Some content here.\n';
    const result = compareText('', text2);

    expect(result.similarity_ratio).toBe(0.0);
    expect(result.insertions).toBeGreaterThanOrEqual(1);
    expect(result.deletions).toBe(0);
    expect(result.doc1_length).toBe(0);
    expect(result.doc2_length).toBe(text2.length);
  });

  it('empty text2 -> deletions count, similarity_ratio=0.0', () => {
    const text1 = 'Some content here.\n';
    const result = compareText(text1, '');

    expect(result.similarity_ratio).toBe(0.0);
    expect(result.deletions).toBeGreaterThanOrEqual(1);
    expect(result.insertions).toBe(0);
    expect(result.doc1_length).toBe(text1.length);
    expect(result.doc2_length).toBe(0);
  });

  it('both empty -> similarity_ratio=1.0, 0 operations', () => {
    const result = compareText('', '');

    expect(result.similarity_ratio).toBe(1.0);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.total_operations).toBe(0);
    expect(result.operations).toEqual([]);
  });

  it('unicode text (Cafe resume vs Cafe menu) -> handles multi-byte', () => {
    const text1 = 'Caf\u00e9 r\u00e9sum\u00e9\n';
    const text2 = 'Caf\u00e9 menu\n';
    const result = compareText(text1, text2);

    // Should produce valid results without crashing
    expect(result.doc1_length).toBe(text1.length);
    expect(result.doc2_length).toBe(text2.length);
    expect(result.total_operations).toBeGreaterThan(0);
    // The texts differ, so similarity should be < 1
    expect(result.similarity_ratio).toBeLessThan(1.0);
  });

  it('max operations truncation -> truncated=true, operations.length capped', () => {
    // Create text with many differing lines to generate many operations
    const lines1: string[] = [];
    const lines2: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines1.push(`Line ${String(i)} version A`);
      lines2.push(`Line ${String(i)} version B`);
      // Add a common line periodically to generate more operation segments
      if (i % 3 === 0) {
        const common = `Common line ${String(i)}`;
        lines1.push(common);
        lines2.push(common);
      }
    }
    const text1 = lines1.join('\n') + '\n';
    const text2 = lines2.join('\n') + '\n';

    // Use a very small maxOperations to force truncation
    const result = compareText(text1, text2, 3);

    expect(result.truncated).toBe(true);
    expect(result.operations.length).toBeLessThanOrEqual(3);
    expect(result.total_operations).toBeGreaterThan(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// compareStructure TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('compareStructure', () => {
  it('same structural data -> all fields equal', () => {
    const result = compareStructure(
      5, 5,     // page counts
      10, 10,   // chunk counts
      5000, 5000, // text lengths
      4.5, 4.5, // quality scores
      'balanced', 'balanced' // OCR modes
    );

    expect(result.doc1_page_count).toBe(5);
    expect(result.doc2_page_count).toBe(5);
    expect(result.doc1_chunk_count).toBe(10);
    expect(result.doc2_chunk_count).toBe(10);
    expect(result.doc1_text_length).toBe(5000);
    expect(result.doc2_text_length).toBe(5000);
    expect(result.doc1_quality_score).toBe(4.5);
    expect(result.doc2_quality_score).toBe(4.5);
    expect(result.doc1_ocr_mode).toBe('balanced');
    expect(result.doc2_ocr_mode).toBe('balanced');
  });

  it('different structural data -> shows differences', () => {
    const result = compareStructure(
      3, 7,     // page counts differ
      5, 12,    // chunk counts differ
      3000, 8000, // text lengths differ
      4.8, 3.2, // quality scores differ
      'accurate', 'fast' // OCR modes differ
    );

    expect(result.doc1_page_count).toBe(3);
    expect(result.doc2_page_count).toBe(7);
    expect(result.doc1_chunk_count).toBe(5);
    expect(result.doc2_chunk_count).toBe(12);
    expect(result.doc1_text_length).toBe(3000);
    expect(result.doc2_text_length).toBe(8000);
    expect(result.doc1_quality_score).toBe(4.8);
    expect(result.doc2_quality_score).toBe(3.2);
    expect(result.doc1_ocr_mode).toBe('accurate');
    expect(result.doc2_ocr_mode).toBe('fast');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// compareEntities TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('compareEntities', () => {
  it('no entities for either doc -> by_type={}, totals=0', () => {
    const result = compareEntities([], []);

    expect(result.doc1_total_entities).toBe(0);
    expect(result.doc2_total_entities).toBe(0);
    expect(Object.keys(result.by_type).length).toBe(0);
  });

  it('identical entity sets -> all in common, none unique', () => {
    const entities1 = [
      makeEntity('person', 'John Smith', 'doc-1'),
      makeEntity('organization', 'Acme Corp', 'doc-1'),
    ];
    const entities2 = [
      makeEntity('person', 'John Smith', 'doc-2'),
      makeEntity('organization', 'Acme Corp', 'doc-2'),
    ];
    const result = compareEntities(entities1, entities2);

    expect(result.doc1_total_entities).toBe(2);
    expect(result.doc2_total_entities).toBe(2);
    expect(result.by_type['person'].common).toEqual(['john smith']);
    expect(result.by_type['person'].doc1_only).toEqual([]);
    expect(result.by_type['person'].doc2_only).toEqual([]);
    expect(result.by_type['organization'].common).toEqual(['acme corp']);
    expect(result.by_type['organization'].doc1_only).toEqual([]);
    expect(result.by_type['organization'].doc2_only).toEqual([]);
  });

  it('disjoint entity sets -> all unique, none common', () => {
    const entities1 = [
      makeEntity('person', 'Alice', 'doc-1'),
      makeEntity('location', 'New York', 'doc-1'),
    ];
    const entities2 = [
      makeEntity('person', 'Bob', 'doc-2'),
      makeEntity('date', 'January 1, 2025', 'doc-2'),
    ];
    const result = compareEntities(entities1, entities2);

    expect(result.by_type['person'].common).toEqual([]);
    expect(result.by_type['person'].doc1_only).toEqual(['alice']);
    expect(result.by_type['person'].doc2_only).toEqual(['bob']);
    expect(result.by_type['location'].doc1_only).toEqual(['new york']);
    expect(result.by_type['location'].doc2_only).toEqual([]);
    expect(result.by_type['date'].common).toEqual([]);
    expect(result.by_type['date'].doc1_only).toEqual([]);
    expect(result.by_type['date'].doc2_only).toEqual(['january 1, 2025']);
  });

  it('mixed entities (contract v1 vs v2) -> person common, org/date/amount unique', () => {
    // Doc1 entities: person("John Smith"), organization("Acme Corp"), date("January 15, 2025"), amount("$50,000"), location("California")
    const entities1 = [
      makeEntity('person', 'John Smith', 'doc-1'),
      makeEntity('organization', 'Acme Corp', 'doc-1'),
      makeEntity('date', 'January 15, 2025', 'doc-1'),
      makeEntity('amount', '$50,000', 'doc-1'),
      makeEntity('location', 'California', 'doc-1'),
    ];
    // Doc2 entities: person("John Smith"), organization("Beta LLC"), date("March 1, 2025"), amount("$75,000"), location("California")
    const entities2 = [
      makeEntity('person', 'John Smith', 'doc-2'),
      makeEntity('organization', 'Beta LLC', 'doc-2'),
      makeEntity('date', 'March 1, 2025', 'doc-2'),
      makeEntity('amount', '$75,000', 'doc-2'),
      makeEntity('location', 'California', 'doc-2'),
    ];

    const result = compareEntities(entities1, entities2);

    expect(result.doc1_total_entities).toBe(5);
    expect(result.doc2_total_entities).toBe(5);

    // person: common=["john smith"], doc1_only=[], doc2_only=[]
    expect(result.by_type['person'].common).toEqual(['john smith']);
    expect(result.by_type['person'].doc1_only).toEqual([]);
    expect(result.by_type['person'].doc2_only).toEqual([]);

    // organization: common=[], doc1_only=["acme corp"], doc2_only=["beta llc"]
    expect(result.by_type['organization'].common).toEqual([]);
    expect(result.by_type['organization'].doc1_only).toEqual(['acme corp']);
    expect(result.by_type['organization'].doc2_only).toEqual(['beta llc']);

    // date: common=[], doc1_only=["january 15, 2025"], doc2_only=["march 1, 2025"]
    expect(result.by_type['date'].common).toEqual([]);
    expect(result.by_type['date'].doc1_only).toEqual(['january 15, 2025']);
    expect(result.by_type['date'].doc2_only).toEqual(['march 1, 2025']);

    // amount: common=[], doc1_only=["$50,000"], doc2_only=["$75,000"]
    expect(result.by_type['amount'].common).toEqual([]);
    expect(result.by_type['amount'].doc1_only).toEqual(['$50,000']);
    expect(result.by_type['amount'].doc2_only).toEqual(['$75,000']);

    // location: common=["california"], doc1_only=[], doc2_only=[]
    expect(result.by_type['location'].common).toEqual(['california']);
    expect(result.by_type['location'].doc1_only).toEqual([]);
    expect(result.by_type['location'].doc2_only).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateSummary TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateSummary', () => {
  it('contains similarity percentage', () => {
    const textDiff: TextDiffResult = {
      operations: [],
      total_operations: 0,
      truncated: false,
      insertions: 2,
      deletions: 1,
      unchanged: 5,
      similarity_ratio: 0.75,
      doc1_length: 100,
      doc2_length: 110,
    };
    const structDiff: StructuralDiff = {
      doc1_page_count: 5,
      doc2_page_count: 5,
      doc1_chunk_count: 3,
      doc2_chunk_count: 4,
      doc1_text_length: 100,
      doc2_text_length: 110,
      doc1_quality_score: 4.5,
      doc2_quality_score: 4.2,
      doc1_ocr_mode: 'balanced',
      doc2_ocr_mode: 'balanced',
    };

    const summary = generateSummary(textDiff, structDiff, null, 'doc-a.pdf', 'doc-b.pdf');

    expect(summary).toContain('75%');
    expect(summary).toContain('doc-a.pdf');
    expect(summary).toContain('doc-b.pdf');
  });

  it('contains change counts', () => {
    const textDiff: TextDiffResult = {
      operations: [],
      total_operations: 0,
      truncated: false,
      insertions: 3,
      deletions: 2,
      unchanged: 10,
      similarity_ratio: 0.85,
      doc1_length: 500,
      doc2_length: 520,
    };
    const structDiff: StructuralDiff = {
      doc1_page_count: 5,
      doc2_page_count: 7,
      doc1_chunk_count: 10,
      doc2_chunk_count: 12,
      doc1_text_length: 500,
      doc2_text_length: 520,
      doc1_quality_score: null,
      doc2_quality_score: null,
      doc1_ocr_mode: 'balanced',
      doc2_ocr_mode: 'balanced',
    };
    const entityDiff: EntityDiff = {
      doc1_total_entities: 5,
      doc2_total_entities: 7,
      by_type: {
        person: { doc1_count: 2, doc2_count: 3, common: ['alice'], doc1_only: ['bob'], doc2_only: ['charlie', 'dave'] },
        location: { doc1_count: 1, doc2_count: 1, common: ['new york'], doc1_only: [], doc2_only: [] },
      },
    };

    const summary = generateSummary(textDiff, structDiff, entityDiff, 'contract-v1.pdf', 'contract-v2.pdf');

    // Should contain insertions, deletions, and unchanged counts
    expect(summary).toContain('3 insertions');
    expect(summary).toContain('2 deletions');
    expect(summary).toContain('10 unchanged');
    // Page count difference: |5 - 7| = 2
    expect(summary).toContain('2 pages');
    // Entity totals: 1 common (alice + new york), 1 unique to doc1 (bob), 2 unique to doc2 (charlie, dave)
    expect(summary).toContain('Entities:');
    expect(summary).toContain('common');
    expect(summary).toContain('unique to doc1');
    expect(summary).toContain('unique to doc2');
  });
});

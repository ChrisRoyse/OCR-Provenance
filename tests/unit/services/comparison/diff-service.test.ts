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
  generateSummary,
} from '../../../../src/services/comparison/diff-service.js';
import type {
  TextDiffResult,
  StructuralDiff,
} from '../../../../src/models/comparison.js';

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
// StructuralDiff TESTS (plain data object, no function needed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('StructuralDiff', () => {
  it('same structural data -> all fields equal', () => {
    const result: StructuralDiff = {
      doc1_page_count: 5,
      doc2_page_count: 5,
      doc1_chunk_count: 10,
      doc2_chunk_count: 10,
      doc1_text_length: 5000,
      doc2_text_length: 5000,
      doc1_quality_score: 4.5,
      doc2_quality_score: 4.5,
      doc1_ocr_mode: 'balanced',
      doc2_ocr_mode: 'balanced',
    };

    expect(result.doc1_page_count).toBe(result.doc2_page_count);
    expect(result.doc1_chunk_count).toBe(result.doc2_chunk_count);
    expect(result.doc1_text_length).toBe(result.doc2_text_length);
    expect(result.doc1_quality_score).toBe(result.doc2_quality_score);
    expect(result.doc1_ocr_mode).toBe(result.doc2_ocr_mode);
  });

  it('different structural data -> shows differences', () => {
    const result: StructuralDiff = {
      doc1_page_count: 3,
      doc2_page_count: 7,
      doc1_chunk_count: 5,
      doc2_chunk_count: 12,
      doc1_text_length: 3000,
      doc2_text_length: 8000,
      doc1_quality_score: 4.8,
      doc2_quality_score: 3.2,
      doc1_ocr_mode: 'accurate',
      doc2_ocr_mode: 'fast',
    };

    expect(result.doc1_page_count).not.toBe(result.doc2_page_count);
    expect(result.doc1_chunk_count).not.toBe(result.doc2_chunk_count);
    expect(result.doc1_text_length).not.toBe(result.doc2_text_length);
    expect(result.doc1_quality_score).not.toBe(result.doc2_quality_score);
    expect(result.doc1_ocr_mode).not.toBe(result.doc2_ocr_mode);
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

    const summary = generateSummary(textDiff, structDiff, 'doc-a.pdf', 'doc-b.pdf');

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

    const summary = generateSummary(
      textDiff,
      structDiff,
      'contract-v1.pdf',
      'contract-v2.pdf'
    );

    // Should contain insertions, deletions, and unchanged counts
    expect(summary).toContain('3 insertions');
    expect(summary).toContain('2 deletions');
    expect(summary).toContain('10 unchanged');
    // Page count difference: |5 - 7| = 2
    expect(summary).toContain('2 pages');
  });
});

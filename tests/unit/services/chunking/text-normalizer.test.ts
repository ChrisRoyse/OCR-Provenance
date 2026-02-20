import { describe, it, expect } from 'vitest';
import { normalizeForEmbedding } from '../../../../src/services/chunking/text-normalizer.js';

describe('normalizeForEmbedding', () => {
  it('strips single-digit line numbers with multiple spaces', () => {
    const input = '1       The International President shall preside.';
    const result = normalizeForEmbedding(input);
    expect(result).toBe('The International President shall preside.');
  });

  it('strips multi-digit line numbers with multiple spaces', () => {
    const input = '42       Section 5 of the bylaws.';
    const result = normalizeForEmbedding(input);
    expect(result).toBe('Section 5 of the bylaws.');
  });

  it('strips line numbers across multiple lines', () => {
    const input = [
      '1       First line of content.',
      '2       Second line of content.',
      '3       Third line of content.',
    ].join('\n');
    const expected = [
      'First line of content.',
      'Second line of content.',
      'Third line of content.',
    ].join('\n');
    expect(normalizeForEmbedding(input)).toBe(expected);
  });

  it('preserves ordered list items (digit + dot + single space)', () => {
    const input = '1. First item\n2. Second item\n3. Third item';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('preserves section numbers (digit + dot + digit)', () => {
    const input = '1.2 Background information\n3.4.5 Detailed analysis';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('preserves year references with single space', () => {
    const input = '2024 was a productive year for the organization.';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('handles empty input', () => {
    expect(normalizeForEmbedding('')).toBe('');
  });

  it('preserves markdown headings', () => {
    const input = '## ARTICLE 5\n\nThe officers shall meet.';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('preserves table content with pipes', () => {
    const input = '| Name | Role |\n|------|------|\n| Alice | President |';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('handles realistic OCR output with mixed content', () => {
    const input = [
      '1       ARTICLE V - OFFICERS',
      '',
      '2       Section 1. The officers of this Lodge shall be:',
      '3       (a) President',
      '4       (b) Vice President',
      '',
      'Additional text without line numbers.',
      '',
      '1. This is a list item.',
      '2. This is another list item.',
    ].join('\n');
    const expected = [
      'ARTICLE V - OFFICERS',
      '',
      'Section 1. The officers of this Lodge shall be:',
      '(a) President',
      '(b) Vice President',
      '',
      'Additional text without line numbers.',
      '',
      '1. This is a list item.',
      '2. This is another list item.',
    ].join('\n');
    expect(normalizeForEmbedding(input)).toBe(expected);
  });
});

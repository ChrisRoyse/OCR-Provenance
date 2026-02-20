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

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe('normalizeForEmbedding - edge cases', () => {
  it('number with tab character (not spaces) is not removed', () => {
    const input = '5\tSome text';
    const result = normalizeForEmbedding(input);
    // Tab is not matched by \s{2,} since it's a single whitespace char
    expect(result).toBe('5\tSome text');
  });

  it('number at start of line with exactly 2 spaces is removed', () => {
    const input = '7  Text after two spaces';
    const result = normalizeForEmbedding(input);
    expect(result).toBe('Text after two spaces');
  });

  it('multi-line mixed content preserves non-line-number lines', () => {
    const input = '10       Line with number.\nJust a regular line.\n5       Another numbered line.';
    const result = normalizeForEmbedding(input);
    expect(result).toBe('Line with number.\nJust a regular line.\nAnother numbered line.');
  });

  it('does not remove numbers that are part of content (e.g., dollar amounts)', () => {
    const input = '$100 per item\n$2500 total';
    // These start with $ not digits, so untouched
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('line starting with 0 and multiple spaces is removed', () => {
    const input = '0       First line of document.';
    expect(normalizeForEmbedding(input)).toBe('First line of document.');
  });

  it('preserves content when no line numbers present', () => {
    const input = 'This is normal text.\nWith multiple lines.\nAnd no line numbers.';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('"6  Some text" has line number removed (2 spaces)', () => {
    const input = '6  Some text';
    expect(normalizeForEmbedding(input)).toBe('Some text');
  });

  it('"25     Text here" has line number removed (multi-space)', () => {
    const input = '25     Text here';
    expect(normalizeForEmbedding(input)).toBe('Text here');
  });

  it('"1. Item" is NOT removed (single space with dot = ordered list)', () => {
    const input = '1. Item';
    expect(normalizeForEmbedding(input)).toBe('1. Item');
  });

  it('"2024 was great" is NOT removed (single space after year)', () => {
    const input = '2024 was great';
    expect(normalizeForEmbedding(input)).toBe('2024 was great');
  });

  it('empty string returns empty string', () => {
    expect(normalizeForEmbedding('')).toBe('');
  });

  it('text with no line numbers is returned unchanged', () => {
    const input = 'The board shall meet quarterly to discuss organizational matters.';
    expect(normalizeForEmbedding(input)).toBe(input);
  });

  it('multiple lines with line numbers are all removed', () => {
    const input = [
      '1       First line.',
      '2       Second line.',
      '3       Third line.',
      '4       Fourth line.',
      '5       Fifth line.',
    ].join('\n');
    const expected = [
      'First line.',
      'Second line.',
      'Third line.',
      'Fourth line.',
      'Fifth line.',
    ].join('\n');
    expect(normalizeForEmbedding(input)).toBe(expected);
  });

  it('line number with exactly 2 spaces at boundary is removed', () => {
    const input = '99  End of document.';
    expect(normalizeForEmbedding(input)).toBe('End of document.');
  });

  it('digit followed by single space is NOT removed (not a line number)', () => {
    const input = '3 blind mice ran away.';
    expect(normalizeForEmbedding(input)).toBe('3 blind mice ran away.');
  });
});

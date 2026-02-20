import { describe, it, expect } from 'vitest';
import { mergeHeadingOnlyChunks } from '../../../../src/services/chunking/chunk-merger.js';
import { ChunkResult } from '../../../../src/models/chunk.js';
import { chunkHybridSectionAware } from '../../../../src/services/chunking/chunker.js';

function makeChunk(overrides: Partial<ChunkResult> & { index: number; text: string }): ChunkResult {
  return {
    startOffset: 0,
    endOffset: overrides.text.length,
    overlapWithPrevious: 0,
    overlapWithNext: 0,
    pageNumber: 1,
    pageRange: null,
    headingContext: null,
    headingLevel: null,
    sectionPath: null,
    contentTypes: ['text'],
    isAtomic: false,
    ...overrides,
  };
}

describe('mergeHeadingOnlyChunks', () => {
  it('returns empty array for empty input', () => {
    expect(mergeHeadingOnlyChunks([], 100)).toEqual([]);
  });

  it('returns single chunk unchanged', () => {
    const chunks = [makeChunk({ index: 0, text: '## Heading', contentTypes: ['heading'] })];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('## Heading');
  });

  it('does not merge chunks above threshold', () => {
    const longHeading = '## ' + 'A'.repeat(120);
    const chunks = [
      makeChunk({ index: 0, text: longHeading, contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: 'Body text content here.' }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(2);
  });

  it('merges heading-only chunk into next chunk', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '## ARTICLE 5',
        contentTypes: ['heading'],
        headingContext: 'ARTICLE 5',
        headingLevel: 2,
        sectionPath: 'ARTICLE 5',
        startOffset: 0,
        endOffset: 13,
      }),
      makeChunk({
        index: 1,
        text: 'The officers shall meet quarterly.',
        contentTypes: ['text'],
        startOffset: 15,
        endOffset: 48,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('## ARTICLE 5');
    expect(result[0].text).toContain('The officers shall meet quarterly.');
    expect(result[0].index).toBe(0);
    expect(result[0].headingContext).toBe('ARTICLE 5');
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(48);
    expect(result[0].contentTypes).toContain('heading');
    expect(result[0].contentTypes).toContain('text');
  });

  it('merges last heading-only chunk into previous', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: 'Some body content that is long enough.',
        contentTypes: ['text'],
        startOffset: 0,
        endOffset: 38,
      }),
      makeChunk({
        index: 1,
        text: '## APPENDIX',
        contentTypes: ['heading'],
        startOffset: 40,
        endOffset: 51,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('Some body content');
    expect(result[0].text).toContain('## APPENDIX');
    expect(result[0].endOffset).toBe(51);
  });

  it('re-indexes chunks after merging', () => {
    const chunks = [
      makeChunk({ index: 0, text: '## Heading', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: 'Body 1 text here.' }),
      makeChunk({ index: 2, text: 'Body 2 text here.' }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
  });

  it('handles consecutive heading-only chunks (cascade merge)', () => {
    const chunks = [
      makeChunk({ index: 0, text: '# Part I', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: '## Chapter 1', contentTypes: ['heading'] }),
      makeChunk({ index: 2, text: '### Section 1.1', contentTypes: ['heading'] }),
      makeChunk({ index: 3, text: 'Actual content goes here and should remain.' }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('# Part I');
    expect(result[0].text).toContain('## Chapter 1');
    expect(result[0].text).toContain('### Section 1.1');
    expect(result[0].text).toContain('Actual content goes here');
    expect(result[0].index).toBe(0);
  });

  it('preserves non-heading tiny chunks', () => {
    const chunks = [
      makeChunk({ index: 0, text: 'OK', contentTypes: ['text'] }),
      makeChunk({ index: 1, text: 'Body text that is normal length.' }),
    ];
    // Non-heading tiny chunk should NOT be merged
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(2);
  });

  it('preserves chunks with multiple content types including heading', () => {
    const chunks = [
      makeChunk({ index: 0, text: '## Heading\nSome text', contentTypes: ['heading', 'text'] }),
      makeChunk({ index: 1, text: 'Body text.' }),
    ];
    // Has heading + text content types, not heading-only
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(2);
  });

  it('does not mutate the original array', () => {
    const chunks = [
      makeChunk({ index: 0, text: '## H', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: 'Body text content.' }),
    ];
    const originalLength = chunks.length;
    mergeHeadingOnlyChunks(chunks, 100);
    expect(chunks).toHaveLength(originalLength);
    expect(chunks[0].text).toBe('## H');
  });

  it('integration: chunkHybridSectionAware produces no tiny heading-only chunks', () => {
    // Build a document with headings followed by body text
    const text = [
      '# ARTICLE 1',
      '',
      'The union shall be governed by these bylaws.',
      '',
      '# ARTICLE 2',
      '',
      'Officers include the President and Secretary.',
      '',
      '# ARTICLE 3',
      '',
      '# ARTICLE 4',
      '',
      'Meetings shall occur quarterly as scheduled by the board of directors.',
    ].join('\n');

    const chunks = chunkHybridSectionAware(text, [], null);

    // No chunk should be heading-only AND under 100 chars
    for (const chunk of chunks) {
      if (chunk.contentTypes.length === 1 && chunk.contentTypes[0] === 'heading') {
        expect(chunk.text.trim().length).toBeGreaterThanOrEqual(100);
      }
    }
  });
});

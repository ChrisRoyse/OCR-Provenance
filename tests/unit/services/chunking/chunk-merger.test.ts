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

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe('mergeHeadingOnlyChunks - edge cases', () => {
  it('merged chunk text = heading + "\\n\\n" + next text', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '## Title',
        contentTypes: ['heading'],
        startOffset: 0,
        endOffset: 8,
      }),
      makeChunk({
        index: 1,
        text: 'Body content.',
        contentTypes: ['text'],
        startOffset: 10,
        endOffset: 23,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('## Title\n\nBody content.');
  });

  it('merged chunk contentTypes is union of both', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '# H',
        contentTypes: ['heading'],
        startOffset: 0,
        endOffset: 3,
      }),
      makeChunk({
        index: 1,
        text: 'Para\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        contentTypes: ['text', 'table'],
        startOffset: 5,
        endOffset: 40,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].contentTypes).toContain('heading');
    expect(result[0].contentTypes).toContain('text');
    expect(result[0].contentTypes).toContain('table');
  });

  it('merged chunk startOffset = min, endOffset = max', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '## H',
        contentTypes: ['heading'],
        startOffset: 50,
        endOffset: 54,
      }),
      makeChunk({
        index: 1,
        text: 'Body.',
        contentTypes: ['text'],
        startOffset: 56,
        endOffset: 200,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result[0].startOffset).toBe(50);
    expect(result[0].endOffset).toBe(200);
  });

  it('minChunkSize=0 means nothing is considered tiny (no merges)', () => {
    const chunks = [
      makeChunk({ index: 0, text: '# H', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: 'Body text.' }),
    ];
    // minChunkSize=0 means chunk.text.trim().length < 0 is always false
    const result = mergeHeadingOnlyChunks(chunks, 0);
    expect(result).toHaveLength(2);
  });

  it('five consecutive heading-only chunks cascade into body', () => {
    const chunks = [
      makeChunk({ index: 0, text: '# A', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: '## B', contentTypes: ['heading'] }),
      makeChunk({ index: 2, text: '### C', contentTypes: ['heading'] }),
      makeChunk({ index: 3, text: '#### D', contentTypes: ['heading'] }),
      makeChunk({ index: 4, text: '##### E', contentTypes: ['heading'] }),
      makeChunk({ index: 5, text: 'Actual body text content here that is long enough.' }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('# A');
    expect(result[0].text).toContain('##### E');
    expect(result[0].text).toContain('Actual body text');
    expect(result[0].index).toBe(0);
  });

  it('single chunk returns a NEW object, not same reference', () => {
    const original = makeChunk({ index: 0, text: 'Some long body text that is well above the threshold.', contentTypes: ['text'] });
    const result = mergeHeadingOnlyChunks([original], 100);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toBe(original);
    expect(result[0].text).toBe(original.text);
    // Verify contentTypes is also a new array
    expect(result[0].contentTypes).not.toBe(original.contentTypes);
    expect(result[0].contentTypes).toEqual(original.contentTypes);
  });

  it('single heading-only tiny chunk with no neighbor stays as-is', () => {
    const chunks = [makeChunk({ index: 0, text: '## Heading', contentTypes: ['heading'] })];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('## Heading');
    expect(result[0].contentTypes).toEqual(['heading']);
    expect(result[0].index).toBe(0);
  });

  it('heading-only chunk merged forward: text = heading + "\\n\\n" + next text (exact format)', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '## ARTICLE 7',
        contentTypes: ['heading'],
        headingContext: 'ARTICLE 7',
        headingLevel: 2,
        startOffset: 0,
        endOffset: 13,
      }),
      makeChunk({
        index: 1,
        text: 'Officers shall be elected annually by majority vote.',
        contentTypes: ['text'],
        startOffset: 15,
        endOffset: 67,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    // Verify EXACT merge format: heading + \n\n + next
    expect(result[0].text).toBe('## ARTICLE 7\n\nOfficers shall be elected annually by majority vote.');
  });

  it('last heading-only chunk merged backward into previous', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: 'The board of directors shall govern the organization.',
        contentTypes: ['text'],
        startOffset: 0,
        endOffset: 53,
      }),
      makeChunk({
        index: 1,
        text: '## EXHIBIT A',
        contentTypes: ['heading'],
        startOffset: 55,
        endOffset: 67,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    // Backward merge: previous.text + \n\n + source.text
    expect(result[0].text).toBe('The board of directors shall govern the organization.\n\n## EXHIBIT A');
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(67);
  });

  it('three consecutive heading-only chunks cascade into single result', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '# PART I',
        contentTypes: ['heading'],
        headingContext: 'PART I',
        headingLevel: 1,
        startOffset: 0,
        endOffset: 8,
      }),
      makeChunk({
        index: 1,
        text: '## CHAPTER 1',
        contentTypes: ['heading'],
        headingContext: 'CHAPTER 1',
        headingLevel: 2,
        startOffset: 10,
        endOffset: 22,
      }),
      makeChunk({
        index: 2,
        text: '### Section 1.1',
        contentTypes: ['heading'],
        headingContext: 'Section 1.1',
        headingLevel: 3,
        startOffset: 24,
        endOffset: 39,
      }),
      makeChunk({
        index: 3,
        text: 'The membership shall consist of all persons who have been duly admitted.',
        contentTypes: ['text'],
        startOffset: 41,
        endOffset: 112,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    // All three headings cascaded into the body chunk
    expect(result[0].text).toBe(
      '# PART I\n\n## CHAPTER 1\n\n### Section 1.1\n\nThe membership shall consist of all persons who have been duly admitted.'
    );
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(112);
    expect(result[0].contentTypes).toContain('heading');
    expect(result[0].contentTypes).toContain('text');
  });

  it('merged chunk contentTypes = union of both, deduplicated', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '# Heading',
        contentTypes: ['heading'],
        startOffset: 0,
        endOffset: 9,
      }),
      makeChunk({
        index: 1,
        text: 'Text with a table.\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        contentTypes: ['heading', 'text', 'table'],
        startOffset: 11,
        endOffset: 60,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    // heading appears in both but should be deduplicated
    const types = result[0].contentTypes;
    expect(types).toContain('heading');
    expect(types).toContain('text');
    expect(types).toContain('table');
    // Verify no duplicates
    expect(types.length).toBe(new Set(types).size);
  });

  it('indices re-assigned 0, 1, 2, ... after merge', () => {
    const chunks = [
      makeChunk({ index: 0, text: '## Section A', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: 'First body text that is detailed enough to stand on its own.' }),
      makeChunk({ index: 2, text: '## Section B', contentTypes: ['heading'] }),
      makeChunk({ index: 3, text: 'Second body text for the next section in the document.' }),
      makeChunk({ index: 4, text: 'Third body paragraph with some more content here.' }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    // Two heading-only chunks merged into their next neighbors
    expect(result).toHaveLength(3);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
    expect(result[2].index).toBe(2);
  });

  it('minChunkSize=0 means nothing is merged (all chunks above threshold)', () => {
    const chunks = [
      makeChunk({ index: 0, text: '# H', contentTypes: ['heading'] }),
      makeChunk({ index: 1, text: '## H2', contentTypes: ['heading'] }),
      makeChunk({ index: 2, text: 'Body.' }),
    ];
    // With minChunkSize=0, text.trim().length < 0 is always false
    const result = mergeHeadingOnlyChunks(chunks, 0);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('# H');
    expect(result[1].text).toBe('## H2');
    expect(result[2].text).toBe('Body.');
  });

  it('merged chunk startOffset = min of both, endOffset = max of both', () => {
    const chunks = [
      makeChunk({
        index: 0,
        text: '## Title',
        contentTypes: ['heading'],
        startOffset: 100,
        endOffset: 108,
      }),
      makeChunk({
        index: 1,
        text: 'Body content here.',
        contentTypes: ['text'],
        startOffset: 110,
        endOffset: 500,
      }),
    ];
    const result = mergeHeadingOnlyChunks(chunks, 100);
    expect(result).toHaveLength(1);
    expect(result[0].startOffset).toBe(100);
    expect(result[0].endOffset).toBe(500);
  });
});

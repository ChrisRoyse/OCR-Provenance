import { describe, it, expect } from 'vitest';
import { normalizeHeadingLevels, HeadingNormalizationConfig } from '../../../../src/services/chunking/heading-normalizer.js';
import { MarkdownBlock } from '../../../../src/services/chunking/markdown-parser.js';
import { buildSectionHierarchy } from '../../../../src/services/chunking/markdown-parser.js';

function makeHeading(text: string, level: number, idx: number): MarkdownBlock {
  return {
    type: 'heading',
    text: `${'#'.repeat(level)} ${text}`,
    startOffset: idx * 100,
    endOffset: idx * 100 + text.length + level + 1,
    headingLevel: level,
    headingText: text,
    pageNumber: 1,
  };
}

function makeParagraph(text: string, idx: number): MarkdownBlock {
  return {
    type: 'paragraph',
    text,
    startOffset: idx * 100,
    endOffset: idx * 100 + text.length,
    headingLevel: null,
    headingText: null,
    pageNumber: 1,
  };
}

describe('normalizeHeadingLevels', () => {
  const enabledConfig: HeadingNormalizationConfig = { enabled: true };

  it('returns blocks unchanged when disabled', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 3, 2),
      makeHeading('ARTICLE 4', 2, 3),
    ];
    const config: HeadingNormalizationConfig = { enabled: false };
    normalizeHeadingLevels(blocks, config);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(3);
    expect(blocks[3].headingLevel).toBe(2);
  });

  it('normalizes ARTICLE headings to mode level', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeParagraph('Content for article 1', 1),
      makeHeading('ARTICLE 2', 2, 2),
      makeParagraph('Content for article 2', 3),
      makeHeading('ARTICLE 3', 2, 4),
      makeParagraph('Content for article 3', 5),
      makeHeading('ARTICLE 4', 2, 6),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode is H2 (3 occurrences vs 1 for H1)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
    expect(blocks[4].headingLevel).toBe(2);
    expect(blocks[6].headingLevel).toBe(2);
    // Non-heading blocks are unaffected
    expect(blocks[1].headingLevel).toBeNull();
  });

  it('respects minPatternCount threshold', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
    ];
    const config: HeadingNormalizationConfig = { enabled: true, minPatternCount: 3 };
    normalizeHeadingLevels(blocks, config);
    // Only 2 ARTICLEs, below threshold of 3 - no change
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
  });

  it('normalizes Section headings independently from Article headings', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('Section 1.1', 3, 1),
      makeHeading('ARTICLE 2', 2, 2),
      makeHeading('Section 2.1', 2, 3),
      makeHeading('ARTICLE 3', 2, 4),
      makeHeading('Section 3.1', 2, 5),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // ARTICLE: mode is H2 (2 vs 1)
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
    expect(blocks[4].headingLevel).toBe(2);
    // Section: mode is H2 (2 vs 1)
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[3].headingLevel).toBe(2);
    expect(blocks[5].headingLevel).toBe(2);
  });

  it('handles bold-wrapped heading text', () => {
    const blocks = [
      makeHeading('**ARTICLE 1**', 1, 0),
      makeHeading('**ARTICLE 2**', 2, 1),
      makeHeading('**ARTICLE 3**', 2, 2),
    ];
    // Manually set headingText with bold markers
    blocks[0].headingText = '**ARTICLE 1**';
    blocks[1].headingText = '**ARTICLE 2**';
    blocks[2].headingText = '**ARTICLE 3**';

    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
  });

  it('handles mixed case heading text', () => {
    const blocks = [
      makeHeading('Article 1', 1, 0),
      makeHeading('article 2', 3, 1),
      makeHeading('ARTICLE 3', 3, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // Mode is H3 (2 occurrences)
    expect(blocks[0].headingLevel).toBe(3);
    expect(blocks[1].headingLevel).toBe(3);
    expect(blocks[2].headingLevel).toBe(3);
  });

  it('does not modify block.text', () => {
    const blocks = [
      makeHeading('ARTICLE 1', 1, 0),
      makeHeading('ARTICLE 2', 2, 1),
      makeHeading('ARTICLE 3', 2, 2),
    ];
    const originalTexts = blocks.map(b => b.text);
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks.map(b => b.text)).toEqual(originalTexts);
  });

  it('handles empty blocks array', () => {
    const blocks: MarkdownBlock[] = [];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks).toEqual([]);
  });

  it('leaves non-pattern headings unchanged', () => {
    const blocks = [
      makeHeading('Introduction', 1, 0),
      makeHeading('Background', 2, 1),
      makeHeading('Summary', 3, 2),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(3);
  });

  it('handles Chapter and Part patterns', () => {
    const blocks = [
      makeHeading('CHAPTER 1', 1, 0),
      makeHeading('CHAPTER 2', 2, 1),
      makeHeading('CHAPTER 3', 2, 2),
      makeHeading('PART 1', 1, 3),
      makeHeading('PART 2', 3, 4),
      makeHeading('PART 3', 3, 5),
    ];
    normalizeHeadingLevels(blocks, enabledConfig);
    // CHAPTER: mode H2
    expect(blocks[0].headingLevel).toBe(2);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBe(2);
    // PART: mode H3
    expect(blocks[3].headingLevel).toBe(3);
    expect(blocks[4].headingLevel).toBe(3);
    expect(blocks[5].headingLevel).toBe(3);
  });

  it('integrates correctly with buildSectionHierarchy', () => {
    // Simulate Datalab giving ARTICLE 1 as H1 but rest as H3
    const blocks: MarkdownBlock[] = [
      makeHeading('ARTICLE 1', 1, 0),
      makeParagraph('Content A', 1),
      makeHeading('Section 1.1', 3, 2),
      makeParagraph('Content B', 3),
      makeHeading('ARTICLE 2', 3, 4), // Wrong: should be H1
      makeParagraph('Content C', 5),
      makeHeading('ARTICLE 3', 3, 6), // Wrong: should be H1
    ];

    // Without normalization, ARTICLE 2 and 3 nest under Section 1.1
    const sectionsBefore = buildSectionHierarchy(blocks);
    const pathBefore = sectionsBefore.get(4)?.path;
    // ARTICLE 2 at H3 would be at same level as Section 1.1
    expect(pathBefore).toContain('ARTICLE 1');

    // After normalization, ARTICLEs become H3 (mode), but all at same level
    normalizeHeadingLevels(blocks, enabledConfig);
    const sectionsAfter = buildSectionHierarchy(blocks);

    // ARTICLE 2 should now be a top-level section, not nested under ARTICLE 1
    const pathAfter = sectionsAfter.get(4)?.path;
    expect(pathAfter).toBe('ARTICLE 2');
  });
});

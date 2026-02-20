/**
 * Heading-Only Chunk Merger for Section-Aware Chunking
 *
 * Post-processing pass that merges tiny heading-only chunks with their
 * nearest neighbor to improve embedding quality. Heading-only chunks
 * (e.g., "## ARTICLE 5") produce poor embeddings because they lack
 * semantic content.
 *
 * @module services/chunking/chunk-merger
 */

import { ChunkResult } from '../../models/chunk.js';

/**
 * Check if a chunk is heading-only and below the size threshold.
 */
function isHeadingOnlyTiny(chunk: ChunkResult, minChunkSize: number): boolean {
  return (
    chunk.contentTypes.length === 1 &&
    chunk.contentTypes[0] === 'heading' &&
    chunk.text.trim().length < minChunkSize
  );
}

/**
 * Merge two chunks: prepend `source` text before `target`.
 * Updates offsets, contentTypes, and heading context.
 */
function mergeIntoNext(source: ChunkResult, target: ChunkResult): void {
  target.text = source.text + '\n\n' + target.text;
  target.startOffset = Math.min(source.startOffset, target.startOffset);
  target.endOffset = Math.max(source.endOffset, target.endOffset);
  target.headingContext = source.headingContext ?? target.headingContext;
  target.headingLevel = source.headingLevel ?? target.headingLevel;
  target.sectionPath = source.sectionPath ?? target.sectionPath;
  target.pageNumber = source.pageNumber ?? target.pageNumber;

  // Merge content types (deduplicated)
  const types = new Set([...source.contentTypes, ...target.contentTypes]);
  target.contentTypes = Array.from(types);
}

/**
 * Merge two chunks: append `source` text after `target`.
 */
function mergeIntoPrevious(target: ChunkResult, source: ChunkResult): void {
  target.text = target.text + '\n\n' + source.text;
  target.endOffset = Math.max(target.endOffset, source.endOffset);

  // Merge content types (deduplicated)
  const types = new Set([...target.contentTypes, ...source.contentTypes]);
  target.contentTypes = Array.from(types);
}

/**
 * Merge heading-only chunks that are below the minimum size threshold.
 *
 * Strategy:
 * - If a next chunk exists, merge heading into next (prepend)
 * - If no next chunk (last in array), merge into previous (append)
 * - Consecutive heading-only chunks cascade-merge via while loop
 * - Re-indexes all chunks after merging
 *
 * @param chunks - Array of ChunkResult (not mutated; returns new array)
 * @param minChunkSize - Minimum character threshold (default: 100)
 * @returns New array with heading-only chunks merged
 */
export function mergeHeadingOnlyChunks(
  chunks: ChunkResult[],
  minChunkSize: number = 100
): ChunkResult[] {
  if (chunks.length <= 1) {
    return chunks.map(c => ({ ...c, contentTypes: [...c.contentTypes] }));
  }

  // Work on a shallow copy so we can splice without affecting the original
  const result = chunks.map(c => ({ ...c, contentTypes: [...c.contentTypes] }));
  let i = 0;

  while (i < result.length) {
    if (!isHeadingOnlyTiny(result[i], minChunkSize)) {
      i++;
      continue;
    }

    if (i < result.length - 1) {
      // Merge into next chunk
      mergeIntoNext(result[i], result[i + 1]);
      result.splice(i, 1);
      // Don't increment i - check the merged result again (cascade)
    } else if (i > 0) {
      // Last chunk - merge into previous
      mergeIntoPrevious(result[i - 1], result[i]);
      result.splice(i, 1);
      // Move back to check if previous is now also heading-only-tiny
      i = Math.max(0, i - 1);
    } else {
      // Single chunk remaining - nothing to merge with
      i++;
    }
  }

  // Re-index all chunks
  for (let idx = 0; idx < result.length; idx++) {
    result[idx].index = idx;
  }

  return result;
}

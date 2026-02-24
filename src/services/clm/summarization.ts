/**
 * Document Summarization Service
 *
 * Generates structured summaries from chunk data.
 * Uses chunk content, metadata, and document context.
 * No external API calls - pure algorithmic extraction.
 *
 * @module clm/summarization
 */

// =============================================================================
// TYPES
// =============================================================================

export interface DocumentSummary {
  document_id: string;
  total_chunks: number;
  total_pages: number;
  key_sections: string[];
  content_types: string[];
  word_count: number;
  summary_text: string;
}

export interface ChunkInput {
  text: string;
  page_number: number | null;
  heading_context: string | null;
  section_path: string | null;
  content_types: string | null;
}

export interface CorpusSummary {
  total_documents: number;
  total_chunks: number;
  total_pages: number;
  total_words: number;
  documents: Array<{
    document_id: string;
    file_name: string;
    page_count: number;
    chunk_count: number;
    status: string;
  }>;
  content_type_distribution: Record<string, number>;
  top_sections: string[];
}

// =============================================================================
// DOCUMENT SUMMARIZATION
// =============================================================================

/**
 * Generate summary from document chunks.
 * Pure algorithmic extraction - no API calls.
 */
export function summarizeDocument(chunks: ChunkInput[]): DocumentSummary {
  const sections = new Set<string>();
  const contentTypes = new Set<string>();
  let wordCount = 0;
  const pages = new Set<number>();

  for (const chunk of chunks) {
    if (chunk.heading_context) sections.add(chunk.heading_context);
    if (chunk.section_path) sections.add(chunk.section_path);
    if (chunk.page_number !== null && chunk.page_number !== undefined) {
      pages.add(chunk.page_number);
    }
    if (chunk.content_types) {
      for (const ct of chunk.content_types.split(',')) {
        const trimmed = ct.trim();
        if (trimmed) contentTypes.add(trimmed);
      }
    }
    wordCount += chunk.text.split(/\s+/).filter((w) => w.length > 0).length;
  }

  // Build summary from first chunks of each section
  const summaryParts: string[] = [];
  const seenSections = new Set<string>();
  for (const chunk of chunks.slice(0, 20)) {
    const section = chunk.heading_context ?? chunk.section_path ?? 'General';
    if (!seenSections.has(section)) {
      seenSections.add(section);
      // Take first 200 chars of the section
      const preview = chunk.text.substring(0, 200).replace(/\s+/g, ' ').trim();
      summaryParts.push(`[${section}]: ${preview}...`);
    }
  }

  return {
    document_id: '', // Set by caller
    total_chunks: chunks.length,
    total_pages: pages.size,
    key_sections: Array.from(sections).slice(0, 20),
    content_types: Array.from(contentTypes),
    word_count: wordCount,
    summary_text: summaryParts.join('\n\n'),
  };
}

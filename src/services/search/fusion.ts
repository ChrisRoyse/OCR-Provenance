/**
 * Reciprocal Rank Fusion (RRF) for Hybrid Search
 *
 * Combines BM25 and semantic search results using rank-based fusion.
 * Formula: score = sum(weight / (k + rank))
 */

interface RRFConfig {
  k: number;
  bm25Weight: number;
  semanticWeight: number;
}

interface RRFSearchResult {
  chunk_id: string | null;
  image_id: string | null;
  extraction_id: string | null;
  embedding_id: string;
  document_id: string;
  original_text: string;
  result_type: 'chunk' | 'vlm' | 'extraction';
  rrf_score: number;
  bm25_rank: number | null;
  bm25_score: number | null;
  semantic_rank: number | null;
  semantic_score: number | null;
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;
  page_number: number | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  provenance_id: string;
  content_hash: string;
  found_in_bm25: boolean;
  found_in_semantic: boolean;
  heading_context?: string | null;
  section_path?: string | null;
  content_types?: string | null;
  is_atomic?: boolean;
  page_range?: string | null;
  heading_level?: number | null;
  ocr_quality_score?: number | null;
}

export interface RankedResult {
  chunk_id: string | null;
  image_id: string | null;
  extraction_id?: string | null;
  embedding_id: string;
  rank: number;
  score: number;
  result_type: 'chunk' | 'vlm' | 'extraction';
  document_id: string;
  original_text: string;
  source_file_path: string;
  source_file_name: string;
  source_file_hash: string;
  page_number: number | null;
  character_start: number;
  character_end: number;
  chunk_index: number;
  provenance_id: string;
  content_hash: string;
  heading_context?: string | null;
  section_path?: string | null;
  content_types?: string | null;
  is_atomic?: boolean;
  page_range?: string | null;
  heading_level?: number | null;
  ocr_quality_score?: number | null;
}

const DEFAULT_CONFIG: RRFConfig = {
  k: 60,
  bm25Weight: 1.0,
  semanticWeight: 1.0,
};

/**
 * Build an RRFSearchResult from a RankedResult with source-specific score fields.
 */
function buildFusedResult(
  result: RankedResult,
  rrfScore: number,
  source: 'bm25' | 'semantic'
): RRFSearchResult {
  return {
    chunk_id: result.chunk_id,
    image_id: result.image_id,
    extraction_id: result.extraction_id ?? null,
    embedding_id: result.embedding_id,
    document_id: result.document_id,
    original_text: result.original_text,
    result_type: result.result_type,
    rrf_score: rrfScore,
    bm25_rank: source === 'bm25' ? result.rank : null,
    bm25_score: source === 'bm25' ? result.score : null,
    semantic_rank: source === 'semantic' ? result.rank : null,
    semantic_score: source === 'semantic' ? result.score : null,
    source_file_path: result.source_file_path,
    source_file_name: result.source_file_name,
    source_file_hash: result.source_file_hash,
    page_number: result.page_number,
    character_start: result.character_start,
    character_end: result.character_end,
    chunk_index: result.chunk_index,
    provenance_id: result.provenance_id,
    content_hash: result.content_hash,
    found_in_bm25: source === 'bm25',
    found_in_semantic: source === 'semantic',
    heading_context: result.heading_context ?? null,
    section_path: result.section_path ?? null,
    content_types: result.content_types ?? null,
    is_atomic: result.is_atomic ?? false,
    page_range: result.page_range ?? null,
    heading_level: result.heading_level ?? null,
    ocr_quality_score: result.ocr_quality_score ?? null,
  };
}

/**
 * Compute a stable dedup key for a ranked result.
 * Uses chunk_id for text chunks, image_id for VLM results,
 * with embedding_id as fallback for backwards compatibility.
 */
function getDedupKey(result: RankedResult): string {
  if (result.chunk_id) return `chunk-${result.chunk_id}`;
  if (result.image_id) return `image-${result.image_id}`;
  if (result.extraction_id) return `ext-${result.extraction_id}`;
  return `emb-${result.embedding_id}`;
}

export class RRFFusion {
  private readonly config: RRFConfig;

  constructor(config: Partial<RRFConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.k < 1) {
      throw new Error(`RRF k must be >= 1, got ${this.config.k}`);
    }
    if (this.config.bm25Weight < 0 || this.config.semanticWeight < 0) {
      throw new Error('RRF weights must be non-negative');
    }
  }

  fuse(
    bm25Results: RankedResult[],
    semanticResults: RankedResult[],
    limit: number,
    options?: { qualityBoost?: boolean }
  ): RRFSearchResult[] {
    const { k, bm25Weight, semanticWeight } = this.config;
    const qualityBoost = options?.qualityBoost ?? false;
    // Use chunk_id/image_id as dedup key so the same chunk from BM25 and semantic
    // merges correctly, even when BM25 results lack an embedding_id.
    const fusedMap = new Map<string, RRFSearchResult>();

    for (const result of bm25Results) {
      const rrfScore = bm25Weight / (k + result.rank);
      const dedupKey = getDedupKey(result);
      fusedMap.set(dedupKey, buildFusedResult(result, rrfScore, 'bm25'));
    }

    for (const result of semanticResults) {
      const rrfContribution = semanticWeight / (k + result.rank);
      const dedupKey = getDedupKey(result);
      const existing = fusedMap.get(dedupKey);

      if (existing) {
        existing.rrf_score += rrfContribution;
        existing.semantic_rank = result.rank;
        existing.semantic_score = result.score;
        existing.found_in_semantic = true;
        // BM25 provenance_id (chunk-level, depth 2) is kept over semantic's
        // (embedding-level, depth 3) — both are valid but chunk-level is canonical
      } else {
        fusedMap.set(dedupKey, buildFusedResult(result, rrfContribution, 'semantic'));
      }
    }

    const results = Array.from(fusedMap.values());

    // Apply quality boost: multiply rrf_score by quality factor
    if (qualityBoost) {
      for (const r of results) {
        const qualityFactor = 1 + (r.ocr_quality_score ?? 3) / 10.0;
        r.rrf_score = r.rrf_score * qualityFactor;
      }
    }

    return results
      .sort((a, b) => b.rrf_score - a.rrf_score)
      .slice(0, limit);
  }
}

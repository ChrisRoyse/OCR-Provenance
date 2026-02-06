/**
 * Reciprocal Rank Fusion (RRF) for Hybrid Search
 *
 * Combines BM25 and semantic search results using rank-based fusion.
 * Formula: score = sum(weight / (k + rank))
 */

export interface RRFConfig {
  k: number;
  bm25Weight: number;
  semanticWeight: number;
}

export interface RRFSearchResult {
  chunk_id: string;
  document_id: string;
  original_text: string;
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
}

export interface RankedResult {
  chunk_id: string;
  rank: number;
  score: number;
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
  source: 'bm25' | 'semantic',
): RRFSearchResult {
  return {
    chunk_id: result.chunk_id,
    document_id: result.document_id,
    original_text: result.original_text,
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
  };
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
    limit: number
  ): RRFSearchResult[] {
    const { k, bm25Weight, semanticWeight } = this.config;
    const fusedMap = new Map<string, RRFSearchResult>();

    for (const result of bm25Results) {
      const rrfScore = bm25Weight / (k + result.rank);
      fusedMap.set(result.chunk_id, buildFusedResult(result, rrfScore, 'bm25'));
    }

    for (const result of semanticResults) {
      const rrfContribution = semanticWeight / (k + result.rank);
      const existing = fusedMap.get(result.chunk_id);

      if (existing) {
        existing.rrf_score += rrfContribution;
        existing.semantic_rank = result.rank;
        existing.semantic_score = result.score;
        existing.found_in_semantic = true;
        // BM25 provenance_id (chunk-level, depth 2) is kept over semantic's
        // (embedding-level, depth 3) — both are valid but chunk-level is canonical
      } else {
        fusedMap.set(result.chunk_id, buildFusedResult(result, rrfContribution, 'semantic'));
      }
    }

    return Array.from(fusedMap.values())
      .sort((a, b) => b.rrf_score - a.rrf_score)
      .slice(0, limit);
  }
}

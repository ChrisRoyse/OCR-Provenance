#!/usr/bin/env python3
"""
Local cross-encoder reranking worker using sentence-transformers.

Reads JSON from stdin with format:
  {"query": "search text", "passages": [{"index": 0, "text": "...", "original_score": 0.5}, ...]}

Outputs JSON array of reranked results to stdout:
  [{"index": 0, "relevance_score": 0.95, "original_score": 0.5}, ...]

CRITICAL: All logging goes to stderr. Stdout is reserved for JSON output.
"""

import json
import logging
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


_cached_model = None
_cached_model_name = None


def get_model(model_name: str):
    """Get or load a cached cross-encoder model."""
    global _cached_model, _cached_model_name
    try:
        from sentence_transformers import CrossEncoder
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "sentence-transformers not installed. Install with: pip install sentence-transformers"
                }
            ),
            file=sys.stdout,
        )
        sys.exit(1)

    if _cached_model is not None and _cached_model_name == model_name:
        logger.info("Using cached reranker model: %s", model_name)
        return _cached_model
    logger.info("Loading reranker model: %s", model_name)
    start = time.time()
    _cached_model = CrossEncoder(model_name, max_length=512)
    _cached_model_name = model_name
    logger.info("Model loaded in %.2fs", time.time() - start)
    return _cached_model


def rerank(query: str, passages: list[dict]) -> list[dict]:
    """Rerank passages using cross-encoder model."""
    model = get_model("cross-encoder/ms-marco-MiniLM-L-12-v2")

    # Truncate passages to 500 chars for efficiency
    pairs = [(query, p["text"][:500]) for p in passages]

    start = time.time()
    scores = model.predict(pairs)
    logger.info("Reranked %d passages in %.2fs", len(passages), time.time() - start)

    results = []
    for passage, score in zip(passages, scores, strict=False):
        results.append(
            {
                "index": passage["index"],
                "relevance_score": float(score),
                "original_score": passage.get("original_score", 0),
            }
        )

    results.sort(key=lambda x: x["relevance_score"], reverse=True)
    return results


if __name__ == "__main__":
    try:
        input_data = json.loads(sys.stdin.read())
        query = input_data["query"]
        passages = input_data["passages"]

        if not passages:
            print(json.dumps([]))
            sys.exit(0)

        result = rerank(query, passages)
        print(json.dumps(result))
    except Exception as e:
        logger.error("Reranker failed: %s", str(e))
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

#!/usr/bin/env python3
"""
GPU Embedding Worker for OCR Provenance MCP System

Generates 768-dimensional embeddings using nomic-embed-text-v1.5 on local GPU.

CRITICAL CONSTRAINTS:
- CP-004: Local GPU inference ONLY - NEVER fall back to cloud
- AP-008: NO Flash Attention - incompatible with CUDA 13.1/Blackwell
- Task prefixes: "search_document: " for chunks, "search_query: " for queries

Hardware: RTX 5090 (sm_120), CUDA 13.1, 32GB VRAM

Usage:
    # Embed chunks (document mode)
    python embedding_worker.py --chunks "text1" "text2" --json

    # Embed query (search mode)
    python embedding_worker.py --query "search text" --json

    # From stdin (for large batches from TypeScript)
    echo '["text1", "text2"]' | python embedding_worker.py --stdin --json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

try:
    # When run as a script from python/ directory
    from gpu_utils import EmbeddingModelError, GPUNotAvailableError, GPUOutOfMemoryError
except ImportError:
    # When imported as part of python package
    from .gpu_utils import EmbeddingModelError, GPUNotAvailableError, GPUOutOfMemoryError

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# =============================================================================
# Constants - DO NOT CHANGE
# =============================================================================

MODEL_PATH = Path("./models/nomic-embed-text-v1.5")
EMBEDDING_DIM = 768
MODEL_NAME = "nomic-embed-text-v1.5"
MODEL_VERSION = "1.5.0"

# Task prefixes - REQUIRED by nomic model
PREFIX_DOCUMENT = "search_document: "
PREFIX_QUERY = "search_query: "

# Batch configuration
DEFAULT_BATCH_SIZE = 512
MIN_BATCH_SIZE = 1  # Must support single-item batches for VLM descriptions

# Device configuration
DEFAULT_DEVICE = "cuda:0"


# =============================================================================
# Data Classes - MUST match TypeScript interfaces
# =============================================================================


@dataclass
class EmbeddingResult:
    """
    Result from batch embedding generation.
    MUST match src/models/embedding.ts EmbeddingGenerationResult
    """

    success: bool
    embeddings: list[list[float]]  # (n, 768) as nested list for JSON
    count: int
    elapsed_ms: float
    ms_per_chunk: float
    device: str
    batch_size: int
    model: str = MODEL_NAME
    model_version: str = MODEL_VERSION
    vram_used_gb: float = 0.0
    error: str | None = None


@dataclass
class QueryEmbeddingResult:
    """Result from single query embedding."""

    success: bool
    embedding: list[float]  # (768,) as list for JSON
    elapsed_ms: float
    device: str
    model: str = MODEL_NAME
    error: str | None = None


# =============================================================================
# Global Model Singleton
# =============================================================================

_model: SentenceTransformer | None = None
_device: str | None = None


# =============================================================================
# Core Functions
# =============================================================================


def load_model(device: str = DEFAULT_DEVICE) -> SentenceTransformer:
    """
    Load nomic-embed-text-v1.5 to GPU.

    FAIL-FAST: Raises if GPU unavailable or model missing.
    NO FALLBACKS.

    Args:
        device: CUDA device (e.g., 'cuda:0')

    Returns:
        Loaded SentenceTransformer model

    Raises:
        GPUNotAvailableError: CUDA not available
        EmbeddingModelError: Model not found or failed to load
    """
    global _model, _device

    # Return cached model if same device
    if _model is not None and _device == device:
        return _model

    logger.info("Loading embedding model to %s...", device)

    # FAIL-FAST: Verify GPU
    if not torch.cuda.is_available():
        raise GPUNotAvailableError(
            "CUDA GPU required. NO CPU/cloud fallback allowed per CP-004."
        )

    # FAIL-FAST: Verify model exists
    if not MODEL_PATH.exists():
        raise EmbeddingModelError(
            f"Model not found at {MODEL_PATH}. Download with: git lfs pull",
            model_path=str(MODEL_PATH),
        )

    # Check required files
    required = ["config.json", "model.safetensors", "tokenizer.json"]
    missing = [f for f in required if not (MODEL_PATH / f).exists()]
    if missing:
        raise EmbeddingModelError(
            f"Missing model files: {missing}", model_path=str(MODEL_PATH)
        )

    try:
        # Load model - trust_remote_code required for NomicBertModel
        _model = SentenceTransformer(
            str(MODEL_PATH), device=device, trust_remote_code=True
        )
        _device = device

        # Verify dimensions
        dim = _model.get_sentence_embedding_dimension()
        if dim != EMBEDDING_DIM:
            raise EmbeddingModelError(
                f"Wrong embedding dimension: {dim}, expected {EMBEDDING_DIM}",
                model_path=str(MODEL_PATH),
            )

        logger.info(
            "Model loaded: %s, dim=%d, device=%s", MODEL_NAME, EMBEDDING_DIM, device
        )
        return _model

    except (GPUNotAvailableError, EmbeddingModelError):
        raise
    except Exception as e:
        raise EmbeddingModelError(
            f"Failed to load model: {e}", model_path=str(MODEL_PATH), cause=e
        ) from e


def embed_chunks(
    chunks: list[str], batch_size: int = DEFAULT_BATCH_SIZE, device: str = DEFAULT_DEVICE
) -> np.ndarray:
    """
    Embed document chunks with "search_document: " prefix.

    Args:
        chunks: Text chunks to embed
        batch_size: GPU batch size (default 512)
        device: CUDA device

    Returns:
        np.ndarray of shape (n_chunks, 768), dtype float32

    Raises:
        GPUNotAvailableError: No GPU
        EmbeddingModelError: Model error
    """
    if not chunks:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    model = load_model(device)

    # Add task prefix - REQUIRED by nomic model
    prefixed = [f"{PREFIX_DOCUMENT}{chunk}" for chunk in chunks]

    # Generate embeddings
    embeddings = model.encode(
        prefixed,
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,  # L2 normalize for cosine similarity
        show_progress_bar=False,
        device=device,
    )

    return embeddings.astype(np.float32)


def embed_query(query: str, device: str = DEFAULT_DEVICE) -> np.ndarray:
    """
    Embed search query with "search_query: " prefix.

    Args:
        query: Search query text
        device: CUDA device

    Returns:
        np.ndarray of shape (768,), dtype float32
    """
    model = load_model(device)

    # Add query task prefix
    prefixed = f"{PREFIX_QUERY}{query}"

    embedding = model.encode(
        [prefixed],
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
        device=device,
    )

    return embedding[0].astype(np.float32)


def embed_with_oom_recovery(
    chunks: list[str],
    initial_batch_size: int = DEFAULT_BATCH_SIZE,
    device: str = DEFAULT_DEVICE,
) -> tuple[np.ndarray, int]:
    """
    Embed with automatic OOM recovery via batch size reduction.

    Halves batch size on OOM until MIN_BATCH_SIZE.

    Args:
        chunks: Text chunks to embed
        initial_batch_size: Starting batch size
        device: CUDA device

    Returns:
        Tuple of (embeddings, final_batch_size)

    Raises:
        GPUOutOfMemoryError: OOM at minimum batch size
    """
    batch_size = initial_batch_size

    while batch_size >= MIN_BATCH_SIZE:
        try:
            torch.cuda.empty_cache()
            embeddings = embed_chunks(chunks, batch_size, device)
            return embeddings, batch_size
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            batch_size //= 2
            if batch_size >= MIN_BATCH_SIZE:
                logger.warning("OOM: Reducing batch size to %d", batch_size)

    raise GPUOutOfMemoryError(
        f"GPU OOM with {len(chunks)} chunks. "
        f"Tried batch sizes {initial_batch_size} down to {MIN_BATCH_SIZE}.",
        vram_required=None,
        vram_available=None,
    )


def generate_embeddings(
    chunks: list[str],
    batch_size: int = DEFAULT_BATCH_SIZE,
    device: str = DEFAULT_DEVICE,
) -> EmbeddingResult:
    """
    Generate embeddings with full metrics for TypeScript bridge.

    This is the main entry point for batch embedding.

    Args:
        chunks: Text chunks to embed
        batch_size: Initial batch size
        device: CUDA device

    Returns:
        EmbeddingResult with embeddings and metrics
    """
    start_time = time.perf_counter()

    # Reset VRAM tracking (no device arg - PyTorch nightly quirk with sm_120)
    torch.cuda.reset_peak_memory_stats()

    try:
        embeddings_np, final_batch_size = embed_with_oom_recovery(chunks, batch_size, device)

        elapsed_ms = (time.perf_counter() - start_time) * 1000
        ms_per_chunk = elapsed_ms / len(chunks) if chunks else 0
        vram_gb = torch.cuda.max_memory_allocated() / (1024**3)

        # H-8: Convert to list and delete numpy array to avoid ~7x memory overlap
        # (numpy float32 ~1.5MB vs Python float64 list ~10.7MB for 500x768)
        embeddings_list = embeddings_np.tolist()
        del embeddings_np

        return EmbeddingResult(
            success=True,
            embeddings=embeddings_list,
            count=len(chunks),
            elapsed_ms=round(elapsed_ms, 2),
            ms_per_chunk=round(ms_per_chunk, 4),
            device=device,
            batch_size=final_batch_size,
            vram_used_gb=round(vram_gb, 3),
            error=None,
        )

    except Exception as e:
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        logger.error("Embedding generation failed: %s", e)
        return EmbeddingResult(
            success=False,
            embeddings=[],
            count=0,
            elapsed_ms=round(elapsed_ms, 2),
            ms_per_chunk=0,
            device=device,
            batch_size=batch_size,
            error=str(e),
        )


def generate_query_embedding(query: str, device: str = DEFAULT_DEVICE) -> QueryEmbeddingResult:
    """
    Generate query embedding with metrics.

    Args:
        query: Search query text
        device: CUDA device

    Returns:
        QueryEmbeddingResult with embedding and metrics
    """
    start_time = time.perf_counter()

    try:
        embedding = embed_query(query, device)
        elapsed_ms = (time.perf_counter() - start_time) * 1000

        return QueryEmbeddingResult(
            success=True,
            embedding=embedding.tolist(),
            elapsed_ms=round(elapsed_ms, 2),
            device=device,
            error=None,
        )

    except Exception as e:
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        logger.error("Query embedding failed: %s", e)
        return QueryEmbeddingResult(
            success=False,
            embedding=[],
            elapsed_ms=round(elapsed_ms, 2),
            device=device,
            error=str(e),
        )


# =============================================================================
# CLI Entry Point
# =============================================================================


def main() -> None:
    """CLI entry point for embedding worker."""
    parser = argparse.ArgumentParser(
        description="GPU Embedding Worker - nomic-embed-text-v1.5",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python embedding_worker.py --chunks "text1" "text2" --json
  python embedding_worker.py --query "search text" --json
  echo '["text1", "text2"]' | python embedding_worker.py --stdin --json
        """,
    )

    # Input modes (mutually exclusive)
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--chunks", nargs="+", help="Texts to embed")
    input_group.add_argument("--query", help="Search query to embed")
    input_group.add_argument(
        "--stdin", action="store_true", help="Read JSON array from stdin"
    )

    # Configuration
    parser.add_argument(
        "--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Batch size for GPU"
    )
    parser.add_argument("--device", default=DEFAULT_DEVICE, help="CUDA device")
    parser.add_argument(
        "--json", action="store_true", help="JSON output for TypeScript bridge"
    )

    args = parser.parse_args()

    try:
        if args.query:
            # Query mode
            result = generate_query_embedding(args.query, args.device)

        else:
            # Chunk mode
            if args.stdin:
                chunks = json.load(sys.stdin)
                if not isinstance(chunks, list):
                    raise ValueError("stdin must be a JSON array of strings")
            else:
                chunks = args.chunks

            result = generate_embeddings(chunks, args.batch_size, args.device)

        if args.json:
            print(json.dumps(asdict(result)))
        else:
            # Human readable output
            if isinstance(result, EmbeddingResult):
                if result.success:
                    throughput = (
                        1000 / result.ms_per_chunk if result.ms_per_chunk > 0 else 0
                    )
                    print(f"Embedded {result.count} chunks in {result.elapsed_ms}ms")
                    print(f"Throughput: {throughput:.0f} chunks/sec")
                    print(f"VRAM used: {result.vram_used_gb:.3f} GB")
                else:
                    print(f"ERROR: {result.error}", file=sys.stderr)
                    sys.exit(1)
            else:
                if result.success:
                    print(f"Query embedded in {result.elapsed_ms}ms")
                else:
                    print(f"ERROR: {result.error}", file=sys.stderr)
                    sys.exit(1)

    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__,
        }
        if args.json:
            print(json.dumps(error_result))
        else:
            print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

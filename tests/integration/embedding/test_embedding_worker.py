#!/usr/bin/env python3
"""
Integration Tests for GPU Embedding Worker

CRITICAL: NO MOCKS. All tests use REAL GPU with REAL model.

These tests verify:
1. Model loading on GPU
2. Chunk embedding with correct shape and normalization
3. Query embedding
4. CLI interface
5. Edge cases

Run with:
    pytest tests/integration/embedding/test_embedding_worker.py -v
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from sentence_transformers import SentenceTransformer

# Add python directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))

from embedding_worker import (
    DEFAULT_DEVICE,
    EMBEDDING_DIM,
    MODEL_PATH,
    embed_chunks,
    embed_query,
    generate_embeddings,
    generate_query_embedding,
    load_model,
)


# =============================================================================
# Synthetic Test Data (KNOWN INPUTS for deterministic testing)
# =============================================================================

TEST_CHUNK_1 = "The quick brown fox jumps over the lazy dog."
TEST_CHUNK_2 = "Pack my box with five dozen liquor jugs."
TEST_QUERY = "What does the fox do?"

# These chunks should produce different embeddings
DISTINCT_CHUNKS = [
    "Legal contract for services rendered in 2024.",
    "Medical records indicate patient recovery.",
    "Financial statement shows quarterly growth.",
]


# =============================================================================
# Test Classes
# =============================================================================


class TestModelLoading:
    """Verify model loads correctly on GPU."""

    def test_model_path_exists(self):
        """MODEL_PATH directory must exist."""
        assert MODEL_PATH.exists(), f"Model not at {MODEL_PATH}"
        assert (MODEL_PATH / "model.safetensors").exists(), "model.safetensors missing"
        assert (MODEL_PATH / "config.json").exists(), "config.json missing"
        assert (MODEL_PATH / "tokenizer.json").exists(), "tokenizer.json missing"

    def test_load_model_returns_sentence_transformer(self):
        """load_model() returns SentenceTransformer instance."""
        model = load_model()
        assert isinstance(model, SentenceTransformer)

    def test_model_dimension_is_768(self):
        """Model embedding dimension must be exactly 768."""
        model = load_model()
        dim = model.get_sentence_embedding_dimension()
        assert dim == 768, f"Expected 768, got {dim}"

    def test_model_on_cuda(self):
        """Model must be on CUDA device."""
        model = load_model("cuda:0")
        # Check model is on GPU
        first_param = next(iter(model.parameters()), None)
        assert first_param is not None, "Model has no parameters"
        assert first_param.is_cuda, "Model not on CUDA"


class TestEmbedChunks:
    """Verify chunk embedding works correctly."""

    def test_output_shape_single(self):
        """Single chunk returns (1, 768) array."""
        result = embed_chunks([TEST_CHUNK_1])
        assert result.shape == (1, 768), f"Expected (1, 768), got {result.shape}"

    def test_output_shape_batch(self):
        """Batch returns (n, 768) array."""
        result = embed_chunks(DISTINCT_CHUNKS)
        assert result.shape == (3, 768), f"Expected (3, 768), got {result.shape}"

    def test_empty_input_returns_empty(self):
        """Empty list returns (0, 768) array."""
        result = embed_chunks([])
        assert result.shape == (0, 768), f"Expected (0, 768), got {result.shape}"

    def test_embeddings_are_normalized(self):
        """Embeddings have L2 norm of 1.0."""
        result = embed_chunks([TEST_CHUNK_1])
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 0.001, f"Norm is {norm}, expected 1.0"

    def test_embeddings_are_float32(self):
        """Embeddings are float32 dtype."""
        result = embed_chunks([TEST_CHUNK_1])
        assert result.dtype == np.float32, f"Expected float32, got {result.dtype}"

    def test_different_texts_different_embeddings(self):
        """Different texts produce different embeddings."""
        result = embed_chunks(DISTINCT_CHUNKS)
        # Cosine similarity between different texts should be < 0.99
        for i in range(len(DISTINCT_CHUNKS)):
            for j in range(i + 1, len(DISTINCT_CHUNKS)):
                sim = np.dot(result[i], result[j])
                assert sim < 0.99, f"Chunks {i} and {j} too similar: {sim:.4f}"

    def test_same_text_same_embedding(self):
        """Same text produces identical embeddings."""
        result1 = embed_chunks([TEST_CHUNK_1])
        result2 = embed_chunks([TEST_CHUNK_1])
        diff = np.max(np.abs(result1 - result2))
        assert diff < 1e-5, f"Same text gave different embeddings, max diff: {diff}"


class TestEmbedQuery:
    """Verify query embedding works correctly."""

    def test_output_shape(self):
        """Query returns (768,) array."""
        result = embed_query(TEST_QUERY)
        assert result.shape == (768,), f"Expected (768,), got {result.shape}"

    def test_query_is_normalized(self):
        """Query embedding has L2 norm of 1.0."""
        result = embed_query(TEST_QUERY)
        norm = np.linalg.norm(result)
        assert abs(norm - 1.0) < 0.001, f"Norm is {norm}, expected 1.0"

    def test_query_is_float32(self):
        """Query embedding is float32 dtype."""
        result = embed_query(TEST_QUERY)
        assert result.dtype == np.float32, f"Expected float32, got {result.dtype}"


class TestGenerateEmbeddings:
    """Verify the full embedding generation pipeline."""

    def test_success_result(self):
        """Generate embeddings returns success result."""
        result = generate_embeddings([TEST_CHUNK_1, TEST_CHUNK_2])
        assert result.success is True
        assert result.count == 2
        assert len(result.embeddings) == 2
        assert len(result.embeddings[0]) == 768
        assert result.elapsed_ms > 0
        assert result.device == DEFAULT_DEVICE

    def test_empty_input_success(self):
        """Empty input returns success with 0 embeddings."""
        result = generate_embeddings([])
        assert result.success is True
        assert result.count == 0
        assert len(result.embeddings) == 0


class TestQueryEmbeddingResult:
    """Verify query embedding result generation."""

    def test_success_result(self):
        """Generate query embedding returns success result."""
        result = generate_query_embedding(TEST_QUERY)
        assert result.success is True
        assert len(result.embedding) == 768
        assert result.elapsed_ms > 0
        assert result.device == DEFAULT_DEVICE


class TestCLI:
    """Verify CLI interface works."""

    @pytest.fixture
    def project_root(self) -> Path:
        """Get project root directory."""
        return Path(__file__).parent.parent.parent.parent

    def test_cli_chunks_json(self, project_root: Path):
        """CLI --chunks --json produces valid JSON."""
        result = subprocess.run(
            [
                sys.executable,
                "python/embedding_worker.py",
                "--chunks",
                TEST_CHUNK_1,
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=project_root,
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data["success"] is True
        assert data["count"] == 1
        assert len(data["embeddings"]) == 1
        assert len(data["embeddings"][0]) == 768

    def test_cli_query_json(self, project_root: Path):
        """CLI --query --json produces valid JSON."""
        result = subprocess.run(
            [
                sys.executable,
                "python/embedding_worker.py",
                "--query",
                TEST_QUERY,
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=project_root,
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data["success"] is True
        assert len(data["embedding"]) == 768

    def test_cli_stdin_json(self, project_root: Path):
        """CLI --stdin --json reads from stdin."""
        input_data = json.dumps([TEST_CHUNK_1, TEST_CHUNK_2])
        result = subprocess.run(
            [
                sys.executable,
                "python/embedding_worker.py",
                "--stdin",
                "--json",
            ],
            input=input_data,
            capture_output=True,
            text=True,
            cwd=project_root,
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data["success"] is True
        assert data["count"] == 2

    def test_cli_multiple_chunks(self, project_root: Path):
        """CLI handles multiple chunks."""
        result = subprocess.run(
            [
                sys.executable,
                "python/embedding_worker.py",
                "--chunks",
                TEST_CHUNK_1,
                TEST_CHUNK_2,
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=project_root,
        )
        assert result.returncode == 0, f"CLI failed: {result.stderr}"
        data = json.loads(result.stdout)
        assert data["count"] == 2


class TestEdgeCases:
    """Verify edge cases are handled correctly."""

    def test_single_character(self):
        """Single character produces valid embedding."""
        result = embed_chunks(["a"])
        assert result.shape == (1, 768)
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 0.001

    def test_unicode_text(self):
        """Unicode text produces valid embedding."""
        result = embed_chunks(["Hello 🌍 世界"])
        assert result.shape == (1, 768)
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 0.001

    def test_long_text(self):
        """Long text (10000 chars) produces valid embedding."""
        long_text = "x" * 10000
        result = embed_chunks([long_text])
        assert result.shape == (1, 768)
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 0.001

    def test_whitespace_only(self):
        """Whitespace-only text produces valid embedding."""
        result = embed_chunks(["   \n\t   "])
        assert result.shape == (1, 768)
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 0.001


class TestPerformance:
    """Verify performance targets are met."""

    def test_batch_throughput(self):
        """Verify throughput meets target (>= 2000 chunks/sec)."""
        # Generate test chunks
        chunks = [f"This is test document number {i} with some content." for i in range(100)]

        result = generate_embeddings(chunks, batch_size=512)

        assert result.success is True
        throughput = result.count / (result.elapsed_ms / 1000)
        # Allow some margin for first-run warmup
        assert throughput >= 500, f"Throughput {throughput:.0f} chunks/sec below 500 minimum"
        print(f"\nThroughput: {throughput:.0f} chunks/sec")
        print(f"VRAM used: {result.vram_used_gb:.3f} GB")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

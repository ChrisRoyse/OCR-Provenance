"""
OCR Provenance MCP System - Python Workers

This package provides:
- GPU utilities for CUDA/RTX 5090 verification
- Datalab OCR worker for document processing
- Embedding worker for local GPU inference with nomic-embed-text-v1.5

CRITICAL DESIGN PRINCIPLES:
- CP-004: Local GPU Inference - Embedding generation MUST run locally on GPU
- No data leaves the local machine for embedding generation
- NEVER fall back to cloud API - fail fast if GPU not available

Hardware Requirements (from constitution):
- GPU: NVIDIA RTX 3060+ (minimum 8GB VRAM), RTX 5090 recommended (32GB VRAM)
- CUDA: 13.1+
- Compute Capability: 12.0 for Blackwell

Module Structure:
- gpu_utils: GPU verification, VRAM monitoring
- ocr_worker: Datalab OCR API integration (future)
- embedding_worker: nomic-embed-text-v1.5 inference
"""

__version__ = "1.0.0"
__author__ = "OCR Provenance MCP System"

from .gpu_utils import (
    EmbeddingModelError,
    # Error classes
    GPUError,
    # Type definitions
    GPUInfo,
    GPUNotAvailableError,
    GPUOutOfMemoryError,
    ModelInfo,
    VRAMUsage,
    clear_gpu_memory,
    get_vram_usage,
    test_embedding_generation,
    # Core functions
    verify_gpu,
    verify_model_loading,
)

from .embedding_worker import (
    # Constants
    MODEL_PATH,
    EMBEDDING_DIM,
    MODEL_NAME,
    MODEL_VERSION,
    PREFIX_DOCUMENT,
    PREFIX_QUERY,
    DEFAULT_BATCH_SIZE,
    DEFAULT_DEVICE,
    # Data classes
    EmbeddingResult,
    QueryEmbeddingResult,
    # Core functions
    load_model,
    embed_chunks,
    embed_query,
    embed_with_oom_recovery,
    generate_embeddings,
    generate_query_embedding,
)

__all__ = [
    # Version
    "__version__",
    # Error classes (from gpu_utils)
    "EmbeddingModelError",
    "GPUError",
    "GPUNotAvailableError",
    "GPUOutOfMemoryError",
    # Type definitions (from gpu_utils)
    "GPUInfo",
    "ModelInfo",
    "VRAMUsage",
    # GPU utilities (from gpu_utils)
    "clear_gpu_memory",
    "get_vram_usage",
    "test_embedding_generation",
    "verify_gpu",
    "verify_model_loading",
    # Constants (from embedding_worker)
    "MODEL_PATH",
    "EMBEDDING_DIM",
    "MODEL_NAME",
    "MODEL_VERSION",
    "PREFIX_DOCUMENT",
    "PREFIX_QUERY",
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_DEVICE",
    # Data classes (from embedding_worker)
    "EmbeddingResult",
    "QueryEmbeddingResult",
    # Embedding functions (from embedding_worker)
    "load_model",
    "embed_chunks",
    "embed_query",
    "embed_with_oom_recovery",
    "generate_embeddings",
    "generate_query_embedding",
]

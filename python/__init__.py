"""
OCR Provenance MCP System - Python Workers

This package provides:
- GPU utilities for device detection and VRAM monitoring
- Datalab OCR worker for document processing
- Embedding worker for local inference with nomic-embed-text-v1.5

CRITICAL DESIGN PRINCIPLES:
- CP-004: Local Inference - Embedding generation MUST run locally
- No data leaves the local machine for embedding generation
- Auto-detects best device: CUDA > MPS (Apple Silicon) > CPU

Supported Platforms:
- Linux/Windows with NVIDIA GPU (CUDA)
- macOS with Apple Silicon (MPS)
- Any platform without GPU (CPU fallback)

Module Structure:
- gpu_utils: GPU verification, VRAM monitoring, device detection
- ocr_worker: Datalab OCR API integration (future)
- embedding_worker: nomic-embed-text-v1.5 inference
"""

__version__ = "1.0.0"
__author__ = "OCR Provenance MCP System"

from .embedding_worker import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DEVICE,
    EMBEDDING_DIM,
    MODEL_NAME,
    # Constants
    MODEL_PATH,
    MODEL_VERSION,
    PREFIX_DOCUMENT,
    PREFIX_QUERY,
    # Data classes
    EmbeddingResult,
    QueryEmbeddingResult,
    embed_chunks,
    embed_query,
    embed_with_oom_recovery,
    generate_embeddings,
    generate_query_embedding,
    # Core functions
    load_model,
)
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

__all__ = [
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_DEVICE",
    "EMBEDDING_DIM",
    "MODEL_NAME",
    # Constants (from embedding_worker)
    "MODEL_PATH",
    "MODEL_VERSION",
    "PREFIX_DOCUMENT",
    "PREFIX_QUERY",
    # Error classes (from gpu_utils)
    "EmbeddingModelError",
    # Data classes (from embedding_worker)
    "EmbeddingResult",
    "GPUError",
    # Type definitions (from gpu_utils)
    "GPUInfo",
    "GPUNotAvailableError",
    "GPUOutOfMemoryError",
    "ModelInfo",
    "QueryEmbeddingResult",
    "VRAMUsage",
    # Version
    "__version__",
    # GPU utilities (from gpu_utils)
    "clear_gpu_memory",
    "embed_chunks",
    "embed_query",
    "embed_with_oom_recovery",
    "generate_embeddings",
    "generate_query_embedding",
    "get_vram_usage",
    # Embedding functions (from embedding_worker)
    "load_model",
    "test_embedding_generation",
    "verify_gpu",
    "verify_model_loading",
]

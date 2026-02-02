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
- embedding_worker: nomic-embed-text-v1.5 inference (future)
"""

__version__ = "1.0.0"
__author__ = "OCR Provenance MCP System"

from .gpu_utils import (
    # Core functions
    verify_gpu,
    get_vram_usage,
    verify_model_loading,
    clear_gpu_memory,
    test_embedding_generation,
    # Error classes
    GPUError,
    GPUNotAvailableError,
    GPUOutOfMemoryError,
    EmbeddingModelError,
    # Type definitions
    GPUInfo,
    VRAMUsage,
    ModelInfo,
)

__all__ = [
    # Version
    "__version__",
    # Core functions
    "verify_gpu",
    "get_vram_usage",
    "verify_model_loading",
    "clear_gpu_memory",
    "test_embedding_generation",
    # Error classes
    "GPUError",
    "GPUNotAvailableError",
    "GPUOutOfMemoryError",
    "EmbeddingModelError",
    # Type definitions
    "GPUInfo",
    "VRAMUsage",
    "ModelInfo",
]

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
    "EmbeddingModelError",
    "GPUError",
    "GPUInfo",
    "GPUNotAvailableError",
    "GPUOutOfMemoryError",
    "ModelInfo",
    "VRAMUsage",
    "__version__",
    "clear_gpu_memory",
    "get_vram_usage",
    "test_embedding_generation",
    "verify_gpu",
    "verify_model_loading",
]

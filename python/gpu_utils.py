#!/usr/bin/env python3
"""
GPU Utilities for OCR Provenance MCP System

Provides GPU verification and VRAM monitoring.
Designed for NVIDIA RTX 5090 with CUDA 13.1+.

CRITICAL: This module follows fail-fast principles. If GPU is not available,
operations will raise exceptions - NO fallbacks to CPU or cloud.
"""

import sys
import json
import argparse
import logging
from typing import TypedDict, Optional
from pathlib import Path

# Configure logging with detailed format for debugging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# =============================================================================
# Error Classes (CS-ERR-001 compliant)
# =============================================================================

class GPUError(Exception):
    """Base class for GPU-related errors."""
    pass


class GPUNotAvailableError(GPUError):
    """Raised when no CUDA GPU is available."""
    def __init__(self, message: str = "CUDA GPU not available"):
        self.message = message
        super().__init__(self.message)


class GPUOutOfMemoryError(GPUError):
    """Raised when GPU runs out of memory."""
    def __init__(self, message: str, vram_required: Optional[float] = None, vram_available: Optional[float] = None):
        self.message = message
        self.vram_required = vram_required
        self.vram_available = vram_available
        super().__init__(self.message)


class EmbeddingModelError(Exception):
    """Raised when embedding model fails to load or run."""
    def __init__(self, message: str, model_path: Optional[str] = None, cause: Optional[Exception] = None):
        self.message = message
        self.model_path = model_path
        self.cause = cause
        super().__init__(self.message)


# =============================================================================
# Type Definitions
# =============================================================================

class GPUInfo(TypedDict):
    """GPU information structure."""
    available: bool
    name: str
    vram_gb: float
    vram_used_gb: float
    vram_free_gb: float
    cuda_version: str
    compute_capability: str
    driver_version: str


class VRAMUsage(TypedDict):
    """VRAM usage statistics."""
    allocated_gb: float
    reserved_gb: float
    free_gb: float
    total_gb: float


class ModelInfo(TypedDict):
    """Embedding model information."""
    success: bool
    model_path: str
    error: Optional[str]
    model_info: dict


# =============================================================================
# GPU Verification Functions
# =============================================================================

def verify_gpu() -> GPUInfo:
    """
    Verify GPU availability and return detailed information.

    Returns:
        GPUInfo dict with GPU specifications

    Raises:
        GPUNotAvailableError: If GPU is not available (fail-fast, no fallback)
        ImportError: If PyTorch is not installed
    """
    logger.info("Starting GPU verification...")

    try:
        import torch
    except ImportError as e:
        logger.error("PyTorch not installed: %s", e)
        raise ImportError(
            "PyTorch is not installed. Install with: pip install torch --index-url https://download.pytorch.org/whl/cu131"
        ) from e

    if not torch.cuda.is_available():
        logger.error("CUDA is not available on this system")
        raise GPUNotAvailableError(
            "CUDA GPU not available. This system requires a CUDA-capable GPU for embedding generation. "
            "No fallback to CPU or cloud is allowed per CP-004 (Local GPU Inference principle)."
        )

    device = torch.cuda.current_device()
    props = torch.cuda.get_device_properties(device)

    total_memory = props.total_memory / (1024**3)  # Convert to GB
    allocated = torch.cuda.memory_allocated(device) / (1024**3)
    free = total_memory - allocated

    compute_cap = f"{props.major}.{props.minor}"

    # Check minimum VRAM requirement (8GB per constitution)
    if total_memory < 8.0:
        logger.warning(
            "GPU VRAM (%.2f GB) below recommended minimum (8 GB). "
            "Performance may be degraded.", total_memory
        )

    gpu_info = GPUInfo(
        available=True,
        name=props.name,
        vram_gb=round(total_memory, 2),
        vram_used_gb=round(allocated, 2),
        vram_free_gb=round(free, 2),
        cuda_version=torch.version.cuda or "unknown",
        compute_capability=compute_cap,
        driver_version=str(torch.cuda.get_device_capability(device)),
    )

    logger.info(
        "GPU verified: %s, VRAM: %.2f GB, CUDA: %s, Compute: %s",
        gpu_info["name"], gpu_info["vram_gb"], gpu_info["cuda_version"],
        gpu_info["compute_capability"]
    )

    return gpu_info


def get_vram_usage() -> VRAMUsage:
    """
    Get current VRAM usage statistics.

    Returns:
        VRAMUsage dict with allocated, reserved, and free memory in GB

    Raises:
        GPUNotAvailableError: If CUDA is not available
        ImportError: If PyTorch is not installed
    """
    logger.debug("Querying VRAM usage...")

    try:
        import torch
    except ImportError as e:
        logger.error("PyTorch not installed: %s", e)
        raise ImportError("PyTorch not installed") from e

    if not torch.cuda.is_available():
        logger.error("CUDA not available for VRAM query")
        raise GPUNotAvailableError("CUDA not available for VRAM usage query")

    device = torch.cuda.current_device()

    allocated = torch.cuda.memory_allocated(device) / (1024**3)
    reserved = torch.cuda.memory_reserved(device) / (1024**3)
    total = torch.cuda.get_device_properties(device).total_memory / (1024**3)

    usage = VRAMUsage(
        allocated_gb=round(allocated, 3),
        reserved_gb=round(reserved, 3),
        free_gb=round(total - reserved, 3),
        total_gb=round(total, 2)
    )

    logger.debug(
        "VRAM: allocated=%.3f GB, reserved=%.3f GB, free=%.3f GB, total=%.2f GB",
        usage["allocated_gb"], usage["reserved_gb"], usage["free_gb"], usage["total_gb"]
    )

    return usage


def verify_model_loading(model_path: str = "./models/nomic-embed-text-v1.5") -> ModelInfo:
    """
    Verify the embedding model can be loaded on GPU.

    Args:
        model_path: Path to the nomic-embed-text-v1.5 model

    Returns:
        ModelInfo dict with loading status and model info

    Raises:
        EmbeddingModelError: If model fails to load
        GPUNotAvailableError: If GPU is not available
    """
    logger.info("Verifying model loading from: %s", model_path)

    model_dir = Path(model_path)
    if not model_dir.exists():
        error_msg = f"Model directory not found: {model_path}"
        logger.error(error_msg)
        raise EmbeddingModelError(error_msg, model_path=model_path)

    # Check for required model files
    required_files = ["config.json", "model.safetensors", "tokenizer.json"]
    missing_files = [f for f in required_files if not (model_dir / f).exists()]
    if missing_files:
        error_msg = f"Missing required model files: {missing_files}"
        logger.error(error_msg)
        raise EmbeddingModelError(error_msg, model_path=model_path)

    try:
        import torch
        from sentence_transformers import SentenceTransformer

        if not torch.cuda.is_available():
            raise GPUNotAvailableError(
                "GPU required for model loading. No CPU fallback allowed per CP-004."
            )

        device = "cuda:0"
        logger.info("Loading model to device: %s", device)

        # Load model to GPU
        model = SentenceTransformer(model_path, device=device, trust_remote_code=True)

        # Get model info
        embedding_dim = model.get_sentence_embedding_dimension()
        max_seq_len = model.max_seq_length

        model_info = ModelInfo(
            success=True,
            model_path=model_path,
            error=None,
            model_info={
                "device": device,
                "embedding_dimension": embedding_dim,
                "max_seq_length": max_seq_len,
            }
        )

        logger.info(
            "Model loaded successfully: dim=%d, max_seq=%d, device=%s",
            embedding_dim, max_seq_len, device
        )

        # Cleanup
        del model
        torch.cuda.empty_cache()
        logger.debug("Model unloaded and GPU cache cleared")

        return model_info

    except GPUNotAvailableError:
        raise
    except Exception as e:
        logger.error("Model loading failed: %s", e)
        raise EmbeddingModelError(
            f"Failed to load embedding model: {e}",
            model_path=model_path,
            cause=e
        ) from e


def clear_gpu_memory() -> None:
    """
    Clear GPU memory cache.

    Raises:
        GPUNotAvailableError: If CUDA is not available
    """
    logger.debug("Clearing GPU memory...")

    try:
        import torch
        if not torch.cuda.is_available():
            raise GPUNotAvailableError("Cannot clear GPU memory: CUDA not available")

        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        logger.info("GPU memory cleared successfully")
    except GPUNotAvailableError:
        raise
    except Exception as e:
        logger.error("Failed to clear GPU memory: %s", e)
        raise GPUError(f"Failed to clear GPU memory: {e}") from e


def test_embedding_generation(model_path: str = "./models/nomic-embed-text-v1.5") -> dict:
    """
    Test that embedding generation works end-to-end on GPU.

    Args:
        model_path: Path to the embedding model

    Returns:
        dict with test results including embedding shape and timing

    Raises:
        EmbeddingModelError: If embedding generation fails
        GPUNotAvailableError: If GPU is not available
    """
    logger.info("Testing embedding generation...")

    try:
        import torch
        import time
        from sentence_transformers import SentenceTransformer

        if not torch.cuda.is_available():
            raise GPUNotAvailableError("GPU required for embedding generation")

        device = "cuda:0"
        model = SentenceTransformer(model_path, device=device, trust_remote_code=True)

        # Test with sample text
        test_texts = [
            "This is a test document for OCR provenance verification.",
            "The system must maintain complete data lineage.",
            "Every embedding must trace back to its source file."
        ]

        # Time the embedding generation
        start_time = time.perf_counter()
        embeddings = model.encode(test_texts, device=device, convert_to_numpy=True)
        end_time = time.perf_counter()

        elapsed_ms = (end_time - start_time) * 1000

        result = {
            "success": True,
            "embedding_shape": list(embeddings.shape),
            "embedding_dimension": embeddings.shape[1],
            "num_texts": len(test_texts),
            "elapsed_ms": round(elapsed_ms, 2),
            "ms_per_text": round(elapsed_ms / len(test_texts), 2),
            "device": device
        }

        logger.info(
            "Embedding test passed: shape=%s, time=%.2fms, device=%s",
            embeddings.shape, elapsed_ms, device
        )

        # Cleanup
        del model
        del embeddings
        torch.cuda.empty_cache()

        return result

    except (GPUNotAvailableError, EmbeddingModelError):
        raise
    except Exception as e:
        logger.error("Embedding generation test failed: %s", e)
        raise EmbeddingModelError(
            f"Embedding generation test failed: {e}",
            model_path=model_path,
            cause=e
        ) from e


# =============================================================================
# CLI Entry Point
# =============================================================================

def main() -> None:
    """CLI entry point for GPU verification."""
    parser = argparse.ArgumentParser(
        description="GPU Utilities for OCR Provenance MCP System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python gpu_utils.py --verify                 # Verify GPU availability
  python gpu_utils.py --verify --json          # Output as JSON
  python gpu_utils.py --vram                   # Show VRAM usage
  python gpu_utils.py --verify-model           # Verify model loading
  python gpu_utils.py --test-embedding         # Test embedding generation
        """
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify GPU availability and capabilities"
    )
    parser.add_argument(
        "--vram",
        action="store_true",
        help="Show current VRAM usage"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="./models/nomic-embed-text-v1.5",
        help="Path to embedding model (default: ./models/nomic-embed-text-v1.5)"
    )
    parser.add_argument(
        "--verify-model",
        action="store_true",
        help="Verify model can be loaded on GPU"
    )
    parser.add_argument(
        "--test-embedding",
        action="store_true",
        help="Test embedding generation end-to-end"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging"
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Default to --verify if no arguments
    if not any([args.verify, args.vram, args.verify_model, args.test_embedding]):
        args.verify = True

    results: dict = {}
    exit_code = 0

    try:
        if args.verify:
            gpu_info = verify_gpu()
            results["gpu"] = dict(gpu_info)

            if not args.json:
                print("=" * 60)
                print("GPU Verification Results")
                print("=" * 60)
                print(f"  GPU Available:       Yes")
                print(f"  GPU Name:            {gpu_info['name']}")
                print(f"  VRAM Total:          {gpu_info['vram_gb']} GB")
                print(f"  VRAM Free:           {gpu_info['vram_free_gb']} GB")
                print(f"  CUDA Version:        {gpu_info['cuda_version']}")
                print(f"  Compute Capability:  {gpu_info['compute_capability']}")
                print("=" * 60)

        if args.vram:
            vram_info = get_vram_usage()
            results["vram"] = dict(vram_info)

            if not args.json:
                print("\nVRAM Usage:")
                print(f"  Allocated: {vram_info['allocated_gb']} GB")
                print(f"  Reserved:  {vram_info['reserved_gb']} GB")
                print(f"  Free:      {vram_info['free_gb']} GB")
                print(f"  Total:     {vram_info['total_gb']} GB")

        if args.verify_model:
            model_result = verify_model_loading(args.model)
            results["model"] = dict(model_result)

            if not args.json:
                print("\nModel Verification:")
                print(f"  Status:    SUCCESS")
                print(f"  Path:      {model_result['model_path']}")
                print(f"  Device:    {model_result['model_info'].get('device', 'N/A')}")
                print(f"  Dimension: {model_result['model_info'].get('embedding_dimension', 'N/A')}")
                print(f"  Max Seq:   {model_result['model_info'].get('max_seq_length', 'N/A')}")

        if args.test_embedding:
            embed_result = test_embedding_generation(args.model)
            results["embedding_test"] = embed_result

            if not args.json:
                print("\nEmbedding Generation Test:")
                print(f"  Status:     SUCCESS")
                print(f"  Shape:      {embed_result['embedding_shape']}")
                print(f"  Dimension:  {embed_result['embedding_dimension']}")
                print(f"  Time:       {embed_result['elapsed_ms']} ms")
                print(f"  Per Text:   {embed_result['ms_per_text']} ms")
                print(f"  Device:     {embed_result['device']}")

    except GPUNotAvailableError as e:
        logger.error("GPU Error: %s", e)
        results["error"] = {
            "type": "GPU_NOT_AVAILABLE",
            "message": str(e)
        }
        if not args.json:
            print(f"\nERROR: {e}")
            print("This system requires a CUDA-capable GPU. No fallback is allowed.")
        exit_code = 1

    except EmbeddingModelError as e:
        logger.error("Model Error: %s", e)
        results["error"] = {
            "type": "EMBEDDING_MODEL_ERROR",
            "message": str(e),
            "model_path": e.model_path
        }
        if not args.json:
            print(f"\nERROR: {e}")
        exit_code = 1

    except ImportError as e:
        logger.error("Import Error: %s", e)
        results["error"] = {
            "type": "IMPORT_ERROR",
            "message": str(e)
        }
        if not args.json:
            print(f"\nERROR: {e}")
        exit_code = 1

    except Exception as e:
        logger.exception("Unexpected error: %s", e)
        results["error"] = {
            "type": "UNEXPECTED_ERROR",
            "message": str(e)
        }
        if not args.json:
            print(f"\nUNEXPECTED ERROR: {e}")
        exit_code = 1

    if args.json:
        print(json.dumps(results, indent=2))

    sys.exit(exit_code)


if __name__ == "__main__":
    main()

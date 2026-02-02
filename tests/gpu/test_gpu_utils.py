#!/usr/bin/env python3
"""
GPU Utilities Tests

Verifies GPU availability and capabilities for embedding generation.
Uses REAL GPU hardware and model - NO mocks or fake data.

IMPORTANT: These tests verify actual system capabilities. If a test fails,
it means the system is NOT ready for production use. Do NOT modify tests
to pass when the underlying functionality is broken.
"""

import sys
import os

# Add python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python'))

from gpu_utils import (
    verify_gpu,
    get_vram_usage,
    verify_model_loading,
    clear_gpu_memory,
    test_embedding_generation as run_embedding_test,
    GPUNotAvailableError,
    EmbeddingModelError,
)

# Test configuration
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'models', 'nomic-embed-text-v1.5')
MINIMUM_VRAM_GB = 8.0
EXPECTED_EMBEDDING_DIM = 768


def test_gpu_available():
    """
    Test that GPU is available.

    This test MUST pass for the system to function.
    Failure means: No CUDA-capable GPU detected.
    """
    print("\n[TEST] GPU Availability")
    print("-" * 50)

    info = verify_gpu()

    assert info["available"] is True, "GPU must be available for embedding generation"
    assert info["name"], "GPU name must be reported"
    assert info["cuda_version"], "CUDA version must be reported"

    print(f"  GPU Name:         {info['name']}")
    print(f"  CUDA Version:     {info['cuda_version']}")
    print(f"  Compute Cap:      {info['compute_capability']}")
    print(f"  RESULT:           PASS")


def test_vram_sufficient():
    """
    Test that VRAM is sufficient for batch processing.

    Minimum 8GB VRAM required per constitution.
    Failure means: GPU has insufficient memory for batch embedding.
    """
    print("\n[TEST] VRAM Sufficiency")
    print("-" * 50)

    info = verify_gpu()

    assert info["available"], "GPU must be available"
    assert info["vram_gb"] >= MINIMUM_VRAM_GB, (
        f"Insufficient VRAM: {info['vram_gb']}GB (need {MINIMUM_VRAM_GB}GB+)"
    )

    print(f"  Total VRAM:       {info['vram_gb']} GB")
    print(f"  Minimum Required: {MINIMUM_VRAM_GB} GB")
    print(f"  RESULT:           PASS")


def test_vram_usage_reporting():
    """
    Test VRAM usage reporting functionality.

    Verifies that VRAM metrics can be retrieved.
    Failure means: Cannot monitor GPU memory usage.
    """
    print("\n[TEST] VRAM Usage Reporting")
    print("-" * 50)

    usage = get_vram_usage()

    assert "allocated_gb" in usage, "Must report allocated VRAM"
    assert "reserved_gb" in usage, "Must report reserved VRAM"
    assert "free_gb" in usage, "Must report free VRAM"
    assert "total_gb" in usage, "Must report total VRAM"

    assert usage["total_gb"] > 0, "Total VRAM must be positive"
    assert usage["free_gb"] >= 0, "Free VRAM must be non-negative"

    print(f"  Allocated:        {usage['allocated_gb']} GB")
    print(f"  Reserved:         {usage['reserved_gb']} GB")
    print(f"  Free:             {usage['free_gb']} GB")
    print(f"  Total:            {usage['total_gb']} GB")
    print(f"  RESULT:           PASS")


def test_compute_capability():
    """
    Test GPU compute capability.

    Reports compute capability for the GPU.
    """
    print("\n[TEST] Compute Capability")
    print("-" * 50)

    info = verify_gpu()

    assert info["available"], "GPU must be available"
    assert info["compute_capability"], "Compute capability must be reported"

    major = int(info["compute_capability"].split(".")[0])
    minor = int(info["compute_capability"].split(".")[1])

    print(f"  Compute Cap:      {info['compute_capability']}")
    print(f"  Major Version:    {major}")
    print(f"  Minor Version:    {minor}")
    print(f"  RESULT:           PASS")


def test_model_exists():
    """
    Test that the embedding model directory exists and contains required files.

    Failure means: Model not downloaded or path incorrect.
    """
    print("\n[TEST] Model Directory Verification")
    print("-" * 50)

    model_path = os.path.abspath(MODEL_PATH)
    print(f"  Model Path:       {model_path}")

    assert os.path.exists(model_path), f"Model directory not found: {model_path}"
    assert os.path.isdir(model_path), f"Model path is not a directory: {model_path}"

    required_files = ["config.json", "model.safetensors", "tokenizer.json"]
    for f in required_files:
        file_path = os.path.join(model_path, f)
        assert os.path.exists(file_path), f"Required file missing: {f}"
        print(f"  Found:            {f}")

    print(f"  RESULT:           PASS")


def test_model_loading():
    """
    Test that the embedding model can be loaded on GPU.

    This test ACTUALLY loads the model to GPU memory.
    Failure means: Model cannot be used for embedding generation.
    """
    print("\n[TEST] Model Loading to GPU")
    print("-" * 50)

    model_path = os.path.abspath(MODEL_PATH)
    print(f"  Model Path:       {model_path}")

    result = verify_model_loading(model_path)

    assert result["success"], f"Model loading failed: {result.get('error')}"
    assert result["model_info"]["device"] == "cuda:0", "Model must load on GPU"
    assert result["model_info"]["embedding_dimension"] == EXPECTED_EMBEDDING_DIM, (
        f"Expected {EXPECTED_EMBEDDING_DIM} dimensions, got {result['model_info']['embedding_dimension']}"
    )

    print(f"  Device:           {result['model_info']['device']}")
    print(f"  Dimensions:       {result['model_info']['embedding_dimension']}")
    print(f"  Max Seq Length:   {result['model_info']['max_seq_length']}")
    print(f"  RESULT:           PASS")


def test_embedding_generation():
    """
    Test end-to-end embedding generation on GPU.

    This test ACTUALLY generates embeddings using the real model.
    Failure means: Cannot generate embeddings for OCR text.
    """
    print("\n[TEST] Embedding Generation")
    print("-" * 50)

    model_path = os.path.abspath(MODEL_PATH)
    print(f"  Model Path:       {model_path}")

    result = run_embedding_test(model_path)

    assert result["success"], "Embedding generation must succeed"
    assert result["embedding_dimension"] == EXPECTED_EMBEDDING_DIM, (
        f"Expected {EXPECTED_EMBEDDING_DIM} dimensions, got {result['embedding_dimension']}"
    )
    assert result["device"] == "cuda:0", "Embeddings must be generated on GPU"

    print(f"  Shape:            {result['embedding_shape']}")
    print(f"  Dimensions:       {result['embedding_dimension']}")
    print(f"  Texts Embedded:   {result['num_texts']}")
    print(f"  Total Time:       {result['elapsed_ms']} ms")
    print(f"  Per Text:         {result['ms_per_text']} ms")
    print(f"  Device:           {result['device']}")
    print(f"  RESULT:           PASS")


def test_gpu_memory_cleanup():
    """
    Test GPU memory can be cleared.

    Verifies memory management works for batch processing.
    """
    print("\n[TEST] GPU Memory Cleanup")
    print("-" * 50)

    # Get initial memory state
    before = get_vram_usage()
    print(f"  Before Cleanup:   {before['allocated_gb']} GB allocated")

    # Clear memory
    clear_gpu_memory()

    # Get final memory state
    after = get_vram_usage()
    print(f"  After Cleanup:    {after['allocated_gb']} GB allocated")

    # Memory should be same or less after cleanup
    assert after["allocated_gb"] <= before["allocated_gb"] + 0.1, (
        "Memory should not increase after cleanup"
    )

    print(f"  RESULT:           PASS")


def run_all_tests():
    """Run all GPU tests and report results."""
    print("=" * 60)
    print("GPU Verification Test Suite")
    print("OCR Provenance MCP System")
    print("=" * 60)
    print("\nNOTE: These tests use REAL hardware and models.")
    print("      No mocks. No fake data. Actual system verification.")
    print("      If a test fails, the system is not production-ready.")

    tests = [
        ("GPU Availability", test_gpu_available),
        ("VRAM Sufficiency", test_vram_sufficient),
        ("VRAM Usage Reporting", test_vram_usage_reporting),
        ("Compute Capability", test_compute_capability),
        ("Model Directory", test_model_exists),
        ("Model Loading", test_model_loading),
        ("Embedding Generation", test_embedding_generation),
        ("GPU Memory Cleanup", test_gpu_memory_cleanup),
    ]

    passed = 0
    failed = 0
    errors = []

    for name, test_fn in tests:
        try:
            test_fn()
            passed += 1
        except AssertionError as e:
            failed += 1
            errors.append((name, "ASSERTION", str(e)))
            print(f"  RESULT:           FAIL - {e}")
        except GPUNotAvailableError as e:
            failed += 1
            errors.append((name, "GPU_ERROR", str(e)))
            print(f"  RESULT:           FAIL - GPU Error: {e}")
        except EmbeddingModelError as e:
            failed += 1
            errors.append((name, "MODEL_ERROR", str(e)))
            print(f"  RESULT:           FAIL - Model Error: {e}")
        except Exception as e:
            failed += 1
            errors.append((name, "EXCEPTION", str(e)))
            print(f"  RESULT:           FAIL - Exception: {e}")

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    print(f"  Total Tests:      {len(tests)}")
    print(f"  Passed:           {passed}")
    print(f"  Failed:           {failed}")

    if errors:
        print("\n  FAILURES:")
        for name, err_type, msg in errors:
            print(f"    - {name} ({err_type}): {msg[:50]}...")

    print("=" * 60)

    if failed > 0:
        print("\nSYSTEM STATUS: NOT READY")
        print("Fix the above failures before using the system.")
        return 1
    else:
        print("\nSYSTEM STATUS: READY")
        print("All GPU verification tests passed.")
        return 0


if __name__ == "__main__":
    exit_code = run_all_tests()
    sys.exit(exit_code)

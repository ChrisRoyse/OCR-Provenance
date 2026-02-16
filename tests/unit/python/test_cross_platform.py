"""
Cross-Platform Device Detection Unit Tests

Tests resolve_device(), detect_best_device(), and verify_gpu() with mocked
torch backends. No GPU or embedding model required — runs on any platform.

Uses monkeypatch to simulate:
- CUDA + MPS available (Linux with both)
- CUDA only (typical Linux/Windows with NVIDIA)
- MPS only (macOS Apple Silicon)
- No GPU (CPU-only systems)

Best practice from: https://discuss.pytorch.org/t/mock-torch-device-for-unit-testing/136620
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add python directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))

from embedding_worker import DEFAULT_DEVICE, resolve_device
from gpu_utils import detect_best_device


# =============================================================================
# Fixtures for mocking device availability
# =============================================================================


@pytest.fixture()
def mock_cuda_available(monkeypatch):
    """Mock torch.cuda.is_available() -> True."""
    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda idx=0: "Mock NVIDIA GPU")


@pytest.fixture()
def mock_cuda_unavailable(monkeypatch):
    """Mock torch.cuda.is_available() -> False."""
    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)


@pytest.fixture()
def mock_mps_available(monkeypatch):
    """Mock torch.backends.mps.is_available() -> True."""
    import torch

    if not hasattr(torch.backends, "mps"):
        # Create mock mps module if it doesn't exist (Linux)
        mps_mock = MagicMock()
        mps_mock.is_available = MagicMock(return_value=True)
        monkeypatch.setattr(torch.backends, "mps", mps_mock)
    else:
        monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)


@pytest.fixture()
def mock_mps_unavailable(monkeypatch):
    """Mock torch.backends.mps.is_available() -> False."""
    import torch

    if not hasattr(torch.backends, "mps"):
        mps_mock = MagicMock()
        mps_mock.is_available = MagicMock(return_value=False)
        monkeypatch.setattr(torch.backends, "mps", mps_mock)
    else:
        monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)


# =============================================================================
# resolve_device() — auto mode
# =============================================================================


class TestResolveDeviceAuto:
    """Test resolve_device('auto') with different hardware configs."""

    def test_auto_prefers_cuda_when_available(self, mock_cuda_available, mock_mps_unavailable):
        """CUDA > MPS > CPU priority: selects CUDA when available."""
        assert resolve_device("auto") == "cuda:0"

    def test_auto_prefers_cuda_over_mps(self, mock_cuda_available, mock_mps_available):
        """CUDA > MPS > CPU priority: selects CUDA even when MPS available."""
        assert resolve_device("auto") == "cuda:0"

    def test_auto_falls_to_mps_without_cuda(self, mock_cuda_unavailable, mock_mps_available):
        """Without CUDA, selects MPS on Apple Silicon."""
        assert resolve_device("auto") == "mps"

    def test_auto_falls_to_cpu_without_any_gpu(self, mock_cuda_unavailable, mock_mps_unavailable):
        """Without CUDA or MPS, falls back to CPU."""
        assert resolve_device("auto") == "cpu"


# =============================================================================
# resolve_device() — explicit device requests
# =============================================================================


class TestResolveDeviceExplicit:
    """Test resolve_device() with explicit device strings."""

    def test_cpu_always_returns_cpu(self, mock_cuda_available):
        """Explicit 'cpu' request always returns 'cpu'."""
        assert resolve_device("cpu") == "cpu"

    def test_cuda_returns_cuda_when_available(self, mock_cuda_available):
        """Explicit 'cuda:0' returns 'cuda:0' when CUDA available."""
        assert resolve_device("cuda:0") == "cuda:0"

    def test_cuda_returns_cuda1_when_available(self, mock_cuda_available):
        """Explicit 'cuda:1' is passed through when CUDA available."""
        assert resolve_device("cuda:1") == "cuda:1"

    def test_cuda_falls_back_without_cuda(self, mock_cuda_unavailable, mock_mps_available):
        """Explicit 'cuda:0' falls back to auto when CUDA unavailable."""
        result = resolve_device("cuda:0")
        # Falls back to auto -> MPS in this mock setup
        assert result == "mps"

    def test_cuda_falls_to_cpu_without_any_gpu(self, mock_cuda_unavailable, mock_mps_unavailable):
        """Explicit 'cuda:0' falls to CPU when nothing available."""
        assert resolve_device("cuda:0") == "cpu"

    def test_mps_returns_mps_when_available(self, mock_mps_available):
        """Explicit 'mps' returns 'mps' when MPS available."""
        assert resolve_device("mps") == "mps"

    def test_mps_falls_back_without_mps(self, mock_cuda_available, mock_mps_unavailable):
        """Explicit 'mps' falls back when MPS unavailable."""
        result = resolve_device("mps")
        # Falls to auto -> CUDA
        assert result == "cuda:0"

    def test_mps_falls_to_cpu_without_any(self, mock_cuda_unavailable, mock_mps_unavailable):
        """Explicit 'mps' falls to CPU when nothing available."""
        assert resolve_device("mps") == "cpu"

    def test_unknown_device_passed_through(self):
        """Unknown device strings are passed through as-is."""
        assert resolve_device("xpu:0") == "xpu:0"
        assert resolve_device("tpu:0") == "tpu:0"
        assert resolve_device("npu:0") == "npu:0"


# =============================================================================
# detect_best_device()
# =============================================================================


class TestDetectBestDevice:
    """Test detect_best_device() returns correct device."""

    def test_returns_cuda_when_available(self, mock_cuda_available, mock_mps_unavailable):
        assert detect_best_device() == "cuda:0"

    def test_returns_mps_without_cuda(self, mock_cuda_unavailable, mock_mps_available):
        assert detect_best_device() == "mps"

    def test_returns_cpu_without_gpu(self, mock_cuda_unavailable, mock_mps_unavailable):
        assert detect_best_device() == "cpu"


# =============================================================================
# verify_gpu() — non-raising behavior
# =============================================================================


class TestVerifyGpu:
    """Test verify_gpu() returns GPUInfo without raising."""

    def test_returns_dict_with_available_key(self, mock_cuda_unavailable, mock_mps_unavailable):
        from gpu_utils import verify_gpu

        info = verify_gpu()
        assert isinstance(info, dict)
        assert "available" in info
        assert info["available"] is False

    def test_no_cuda_returns_best_device_in_name(
        self, mock_cuda_unavailable, mock_mps_unavailable
    ):
        from gpu_utils import verify_gpu

        info = verify_gpu()
        assert "cpu" in info["name"].lower()

    def test_no_cuda_has_zero_vram(self, mock_cuda_unavailable, mock_mps_unavailable):
        from gpu_utils import verify_gpu

        info = verify_gpu()
        assert info["vram_gb"] == 0
        assert info["vram_free_gb"] == 0

    @pytest.mark.skipif(
        not __import__("torch").cuda.is_available(),
        reason="CUDA not available — cannot test verify_gpu() with real GPU",
    )
    def test_with_cuda_returns_available_true(self):
        """When CUDA is genuinely available, verify_gpu() returns available=True."""
        from gpu_utils import verify_gpu

        info = verify_gpu()
        assert info["available"] is True
        assert isinstance(info["name"], str)
        assert len(info["name"]) > 0
        assert info["vram_gb"] > 0


# =============================================================================
# DEFAULT_DEVICE constant
# =============================================================================


class TestDefaultDevice:
    """Verify DEFAULT_DEVICE is set for cross-platform auto-detection."""

    def test_default_device_is_auto(self):
        """DEFAULT_DEVICE must be 'auto' for cross-platform support."""
        assert DEFAULT_DEVICE == "auto"

    def test_resolve_device_default_matches_constant(
        self, mock_cuda_unavailable, mock_mps_unavailable
    ):
        """resolve_device() with no args uses DEFAULT_DEVICE."""
        result = resolve_device()
        # With nothing available, default 'auto' should resolve to 'cpu'
        assert result == "cpu"

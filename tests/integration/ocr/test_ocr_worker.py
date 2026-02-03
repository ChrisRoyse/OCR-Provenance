"""
Integration tests for OCR Worker.

IMPORTANT: These tests make REAL API calls to Datalab.
Requires DATALAB_API_KEY environment variable set.
Uses real files from ./data/bench/ directory.
"""

import os
import sys
import uuid
from pathlib import Path

import pytest

# Add python directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "python"))

from ocr_worker import (
    OCRError,
    OCRFileError,
    OCRResult,
    SUPPORTED_EXTENSIONS,
    compute_content_hash,
    get_api_key,
    parse_page_offsets,
    process_batch,
    process_document,
    validate_file,
)


# =============================================================================
# TEST DATA - Real files from ./data/bench/
# =============================================================================

TEST_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data" / "bench"
TEST_PDF = TEST_DATA_DIR / "doc_0005.pdf"  # Multi-page PDF with needle phrase
TEST_DOCX = TEST_DATA_DIR / "doc_0000.docx"  # DOCX with Unicode text
TEST_TXT = TEST_DATA_DIR / "doc_0005.txt"  # Reference text for validation


def _is_api_key_configured() -> bool:
    """Check if API key is properly configured."""
    key = os.environ.get("DATALAB_API_KEY", "")
    return bool(key) and key != "your_api_key_here"


# Skip all tests if no API key
pytestmark = pytest.mark.skipif(
    not _is_api_key_configured(),
    reason="DATALAB_API_KEY not configured"
)


class TestValidation:
    """Tests for input validation (no API calls)."""

    def test_validate_file_exists(self):
        """Valid file passes validation."""
        path = validate_file(str(TEST_PDF))
        assert path.exists()
        assert path.suffix == ".pdf"
        print(f"[PASS] File validated: {path}")

    def test_validate_file_not_found(self):
        """Missing file raises OCRFileError."""
        with pytest.raises(OCRFileError) as exc:
            validate_file("/nonexistent/path/doc.pdf")
        assert exc.value.category == "OCR_FILE_ERROR"
        assert "not found" in str(exc.value).lower()
        print(f"[PASS] Missing file error: {exc.value}")

    def test_validate_unsupported_type(self, tmp_path):
        """Unsupported extension raises OCRFileError."""
        bad_file = tmp_path / "test.xyz"
        bad_file.touch()
        with pytest.raises(OCRFileError) as exc:
            validate_file(str(bad_file))
        assert "unsupported" in str(exc.value).lower()
        print(f"[PASS] Unsupported type error: {exc.value}")

    def test_supported_extensions(self):
        """All expected extensions are supported."""
        expected = {'.pdf', '.png', '.jpg', '.jpeg', '.docx', '.doc'}
        assert expected.issubset(SUPPORTED_EXTENSIONS)
        print(f"[PASS] Supported extensions: {sorted(SUPPORTED_EXTENSIONS)}")


class TestHashComputation:
    """Tests for hash computation matching TypeScript."""

    def test_hash_format(self):
        """Hash matches sha256:... format from src/utils/hash.ts."""
        hash_result = compute_content_hash("hello world")
        assert hash_result.startswith("sha256:")
        assert len(hash_result) == 71  # "sha256:" (7) + 64 hex chars
        print(f"[PASS] Hash format: {hash_result[:40]}...")

    def test_hash_consistency(self):
        """Same input produces same hash."""
        h1 = compute_content_hash("test content")
        h2 = compute_content_hash("test content")
        assert h1 == h2
        print(f"[PASS] Hash consistency verified")

    def test_hash_known_value(self):
        """Verify against known SHA-256."""
        # "hello" SHA-256 = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        result = compute_content_hash("hello")
        expected = "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        assert result == expected
        print(f"[PASS] Known hash verified: {result}")


class TestPageOffsetParsing:
    """Tests for page delimiter parsing."""

    def test_single_page(self):
        """Document without page markers = single page."""
        markdown = "This is a single page document with no markers."
        offsets = parse_page_offsets(markdown)
        assert len(offsets) == 1
        assert offsets[0].page == 1
        assert offsets[0].char_start == 0
        assert offsets[0].char_end == len(markdown)
        print(f"[PASS] Single page: {offsets}")

    def test_multi_page(self):
        """Parse page markers correctly."""
        markdown = "Page 1 content\n---\n<!-- Page 2 -->\nPage 2 content\n---\n<!-- Page 3 -->\nPage 3"
        offsets = parse_page_offsets(markdown)
        assert len(offsets) == 3
        assert offsets[0].page == 1
        assert offsets[1].page == 2
        assert offsets[2].page == 3
        print(f"[PASS] Multi-page parsing: {[(o.page, o.char_start, o.char_end) for o in offsets]}")


class TestProcessDocument:
    """
    Integration tests for document processing.
    Makes REAL API calls - requires DATALAB_API_KEY.
    """

    def test_process_pdf_success(self):
        """
        FULL STATE VERIFICATION: Process real PDF.

        Source of Truth: OCRResult dataclass fields
        Evidence: Print actual values from API response
        """

        # Skip if test file doesn't exist
        if not TEST_PDF.exists():
            pytest.skip(f"Test file not found: {TEST_PDF}")

        doc_id = str(uuid.uuid4())
        prov_id = str(uuid.uuid4())

        print(f"\n[TEST] Processing: {TEST_PDF}")
        print(f"[TEST] Document ID: {doc_id}")

        result = process_document(
            str(TEST_PDF),
            document_id=doc_id,
            provenance_id=prov_id,
            mode="fast"  # Use fast mode for tests
        )

        # === EVIDENCE OF SUCCESS ===
        print(f"\n[EVIDENCE] OCR Result:")
        print(f"  - ID: {result.id}")
        print(f"  - Document ID: {result.document_id}")
        print(f"  - Request ID: {result.datalab_request_id}")
        print(f"  - Mode: {result.datalab_mode}")
        print(f"  - Pages: {result.page_count}")
        print(f"  - Text length: {result.text_length}")
        print(f"  - Content hash: {result.content_hash[:40]}...")
        print(f"  - Duration: {result.processing_duration_ms}ms")
        print(f"  - Cost: ${(result.cost_cents or 0)/100:.4f}")
        print(f"  - Page offsets: {len(result.page_offsets)}")

        # === ASSERTIONS ===
        assert isinstance(result, OCRResult)
        assert result.document_id == doc_id
        assert result.provenance_id == prov_id
        assert result.datalab_mode == "fast"
        assert result.page_count >= 1
        assert result.text_length > 0
        assert len(result.extracted_text) > 0
        assert result.content_hash.startswith("sha256:")
        assert len(result.content_hash) == 71
        assert result.processing_duration_ms > 0
        assert len(result.page_offsets) >= 1

        # Verify hash integrity
        recomputed_hash = compute_content_hash(result.extracted_text)
        assert recomputed_hash == result.content_hash, "Hash verification failed!"
        print(f"[EVIDENCE] Hash verified: {recomputed_hash == result.content_hash}")

    def test_process_docx_success(self):
        """
        Test DOCX processing.
        """

        if not TEST_DOCX.exists():
            pytest.skip(f"Test file not found: {TEST_DOCX}")

        result = process_document(
            str(TEST_DOCX),
            document_id=str(uuid.uuid4()),
            provenance_id=str(uuid.uuid4()),
            mode="fast"
        )

        print(f"\n[EVIDENCE] DOCX test:")
        print(f"  - Text length: {result.text_length}")
        print(f"  - Text preview: {result.extracted_text[:200]}...")

        assert result.text_length > 0
        assert result.content_hash.startswith("sha256:")
        print(f"[PASS] DOCX processing succeeded")


class TestEdgeCases:
    """
    Edge case tests - REAL API calls.

    Tests boundary conditions with actual Datalab API.
    """

    def test_empty_pdf_handling(self):
        """
        Test with empty/minimal page PDF.

        doc_0000.pdf through doc_0004.pdf are marked as "empty_page_pdf"
        in manifest.json edge_cases.
        """

        empty_pdf = TEST_DATA_DIR / "doc_0000.pdf"
        if not empty_pdf.exists():
            pytest.skip("Empty test PDF not found")

        print(f"\n[EDGE CASE] Processing empty page PDF: {empty_pdf}")

        result = process_document(
            str(empty_pdf),
            document_id=str(uuid.uuid4()),
            provenance_id=str(uuid.uuid4()),
            mode="fast"
        )

        print(f"[EVIDENCE] Empty PDF result:")
        print(f"  - Text length: {result.text_length}")
        print(f"  - Page count: {result.page_count}")
        print(f"  - Content hash: {result.content_hash[:40]}...")

        # Should succeed even with empty/minimal content
        assert isinstance(result, OCRResult)
        assert result.content_hash.startswith("sha256:")
        print("[PASS] Empty PDF handled correctly")


class TestBatchProcessing:
    """Batch processing tests with REAL API calls."""

    def test_batch_multiple_files(self):
        """
        Process batch of files.

        Uses real files from ./data/bench/
        """

        # Get 2 test files to minimize API costs
        test_files = sorted(TEST_DATA_DIR.glob("*.pdf"))[:2]
        if len(test_files) < 2:
            pytest.skip("Not enough test files")

        file_paths = [str(f) for f in test_files]
        doc_ids = [str(uuid.uuid4()) for _ in test_files]
        prov_ids = [str(uuid.uuid4()) for _ in test_files]

        print(f"\n[TEST] Batch processing {len(test_files)} files")
        for f in test_files:
            print(f"  - {f.name}")

        results = process_batch(
            file_paths,
            doc_ids,
            prov_ids,
            mode="fast",
            max_concurrent=2
        )

        print(f"\n[EVIDENCE] Batch results:")
        for i, r in enumerate(results):
            if isinstance(r, OCRResult):
                print(f"  [{i}] SUCCESS: {test_files[i].name} - {r.text_length} chars")
            else:
                print(f"  [{i}] FAILED: {test_files[i].name} - {r}")

        assert len(results) == len(test_files)
        success_count = sum(1 for r in results if isinstance(r, OCRResult))
        assert success_count >= 1, "At least one file should succeed"
        print(f"[PASS] Batch: {success_count}/{len(test_files)} succeeded")


# =============================================================================
# MANUAL VERIFICATION TEST
# =============================================================================

class TestManualVerification:
    """
    Run these tests manually to verify end-to-end flow.

    Use: pytest tests/integration/ocr/test_ocr_worker.py::TestManualVerification -v -s
    """

    def test_full_pipeline_verification(self):
        """
        FULL STATE VERIFICATION

        1. Process document
        2. Verify all fields populated
        3. Verify hash integrity
        4. Print complete evidence
        """

        if not TEST_PDF.exists():
            pytest.skip("Test PDF not found")

        print("\n" + "=" * 60)
        print("FULL STATE VERIFICATION TEST")
        print("=" * 60)

        # STATE BEFORE
        doc_id = str(uuid.uuid4())
        prov_id = str(uuid.uuid4())

        print(f"\n[BEFORE] Document ID: {doc_id}")
        print(f"[BEFORE] Provenance ID: {prov_id}")
        print(f"[BEFORE] File: {TEST_PDF}")
        print(f"[BEFORE] File exists: {TEST_PDF.exists()}")
        print(f"[BEFORE] File size: {TEST_PDF.stat().st_size} bytes")

        # EXECUTE
        result = process_document(
            str(TEST_PDF),
            document_id=doc_id,
            provenance_id=prov_id,
            mode="fast"  # Use fast for testing
        )

        # STATE AFTER
        print(f"\n[AFTER] Result type: {type(result).__name__}")
        print(f"[AFTER] Result ID: {result.id}")
        print(f"[AFTER] Document ID match: {result.document_id == doc_id}")
        print(f"[AFTER] Provenance ID match: {result.provenance_id == prov_id}")
        print(f"[AFTER] Text extracted: {result.text_length} chars")
        print(f"[AFTER] Pages: {result.page_count}")
        print(f"[AFTER] Page offsets: {len(result.page_offsets)}")

        # HASH VERIFICATION
        recomputed = compute_content_hash(result.extracted_text)
        print(f"\n[VERIFY] Stored hash: {result.content_hash}")
        print(f"[VERIFY] Computed hash: {recomputed}")
        print(f"[VERIFY] Hash match: {result.content_hash == recomputed}")

        # PAGE OFFSET VERIFICATION
        print(f"\n[VERIFY] Page offsets:")
        for po in result.page_offsets:
            print(f"  Page {po.page}: chars {po.char_start}-{po.char_end}")

        # FINAL ASSERTION
        assert result.content_hash == recomputed
        assert result.document_id == doc_id
        assert result.provenance_id == prov_id
        assert result.text_length > 0

        print("\n" + "=" * 60)
        print("VERIFICATION PASSED")
        print("=" * 60)


# =============================================================================
# Run tests when invoked directly
# =============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

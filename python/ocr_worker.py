#!/usr/bin/env python3
"""
Datalab OCR Worker for OCR Provenance MCP System

Extracts text from documents using Datalab API.
FAIL-FAST: No fallbacks, no mocks. Errors propagate immediately.
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

# Configure logging FIRST
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# =============================================================================
# ERROR CLASSES (CS-ERR-001 compliant - inline, no separate module)
# =============================================================================

class OCRError(Exception):
    """Base OCR error with category for error handling."""

    def __init__(self, message: str, category: str, request_id: str | None = None):
        super().__init__(message)
        self.category = category
        self.request_id = request_id


class OCRAPIError(OCRError):
    """API errors (4xx/5xx responses)."""

    def __init__(self, message: str, status_code: int, request_id: str | None = None):
        category = "OCR_SERVER_ERROR" if status_code >= 500 else "OCR_API_ERROR"
        super().__init__(message, category, request_id)
        self.status_code = status_code


class OCRRateLimitError(OCRError):
    """Rate limit exceeded (429)."""

    def __init__(self, message: str = "Rate limit exceeded", retry_after: int = 60):
        super().__init__(message, "OCR_RATE_LIMIT")
        self.retry_after = retry_after


class OCRTimeoutError(OCRError):
    """Processing timeout."""

    def __init__(self, message: str, request_id: str | None = None):
        super().__init__(message, "OCR_TIMEOUT", request_id)


class OCRFileError(OCRError):
    """File access errors."""

    def __init__(self, message: str, file_path: str):
        super().__init__(message, "OCR_FILE_ERROR")
        self.file_path = file_path


class OCRAuthenticationError(OCRError):
    """Authentication/subscription errors (401/403)."""

    def __init__(self, message: str, status_code: int):
        # Provide actionable error message
        if "subscription" in message.lower() or "expired" in message.lower():
            detailed_msg = (
                f"Datalab API subscription expired. {message} "
                "Action: Renew subscription at https://www.datalab.to/settings"
            )
        elif status_code == 401:
            detailed_msg = (
                f"Datalab API authentication failed. {message} "
                "Action: Verify DATALAB_API_KEY is correct"
            )
        else:
            detailed_msg = f"Datalab API access denied (HTTP {status_code}). {message}"
        super().__init__(detailed_msg, "OCR_AUTHENTICATION_ERROR")
        self.status_code = status_code


# =============================================================================
# DATA STRUCTURES (match src/models/document.ts exactly)
# =============================================================================

@dataclass
class PageOffset:
    """
    Character offset for a single page.
    MUST match src/models/document.ts PageOffset interface.
    Note: TypeScript uses camelCase (charStart), Python uses snake_case (char_start).
    """
    page: int       # 1-indexed page number
    char_start: int  # Start offset in full text
    char_end: int    # End offset in full text


@dataclass
class OCRResult:
    """
    Result from OCR processing.
    MUST match src/models/document.ts OCRResult interface exactly.
    """
    # Required fields (match TypeScript interface)
    id: str                          # UUID - generate with uuid.uuid4()
    provenance_id: str               # UUID - caller provides
    document_id: str                 # UUID - caller provides
    extracted_text: str              # Markdown text from Datalab
    text_length: int                 # len(extracted_text)
    datalab_request_id: str          # Unique ID for this request
    datalab_mode: Literal["fast", "balanced", "accurate"]
    parse_quality_score: float | None
    page_count: int
    cost_cents: float | None
    content_hash: str                # sha256:... of extracted_text
    processing_started_at: str       # ISO 8601
    processing_completed_at: str     # ISO 8601
    processing_duration_ms: int

    # Additional fields for provenance (not in TS interface but needed)
    page_offsets: list[PageOffset]   # Character offsets per page
    error: str | None = None


# =============================================================================
# SUPPORTED FILE TYPES (match src/models/document.ts)
# =============================================================================

SUPPORTED_EXTENSIONS = frozenset({
    '.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp',
    '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'
})


# =============================================================================
# MAIN IMPLEMENTATION
# =============================================================================

def get_api_key() -> str:
    """
    Get Datalab API key from environment.
    FAIL-FAST: Raises immediately if not set.
    """
    api_key = os.environ.get("DATALAB_API_KEY")
    if not api_key:
        raise ValueError(
            "DATALAB_API_KEY environment variable is required. "
            "Get your key from https://www.datalab.to/settings"
        )
    if api_key == "your_api_key_here":
        raise ValueError(
            "DATALAB_API_KEY is set to placeholder value. "
            "Update .env with your actual API key."
        )
    return api_key


def validate_file(file_path: str) -> Path:
    """
    Validate file exists and is supported type.
    FAIL-FAST: Raises immediately on any issue.
    """
    path = Path(file_path).resolve()

    if not path.exists():
        raise OCRFileError(f"File not found: {file_path}", str(path))

    if not path.is_file():
        raise OCRFileError(f"Not a file: {file_path}", str(path))

    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise OCRFileError(
            f"Unsupported file type: {path.suffix}. "
            f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
            str(path)
        )

    return path


def compute_content_hash(content: str) -> str:
    """
    Compute SHA-256 hash matching src/utils/hash.ts format.

    Returns: 'sha256:' + 64 lowercase hex characters
    """
    hash_hex = hashlib.sha256(content.encode('utf-8')).hexdigest()
    return f"sha256:{hash_hex}"


def parse_page_offsets(markdown: str) -> list[PageOffset]:
    """
    Parse page delimiters from Datalab paginated output.

    Datalab with paginate=True adds markers like:
    ---
    <!-- Page 2 -->

    Returns list of PageOffset with character positions.
    """
    # Pattern matches page markers: newline + "---" + newline + "<!-- Page N -->" + newline
    page_pattern = r'\n---\n<!-- Page (\d+) -->\n'

    parts = re.split(page_pattern, markdown)

    if len(parts) == 1:
        # No page markers = single page document
        return [PageOffset(page=1, char_start=0, char_end=len(markdown))]

    offsets = []
    current_offset = 0

    # First part is page 1 content
    page1_content = parts[0]
    offsets.append(PageOffset(page=1, char_start=0, char_end=len(page1_content)))
    current_offset = len(page1_content)

    # Subsequent parts: alternating page_number, content
    for i in range(1, len(parts), 2):
        if i + 1 < len(parts):
            page_num = int(parts[i])
            content = parts[i + 1]
            marker_len = len(f"\n---\n<!-- Page {page_num} -->\n")
            offsets.append(PageOffset(
                page=page_num,
                char_start=current_offset + marker_len,
                char_end=current_offset + marker_len + len(content)
            ))
            current_offset += marker_len + len(content)

    return offsets


def process_document(
    file_path: str,
    document_id: str,
    provenance_id: str,
    mode: Literal["fast", "balanced", "accurate"] = "accurate",
    timeout: int = 300
) -> OCRResult:
    """
    Process a document through Datalab OCR.

    This is the MAIN function. Everything else supports this.

    Args:
        file_path: Path to document (PDF, image, or Office file)
        document_id: UUID of the document record in database
        provenance_id: UUID for the OCR_RESULT provenance record
        mode: OCR quality mode (accurate costs more but better quality)
        timeout: Maximum wait time in seconds (minimum 30s for API polling)

    Returns:
        OCRResult with extracted text and metadata

    Raises:
        OCRAPIError: On 4xx/5xx API responses
        OCRRateLimitError: On 429 (wait and retry)
        OCRTimeoutError: On timeout
        OCRFileError: On file access issues
        ValueError: On missing API key
    """
    from datalab_sdk import ConvertOptions, DatalabClient
    from datalab_sdk.exceptions import (
        DatalabAPIError,
        DatalabFileError,
        DatalabTimeoutError,
    )

    # Validate inputs
    validated_path = validate_file(file_path)
    api_key = get_api_key()

    logger.info(f"Processing document: {validated_path} (mode={mode})")

    # Record timing
    start_time = time.time()
    start_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Generate unique request ID for tracking
    request_id = str(uuid.uuid4())

    try:
        # Initialize client
        client = DatalabClient(api_key=api_key)

        # Configure options - paginate=True for page offset tracking
        options = ConvertOptions(
            output_format="markdown",
            mode=mode,
            paginate=True
        )

        # Calculate max_polls based on timeout (1 second poll interval)
        max_polls = max(timeout, 30)

        # Call Datalab API
        result = client.convert(
            file_path=str(validated_path),
            options=options,
            max_polls=max_polls,
            poll_interval=1
        )

        # Record completion
        end_time = time.time()
        end_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        duration_ms = int((end_time - start_time) * 1000)

        # Check for errors in result
        if not result.success:
            error_msg = result.error or "Unknown error during OCR processing"
            logger.error(f"OCR failed: {error_msg}")
            raise OCRAPIError(error_msg, status_code=500, request_id=request_id)

        # Extract data from result
        markdown = result.markdown or ""
        page_count = result.page_count or 1
        quality_score = result.parse_quality_score

        # Get cost from response (SDK returns 'total_cost_cents' directly in cents)
        cost_breakdown = result.cost_breakdown or {}
        cost_cents = cost_breakdown.get('total_cost_cents')

        # Parse page offsets for provenance tracking
        page_offsets = parse_page_offsets(markdown)

        # Compute content hash (matching src/utils/hash.ts format)
        content_hash = compute_content_hash(markdown)

        ocr_result = OCRResult(
            id=str(uuid.uuid4()),
            provenance_id=provenance_id,
            document_id=document_id,
            extracted_text=markdown,
            text_length=len(markdown),
            datalab_request_id=request_id,
            datalab_mode=mode,
            parse_quality_score=quality_score,
            page_count=page_count,
            cost_cents=cost_cents,
            content_hash=content_hash,
            processing_started_at=start_timestamp,
            processing_completed_at=end_timestamp,
            processing_duration_ms=duration_ms,
            page_offsets=page_offsets,
        )

        logger.info(
            f"OCR complete: {page_count} pages, {len(markdown)} chars, "
            f"{duration_ms}ms, cost=${(cost_cents or 0)/100:.4f}"
        )

        return ocr_result

    except DatalabAPIError as e:
        status = getattr(e, 'status_code', 500)
        error_msg = str(e)
        if status == 429 or "rate limit" in error_msg.lower():
            logger.error(f"Rate limit exceeded: {e}")
            raise OCRRateLimitError(error_msg) from e
        else:
            logger.error(f"API error ({status}): {e}")
            raise OCRAPIError(error_msg, status, request_id) from e

    except DatalabTimeoutError as e:
        logger.error(f"Timeout after {timeout}s: {e}")
        raise OCRTimeoutError(str(e), request_id) from e

    except DatalabFileError as e:
        logger.error(f"File error: {e}")
        raise OCRFileError(str(e), str(validated_path)) from e

    except Exception as e:
        # Catch-all for unexpected errors - still fail fast
        logger.error(f"Unexpected error during OCR: {e}")
        raise OCRAPIError(str(e), 500, request_id) from e


def process_batch(
    file_paths: list[str],
    document_ids: list[str],
    provenance_ids: list[str],
    mode: Literal["fast", "balanced", "accurate"] = "accurate",
    max_concurrent: int = 3
) -> list[OCRResult | OCRError]:
    """
    Process multiple documents with concurrency control.

    Args:
        file_paths: List of document paths
        document_ids: Matching list of document UUIDs
        provenance_ids: Matching list of provenance UUIDs
        mode: OCR mode for all documents
        max_concurrent: Max parallel requests (respect Datalab rate limits)

    Returns:
        List of OCRResult on success or OCRError on failure (same order as input)
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not (len(file_paths) == len(document_ids) == len(provenance_ids)):
        raise ValueError("file_paths, document_ids, and provenance_ids must have same length")

    results: dict[int, OCRResult | OCRError] = {}

    def process_one(idx: int) -> tuple[int, OCRResult | OCRError]:
        try:
            result = process_document(
                file_paths[idx],
                document_ids[idx],
                provenance_ids[idx],
                mode
            )
            return idx, result
        except OCRError as e:
            return idx, e

    with ThreadPoolExecutor(max_workers=max_concurrent) as executor:
        futures = {executor.submit(process_one, i): i for i in range(len(file_paths))}

        for future in as_completed(futures):
            idx, result = future.result()
            results[idx] = result

            if isinstance(result, OCRError):
                logger.error(f"Failed [{idx}]: {file_paths[idx]} - {result}")
            else:
                logger.info(f"Complete [{idx}]: {file_paths[idx]}")

    # Return in original order
    return [results[i] for i in range(len(file_paths))]


# =============================================================================
# CLI INTERFACE (for manual testing)
# =============================================================================

def main() -> None:
    """CLI entry point for manual testing."""
    # Load .env file if present
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            load_dotenv(env_path)
            logger.debug(f"Loaded environment from {env_path}")
    except ImportError:
        pass  # python-dotenv not installed, skip

    parser = argparse.ArgumentParser(
        description="Datalab OCR Worker - Extract text from documents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Process single PDF
  python ocr_worker.py --file ./data/bench/doc_0005.pdf --mode accurate

  # Process with JSON output
  python ocr_worker.py --file ./data/bench/doc_0005.pdf --json

  # Batch process directory
  python ocr_worker.py --dir ./data/bench/ --ext pdf --limit 5
        """
    )
    parser.add_argument("--file", "-f", type=str, help="Single file to process")
    parser.add_argument("--dir", "-d", type=str, help="Directory to scan")
    parser.add_argument("--ext", type=str, default="pdf", help="Extension filter for --dir")
    parser.add_argument("--limit", type=int, default=10, help="Max files for --dir")
    parser.add_argument(
        "--mode", "-m",
        choices=["fast", "balanced", "accurate"],
        default="accurate",
        help="OCR mode (default: accurate)"
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if not args.file and not args.dir:
        parser.error("Either --file or --dir is required")

    try:
        if args.file:
            # Single file
            result = process_document(
                args.file,
                document_id=str(uuid.uuid4()),
                provenance_id=str(uuid.uuid4()),
                mode=args.mode
            )

            if args.json:
                # asdict() recursively converts nested dataclasses
                print(json.dumps(asdict(result), indent=2))
            else:
                print("=== OCR Result ===")
                print(f"Pages: {result.page_count}")
                print(f"Characters: {result.text_length}")
                print(f"Duration: {result.processing_duration_ms}ms")
                print(f"Cost: ${(result.cost_cents or 0)/100:.4f}")
                print(f"Quality: {result.parse_quality_score}")
                print(f"Hash: {result.content_hash[:40]}...")
                print("\n=== Extracted Text (first 500 chars) ===")
                print(result.extracted_text[:500])

        else:
            # Directory batch
            dir_path = Path(args.dir)
            if not dir_path.is_dir():
                raise ValueError(f"Not a directory: {args.dir}")

            files = sorted(dir_path.glob(f"*.{args.ext}"))[:args.limit]

            if not files:
                print(f"No .{args.ext} files found in {args.dir}")
                sys.exit(1)

            print(f"Processing {len(files)} files...")

            results = process_batch(
                [str(f) for f in files],
                [str(uuid.uuid4()) for _ in files],
                [str(uuid.uuid4()) for _ in files],
                mode=args.mode,
                max_concurrent=3
            )

            success = sum(1 for r in results if isinstance(r, OCRResult))
            failed = len(results) - success

            print(f"\nResults: {success} success, {failed} failed")

            if args.json:
                output = [
                    asdict(r) if isinstance(r, OCRResult)
                    else {"error": str(r), "category": r.category}
                    for r in results
                ]
                print(json.dumps(output, indent=2))

    except Exception as e:
        logger.exception(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

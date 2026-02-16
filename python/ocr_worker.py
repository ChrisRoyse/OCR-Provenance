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
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
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
        if "subscription" in message.lower() or "expired" in message.lower() or status_code == 403:
            detailed_msg = (
                f"Datalab API subscription inactive (HTTP {status_code}). {message} "
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

    page: int  # 1-indexed page number
    char_start: int  # Start offset in full text
    char_end: int  # End offset in full text


@dataclass
class OCRResult:
    """
    Result from OCR processing.
    MUST match src/models/document.ts OCRResult interface exactly.
    """

    # Required fields (match TypeScript interface)
    id: str  # UUID - generate with uuid.uuid4()
    provenance_id: str  # UUID - caller provides
    document_id: str  # UUID - caller provides
    extracted_text: str  # Markdown text from Datalab
    text_length: int  # len(extracted_text)
    datalab_request_id: str  # Unique ID for this request
    datalab_mode: Literal["fast", "balanced", "accurate"]
    parse_quality_score: float | None
    page_count: int
    cost_cents: float | None
    content_hash: str  # sha256:... of extracted_text
    processing_started_at: str  # ISO 8601
    processing_completed_at: str  # ISO 8601
    processing_duration_ms: int

    # Additional fields for provenance (not in TS interface but needed)
    page_offsets: list[PageOffset]  # Character offsets per page
    error: str | None = None

    # Images extracted by Datalab (filename -> base64 data)
    images: dict[str, str] | None = None

    # JSON block hierarchy from Datalab (when output_format includes 'json')
    json_blocks: dict | None = None

    # Datalab metadata (page_stats, block_counts, etc.)
    metadata: dict | None = None

    # Structured extraction result (when page_schema provided)
    extraction_json: dict | list | None = None

    # Full cost breakdown dict from Datalab
    cost_breakdown_full: dict | None = None

    # Document metadata from Datalab
    doc_title: str | None = None
    doc_author: str | None = None
    doc_subject: str | None = None


# =============================================================================
# SUPPORTED FILE TYPES (match src/models/document.ts)
# =============================================================================

SUPPORTED_EXTENSIONS = frozenset(
    {
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".tiff",
        ".tif",
        ".bmp",
        ".gif",
        ".webp",
        ".docx",
        ".doc",
        ".pptx",
        ".ppt",
        ".xlsx",
        ".xls",
        ".txt",
        ".csv",
        ".md",
    }
)


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
            "DATALAB_API_KEY is set to placeholder value. Update .env with your actual API key."
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
            str(path),
        )

    return path


def compute_content_hash(content: str) -> str:
    """
    Compute SHA-256 hash matching src/utils/hash.ts format.

    Returns: 'sha256:' + 64 lowercase hex characters
    """
    hash_hex = hashlib.sha256(content.encode("utf-8")).hexdigest()
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
    page_pattern = r"\n---\n<!-- Page (\d+) -->\n"

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
            offsets.append(
                PageOffset(
                    page=page_num,
                    char_start=current_offset + marker_len,
                    char_end=current_offset + marker_len + len(content),
                )
            )
            current_offset += marker_len + len(content)

    return offsets


def process_document(
    file_path: str,
    document_id: str,
    provenance_id: str,
    mode: Literal["fast", "balanced", "accurate"] = "balanced",
    timeout: int = 300,
    # New Datalab API parameters
    max_pages: int | None = None,
    page_range: str | None = None,
    skip_cache: bool = False,
    disable_image_extraction: bool = False,
    extras: list[str] | None = None,
    page_schema: str | None = None,
    additional_config: dict | None = None,
    file_url: str | None = None,
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
        max_pages: Maximum pages to process (Datalab limit: 7000)
        page_range: Specific pages to process, 0-indexed (e.g. "0-5,10")
        skip_cache: Force reprocessing, skip Datalab cache
        disable_image_extraction: Skip image extraction for text-only processing
        extras: Extra Datalab features (e.g. ["track_changes", "chart_understanding"])
        page_schema: JSON schema string for structured data extraction per page
        additional_config: Additional Datalab config dict
        file_url: URL of file to process (instead of local file, passed to Datalab as file_url)

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
    if file_url:
        validated_path = None  # No local file when using URL
        logger.info(f"Processing document from URL: {file_url} (mode={mode})")
    else:
        validated_path = validate_file(file_path)
        logger.info(f"Processing document: {validated_path} (mode={mode})")
    api_key = get_api_key()

    # Record timing
    start_time = time.time()
    start_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Generate unique request ID for tracking
    request_id = str(uuid.uuid4())

    try:
        # Initialize client
        client = DatalabClient(api_key=api_key)

        # Configure options - paginate=True for page offset tracking
        options = ConvertOptions(output_format="markdown,json", mode=mode, paginate=True)
        # Only set optional Datalab API params if provided
        if max_pages is not None:
            options.max_pages = max_pages
        if page_range is not None:
            options.page_range = page_range
        if skip_cache:
            options.skip_cache = True
        if disable_image_extraction:
            options.disable_image_extraction = True
        if extras:
            options.extras = extras
        if page_schema:
            options.page_schema = page_schema
        if additional_config:
            options.additional_config = additional_config

        # Calculate max_polls based on timeout (3 second poll interval) (FIX-P2-1)
        max_polls = max(timeout // 3, 30)

        # Call Datalab API
        if file_url:
            result = client.convert(
                file_url=file_url, options=options, max_polls=max_polls, poll_interval=3
            )
        else:
            result = client.convert(
                file_path=str(validated_path), options=options, max_polls=max_polls, poll_interval=3
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
        cost_cents = cost_breakdown.get("total_cost_cents")

        # Capture images from Datalab response (filename -> base64 data)
        # Images are returned as a dict with filename keys and base64-encoded image data
        images = getattr(result, "images", None) or {}
        if images:
            logger.info(f"Captured {len(images)} images from Datalab response")

        # Capture JSON block hierarchy (from output_format="markdown,json")
        json_blocks = None
        raw_json = getattr(result, "json", None)
        if raw_json is not None:
            if isinstance(raw_json, dict):
                json_blocks = raw_json
            elif hasattr(raw_json, "__dict__"):
                json_blocks = raw_json.__dict__
            else:
                logger.warning(f"JSON output requested but got unexpected type: {type(raw_json)}")
            if json_blocks is not None:
                children = json_blocks.get("children", json_blocks.get("blocks", []))
                logger.info(
                    f"Captured JSON block hierarchy with {len(children) if isinstance(children, list) else 0} top-level blocks"
                )

        # Capture metadata (page_stats, block_counts, etc.)
        metadata_dict = None
        raw_metadata = getattr(result, "metadata", None)
        if raw_metadata is not None:
            if isinstance(raw_metadata, dict):
                metadata_dict = raw_metadata
            elif hasattr(raw_metadata, "__dict__"):
                metadata_dict = raw_metadata.__dict__

        # Capture structured extraction result (when page_schema provided)
        extraction_json = None
        raw_extraction = getattr(result, "extraction_schema_json", None)
        if raw_extraction is not None:
            if isinstance(raw_extraction, str):
                extraction_json = json.loads(raw_extraction)
            elif isinstance(raw_extraction, (dict, list)):
                extraction_json = raw_extraction
            if extraction_json is not None:
                logger.info("Captured structured extraction data")

        # Capture extras feature data (when extras params are enabled)
        # These are returned as top-level attributes on the result object
        extras_features: dict = {}
        for extras_key in (
            "links",
            "charts",
            "tracked_changes",
            "table_row_bboxes",
            "infographics",
        ):
            val = getattr(result, extras_key, None)
            if val is not None:
                extras_features[extras_key] = val
        if extras_features:
            # Merge extras features into metadata dict for downstream storage
            if metadata_dict is None:
                metadata_dict = {}
            metadata_dict["extras_features"] = extras_features
            logger.info(f"Captured extras features: {list(extras_features.keys())}")

        # Extract document metadata fields from Datalab metadata
        doc_title = None
        doc_author = None
        doc_subject = None
        if metadata_dict:
            doc_title = metadata_dict.get("title")
            doc_author = metadata_dict.get("author")
            doc_subject = metadata_dict.get("subject")

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
            images=images if images else None,
            json_blocks=json_blocks,
            metadata=metadata_dict,
            extraction_json=extraction_json,
            cost_breakdown_full=cost_breakdown if cost_breakdown else None,
            doc_title=doc_title,
            doc_author=doc_author,
            doc_subject=doc_subject,
        )

        logger.info(
            f"OCR complete: {page_count} pages, {len(markdown)} chars, "
            f"{duration_ms}ms, cost=${(cost_cents or 0) / 100:.4f}"
        )

        return ocr_result

    except DatalabAPIError as e:
        status = getattr(e, "status_code", 500)
        error_msg = str(e)
        if status == 429 or "rate limit" in error_msg.lower():
            logger.error(f"Rate limit exceeded: {e}")
            raise OCRRateLimitError(error_msg) from e
        elif status in (401, 403):
            logger.error(f"Authentication error ({status}): {e}")
            raise OCRAuthenticationError(error_msg, status) from e
        else:
            logger.error(f"API error ({status}): {e}")
            raise OCRAPIError(error_msg, status, request_id) from e

    except DatalabTimeoutError as e:
        logger.error(f"Timeout after {timeout}s: {e}")
        raise OCRTimeoutError(str(e), request_id) from e

    except DatalabFileError as e:
        logger.error(f"File error: {e}")
        raise OCRFileError(str(e), file_url or str(validated_path)) from e

    except Exception as e:
        # Catch-all for unexpected errors - still fail fast
        logger.error(f"Unexpected error during OCR: {e}")
        raise OCRAPIError(str(e), 500, request_id) from e


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
        """,
    )
    parser.add_argument("--file", "-f", type=str, help="Single file to process")
    parser.add_argument(
        "--file-url", type=str, help="URL of file to process (instead of local file)"
    )
    parser.add_argument(
        "--mode",
        "-m",
        choices=["fast", "balanced", "accurate"],
        default="balanced",
        help="OCR mode (default: balanced)",
    )
    parser.add_argument(
        "--doc-id", type=str, help="Document ID (UUID) - auto-generated if not provided"
    )
    parser.add_argument(
        "--prov-id", type=str, help="Provenance ID (UUID) - auto-generated if not provided"
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    # Datalab API parameters
    parser.add_argument("--max-pages", type=int, help="Max pages to process (Datalab limit: 7000)")
    parser.add_argument("--page-range", type=str, help='Page range, 0-indexed (e.g. "0-5,10")')
    parser.add_argument(
        "--skip-cache", action="store_true", help="Force reprocessing, skip Datalab cache"
    )
    parser.add_argument(
        "--disable-image-extraction", action="store_true", help="Skip image extraction"
    )
    parser.add_argument(
        "--extras",
        type=str,
        help='Comma-separated extras (e.g. "track_changes,chart_understanding")',
    )
    parser.add_argument(
        "--page-schema", type=str, help="JSON schema string for structured extraction per page"
    )
    parser.add_argument(
        "--additional-config", type=str, help="JSON string of additional Datalab config"
    )

    args = parser.parse_args()

    if args.json:
        # Suppress logging in JSON mode for clean output
        logging.getLogger().setLevel(logging.CRITICAL)

    if not args.file and not args.file_url:
        parser.error("Either --file or --file-url is required")

    try:
        # Use provided IDs or generate new ones
        doc_id = args.doc_id or str(uuid.uuid4())
        prov_id = args.prov_id or str(uuid.uuid4())
        # Parse extras list from comma-separated string
        extras_list = args.extras.split(",") if args.extras else None
        # Parse additional config JSON
        additional_config = json.loads(args.additional_config) if args.additional_config else None

        result = process_document(
            args.file or "",
            document_id=doc_id,
            provenance_id=prov_id,
            mode=args.mode,
            max_pages=args.max_pages,
            page_range=args.page_range,
            skip_cache=args.skip_cache,
            disable_image_extraction=args.disable_image_extraction,
            extras=extras_list,
            page_schema=args.page_schema,
            additional_config=additional_config,
            file_url=args.file_url,
        )

        if args.json:
            # asdict() recursively converts nested dataclasses
            # Use compact format (no indent) for python-shell compatibility
            print(json.dumps(asdict(result)))
        else:
            print("=== OCR Result ===")
            print(f"Pages: {result.page_count}")
            print(f"Characters: {result.text_length}")
            print(f"Duration: {result.processing_duration_ms}ms")
            print(f"Cost: ${(result.cost_cents or 0) / 100:.4f}")
            print(f"Quality: {result.parse_quality_score}")
            print(f"Hash: {result.content_hash[:40]}...")
            print("\n=== Extracted Text (first 500 chars) ===")
            print(result.extracted_text[:500])

    except Exception as e:
        logger.exception(f"Fatal error: {e}")
        if args.json:
            details = {}
            if hasattr(e, "status_code"):
                details["status_code"] = e.status_code
            if hasattr(e, "request_id"):
                details["request_id"] = e.request_id
            if hasattr(e, "file_path"):
                details["file_path"] = e.file_path
            print(
                json.dumps(
                    {
                        "error": str(e),
                        "category": getattr(e, "category", "OCR_API_ERROR"),
                        "details": details,
                    }
                )
            )
        sys.exit(1)


if __name__ == "__main__":
    main()

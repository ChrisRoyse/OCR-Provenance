#!/usr/bin/env python3
"""
Datalab Form Fill Worker for OCR Provenance MCP System

Fills PDF/image forms using Datalab API.
FAIL-FAST: No fallbacks, no mocks. Errors propagate immediately.
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

# Configure logging FIRST
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


# =============================================================================
# ERROR CLASSES (same pattern as ocr_worker.py)
# =============================================================================


class FormFillError(Exception):
    """Base form fill error with category for error handling."""

    def __init__(self, message: str, category: str):
        super().__init__(message)
        self.category = category


class FormFillAPIError(FormFillError):
    """API errors (4xx/5xx responses)."""

    def __init__(self, message: str, status_code: int):
        category = "FORM_FILL_SERVER_ERROR" if status_code >= 500 else "FORM_FILL_API_ERROR"
        super().__init__(message, category)
        self.status_code = status_code


class FormFillFileError(FormFillError):
    """File access errors."""

    def __init__(self, message: str, file_path: str):
        super().__init__(message, "FORM_FILL_FILE_ERROR")
        self.file_path = file_path


# =============================================================================
# DATA STRUCTURES
# =============================================================================


@dataclass
class FormFillResult:
    """Result from form fill processing."""

    id: str
    source_file_path: str
    source_file_hash: str
    output_base64: str | None
    fields_filled: list[str]
    fields_not_found: list[str]
    page_count: int | None
    cost_cents: float | None
    status: str  # 'complete' or 'failed'
    error: str | None = None
    processing_duration_ms: int = 0


# =============================================================================
# SUPPORTED FILE TYPES (subset that supports form filling)
# =============================================================================

SUPPORTED_EXTENSIONS = frozenset({".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".docx"})


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
        raise FormFillFileError(f"File not found: {file_path}", str(path))

    if not path.is_file():
        raise FormFillFileError(f"Not a file: {file_path}", str(path))

    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise FormFillFileError(
            f"Unsupported file type for form filling: {path.suffix}. "
            f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
            str(path),
        )

    return path


def compute_file_hash(file_path: str) -> str:
    """Compute SHA-256 of file content (64KB chunks for memory efficiency)."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def fill_form(
    file_path: str,
    field_data: dict,
    context: str | None = None,
    confidence_threshold: float = 0.5,
    page_range: str | None = None,
    timeout: int = 300,
) -> FormFillResult:
    """
    Fill a PDF/image form using Datalab API.

    This is the MAIN function. Everything else supports this.

    Args:
        file_path: Path to document (PDF, image, or DOCX)
        field_data: Dict of field names to fill data
        context: Optional context string for form filling
        confidence_threshold: Minimum confidence for field matching (0-1)
        page_range: Specific pages to process, 0-indexed (e.g. "0-5,10")
        timeout: Maximum wait time in seconds

    Returns:
        FormFillResult with filled form data

    Raises:
        FormFillAPIError: On 4xx/5xx API responses
        FormFillError: On timeout or other errors
        FormFillFileError: On file access issues
        ValueError: On missing API key
    """
    from datalab_sdk import DatalabClient, FormFillingOptions
    from datalab_sdk.exceptions import (
        DatalabAPIError,
        DatalabFileError,
        DatalabTimeoutError,
    )

    # Validate inputs
    validated_path = validate_file(file_path)
    api_key = get_api_key()
    file_hash = compute_file_hash(str(validated_path))

    logger.info(f"Filling form: {validated_path} with {len(field_data)} fields")

    # Record timing
    start_time = time.time()

    # Generate unique result ID for tracking
    result_id = str(uuid.uuid4())

    try:
        # Initialize client
        client = DatalabClient(api_key=api_key)

        # Configure options
        options = FormFillingOptions(
            field_data=field_data,
            confidence_threshold=confidence_threshold,
        )
        # Only set optional params if provided
        if context:
            options.context = context
        if page_range:
            options.page_range = page_range

        # Calculate max_polls based on timeout (3 second poll interval) (FIX-P2-2)
        max_polls = max(timeout // 3, 30)

        # Call Datalab API
        result = client.fill(
            file_path=str(validated_path),
            options=options,
            max_polls=max_polls,
            poll_interval=3,
        )

        # Record completion
        end_time = time.time()
        duration_ms = int((end_time - start_time) * 1000)

        # Check for errors in result
        if not result.success:
            error_msg = result.error or "Unknown form fill error"
            logger.error(f"Form fill failed: {error_msg}")
            return FormFillResult(
                id=result_id,
                source_file_path=str(validated_path),
                source_file_hash=file_hash,
                output_base64=None,
                fields_filled=[],
                fields_not_found=list(field_data.keys()),
                page_count=None,
                cost_cents=None,
                status="failed",
                error=error_msg,
                processing_duration_ms=duration_ms,
            )

        # Extract results
        output_base64 = getattr(result, "output_base64", None) or getattr(
            result, "file_base64", None
        )
        fields_filled = getattr(result, "fields_filled", []) or []
        fields_not_found = getattr(result, "fields_not_found", []) or []
        page_count = getattr(result, "page_count", None)
        cost_breakdown = getattr(result, "cost_breakdown", {}) or {}
        cost_cents = cost_breakdown.get("total_cost_cents")

        logger.info(
            f"Form fill complete: {len(fields_filled)} filled, "
            f"{len(fields_not_found)} not found, {duration_ms}ms"
        )

        return FormFillResult(
            id=result_id,
            source_file_path=str(validated_path),
            source_file_hash=file_hash,
            output_base64=output_base64,
            fields_filled=fields_filled,
            fields_not_found=fields_not_found,
            page_count=page_count,
            cost_cents=cost_cents,
            status="complete",
            processing_duration_ms=duration_ms,
        )

    except DatalabAPIError as e:
        status = getattr(e, "status_code", 500)
        raise FormFillAPIError(str(e), status) from e

    except DatalabTimeoutError as e:
        raise FormFillError(str(e), "FORM_FILL_TIMEOUT") from e

    except DatalabFileError as e:
        raise FormFillFileError(str(e), str(validated_path)) from e

    except Exception as e:
        # Catch-all for unexpected errors - still fail fast
        raise FormFillAPIError(str(e), 500) from e


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
        description="Datalab Form Fill Worker - Fill document forms",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fill a PDF form with JSON output
  python form_fill_worker.py --file form.pdf --field-data '{"name": {"value": "John"}}' --json

  # Fill with context and custom confidence threshold
  python form_fill_worker.py --file form.pdf --field-data '{"name": {"value": "John"}}' --context "Employment form" --confidence-threshold 0.8
        """,
    )
    parser.add_argument("--file", "-f", required=True, help="PDF/image file to fill")
    parser.add_argument(
        "--field-data",
        required=True,
        help='JSON dict: {"field_name": {"value": "...", "description": "..."}}',
    )
    parser.add_argument("--context", type=str, help="Context for form filling")
    parser.add_argument(
        "--confidence-threshold",
        type=float,
        default=0.5,
        help="Confidence threshold (0-1, default: 0.5)",
    )
    parser.add_argument("--page-range", type=str, help='Page range, 0-indexed (e.g. "0-5,10")')
    parser.add_argument("--timeout", type=int, default=300, help="Timeout seconds (default: 300)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")

    args = parser.parse_args()

    if args.json:
        # Suppress logging in JSON mode for clean output
        logging.getLogger().setLevel(logging.CRITICAL)
    elif args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    try:
        # Parse field_data JSON
        field_data = json.loads(args.field_data)
        if not isinstance(field_data, dict):
            raise ValueError("--field-data must be a JSON object")

        result = fill_form(
            file_path=args.file,
            field_data=field_data,
            context=args.context,
            confidence_threshold=args.confidence_threshold,
            page_range=args.page_range,
            timeout=args.timeout,
        )

        if args.json:
            # Use compact format (no indent) for python-shell compatibility
            print(json.dumps(asdict(result)))
        else:
            print("=== Form Fill Result ===")
            print(f"Status: {result.status}")
            print(f"Fields filled: {result.fields_filled}")
            print(f"Fields not found: {result.fields_not_found}")
            print(f"Duration: {result.processing_duration_ms}ms")
            if result.error:
                print(f"Error: {result.error}")

    except Exception as e:
        logger.exception(f"Fatal error: {e}")
        if args.json:
            details = {}
            if hasattr(e, "status_code"):
                details["status_code"] = e.status_code
            if hasattr(e, "file_path"):
                details["file_path"] = e.file_path
            print(
                json.dumps(
                    {
                        "error": str(e),
                        "category": getattr(e, "category", "FORM_FILL_API_ERROR"),
                        "details": details,
                    }
                )
            )
        sys.exit(1)


if __name__ == "__main__":
    main()

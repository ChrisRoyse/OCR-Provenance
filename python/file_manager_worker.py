#!/usr/bin/env python3
"""
Datalab File Manager Worker for OCR Provenance MCP System

Manages file uploads, listing, retrieval, and deletion via Datalab API.
FAIL-FAST: No fallbacks, no mocks. Errors propagate immediately.
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

# Configure logging FIRST - all logging goes to stderr
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


# =============================================================================
# CONSTANTS
# =============================================================================

# SDK handles base URL via DATALAB_HOST env var (default: https://www.datalab.to)


# =============================================================================
# ERROR CLASSES (same pattern as form_fill_worker.py)
# =============================================================================


class FileManagerError(Exception):
    """Base file manager error with category for error handling."""

    def __init__(self, message: str, category: str):
        super().__init__(message)
        self.category = category


class FileManagerAPIError(FileManagerError):
    """API errors (4xx/5xx responses)."""

    def __init__(self, message: str, status_code: int):
        category = "FILE_MANAGER_SERVER_ERROR" if status_code >= 500 else "FILE_MANAGER_API_ERROR"
        super().__init__(message, category)
        self.status_code = status_code


class FileManagerFileError(FileManagerError):
    """File access errors."""

    def __init__(self, message: str, file_path: str):
        super().__init__(message, "FILE_MANAGER_FILE_ERROR")
        self.file_path = file_path


# =============================================================================
# DATA STRUCTURES
# =============================================================================


@dataclass
class UploadResult:
    """Result from file upload."""

    file_id: str
    reference: str | None
    file_name: str
    file_hash: str
    file_size: int
    content_type: str
    status: str  # 'complete' or 'failed'
    error: str | None = None
    processing_duration_ms: int = 0


@dataclass
class FileInfo:
    """File metadata from Datalab."""

    file_id: str
    file_name: str | None
    file_size: int | None
    content_type: str | None
    created_at: str | None
    reference: str | None
    status: str | None


@dataclass
class FileListResult:
    """Result from listing files."""

    files: list[dict]
    total: int


@dataclass
class DownloadUrlResult:
    """Result from get_download_url with metadata."""

    download_url: str
    expires_in: int
    file_id: str


# =============================================================================
# HELPERS
# =============================================================================


def _import_sdk_exceptions() -> tuple:
    """Import SDK exception classes (deferred to match get_client pattern)."""
    from datalab_sdk.exceptions import (
        DatalabAPIError,
        DatalabFileError,
        DatalabTimeoutError,
        DatalabValidationError,
    )

    return DatalabAPIError, DatalabFileError, DatalabTimeoutError, DatalabValidationError


def _handle_sdk_exception(e: Exception, operation: str, context: str = "") -> None:
    """
    Handle SDK exceptions with specific error types.
    Raises the appropriate FileManager error based on the SDK exception type.
    """
    DatalabAPIError, DatalabFileError, DatalabTimeoutError, DatalabValidationError = _import_sdk_exceptions()

    if isinstance(e, DatalabValidationError):
        raise FileManagerAPIError(f"Invalid input for {operation}: {e}", 400) from e

    if isinstance(e, DatalabTimeoutError):
        raise FileManagerAPIError(f"{operation} timeout: {e}", 504) from e

    if isinstance(e, DatalabFileError):
        raise FileManagerFileError(f"{operation} file error: {e}", context or "unknown") from e

    if isinstance(e, DatalabAPIError):
        status = getattr(e, "status_code", 500)
        error_msg = str(e)
        if status == 429 or "rate limit" in error_msg.lower():
            raise FileManagerAPIError(f"Rate limit exceeded during {operation}: {e}", 429) from e
        if status in (401, 403):
            raise FileManagerAPIError(f"Authentication error during {operation} ({status}): {e}", status) from e
        if status == 404 or "not found" in error_msg.lower():
            raise FileManagerAPIError(f"Not found during {operation}: {e}", 404) from e
        raise FileManagerAPIError(f"API error during {operation} ({status}): {e}", status) from e

    # Unexpected exception type — log and raise as 500
    logger.error(f"Unexpected error during {operation}: {type(e).__name__}: {e}")
    raise FileManagerAPIError(f"SDK {operation} failed: {e}", 500) from e


def get_client() -> "DatalabClient":  # noqa: F821
    """
    Get a DatalabClient instance.
    FAIL-FAST: Raises immediately if API key not set.
    The SDK reads DATALAB_API_KEY from the environment automatically.
    """
    from datalab_sdk import DatalabClient

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
    return DatalabClient()


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


def get_content_type(file_path: str) -> str:
    """Determine content type from file extension."""
    ext = Path(file_path).suffix.lower()
    content_types = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".ppt": "application/vnd.ms-powerpoint",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".tiff": "image/tiff",
        ".tif": "image/tiff",
        ".bmp": "image/bmp",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".md": "text/markdown",
    }
    return content_types.get(ext, "application/octet-stream")


def validate_file(file_path: str) -> Path:
    """
    Validate file exists and is readable.
    FAIL-FAST: Raises immediately on any issue.
    """
    path = Path(file_path).resolve()

    if not path.exists():
        raise FileManagerFileError(f"File not found: {file_path}", str(path))

    if not path.is_file():
        raise FileManagerFileError(f"Not a file: {file_path}", str(path))

    return path


def _serialize_file_metadata(obj: object) -> dict:
    """
    Serialize an UploadedFileMetadata SDK object to a plain dict.
    L-2: SDK returns UploadedFileMetadata dataclass objects, not dicts.
    We explicitly convert to ensure consistent JSON output.
    """
    from dataclasses import fields as dc_fields

    # If it's already a dict, return as-is
    if isinstance(obj, dict):
        return obj

    # If it's a dataclass, convert properly with str(file_id) for L-1
    try:
        dc_fields(obj)  # Raises TypeError if not a dataclass
        result = asdict(obj)
        # L-1: Ensure file_id is str (SDK returns int)
        if "file_id" in result:
            result["file_id"] = str(result["file_id"])
        return result
    except TypeError:
        pass

    # Fallback: convert known attributes
    result = {}
    for attr in ("file_id", "original_filename", "content_type", "reference",
                 "upload_status", "file_size", "created", "error"):
        val = getattr(obj, attr, None)
        if val is not None:
            result[attr] = str(val) if attr == "file_id" else val
    return result


# =============================================================================
# API ACTIONS
# =============================================================================


def upload_file(file_path: str, timeout: int = 300) -> UploadResult:
    """
    Upload a file to Datalab cloud storage via SDK.

    The SDK handles the 3-step upload process internally with retry logic
    (tenacity-based exponential backoff for 429/5xx).

    Args:
        file_path: Path to file to upload
        timeout: Request timeout in seconds (unused - SDK manages timeouts)

    Returns:
        UploadResult with file_id and reference

    Raises:
        FileManagerAPIError: On API errors
        FileManagerFileError: On file access issues
        ValueError: On missing API key
    """
    validated_path = validate_file(file_path)
    client = get_client()
    file_hash = compute_file_hash(str(validated_path))
    file_size = validated_path.stat().st_size
    file_name = validated_path.name
    content_type = get_content_type(str(validated_path))

    logger.info(f"Uploading file via SDK: {validated_path} ({file_size} bytes)")

    start_time = time.time()

    try:
        result = client.upload_files(str(validated_path))
    except Exception as e:
        _handle_sdk_exception(e, "upload", str(validated_path))

    # SDK returns UploadedFileMetadata with file_id (int), reference, etc.
    # L-1: SDK's UploadedFileMetadata.file_id is int — convert to str for JSON protocol
    file_id = str(result.file_id)
    reference = result.reference

    if not file_id:
        raise FileManagerAPIError("SDK returned empty file_id", 500)

    logger.info(f"Upload complete via SDK: file_id={file_id}, reference={reference}")

    end_time = time.time()
    duration_ms = int((end_time - start_time) * 1000)

    return UploadResult(
        file_id=file_id,
        reference=reference,
        file_name=file_name,
        file_hash=file_hash,
        file_size=file_size,
        content_type=content_type,
        status="complete",
        processing_duration_ms=duration_ms,
    )


def list_files(limit: int = 50, offset: int = 0, timeout: int = 60) -> FileListResult:
    """
    List files in Datalab cloud storage via SDK.

    Args:
        limit: Max files to return
        offset: Pagination offset
        timeout: Request timeout in seconds (unused - SDK manages timeouts)

    Returns:
        FileListResult with files array and total count
    """
    client = get_client()

    try:
        data = client.list_files(limit=limit, offset=offset)
    except Exception as e:
        _handle_sdk_exception(e, "list_files")

    # SDK returns dict with 'files' (list of UploadedFileMetadata objects), 'total', 'limit', 'offset'
    # L-2: Explicitly serialize UploadedFileMetadata objects to plain dicts
    raw_files = data.get("files", [])
    files = [_serialize_file_metadata(f) for f in raw_files]
    total = data.get("total", len(files))

    return FileListResult(files=files, total=total)


def get_file(file_id: str, timeout: int = 60) -> FileInfo:
    """
    Get metadata for a specific file via SDK.

    Args:
        file_id: Datalab file ID
        timeout: Request timeout in seconds (unused - SDK manages timeouts)

    Returns:
        FileInfo with file metadata
    """
    client = get_client()

    try:
        meta = client.get_file_metadata(file_id)
    except Exception as e:
        _handle_sdk_exception(e, "get_file_metadata")

    # L-1: Ensure file_id is str
    return FileInfo(
        file_id=str(meta.file_id),
        file_name=meta.original_filename,
        file_size=meta.file_size,
        content_type=meta.content_type,
        created_at=str(meta.created) if meta.created else None,
        reference=meta.reference,
        status=meta.upload_status,
    )


def get_download_url(file_id: str, expires_in: int = 3600, timeout: int = 60) -> DownloadUrlResult:
    """
    Get a download URL for a file via SDK.

    Args:
        file_id: Datalab file ID
        expires_in: URL expiry time in seconds (default: 3600, max: 86400)
        timeout: Request timeout in seconds (unused - SDK manages timeouts)

    Returns:
        DownloadUrlResult with download_url, expires_in, and file_id

    Raises:
        FileManagerAPIError: On invalid expires_in, API errors, or missing download_url
    """
    # L-3: Validate expires_in bounds
    if expires_in < 60 or expires_in > 86400:
        raise FileManagerAPIError(
            f"expires_in must be between 60 and 86400 seconds, got {expires_in}", 400
        )

    client = get_client()

    try:
        data = client.get_file_download_url(file_id, expires_in=expires_in)
    except Exception as e:
        _handle_sdk_exception(e, "get_download_url")

    download_url = data.get("download_url")
    if not download_url:
        raise FileManagerAPIError(
            f"No download_url in SDK response. Keys: {list(data.keys())}",
            500,
        )

    return DownloadUrlResult(
        download_url=download_url,
        expires_in=expires_in,
        file_id=str(data.get("file_id", file_id)),
    )


def delete_file(file_id: str, timeout: int = 60) -> bool:
    """
    Delete a file from Datalab cloud storage via SDK.

    Args:
        file_id: Datalab file ID
        timeout: Request timeout in seconds (unused - SDK manages timeouts)

    Returns:
        True if deleted
    """
    client = get_client()

    try:
        result = client.delete_file(file_id)
    except Exception as e:
        _handle_sdk_exception(e, "delete_file")

    if not result.get("success", True):
        raise FileManagerAPIError(
            f"SDK delete returned failure: {result.get('message', 'unknown')}",
            500,
        )

    return True


# =============================================================================
# CLI INTERFACE
# =============================================================================


def main() -> None:
    """CLI entry point."""
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
        description="Datalab File Manager Worker - Upload, list, get, download, delete files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python file_manager_worker.py --action upload --file document.pdf
  python file_manager_worker.py --action list --limit 10
  python file_manager_worker.py --action get --file-id abc123
  python file_manager_worker.py --action download-url --file-id abc123 --expires-in 7200
  python file_manager_worker.py --action delete --file-id abc123
        """,
    )
    parser.add_argument(
        "--action",
        required=True,
        choices=["upload", "list", "get", "download-url", "delete"],
        help="Action to perform",
    )
    parser.add_argument("--file", "-f", type=str, help="File path (for upload)")
    parser.add_argument("--file-id", type=str, help="Datalab file ID (for get/download-url/delete)")
    parser.add_argument("--limit", type=int, default=50, help="Limit for list (default: 50)")
    parser.add_argument("--offset", type=int, default=0, help="Offset for list (default: 0)")
    parser.add_argument("--expires-in", type=int, default=3600, help="Download URL expiry in seconds (default: 3600, min: 60, max: 86400)")
    parser.add_argument("--timeout", type=int, default=300, help="Timeout seconds (default: 300)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")

    args = parser.parse_args()

    # Suppress logging for clean JSON output
    logging.getLogger().setLevel(logging.CRITICAL)
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    try:
        if args.action == "upload":
            if not args.file:
                raise ValueError("--file is required for upload action")
            result = upload_file(args.file, timeout=args.timeout)
            print(json.dumps(asdict(result)))

        elif args.action == "list":
            result = list_files(limit=args.limit, offset=args.offset, timeout=args.timeout)
            print(json.dumps(asdict(result)))

        elif args.action == "get":
            if not args.file_id:
                raise ValueError("--file-id is required for get action")
            result = get_file(args.file_id, timeout=args.timeout)
            print(json.dumps(asdict(result)))

        elif args.action == "download-url":
            if not args.file_id:
                raise ValueError("--file-id is required for download-url action")
            result = get_download_url(args.file_id, expires_in=args.expires_in, timeout=args.timeout)
            print(json.dumps(asdict(result)))

        elif args.action == "delete":
            if not args.file_id:
                raise ValueError("--file-id is required for delete action")
            delete_file(args.file_id, timeout=args.timeout)
            print(json.dumps({"deleted": True, "file_id": args.file_id}))

    except Exception as e:
        logger.exception(f"Fatal error: {e}")
        details = {}
        if hasattr(e, "status_code"):
            details["status_code"] = e.status_code
        if hasattr(e, "file_path"):
            details["file_path"] = e.file_path
        print(
            json.dumps(
                {
                    "error": str(e),
                    "category": getattr(e, "category", "FILE_MANAGER_API_ERROR"),
                    "details": details,
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()

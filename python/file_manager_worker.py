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

from datalab_sdk import DatalabClient

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


# =============================================================================
# HELPERS
# =============================================================================


def get_client() -> DatalabClient:
    """
    Get a DatalabClient instance.
    FAIL-FAST: Raises immediately if API key not set.
    The SDK reads DATALAB_API_KEY from the environment automatically.
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
        raise FileManagerAPIError(f"SDK upload failed: {e}", 500) from e

    # SDK returns UploadedFileMetadata with file_id, reference, etc.
    file_id = result.file_id
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
        raise FileManagerAPIError(f"SDK list_files failed: {e}", 500) from e

    # SDK returns dict with 'files', 'total', 'limit', 'offset'
    files = data.get("files", [])
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
        error_str = str(e).lower()
        if "404" in error_str or "not found" in error_str:
            raise FileManagerAPIError(f"File not found: {file_id}", 404) from e
        raise FileManagerAPIError(f"SDK get_file_metadata failed: {e}", 500) from e

    return FileInfo(
        file_id=meta.file_id,
        file_name=meta.original_filename,
        file_size=meta.file_size,
        content_type=meta.content_type,
        created_at=str(meta.created) if meta.created else None,
        reference=meta.reference,
        status=meta.upload_status,
    )


def get_download_url(file_id: str, timeout: int = 60) -> str:
    """
    Get a download URL for a file via SDK.

    Args:
        file_id: Datalab file ID
        timeout: Request timeout in seconds (unused - SDK manages timeouts)

    Returns:
        Download URL string
    """
    client = get_client()

    try:
        data = client.get_file_download_url(file_id)
    except Exception as e:
        error_str = str(e).lower()
        if "404" in error_str or "not found" in error_str:
            raise FileManagerAPIError(f"File not found: {file_id}", 404) from e
        raise FileManagerAPIError(f"SDK get_file_download_url failed: {e}", 500) from e

    download_url = data.get("download_url")
    if not download_url:
        raise FileManagerAPIError(
            f"No download_url in SDK response: {json.dumps(data)[:500]}",
            500,
        )

    return download_url


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
        error_str = str(e).lower()
        if "404" in error_str or "not found" in error_str:
            raise FileManagerAPIError(f"File not found: {file_id}", 404) from e
        raise FileManagerAPIError(f"SDK delete_file failed: {e}", 500) from e

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
  python file_manager_worker.py --action download-url --file-id abc123
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
            url = get_download_url(args.file_id, timeout=args.timeout)
            print(json.dumps({"download_url": url}))

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

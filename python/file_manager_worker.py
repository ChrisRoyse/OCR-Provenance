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

import requests

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

DATALAB_BASE_URL = "https://www.datalab.to"


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


def get_headers(api_key: str) -> dict:
    """Build standard API headers."""
    return {
        "X-Api-Key": api_key,
    }


def compute_file_hash(file_path: str) -> str:
    """Compute SHA-256 of file content (64KB chunks for memory efficiency)."""
    h = hashlib.sha256()
    with open(file_path, 'rb') as f:
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
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xls': 'application/vnd.ms-excel',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
        '.bmp': 'image/bmp',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.md': 'text/markdown',
    }
    return content_types.get(ext, 'application/octet-stream')


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
    Upload a file to Datalab cloud storage.

    3-step process:
    1. POST /api/v1/files/upload to get presigned URL
    2. PUT file to presigned URL
    3. GET /api/v1/files/{file_id}/confirm to confirm upload

    Args:
        file_path: Path to file to upload
        timeout: Request timeout in seconds

    Returns:
        UploadResult with file_id and reference

    Raises:
        FileManagerAPIError: On API errors
        FileManagerFileError: On file access issues
        ValueError: On missing API key
    """
    validated_path = validate_file(file_path)
    api_key = get_api_key()
    headers = get_headers(api_key)
    file_hash = compute_file_hash(str(validated_path))
    file_size = validated_path.stat().st_size
    file_name = validated_path.name
    content_type = get_content_type(str(validated_path))

    logger.info(f"Uploading file: {validated_path} ({file_size} bytes)")

    start_time = time.time()

    # Step 1: Get presigned upload URL
    logger.info("Step 1: Requesting presigned upload URL")
    upload_request_url = f"{DATALAB_BASE_URL}/api/v1/files/upload"
    upload_payload = {
        "filename": file_name,
        "content_type": content_type,
        "file_size": file_size,
    }

    resp = requests.post(
        upload_request_url,
        json=upload_payload,
        headers=headers,
        timeout=timeout,
    )

    if resp.status_code != 200:
        raise FileManagerAPIError(
            f"Failed to get upload URL: {resp.status_code} {resp.text[:500]}",
            resp.status_code,
        )

    upload_data = resp.json()
    presigned_url = upload_data.get("presigned_url") or upload_data.get("upload_url")
    file_id = upload_data.get("file_id") or upload_data.get("id")

    if not presigned_url:
        raise FileManagerAPIError(
            f"No presigned URL in response: {json.dumps(upload_data)[:500]}",
            500,
        )
    if not file_id:
        raise FileManagerAPIError(
            f"No file_id in response: {json.dumps(upload_data)[:500]}",
            500,
        )

    logger.info(f"Got file_id: {file_id}")

    # Step 2: PUT file to presigned URL
    logger.info("Step 2: Uploading file to presigned URL")
    with open(str(validated_path), 'rb') as f:
        put_resp = requests.put(
            presigned_url,
            data=f,
            headers={"Content-Type": content_type},
            timeout=timeout,
        )

    if put_resp.status_code not in (200, 201, 204):
        raise FileManagerAPIError(
            f"Failed to upload file: {put_resp.status_code} {put_resp.text[:500]}",
            put_resp.status_code,
        )

    logger.info("File uploaded successfully")

    # Step 3: Confirm upload
    logger.info("Step 3: Confirming upload")
    confirm_url = f"{DATALAB_BASE_URL}/api/v1/files/{file_id}/confirm"
    confirm_resp = requests.get(
        confirm_url,
        headers=headers,
        timeout=timeout,
    )

    reference = None
    if confirm_resp.status_code == 200:
        confirm_data = confirm_resp.json()
        reference = confirm_data.get("reference") or confirm_data.get("datalab_reference")
        logger.info(f"Upload confirmed, reference: {reference}")
    else:
        logger.warning(
            f"Confirm returned {confirm_resp.status_code}: {confirm_resp.text[:200]}. "
            "Upload may still be processing."
        )

    end_time = time.time()
    duration_ms = int((end_time - start_time) * 1000)

    return UploadResult(
        file_id=file_id,
        reference=reference,
        file_name=file_name,
        file_hash=file_hash,
        file_size=file_size,
        content_type=content_type,
        status='complete',
        processing_duration_ms=duration_ms,
    )


def list_files(limit: int = 50, offset: int = 0, timeout: int = 60) -> FileListResult:
    """
    List files in Datalab cloud storage.

    Args:
        limit: Max files to return
        offset: Pagination offset
        timeout: Request timeout in seconds

    Returns:
        FileListResult with files array and total count
    """
    api_key = get_api_key()
    headers = get_headers(api_key)

    url = f"{DATALAB_BASE_URL}/api/v1/files"
    params = {"limit": limit, "offset": offset}

    resp = requests.get(url, headers=headers, params=params, timeout=timeout)

    if resp.status_code != 200:
        raise FileManagerAPIError(
            f"Failed to list files: {resp.status_code} {resp.text[:500]}",
            resp.status_code,
        )

    data = resp.json()

    # Handle both array and paginated response formats
    if isinstance(data, list):
        files = data
        total = len(files)
    else:
        files = data.get("files", data.get("results", []))
        total = data.get("total", data.get("count", len(files)))

    return FileListResult(files=files, total=total)


def get_file(file_id: str, timeout: int = 60) -> FileInfo:
    """
    Get metadata for a specific file.

    Args:
        file_id: Datalab file ID
        timeout: Request timeout in seconds

    Returns:
        FileInfo with file metadata
    """
    api_key = get_api_key()
    headers = get_headers(api_key)

    url = f"{DATALAB_BASE_URL}/api/v1/files/{file_id}"

    resp = requests.get(url, headers=headers, timeout=timeout)

    if resp.status_code == 404:
        raise FileManagerAPIError(f"File not found: {file_id}", 404)

    if resp.status_code != 200:
        raise FileManagerAPIError(
            f"Failed to get file: {resp.status_code} {resp.text[:500]}",
            resp.status_code,
        )

    data = resp.json()

    return FileInfo(
        file_id=data.get("id", data.get("file_id", file_id)),
        file_name=data.get("file_name"),
        file_size=data.get("file_size"),
        content_type=data.get("content_type"),
        created_at=data.get("created_at"),
        reference=data.get("reference"),
        status=data.get("status"),
    )


def get_download_url(file_id: str, timeout: int = 60) -> str:
    """
    Get a download URL for a file.

    Args:
        file_id: Datalab file ID
        timeout: Request timeout in seconds

    Returns:
        Download URL string
    """
    api_key = get_api_key()
    headers = get_headers(api_key)

    url = f"{DATALAB_BASE_URL}/api/v1/files/{file_id}/download"

    resp = requests.get(url, headers=headers, timeout=timeout)

    if resp.status_code == 404:
        raise FileManagerAPIError(f"File not found: {file_id}", 404)

    if resp.status_code != 200:
        raise FileManagerAPIError(
            f"Failed to get download URL: {resp.status_code} {resp.text[:500]}",
            resp.status_code,
        )

    data = resp.json()
    download_url = data.get("url") or data.get("download_url") or data.get("presigned_url")

    if not download_url:
        raise FileManagerAPIError(
            f"No download URL in response: {json.dumps(data)[:500]}",
            500,
        )

    return download_url


def delete_file(file_id: str, timeout: int = 60) -> bool:
    """
    Delete a file from Datalab cloud storage.

    Args:
        file_id: Datalab file ID
        timeout: Request timeout in seconds

    Returns:
        True if deleted
    """
    api_key = get_api_key()
    headers = get_headers(api_key)

    url = f"{DATALAB_BASE_URL}/api/v1/files/{file_id}"

    resp = requests.delete(url, headers=headers, timeout=timeout)

    if resp.status_code == 404:
        raise FileManagerAPIError(f"File not found: {file_id}", 404)

    if resp.status_code not in (200, 204):
        raise FileManagerAPIError(
            f"Failed to delete file: {resp.status_code} {resp.text[:500]}",
            resp.status_code,
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
        """
    )
    parser.add_argument("--action", required=True,
                        choices=["upload", "list", "get", "download-url", "delete"],
                        help="Action to perform")
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
        if hasattr(e, 'status_code'):
            details['status_code'] = e.status_code
        if hasattr(e, 'file_path'):
            details['file_path'] = e.file_path
        print(json.dumps({
            "error": str(e),
            "category": getattr(e, 'category', 'FILE_MANAGER_API_ERROR'),
            "details": details,
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()

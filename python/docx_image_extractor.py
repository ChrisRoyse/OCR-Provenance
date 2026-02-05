#!/usr/bin/env python3
"""
Extract images from DOCX documents using stdlib zipfile + Pillow.

DOCX files are ZIP archives containing images in word/media/. This module
extracts those images and maps them to estimated page positions by parsing
word/document.xml for image references (a:blip elements).

This is a parallel extractor to image_extractor.py (PDF) for the OCR
Provenance MCP system, enabling VLM analysis of DOCX document images.

Usage:
    python docx_image_extractor.py --input /path/to/doc.docx --output /path/to/images/
    python docx_image_extractor.py -i doc.docx -o ./images --min-size 100 --max-images 50

Output:
    JSON to stdout with extraction results:
    {
        "success": true,
        "count": 5,
        "images": [
            {
                "page": 1,
                "index": 0,
                "format": "png",
                "width": 800,
                "height": 600,
                "bbox": {"x": 0, "y": 0, "width": 800, "height": 600},
                "path": "/path/to/images/p001_i000.png",
                "size": 12345
            },
            ...
        ]
    }
"""

import argparse
import json
import shutil
import subprocess
import sys
import os
import io
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

# Check for Pillow
try:
    from PIL import Image
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Pillow not installed. Run: pip install Pillow",
        "images": []
    }))
    sys.exit(1)


# OOXML namespaces used in word/document.xml
NSMAP = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "v": "urn:schemas-microsoft-com:vml",
}

# Relationship namespace for .rels files
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

# Paragraphs per estimated page
PARAGRAPHS_PER_PAGE = 40

# Formats accepted by Gemini VLM - anything else must be converted to PNG
GEMINI_NATIVE_FORMATS = {"png", "jpg", "jpeg", "gif", "webp"}

# Cache inkscape availability check
_INKSCAPE_PATH: str | None = shutil.which("inkscape")


def _convert_with_inkscape(
    img_bytes: bytes, ext: str, filename: str
) -> tuple[bool, bytes]:
    """Convert EMF/WMF to PNG using inkscape subprocess.

    Returns (success, png_bytes_or_original_bytes).
    """
    if _INKSCAPE_PATH is None:
        return False, img_bytes

    tmpdir = tempfile.mkdtemp(prefix="docx_img_")
    try:
        src = os.path.join(tmpdir, f"input.{ext}")
        dst = os.path.join(tmpdir, "output.png")
        with open(src, "wb") as f:
            f.write(img_bytes)

        result = subprocess.run(
            [_INKSCAPE_PATH, src, "--export-type=png", f"--export-filename={dst}"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and os.path.exists(dst):
            with open(dst, "rb") as f:
                return True, f.read()

        print(
            f"WARNING: inkscape failed for '{filename}': {result.stderr[:200]}",
            file=sys.stderr,
        )
        return False, img_bytes
    except subprocess.TimeoutExpired:
        print(
            f"WARNING: inkscape timed out converting '{filename}'",
            file=sys.stderr,
        )
        return False, img_bytes
    except Exception as e:
        print(
            f"WARNING: inkscape error for '{filename}': {e}",
            file=sys.stderr,
        )
        return False, img_bytes
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _parse_relationships(zf: zipfile.ZipFile) -> dict[str, str]:
    """
    Parse word/_rels/document.xml.rels to build a map of rId -> target path.

    Returns:
        Dictionary mapping relationship IDs (e.g. "rId5") to target paths
        (e.g. "media/image1.png").
    """
    rels_path = "word/_rels/document.xml.rels"
    rid_to_target: dict[str, str] = {}

    try:
        with zf.open(rels_path) as f:
            tree = ET.parse(f)
    except KeyError:
        return rid_to_target
    except ET.ParseError as e:
        print(
            f"WARNING: Failed to parse {rels_path}: {e}",
            file=sys.stderr,
        )
        return rid_to_target

    root = tree.getroot()
    for rel in root.iter(f"{{{RELS_NS}}}Relationship"):
        rid = rel.get("Id", "")
        target = rel.get("Target", "")
        if rid and target:
            rid_to_target[rid] = target

    return rid_to_target


def _parse_image_positions(
    zf: zipfile.ZipFile,
    rid_to_target: dict[str, str],
) -> list[dict[str, Any]]:
    """
    Parse word/document.xml to find image references and their paragraph positions.

    Walks all paragraphs (<w:p>) in order. For each paragraph that contains
    an image reference (a:blip with r:embed), records the paragraph index
    and the target media file.

    Returns:
        List of dicts: {"paragraph_index": int, "media_file": str}
        where media_file is the filename inside word/media/.
    """
    doc_path = "word/document.xml"
    positions: list[dict[str, Any]] = []

    try:
        with zf.open(doc_path) as f:
            tree = ET.parse(f)
    except KeyError:
        return positions
    except ET.ParseError as e:
        print(
            f"WARNING: Failed to parse {doc_path}: {e}",
            file=sys.stderr,
        )
        return positions

    root = tree.getroot()
    w_p_tag = f"{{{NSMAP['w']}}}p"
    a_blip_tag = f"{{{NSMAP['a']}}}blip"
    r_embed_attr = f"{{{NSMAP['r']}}}embed"

    paragraph_index = 0
    for element in root.iter(w_p_tag):
        # Search for a:blip elements inside this paragraph
        for blip in element.iter(a_blip_tag):
            rid = blip.get(r_embed_attr, "")
            if rid and rid in rid_to_target:
                target = rid_to_target[rid]
                # target is like "media/image1.png"
                media_file = target.split("/")[-1] if "/" in target else target
                positions.append({
                    "paragraph_index": paragraph_index,
                    "media_file": media_file,
                })
        paragraph_index += 1

    return positions


def _estimate_page(paragraph_index: int) -> int:
    """Estimate 1-indexed page number from paragraph index."""
    return (paragraph_index // PARAGRAPHS_PER_PAGE) + 1


def extract_images(
    docx_path: str,
    output_dir: str,
    min_size: int = 50,
    max_images: int = 100,
    formats: list[str] | None = None,
) -> dict[str, Any]:
    """
    Extract images from a DOCX document.

    Args:
        docx_path: Path to the DOCX file
        output_dir: Directory to save extracted images
        min_size: Minimum dimension (width or height) to include an image
        max_images: Maximum number of images to extract
        formats: List of formats to include (default: all)

    Returns:
        Dictionary with success status and list of extracted images
    """
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)

    images: list[dict[str, Any]] = []
    errors: list[str] = []

    # Open DOCX as ZIP - fail fast if it cannot be opened
    try:
        zf = zipfile.ZipFile(docx_path, "r")
    except zipfile.BadZipFile:
        return {
            "success": False,
            "error": (
                f"Cannot open as ZIP archive: {docx_path}. "
                "The file may be corrupted or not a valid DOCX. "
                "Verify the file opens in Microsoft Word or LibreOffice."
            ),
            "images": [],
        }
    except FileNotFoundError:
        return {
            "success": False,
            "error": f"DOCX file not found: {docx_path}",
            "images": [],
        }
    except PermissionError:
        return {
            "success": False,
            "error": (
                f"Permission denied reading: {docx_path}. "
                "Check file permissions with: ls -la '{docx_path}'"
            ),
            "images": [],
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to open DOCX file '{docx_path}': {type(e).__name__}: {e}",
            "images": [],
        }

    with zf:
        # List all files in word/media/
        media_files = [
            name for name in zf.namelist()
            if name.startswith("word/media/") and not name.endswith("/")
        ]

        # No images directory - valid DOCX with no embedded images
        if not media_files:
            return {
                "success": True,
                "count": 0,
                "images": [],
            }

        # Parse relationships and document.xml for position mapping
        rid_to_target = _parse_relationships(zf)
        image_positions = _parse_image_positions(zf, rid_to_target)

        # Build a lookup: media filename -> paragraph index
        media_to_paragraph: dict[str, int] = {}
        for pos in image_positions:
            fname = pos["media_file"]
            if fname not in media_to_paragraph:
                media_to_paragraph[fname] = pos["paragraph_index"]

        # Sort media files for deterministic output
        media_files.sort()

        count = 0
        for zip_entry in media_files:
            if count >= max_images:
                break

            media_filename = zip_entry.split("/")[-1]
            ext = media_filename.rsplit(".", 1)[-1].lower() if "." in media_filename else ""

            # Filter by format if specified
            if formats and ext not in [f.lower() for f in formats]:
                continue

            # Read image bytes from ZIP
            try:
                img_bytes = zf.read(zip_entry)
            except Exception as e:
                errors.append(
                    f"File '{zip_entry}': Failed to read from ZIP: "
                    f"{type(e).__name__}: {e}. The DOCX archive may be corrupted."
                )
                continue

            # Get dimensions using PIL
            try:
                pil_img = Image.open(io.BytesIO(img_bytes))
                width, height = pil_img.size
            except Exception as e:
                errors.append(
                    f"File '{zip_entry}': Failed to read image dimensions with Pillow: "
                    f"{type(e).__name__}: {e}. The image data may be corrupted or in "
                    f"an unsupported format."
                )
                continue

            # Skip images smaller than min_size
            if width < min_size or height < min_size:
                continue

            # Estimate page from paragraph position
            paragraph_idx = media_to_paragraph.get(media_filename, 0)
            page = _estimate_page(paragraph_idx)

            bbox = {
                "x": 0,
                "y": 0,
                "width": width,
                "height": height,
            }

            # Convert non-native formats (EMF, WMF, BMP, TIFF) to PNG
            # so the VLM pipeline (Gemini) can process them.
            save_ext = ext
            if ext not in GEMINI_NATIVE_FORMATS:
                converted = False
                # For EMF/WMF: use inkscape (best Linux EMF rasterizer)
                if not converted and ext in ("emf", "wmf"):
                    converted, img_bytes = _convert_with_inkscape(
                        img_bytes, ext, media_filename
                    )
                    if converted:
                        save_ext = "png"
                # Fallback to Pillow for simpler formats (BMP, TIFF)
                if not converted:
                    try:
                        buf = io.BytesIO()
                        pil_img.convert("RGBA").save(buf, format="PNG")
                        img_bytes = buf.getvalue()
                        save_ext = "png"
                        converted = True
                    except Exception:
                        pass
                if not converted:
                    print(
                        f"WARNING: Cannot convert {ext.upper()} to PNG for "
                        f"'{media_filename}'. Saving as-is. VLM processing will "
                        f"skip this image. To enable conversion, install "
                        f"inkscape: sudo apt install inkscape",
                        file=sys.stderr,
                    )

            # Generate filename matching PDF extractor pattern
            filename = f"p{page:03d}_i{count:03d}.{save_ext}"
            filepath = output / filename

            # Save image
            try:
                with open(filepath, "wb") as f:
                    f.write(img_bytes)
            except Exception as e:
                errors.append(
                    f"File '{zip_entry}': Failed to save to '{filepath}': "
                    f"{type(e).__name__}: {e}. Check that the output directory "
                    f"'{output_dir}' is writable."
                )
                continue

            images.append({
                "page": page,
                "index": count,
                "format": save_ext,
                "width": width,
                "height": height,
                "bbox": bbox,
                "path": str(filepath.absolute()),
                "size": len(img_bytes),
            })
            count += 1

        result: dict[str, Any] = {
            "success": True,
            "count": len(images),
            "images": images,
        }

        if errors:
            result["warnings"] = errors

        return result


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Extract images from DOCX documents for VLM analysis"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to input DOCX file",
    )
    parser.add_argument(
        "--output", "-o",
        required=True,
        help="Output directory for extracted images",
    )
    parser.add_argument(
        "--min-size",
        type=int,
        default=50,
        help="Minimum image dimension in pixels (default: 50)",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=100,
        help="Maximum images to extract (default: 100)",
    )
    parser.add_argument(
        "--formats",
        nargs="*",
        help="Image formats to include (default: all)",
    )

    args = parser.parse_args()

    # Validate input file exists
    if not os.path.isfile(args.input):
        print(json.dumps({
            "success": False,
            "error": f"Input file does not exist: {args.input}",
            "images": [],
        }))
        sys.exit(1)

    result = extract_images(
        docx_path=args.input,
        output_dir=args.output,
        min_size=args.min_size,
        max_images=args.max_images,
        formats=args.formats,
    )

    print(json.dumps(result))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()

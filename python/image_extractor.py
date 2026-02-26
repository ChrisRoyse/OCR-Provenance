#!/usr/bin/env python3
"""
Extract images from PDF documents using PyMuPDF (fitz).

This module provides image extraction capabilities for the OCR Provenance
MCP system, enabling VLM (Vision Language Model) analysis of document images.

Usage:
    python image_extractor.py --input /path/to/doc.pdf --output /path/to/images/
    python image_extractor.py -i doc.pdf -o ./images --min-size 100 --max-images 50

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
                "bbox": {"x": 72.0, "y": 100.0, "width": 400.0, "height": 300.0},
                "path": "/path/to/images/p001_i000.png",
                "size": 12345
            },
            ...
        ]
    }
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# Check for required dependencies
try:
    import fitz  # PyMuPDF
except ImportError:
    print(
        json.dumps(
            {
                "success": False,
                "error": "PyMuPDF not installed. Run: pip install PyMuPDF",
                "images": [],
            }
        )
    )
    sys.exit(1)

try:
    import io

    from PIL import Image
except ImportError:
    print(
        json.dumps(
            {
                "success": False,
                "error": "Pillow not installed. Run: pip install Pillow",
                "images": [],
            }
        )
    )
    sys.exit(1)


# Formats accepted by Gemini VLM - anything else must be converted to PNG
GEMINI_NATIVE_FORMATS = {"png", "jpg", "jpeg", "gif", "webp"}

# Cache inkscape availability check
_INKSCAPE_PATH: str | None = shutil.which("inkscape")

# Cache ImageMagick availability check
_MAGICK_PATH: str | None = shutil.which("convert")


def _convert_with_inkscape(img_bytes: bytes, ext: str, filename: str) -> tuple[bool, bytes]:
    """Convert EMF/WMF to PNG using inkscape subprocess."""
    if _INKSCAPE_PATH is None:
        return False, img_bytes

    tmpdir = tempfile.mkdtemp(prefix="pdf_img_")
    try:
        src = os.path.join(tmpdir, f"input.{ext}")
        dst = os.path.join(tmpdir, "output.png")
        with open(src, "wb") as f:
            f.write(img_bytes)

        result = subprocess.run(
            [_INKSCAPE_PATH, src, "--export-type=png", f"--export-filename={dst}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and os.path.exists(dst):
            with open(dst, "rb") as f:
                return True, f.read()
        return False, img_bytes
    except Exception:
        return False, img_bytes
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _convert_with_imagemagick(img_bytes: bytes, ext: str, filename: str) -> tuple[bool, bytes]:
    """Convert EMF/WMF to PNG using ImageMagick convert subprocess.

    Returns (success, png_bytes_or_original_bytes).
    """
    if _MAGICK_PATH is None:
        return False, img_bytes

    tmpdir = tempfile.mkdtemp(prefix="pdf_magick_")
    try:
        src = os.path.join(tmpdir, f"input.{ext}")
        dst = os.path.join(tmpdir, "output.png")
        with open(src, "wb") as f:
            f.write(img_bytes)

        result = subprocess.run(
            [_MAGICK_PATH, src, dst],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and os.path.exists(dst):
            with open(dst, "rb") as f:
                return True, f.read()

        print(
            f"WARNING: imagemagick failed for '{filename}': {result.stderr[:200]}",
            file=sys.stderr,
        )
        return False, img_bytes
    except subprocess.TimeoutExpired:
        print(
            f"WARNING: imagemagick timed out converting '{filename}'",
            file=sys.stderr,
        )
        return False, img_bytes
    except Exception as e:
        print(
            f"WARNING: imagemagick error for '{filename}': {e}",
            file=sys.stderr,
        )
        return False, img_bytes
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def extract_images(
    pdf_path: str,
    output_dir: str,
    min_size: int = 50,
    max_images: int = 100,
    formats: list[str] | None = None,
) -> dict[str, Any]:
    """
    Extract images from a PDF document.

    Args:
        pdf_path: Path to the PDF file
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

    try:
        with fitz.open(pdf_path) as doc:
            count = 0

            for page_num in range(len(doc)):
                if count >= max_images:
                    break

                page = doc[page_num]
                image_list = page.get_images(full=True)

                for img_idx, img_info in enumerate(image_list):
                    if count >= max_images:
                        break

                    xref = img_info[0]

                    try:
                        # Extract image data
                        base = doc.extract_image(xref)
                        img_bytes = base["image"]
                        ext = base["ext"]

                        # Filter by format if specified
                        if formats and ext.lower() not in [f.lower() for f in formats]:
                            continue

                        # Get dimensions using PIL (C-1: close pil_img after use)
                        try:
                            pil_img = Image.open(io.BytesIO(img_bytes))
                            width, height = pil_img.size
                        except Exception as e:
                            errors.append(
                                f"Page {page_num + 1}, image {img_idx}: Failed to read dimensions: {e}"
                            )
                            continue

                        # Skip images smaller than min_size
                        if width < min_size or height < min_size:
                            pil_img.close()
                            continue

                        # Get bounding box on page
                        rects = page.get_image_rects(xref)
                        if rects and len(rects) > 0:
                            r = rects[0]
                            bbox = {
                                "x": float(r.x0),
                                "y": float(r.y0),
                                "width": float(r.width),
                                "height": float(r.height),
                            }
                        else:
                            # Fallback: use image dimensions as bbox
                            bbox = {
                                "x": 0.0,
                                "y": 0.0,
                                "width": float(width),
                                "height": float(height),
                            }

                        # Convert non-native formats to PNG for VLM compatibility
                        save_ext = ext.lower()
                        if save_ext not in GEMINI_NATIVE_FORMATS:
                            converted = False
                            # For EMF/WMF: use inkscape
                            if not converted and save_ext in ("emf", "wmf"):
                                converted, img_bytes = _convert_with_inkscape(
                                    img_bytes, save_ext, f"p{page_num + 1}_i{img_idx}"
                                )
                                if converted:
                                    save_ext = "png"
                            # For EMF/WMF: try ImageMagick as second option
                            if not converted and save_ext in ("emf", "wmf"):
                                converted, img_bytes = _convert_with_imagemagick(
                                    img_bytes, save_ext, f"p{page_num + 1}_i{img_idx}"
                                )
                                if converted:
                                    save_ext = "png"
                            # Fallback to Pillow for simpler formats (BMP, TIFF)
                            # M-6: close RGBA intermediate and BytesIO buffer
                            if not converted:
                                try:
                                    buf = io.BytesIO()
                                    rgba_img = pil_img.convert("RGBA")
                                    rgba_img.save(buf, format="PNG")
                                    rgba_img.close()
                                    img_bytes = buf.getvalue()
                                    buf.close()
                                    save_ext = "png"
                                    converted = True
                                except Exception as conv_err:
                                    errors.append(
                                        f"Page {page_num + 1}, image {img_idx}: "
                                        f"RGBA conversion failed for format '{save_ext}': "
                                        f"{conv_err}"
                                    )
                            if not converted:
                                if save_ext in ("emf", "wmf"):
                                    # Do NOT save raw EMF/WMF - skip entirely
                                    errors.append(
                                        f"EMF/WMF image 'p{page_num + 1}_i{img_idx}' "
                                        f"could not be converted to PNG. Install "
                                        f"inkscape or imagemagick in the Docker image."
                                    )
                                    pil_img.close()
                                    continue

                        # C-1: close pil_img now that we have dimensions and conversion done
                        pil_img.close()

                        # Generate filename: p001_i000.png
                        filename = f"p{page_num + 1:03d}_i{img_idx:03d}.{save_ext}"
                        filepath = output / filename

                        # Save image
                        with open(filepath, "wb") as f:
                            f.write(img_bytes)

                        img_size = len(img_bytes)
                        # M-7: free img_bytes after writing to disk
                        del img_bytes

                        images.append(
                            {
                                "page": page_num + 1,  # 1-indexed
                                "index": img_idx,
                                "format": save_ext,
                                "width": width,
                                "height": height,
                                "bbox": bbox,
                                "path": str(filepath.absolute()),
                                "size": img_size,
                            }
                        )
                        count += 1

                    except Exception as e:
                        errors.append(f"Page {page_num + 1}, image {img_idx}: {e!s}")
                        continue

        result = {"success": True, "count": len(images), "images": images}

        if errors:
            result["warnings"] = errors

        return result

    except fitz.FileNotFoundError:
        return {"success": False, "error": f"PDF file not found: {pdf_path}", "images": []}
    except fitz.FileDataError as e:
        return {"success": False, "error": f"Invalid PDF file: {e!s}", "images": []}
    except Exception as e:
        return {"success": False, "error": f"Extraction failed: {e!s}", "images": []}


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Extract images from PDF documents for VLM analysis"
    )
    parser.add_argument("--input", "-i", required=True, help="Path to input PDF file")
    parser.add_argument(
        "--output", "-o", required=True, help="Output directory for extracted images"
    )
    parser.add_argument(
        "--min-size", type=int, default=50, help="Minimum image dimension in pixels (default: 50)"
    )
    parser.add_argument(
        "--max-images", type=int, default=100, help="Maximum images to extract (default: 100)"
    )

    args = parser.parse_args()

    # Validate input file exists
    if not os.path.isfile(args.input):
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"Input file does not exist: {args.input}",
                    "images": [],
                }
            )
        )
        sys.exit(1)

    result = extract_images(
        pdf_path=args.input,
        output_dir=args.output,
        min_size=args.min_size,
        max_images=args.max_images,
    )

    print(json.dumps(result))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()

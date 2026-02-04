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
import sys
import os
from pathlib import Path
from typing import Any

# Check for required dependencies
try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "PyMuPDF not installed. Run: pip install PyMuPDF",
        "images": []
    }))
    sys.exit(1)

try:
    from PIL import Image
    import io
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Pillow not installed. Run: pip install Pillow",
        "images": []
    }))
    sys.exit(1)


def extract_images(
    pdf_path: str,
    output_dir: str,
    min_size: int = 50,
    max_images: int = 100,
    formats: list[str] | None = None
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
        doc = fitz.open(pdf_path)
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

                    # Get dimensions using PIL
                    try:
                        pil_img = Image.open(io.BytesIO(img_bytes))
                        width, height = pil_img.size
                    except Exception as e:
                        errors.append(f"Page {page_num + 1}, image {img_idx}: Failed to read dimensions: {e}")
                        continue

                    # Skip images smaller than min_size
                    if width < min_size or height < min_size:
                        continue

                    # Get bounding box on page
                    rects = page.get_image_rects(xref)
                    if rects and len(rects) > 0:
                        r = rects[0]
                        bbox = {
                            "x": float(r.x0),
                            "y": float(r.y0),
                            "width": float(r.width),
                            "height": float(r.height)
                        }
                    else:
                        # Fallback: use image dimensions as bbox
                        bbox = {
                            "x": 0.0,
                            "y": 0.0,
                            "width": float(width),
                            "height": float(height)
                        }

                    # Generate filename: p001_i000.png
                    filename = f"p{page_num + 1:03d}_i{img_idx:03d}.{ext}"
                    filepath = output / filename

                    # Save image
                    with open(filepath, "wb") as f:
                        f.write(img_bytes)

                    images.append({
                        "page": page_num + 1,  # 1-indexed
                        "index": img_idx,
                        "format": ext,
                        "width": width,
                        "height": height,
                        "bbox": bbox,
                        "path": str(filepath.absolute()),
                        "size": len(img_bytes)
                    })
                    count += 1

                except Exception as e:
                    errors.append(f"Page {page_num + 1}, image {img_idx}: {str(e)}")
                    continue

        doc.close()

        result = {
            "success": True,
            "count": len(images),
            "images": images
        }

        if errors:
            result["warnings"] = errors

        return result

    except fitz.FileNotFoundError:
        return {
            "success": False,
            "error": f"PDF file not found: {pdf_path}",
            "images": []
        }
    except fitz.FileDataError as e:
        return {
            "success": False,
            "error": f"Invalid PDF file: {str(e)}",
            "images": []
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Extraction failed: {str(e)}",
            "images": []
        }


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Extract images from PDF documents for VLM analysis"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to input PDF file"
    )
    parser.add_argument(
        "--output", "-o",
        required=True,
        help="Output directory for extracted images"
    )
    parser.add_argument(
        "--min-size",
        type=int,
        default=50,
        help="Minimum image dimension in pixels (default: 50)"
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=100,
        help="Maximum images to extract (default: 100)"
    )
    parser.add_argument(
        "--formats",
        nargs="*",
        help="Image formats to include (default: all)"
    )

    args = parser.parse_args()

    # Validate input file exists
    if not os.path.isfile(args.input):
        print(json.dumps({
            "success": False,
            "error": f"Input file does not exist: {args.input}",
            "images": []
        }))
        sys.exit(1)

    result = extract_images(
        pdf_path=args.input,
        output_dir=args.output,
        min_size=args.min_size,
        max_images=args.max_images,
        formats=args.formats
    )

    print(json.dumps(result))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()

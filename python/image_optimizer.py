#!/usr/bin/env python3
"""
Image Optimizer and Relevance Analyzer for VLM Pipeline.

Provides two key functions:
1. Resize images for VLM (optimize token usage)
2. Analyze image relevance to filter out logos, icons, and decorative elements

The relevance analysis uses a multi-layer heuristic approach:
- Layer 1: Size filtering (tiny images are likely icons)
- Layer 2: Aspect ratio analysis (extreme ratios = banners/logos)
- Layer 3: Color diversity (low color count = likely logo/icon)
- Layer 4: Optional VLM pre-classification for borderline cases

Usage:
    # Resize for VLM
    python image_optimizer.py --resize-for-vlm /path/to/image.png --output /tmp/resized.png

    # Analyze image relevance (full analysis)
    python image_optimizer.py --analyze /path/to/image.png

Output:
    JSON to stdout with operation results.
"""

import argparse
import json
import os
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Pillow not installed. Run: pip install Pillow"
    }))
    sys.exit(1)


class ImageCategory(Enum):
    """Classification of image types for VLM relevance filtering."""
    PHOTO = "photo"              # Photographs, screenshots - HIGH relevance
    CHART = "chart"              # Charts, graphs, diagrams - HIGH relevance
    DOCUMENT = "document"        # Scanned documents, forms - HIGH relevance
    LOGO = "logo"                # Company logos, branding - LOW relevance
    ICON = "icon"                # UI icons, small graphics - LOW relevance
    DECORATIVE = "decorative"    # Borders, lines, separators - LOW relevance
    UNKNOWN = "unknown"          # Cannot determine


@dataclass
class ImageAnalysis:
    """Results of image relevance analysis."""
    width: int
    height: int
    aspect_ratio: float
    unique_colors: int
    color_diversity_score: float  # 0-1, higher = more diverse
    size_score: float             # 0-1, based on pixel count
    aspect_score: float           # 0-1, penalty for extreme ratios
    overall_relevance: float      # 0-1, combined score
    predicted_category: ImageCategory
    should_vlm: bool              # Final recommendation
    skip_reason: str | None       # Why skipped, if applicable


# Thresholds for heuristic filtering
MIN_DIMENSION_VLM = 50           # Skip images smaller than this
MIN_RELEVANCE_SCORE = 0.35       # Below this = definitely skip VLM
HIGH_RELEVANCE_SCORE = 0.6       # Above this = definitely process
LOGO_COLOR_THRESHOLD = 48        # Images with fewer colors likely logos
ICON_MAX_DIMENSION = 180         # Images this small are likely icons
EXTREME_ASPECT_RATIO = 3.5       # Ratios > this are likely banners/decorative

# OCR and VLM size limits
VLM_MAX_DIMENSION = 2048         # Gemini optimal size
VLM_MAX_FILE_SIZE = 20_000_000   # 20MB Gemini limit


def get_color_diversity(img: Image.Image, sample_size: int = 10000) -> tuple[int, float]:
    """
    Analyze color diversity of an image.

    Returns:
        (unique_colors, diversity_score)
        - unique_colors: Number of distinct colors in sample
        - diversity_score: 0-1 normalized score (1 = very diverse)
    """
    # M-8: track intermediates for cleanup
    rgb_img = None
    sample_img = None
    try:
        # Convert to RGB if needed
        if img.mode != 'RGB':
            rgb_img = img.convert('RGB')
            work_img = rgb_img
        else:
            work_img = img

        # Sample pixels for large images
        width, height = work_img.size
        total_pixels = width * height

        if total_pixels > sample_size:
            # Resize to get a representative sample
            scale = (sample_size / total_pixels) ** 0.5
            sample_img = work_img.resize(
                (max(1, int(width * scale)), max(1, int(height * scale))),
                Image.Resampling.NEAREST
            )
        else:
            sample_img = work_img

        # Count unique colors
        colors = sample_img.getcolors(maxcolors=65536)
        if colors is None:
            # More than 65536 colors = very diverse
            return 65536, 1.0

        unique_colors = len(colors)

        # Normalize to 0-1 score
        # Scale: 1 color = 0, 256+ colors = 1.0
        if unique_colors <= 1:
            diversity_score = 0.0
        elif unique_colors >= 256:
            diversity_score = 1.0
        else:
            # Log scale for smooth transition
            import math
            diversity_score = math.log2(unique_colors) / 8.0  # log2(256) = 8

        return unique_colors, diversity_score
    finally:
        # M-8: close intermediate images (only if they are distinct objects)
        if sample_img is not None and sample_img is not work_img:
            sample_img.close()
        if rgb_img is not None:
            rgb_img.close()


def calculate_aspect_score(width: int, height: int) -> float:
    """
    Calculate aspect ratio score. Normal ratios score 1.0, extreme ratios score lower.

    Common document/photo ratios (score ~1.0):
    - 4:3, 16:9, 3:2, 1:1, A4 (1:1.41)

    Suspicious ratios (score < 0.5):
    - Very wide banners (10:1)
    - Very tall sidebars (1:10)
    """
    if width == 0 or height == 0:
        return 0.0

    ratio = max(width, height) / min(width, height)

    if ratio <= 2.0:
        return 1.0  # Normal ratio
    elif ratio <= EXTREME_ASPECT_RATIO:
        # Linear decay from 1.0 to 0.5
        return 1.0 - 0.5 * (ratio - 2.0) / (EXTREME_ASPECT_RATIO - 2.0)
    else:
        # Extreme ratio - likely banner/decorative
        return max(0.1, 0.5 - 0.1 * (ratio - EXTREME_ASPECT_RATIO))


def calculate_size_score(width: int, height: int) -> float:
    """
    Calculate size score based on pixel count.

    Larger images are more likely to contain meaningful content.
    Very small images (<100px) are likely icons.
    """
    pixels = width * height

    if pixels < 50 * 50:
        return 0.0  # Tiny - definitely skip
    elif pixels < 100 * 100:
        return 0.2  # Very small - likely icon
    elif pixels < 200 * 200:
        return 0.4  # Small - possibly icon
    elif pixels < 400 * 400:
        return 0.7  # Medium - likely meaningful
    else:
        return 1.0  # Large - definitely meaningful


def predict_category(
    width: int,
    height: int,
    unique_colors: int,
    color_diversity: float
) -> ImageCategory:
    """
    Predict image category based on heuristics.
    """
    max_dim = max(width, height)
    min_dim = min(width, height)
    pixels = width * height
    aspect_ratio = max_dim / min_dim if min_dim > 0 else 999

    # Tiny images are icons
    if max_dim < 64:
        return ImageCategory.ICON

    # Very few colors with small size = likely logo/icon
    if unique_colors < 8 and max_dim < 200:
        return ImageCategory.ICON

    if unique_colors < LOGO_COLOR_THRESHOLD and max_dim < 400:
        return ImageCategory.LOGO

    # Extreme aspect ratio = decorative banner/separator
    if aspect_ratio > 6:
        return ImageCategory.DECORATIVE

    # Medium-high color diversity with reasonable size = content
    if color_diversity > 0.7 and pixels > 200 * 200:
        return ImageCategory.PHOTO

    # Moderate colors, could be chart or document
    if LOGO_COLOR_THRESHOLD <= unique_colors < 256:
        if aspect_ratio < 2:
            return ImageCategory.CHART
        else:
            return ImageCategory.DOCUMENT

    # High color diversity = likely photo
    if unique_colors >= 256:
        return ImageCategory.PHOTO

    return ImageCategory.UNKNOWN


def analyze_image(image_path: str) -> ImageAnalysis:
    """
    Analyze an image to determine if it's worth VLM processing.

    Args:
        image_path: Path to the image file

    Returns:
        ImageAnalysis with relevance scores and recommendation
    """
    with Image.open(image_path) as img:
        width, height = img.size

        # Calculate metrics
        aspect_ratio = max(width, height) / min(width, height) if min(width, height) > 0 else 999
        unique_colors, color_diversity = get_color_diversity(img)
        size_score = calculate_size_score(width, height)
        aspect_score = calculate_aspect_score(width, height)

    # Predict category
    category = predict_category(width, height, unique_colors, color_diversity)

    # Calculate overall relevance score
    # Weights: size (30%), aspect (20%), color diversity (30%), category bonus (20%)
    category_bonus = {
        ImageCategory.PHOTO: 1.0,
        ImageCategory.CHART: 1.0,
        ImageCategory.DOCUMENT: 0.9,
        ImageCategory.UNKNOWN: 0.5,
        ImageCategory.LOGO: 0.2,
        ImageCategory.ICON: 0.1,
        ImageCategory.DECORATIVE: 0.1,
    }

    overall_relevance = (
        0.30 * size_score +
        0.20 * aspect_score +
        0.30 * color_diversity +
        0.20 * category_bonus[category]
    )

    # Determine if we should VLM process
    skip_reason = None

    if max(width, height) < MIN_DIMENSION_VLM:
        should_vlm = False
        skip_reason = f"Too small: {width}x{height} < {MIN_DIMENSION_VLM}px"
    elif category in (ImageCategory.ICON, ImageCategory.DECORATIVE):
        should_vlm = False
        skip_reason = f"Predicted category: {category.value}"
    elif category == ImageCategory.LOGO and overall_relevance < 0.4:
        should_vlm = False
        skip_reason = f"Likely logo with low relevance: {overall_relevance:.2f}"
    elif overall_relevance < MIN_RELEVANCE_SCORE:
        should_vlm = False
        skip_reason = f"Low relevance score: {overall_relevance:.2f} < {MIN_RELEVANCE_SCORE}"
    else:
        should_vlm = True

    return ImageAnalysis(
        width=width,
        height=height,
        aspect_ratio=round(aspect_ratio, 2),
        unique_colors=unique_colors,
        color_diversity_score=round(color_diversity, 3),
        size_score=round(size_score, 3),
        aspect_score=round(aspect_score, 3),
        overall_relevance=round(overall_relevance, 3),
        predicted_category=category,
        should_vlm=should_vlm,
        skip_reason=skip_reason,
    )


def resize_for_vlm(
    input_path: str,
    output_path: str,
    max_dimension: int = VLM_MAX_DIMENSION,
    skip_below: int = MIN_DIMENSION_VLM
) -> dict[str, Any]:
    """
    Resize an image for VLM processing, optimizing for token usage.

    Args:
        input_path: Path to input image
        output_path: Path to save resized image
        max_dimension: Maximum dimension (width or height)
        skip_below: Skip images smaller than this

    Returns:
        Dict with resize results or skip indication
    """
    with Image.open(input_path) as img:
        original_width, original_height = img.size
        max_dim = max(original_width, original_height)

        # Check if too small
        if max_dim < skip_below:
            return {
                "success": True,
                "skipped": True,
                "skip_reason": f"Image too small: {original_width}x{original_height}",
                "original_width": original_width,
                "original_height": original_height,
            }

        # Check if resize needed
        if max_dim <= max_dimension:
            if input_path != output_path:
                img.save(output_path, quality=95)
            return {
                "success": True,
                "resized": False,
                "original_width": original_width,
                "original_height": original_height,
                "output_width": original_width,
                "output_height": original_height,
                "output_path": output_path,
            }

        # Calculate new dimensions preserving aspect ratio
        scale = max_dimension / max_dim
        new_width = int(original_width * scale)
        new_height = int(original_height * scale)

        # Resize with high quality (L-10: close resized image after save)
        resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        try:
            resized.save(output_path, quality=95)
        finally:
            resized.close()

    return {
        "success": True,
        "resized": True,
        "original_width": original_width,
        "original_height": original_height,
        "output_width": new_width,
        "output_height": new_height,
        "scale_factor": round(scale, 4),
        "output_path": output_path,
    }


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Image optimization and relevance analysis for OCR/VLM pipeline"
    )

    # Mode selection
    mode_group = parser.add_mutually_exclusive_group(required=True)
    mode_group.add_argument(
        "--resize-for-vlm",
        metavar="IMAGE",
        help="Resize image for VLM (max 2048px)"
    )
    mode_group.add_argument(
        "--analyze",
        metavar="IMAGE",
        help="Analyze single image for VLM relevance"
    )

    # Options
    parser.add_argument(
        "--output", "-o",
        help="Output path for resized image"
    )
    parser.add_argument(
        "--max-dimension",
        type=int,
        default=VLM_MAX_DIMENSION,
        help=f"Max dimension for VLM resize (default: {VLM_MAX_DIMENSION})"
    )

    args = parser.parse_args()

    try:
        if args.resize_for_vlm:
            if not args.output:
                print(json.dumps({
                    "success": False,
                    "error": "--output required for resize operations"
                }))
                sys.exit(1)
            result = resize_for_vlm(args.resize_for_vlm, args.output, args.max_dimension)

        elif args.analyze:
            analysis = analyze_image(args.analyze)
            result = {
                "success": True,
                "path": args.analyze,
                "width": analysis.width,
                "height": analysis.height,
                "aspect_ratio": analysis.aspect_ratio,
                "unique_colors": analysis.unique_colors,
                "color_diversity_score": analysis.color_diversity_score,
                "size_score": analysis.size_score,
                "aspect_score": analysis.aspect_score,
                "overall_relevance": analysis.overall_relevance,
                "predicted_category": analysis.predicted_category.value,
                "should_vlm": analysis.should_vlm,
            }
            if analysis.skip_reason:
                result["skip_reason"] = analysis.skip_reason

        print(json.dumps(result, indent=2))
        sys.exit(0)

    except FileNotFoundError as e:
        print(json.dumps({
            "success": False,
            "error": f"File not found: {e}"
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"{type(e).__name__}: {e}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()

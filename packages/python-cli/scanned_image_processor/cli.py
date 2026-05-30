"""CLI for cropping scanned album photos."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

from scanned_image_processor.crop import detect_photos

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}


def _iter_images(input_dir: Path, extensions: set[str]) -> list[Path]:
    return sorted(
        path
        for path in input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in extensions
    )


def _output_path(output_dir: Path, source: Path, index: int, total: int) -> Path:
    if total == 1:
        return output_dir / source.name
    return output_dir / f"{source.stem}_{index}{source.suffix}"


def process_directory(
    input_dir: Path,
    output_dir: Path,
    *,
    min_area_ratio: float,
    padding_ratio: float,
    deskew: bool,
    trim_borders: bool,
    trim_tolerance: int,
    extensions: set[str],
    jpeg_quality: int,
) -> tuple[int, int]:
    output_dir.mkdir(parents=True, exist_ok=True)
    images = _iter_images(input_dir, extensions)
    if not images:
        print(f"No images found in {input_dir}", file=sys.stderr)
        return 0, 0

    saved = 0
    skipped = 0

    for image_path in images:
        image = cv2.imread(str(image_path))
        if image is None:
            print(f"Could not read {image_path.name}", file=sys.stderr)
            skipped += 1
            continue

        crops = detect_photos(
            image,
            min_area_ratio=min_area_ratio,
            padding_ratio=padding_ratio,
            deskew=deskew,
            trim_borders=trim_borders,
            trim_tolerance=trim_tolerance,
        )

        if not crops:
            print(f"No photos detected in {image_path.name}", file=sys.stderr)
            skipped += 1
            continue

        for index, crop in enumerate(crops, start=1):
            out_path = _output_path(output_dir, image_path, index, len(crops))
            params = [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality]
            if not cv2.imwrite(str(out_path), crop, params):
                print(f"Failed to write {out_path.name}", file=sys.stderr)
                skipped += 1
                continue
            saved += 1
            print(f"{image_path.name} -> {out_path.name} ({crop.shape[1]}x{crop.shape[0]})")

    return saved, skipped


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Auto-crop photos from flatbed scanner JPEGs using edge detection.",
    )
    parser.add_argument(
        "input",
        type=Path,
        help="Directory containing scanned images",
    )
    parser.add_argument(
        "output",
        type=Path,
        help="Directory to write cropped images",
    )
    parser.add_argument(
        "--min-area",
        type=float,
        default=0.05,
        metavar="RATIO",
        help="Minimum detected region size as a fraction of the scan (default: 0.05)",
    )
    parser.add_argument(
        "--padding",
        type=float,
        default=0.0,
        metavar="RATIO",
        help="Extra margin around each crop (default: 0)",
    )
    parser.add_argument(
        "--no-deskew",
        action="store_true",
        help="Use axis-aligned bounding boxes instead of perspective correction",
    )
    parser.add_argument(
        "--no-trim",
        action="store_true",
        help="Keep white scanner margins instead of trimming them",
    )
    parser.add_argument(
        "--trim-tolerance",
        type=int,
        default=18,
        metavar="N",
        help="Color distance used to detect scanner-bed white (default: 18)",
    )
    parser.add_argument(
        "--jpeg-quality",
        type=int,
        default=95,
        metavar="Q",
        help="JPEG output quality 1-100 (default: 95)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.input.is_dir():
        print(f"Input path is not a directory: {args.input}", file=sys.stderr)
        return 1

    saved, skipped = process_directory(
        args.input,
        args.output,
        min_area_ratio=args.min_area,
        padding_ratio=args.padding,
        deskew=not args.no_deskew,
        trim_borders=not args.no_trim,
        trim_tolerance=args.trim_tolerance,
        extensions=IMAGE_EXTENSIONS,
        jpeg_quality=args.jpeg_quality,
    )

    print(f"Done: {saved} cropped, {skipped} skipped")
    return 0 if saved > 0 or skipped == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

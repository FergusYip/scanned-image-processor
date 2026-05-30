# Scanned Image Processor

Auto-crop photos from flatbed scanner output using edge detection. Built for digitizing old photo albums — scan at **300 DPI**, drop JPEGs in a folder, run the tool.

## Setup

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync
```

## Usage

```bash
uv run scan-crop scans/ cropped/
```

Each input file may produce one or more crops (e.g. when several photos were scanned on one page). Output names are `photo.jpg` for a single crop, or `photo_1.jpg`, `photo_2.jpg` when multiple photos are detected.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--min-area RATIO` | `0.05` | Ignore regions smaller than this fraction of the scan |
| `--padding RATIO` | `0` | Extra margin around each crop |
| `--no-deskew` | off | Skip perspective correction; use rectangular crops |
| `--jpeg-quality Q` | `95` | Output JPEG quality |

### Examples

Single photo per scan (typical):

```bash
uv run scan-crop ~/Scans/album1/ ~/Scans/album1-cropped/
```

Whole album page with multiple photos:

```bash
uv run scan-crop ~/Scans/pages/ ~/Scans/pages-cropped/ --min-area 0.03
```

Looser detection for small or faded photos:

```bash
uv run scan-crop scans/ cropped/ --min-area 0.02 --padding 0.02
```

## Scanning tips

- **300 DPI** is a good default for 3×5 and 4×6 prints
- **600 DPI** for wallet-sized photos or if you plan large enlargements
- Scan in **color** even for black-and-white photos
- Use JPEG quality **90–95** on the scanner; this tool re-encodes at 95 by default

## How it works

1. Grayscale + blur
2. Otsu threshold (photo vs white scanner bed), with Canny fallback
3. Contour detection and filtering (drops specks and full-page borders)
4. Quadrilateral fit + perspective warp to deskew
5. Trim white scanner-bed and photo-paper borders
6. Crop and save

Glossy photos, dark album pages, or overlapping prints may need manual touch-up or tweaked `--min-area` / `--padding` values.

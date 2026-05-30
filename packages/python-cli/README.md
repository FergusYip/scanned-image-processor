# Python CLI

Reference OpenCV implementation for cropping photos from flatbed scanner output.

## Setup

Requires `uv`.

```bash
uv sync
```

## Usage

```bash
uv run scan-crop scans/ cropped/
```

Each input file may produce one or more crops. Output names are `photo.jpg` for a single crop, or `photo_1.jpg`, `photo_2.jpg` when multiple photos are detected.

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `--min-area RATIO` | `0.05` | Ignore regions smaller than this fraction of the scan |
| `--padding RATIO` | `0` | Extra margin around each crop |
| `--no-deskew` | off | Skip perspective correction; use rectangular crops |
| `--no-trim` | off | Keep scanner margins instead of trimming them |
| `--trim-tolerance N` | `18` | Color distance used to detect scanner-bed white |
| `--jpeg-quality Q` | `95` | Output JPEG quality |

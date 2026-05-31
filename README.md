# Scanned Image Processor

Browser-first photo cropper for flatbed scanner images. Upload scanner-bed photos, inspect detected crop overlays, adjust quadrilateral corners, preview the corrected crop, and export JPEG crops locally from the browser.

The original Python CLI is preserved as a reference implementation under `packages/python-cli`.

## Workspace

```text
apps/web/              React + TypeScript + Tailwind browser app
packages/python-cli/   Existing OpenCV Python CLI and uv lockfile
```

## Web App

Requires `pnpm`.

```bash
pnpm install
pnpm --filter @scanned-image-processor/web build
pnpm --filter @scanned-image-processor/web test
```

For local development:

```bash
pnpm --filter @scanned-image-processor/web dev
```

The web app processes images client-side. JPG, PNG, and WebP are supported in v1. TIFF decoding and robust EXIF preservation are tracked as follow-up work.

## Current Web Features

- Multi-file upload and drag/drop.
- Worker-backed crop detection using browser canvas APIs.
- Active source overlay with selectable quadrilateral crops.
- Corner dragging, keyboard nudging, previous/next crop selection, zoom, and fit controls.
- Live preview rendered with the same crop renderer used for downloads.
- Per-crop trim toggle and trim amount.
- Download active source, selected sources, or all sources as JPEGs or a flat ZIP.
- Lightroom-style horizontal source strip with active source, batch selection, status, and remove controls.

## Python CLI

The CLI remains available from its subproject:

```bash
cd packages/python-cli
uv sync
uv run scan-crop scans/ cropped/
```

It uses OpenCV to detect photos, split stacked scans, deskew crops, trim scanner-bed borders, and write JPEG output.

## Repo Notes

- Source crop points are stored in original image coordinates.
- Crop point order is top-left, top-right, bottom-right, bottom-left.
- Preview and export share `apps/web/src/lib/canvasCrop.ts`.
- Complex geometry and filename behavior is covered by Vitest tests in `apps/web/src/test`.

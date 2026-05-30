# Product

## Register

product

## Users

People digitizing physical photo collections from flatbed scanner output. They are often working through batches of scans that contain one or more prints per scanner bed, and they need a fast way to check detection quality before exporting archival crops.

## Product Purpose

Scanned Image Processor turns scanner-bed images into corrected photo crops in the browser. The product keeps source photos local, detects likely prints, lets users correct quadrilateral corners, previews the exact crop output, and exports JPEG crops for one source, selected sources, or the whole batch.

## Brand Personality

Careful, utilitarian, trustworthy. The interface should feel like an editing bench: quiet enough for long sessions, precise enough for corner correction, and direct about errors or skipped files.

## Anti-references

Avoid marketing-page framing, decorative dashboard cards, playful illustration, glossy AI-tool gradients, and novelty controls. This is not a photo sharing app or a brand landing page; it should not hide the working image behind oversized copy or decorative chrome.

## Design Principles

- Keep the scan in charge: the source image and crop overlay are always the main workspace.
- Make batch state visible: active source, selected sources, crop count, processing, and errors should be readable at a glance.
- Prefer explicit control: detection, reset, deletion, and downloads are deliberate actions with recoverable feedback.
- Match preview and export: what users see in the preview must be the same transform used for downloads.
- Preserve local trust: source files stay in the browser and unsupported files are explained without drama.

## Accessibility & Inclusion

Target WCAG 2.1 AA contrast for text and controls. Support keyboard crop selection and handle nudging, visible focus states, reduced-motion preferences, and color-independent state labels for processing, errors, and crop counts.

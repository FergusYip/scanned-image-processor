"""Detect and crop photos from flatbed scanner images."""

from __future__ import annotations

import cv2
import numpy as np


def _order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def _four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    rect = _order_points(pts)
    tl, tr, br, bl = rect
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    width = max(width, 1)
    height = max(height, 1)

    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, matrix, (width, height))


def _contour_to_quad(contour: np.ndarray) -> np.ndarray:
    peri = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
    if len(approx) == 4:
        return approx.reshape(4, 2).astype(np.float32)
    box = cv2.boxPoints(cv2.minAreaRect(contour))
    return box.astype(np.float32)


def _pad_quad(
    quad: np.ndarray, padding_ratio: float, bounds: tuple[int, int]
) -> np.ndarray:
    center = quad.mean(axis=0)
    padded = center + (quad - center) * (1 + padding_ratio)
    padded[:, 0] = np.clip(padded[:, 0], 0, bounds[0] - 1)
    padded[:, 1] = np.clip(padded[:, 1], 0, bounds[1] - 1)
    return padded.astype(np.float32)


def _estimate_scanner_color(image: np.ndarray, sample: int = 40) -> np.ndarray:
    height, width = image.shape[:2]
    sample = max(8, min(sample, height // 8, width // 8))
    patches = [
        image[:sample, :sample],
        image[:sample, -sample:],
        image[-sample:, :sample],
        image[-sample:, -sample:],
    ]
    return np.median(np.concatenate([p.reshape(-1, 3) for p in patches], axis=0), axis=0)


def _scanner_background_mask(
    image: np.ndarray,
    scanner_color: np.ndarray,
    *,
    color_distance: float = 20.0,
) -> np.ndarray:
    diff = np.linalg.norm(image.astype(np.float32) - scanner_color, axis=2)
    return diff <= color_distance


def _build_photo_mask(
    image: np.ndarray,
    scanner_color: np.ndarray,
    *,
    color_distance: float = 20.0,
    close_size: tuple[int, int] = (51, 15),
) -> np.ndarray:
    is_photo = (~_scanner_background_mask(image, scanner_color, color_distance=color_distance)).astype(
        np.uint8
    ) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, close_size)
    closed = cv2.morphologyEx(is_photo, cv2.MORPH_CLOSE, kernel, iterations=2)
    opened = cv2.morphologyEx(
        closed,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11)),
        iterations=1,
    )
    return opened


def _split_mask_at_horizontal_gaps(
    mask: np.ndarray,
    scanner_bg: np.ndarray,
    *,
    gap_threshold: float = 0.75,
    min_gap_rows: int = 8,
) -> np.ndarray:
    coords = np.argwhere(mask > 0)
    if len(coords) == 0:
        return mask

    y0, x0 = coords.min(axis=0)
    y1, x1 = coords.max(axis=0)

    split_mask = mask.copy()
    gap_start: int | None = None
    for row in range(y0, y1 + 1):
        active = mask[row, x0 : x1 + 1] > 0
        if not active.any():
            fraction = 0.0
        else:
            fraction = float(scanner_bg[row, x0 : x1 + 1][active].mean())

        if fraction >= gap_threshold:
            if gap_start is None:
                gap_start = row
        elif gap_start is not None:
            if row - gap_start >= min_gap_rows:
                split_mask[gap_start:row] = 0
            gap_start = None

    if gap_start is not None and (y1 + 1) - gap_start >= min_gap_rows:
        split_mask[gap_start : y1 + 1] = 0

    return split_mask


def _is_plausible_photo(contour: np.ndarray, shape: tuple[int, ...]) -> bool:
    img_height, img_width = shape[:2]
    _, _, width, height = cv2.boundingRect(contour)
    area = cv2.contourArea(contour)
    bbox_area = width * height

    if bbox_area == 0 or area / bbox_area < 0.22:
        return False
    if min(width, height) < 180:
        return False
    if width >= 0.85 * img_width and height < 0.25 * img_height:
        return False
    if width * height > 0.92 * img_height * img_width:
        return False
    return True


def _contour_bbox(contour: np.ndarray) -> tuple[int, int, int, int]:
    x, y, box_w, box_h = cv2.boundingRect(contour)
    return x, y, x + box_w - 1, y + box_h - 1


def _bbox_overlap(
    a: tuple[int, int, int, int],
    b: tuple[int, int, int, int],
) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w = max(0, min(ax2, bx2) - max(ax1, bx1) + 1)
    inter_h = max(0, min(ay2, by2) - max(ay1, by1) + 1)
    inter = inter_w * inter_h
    if inter == 0:
        return 0.0
    area_a = max((ax2 - ax1 + 1) * (ay2 - ay1 + 1), 1)
    area_b = max((bx2 - bx1 + 1) * (by2 - by1 + 1), 1)
    return inter / min(area_a, area_b)


def _sort_contours(contours: list[np.ndarray]) -> list[np.ndarray]:
    return sorted(contours, key=lambda contour: cv2.boundingRect(contour)[1:])


def _mean_saturation(image: np.ndarray, contour: np.ndarray) -> float:
    mask = np.zeros(image.shape[:2], dtype=np.uint8)
    cv2.drawContours(mask, [contour], -1, 255, cv2.FILLED)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    values = hsv[:, :, 1][mask > 0]
    if values.size == 0:
        return 0.0
    return float(values.mean())


def _is_paper_page_contour(image: np.ndarray, contour: np.ndarray) -> bool:
    _, _, width, height = cv2.boundingRect(contour)
    img_height, img_width = image.shape[:2]
    area_ratio = (width * height) / (img_height * img_width)
    return area_ratio > 0.3 and _mean_saturation(image, contour) < 45


def _merge_photo_contours(image: np.ndarray, contours: list[np.ndarray]) -> list[np.ndarray]:
    """Drop overlapping detections, preferring tighter color-rich regions."""
    ranked = sorted(
        contours,
        key=lambda contour: (_mean_saturation(image, contour), cv2.contourArea(contour)),
        reverse=True,
    )
    kept: list[np.ndarray] = []
    for contour in ranked:
        if _is_paper_page_contour(image, contour):
            continue
        bbox = _contour_bbox(contour)
        overlaps = [
            other
            for other in kept
            if _bbox_overlap(bbox, _contour_bbox(other)) >= 0.45
        ]
        if overlaps:
            if all(cv2.contourArea(contour) <= cv2.contourArea(other) * 1.2 for other in overlaps):
                continue
            kept = [
                other
                for other in kept
                if _bbox_overlap(bbox, _contour_bbox(other)) < 0.45
            ]
        kept.append(contour)
    return _sort_contours(kept)


def _find_all_photo_contours(
    image: np.ndarray,
    scanner_color: np.ndarray,
    scanner_bg: np.ndarray,
    *,
    min_area_ratio: float,
) -> list[np.ndarray]:
    color = _find_color_photo_contours(image, scanner_bg, min_area_ratio=min_area_ratio)
    bed = _find_scanner_bed_contours(
        image,
        scanner_color,
        scanner_bg,
        min_area_ratio=min_area_ratio,
    )
    return _merge_photo_contours(image, color + bed)


def _bbox_from_scanner_background(
    scanner_bg: np.ndarray,
    roi: tuple[int, int, int, int],
    *,
    threshold: float = 0.88,
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = roi
    left = x1
    for x in range(x1, x2):
        if scanner_bg[y1:y2, x].mean() < threshold:
            left = x
            break

    right = x2 - 1
    for x in range(x2 - 1, x1, -1):
        if scanner_bg[y1:y2, x].mean() < threshold:
            right = x
            break

    top = y1
    for y in range(y1, y2):
        if scanner_bg[y, x1:x2].mean() < threshold:
            top = y
            break

    bottom = y2 - 1
    for y in range(y2 - 1, y1, -1):
        if scanner_bg[y, x1:x2].mean() < threshold:
            bottom = y
            break

    return left, top, right, bottom


def _bbox_to_contour(bbox: tuple[int, int, int, int]) -> np.ndarray:
    left, top, right, bottom = bbox
    return np.array(
        [[[left, top]], [[right, top]], [[right, bottom]], [[left, bottom]]],
        dtype=np.int32,
    )


def _expand_roi(
    bbox: tuple[int, int, int, int],
    shape: tuple[int, ...],
    *,
    margin: int = 40,
) -> tuple[int, int, int, int]:
    height, width = shape[:2]
    left, top, right, bottom = bbox
    return (
        max(0, left - margin),
        max(0, top - margin),
        min(width, right + 1 + margin),
        min(height, bottom + 1 + margin),
    )


def _color_saturation_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    _, sat_mask = cv2.threshold(hsv[:, :, 1], 35, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    sat_mask = cv2.morphologyEx(sat_mask, cv2.MORPH_CLOSE, kernel, iterations=3)
    return cv2.morphologyEx(sat_mask, cv2.MORPH_OPEN, kernel, iterations=2)


def _find_color_photo_contours(
    image: np.ndarray,
    scanner_bg: np.ndarray,
    *,
    min_area_ratio: float,
) -> list[np.ndarray]:
    sat_mask = _color_saturation_mask(image)
    sat_mask = _split_mask_at_horizontal_gaps(sat_mask, scanner_bg)

    height, width = image.shape[:2]
    min_area = height * width * min_area_ratio
    contours, _ = cv2.findContours(sat_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[tuple[float, np.ndarray]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        if not _is_plausible_photo(contour, image.shape):
            continue
        candidates.append((area, contour))

    candidates.sort(key=lambda item: item[0], reverse=True)
    return _sort_contours([contour for _, contour in candidates])


def _find_scanner_bed_contours(
    image: np.ndarray,
    scanner_color: np.ndarray,
    scanner_bg: np.ndarray,
    *,
    min_area_ratio: float,
) -> list[np.ndarray]:
    mask = _build_photo_mask(image, scanner_color)
    mask = _split_mask_at_horizontal_gaps(mask, scanner_bg)

    height, width = image.shape[:2]
    min_area = height * width * min_area_ratio
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    refined: list[np.ndarray] = []
    for contour in contours:
        if cv2.contourArea(contour) < min_area:
            continue
        if not _is_plausible_photo(contour, image.shape):
            continue

        x, y, box_w, box_h = cv2.boundingRect(contour)
        roi = _expand_roi((x, y, x + box_w - 1, y + box_h - 1), image.shape)
        bbox = _bbox_from_scanner_background(scanner_bg, roi)
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue
        refined.append(_bbox_to_contour(bbox))

    return _sort_contours(refined)


def _deskew_quad_in_bbox(
    image: np.ndarray,
    bbox: tuple[int, int, int, int],
    scanner_color: np.ndarray,
) -> np.ndarray:
    left, top, right, bottom = bbox
    roi = image[top : bottom + 1, left : right + 1]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1] > 25
    not_bg = ~_scanner_background_mask(roi, scanner_color)
    combined = (sat | not_bg).astype(np.uint8) * 255
    combined = cv2.morphologyEx(
        combined,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21)),
        iterations=2,
    )

    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return _contour_to_quad(_bbox_to_contour(bbox))

    contour = max(contours, key=cv2.contourArea)
    quad = _contour_to_quad(contour)
    quad[:, 0] += left
    quad[:, 1] += top

    bbox_area = max((right - left + 1) * (bottom - top + 1), 1)
    xs = quad[:, 0]
    ys = quad[:, 1]
    quad_area = max((xs.max() - xs.min()) * (ys.max() - ys.min()), 1)
    if abs(quad_area - bbox_area) / bbox_area > 0.2:
        return _contour_to_quad(_bbox_to_contour(bbox))

    return quad


def _refine_photo_bounds(
    image: np.ndarray,
    contour: np.ndarray,
    scanner_bg: np.ndarray,
    *,
    inset: int = 2,
) -> tuple[int, int, int, int]:
    x, y, box_w, box_h = cv2.boundingRect(contour)
    roi = _expand_roi((x, y, x + box_w - 1, y + box_h - 1), image.shape)
    left, top, right, bottom = _bbox_from_scanner_background(scanner_bg, roi)
    height, width = image.shape[:2]
    left = min(left + inset, right)
    top = min(top + inset, bottom)
    right = max(right - inset, left)
    bottom = max(bottom - inset, top)
    return (
        max(0, left),
        max(0, top),
        min(width - 1, right),
        min(height - 1, bottom),
    )


def _sample_border_color(image: np.ndarray, sample: int = 12) -> np.ndarray:
    height, width = image.shape[:2]
    sample = max(1, min(sample, height // 4, width // 4))
    patches = [
        image[:sample, :sample],
        image[:sample, -sample:],
        image[-sample:, :sample],
        image[-sample:, -sample:],
    ]
    return np.median(np.concatenate([p.reshape(-1, 3) for p in patches], axis=0), axis=0)


def _trim_white_borders(
    image: np.ndarray,
    scanner_color: np.ndarray | None = None,
    *,
    tolerance: int = 22,
    max_frac: float = 0.04,
    max_pixels: int = 35,
) -> np.ndarray:
    if image.size == 0:
        return image

    background = scanner_color if scanner_color is not None else _sample_border_color(image)
    trimmed = image

    for _ in range(4):
        diff = np.abs(trimmed.astype(np.int16) - background.astype(np.int16))
        is_background = np.all(diff <= tolerance, axis=2)
        gray = cv2.cvtColor(trimmed, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        limit_y = min(max(1, int(h * max_frac)), max_pixels)
        limit_x = min(max(1, int(w * max_frac)), max_pixels)

        def peel_line(values: np.ndarray, background_slice: np.ndarray) -> bool:
            bg_fraction = float(background_slice.mean())
            mean_gray = float(values.mean())
            return bg_fraction >= 0.82 or mean_gray >= 248

        top = 0
        while top < limit_y:
            if not peel_line(gray[top], is_background[top]):
                break
            top += 1

        bottom = h - 1
        removed = 0
        while removed < limit_y:
            if not peel_line(gray[bottom], is_background[bottom]):
                break
            bottom -= 1
            removed += 1

        left = 0
        while left < limit_x:
            if not peel_line(gray[:, left], is_background[:, left]):
                break
            left += 1

        right = w - 1
        removed = 0
        while removed < limit_x:
            if not peel_line(gray[:, right], is_background[:, right]):
                break
            right -= 1
            removed += 1

        if top == 0 and bottom == h - 1 and left == 0 and right == w - 1:
            break
        if top >= bottom or left >= right:
            break
        trimmed = trimmed[top : bottom + 1, left : right + 1]

    for _ in range(15):
        gray = cv2.cvtColor(trimmed, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        corners = (gray[0, 0], gray[0, w - 1], gray[h - 1, 0], gray[h - 1, w - 1])
        if max(corners) < 232:
            break
        top = 1 if corners[0] >= 232 or corners[1] >= 232 else 0
        bottom = 1 if corners[2] >= 232 or corners[3] >= 232 else 0
        left = 1 if corners[0] >= 232 or corners[2] >= 232 else 0
        right = 1 if corners[1] >= 232 or corners[3] >= 232 else 0
        if top + bottom + left + right == 0:
            break
        if h - top - bottom <= 0 or w - left - right <= 0:
            break
        trimmed = trimmed[top : h - bottom, left : w - right]

    return trimmed


def detect_photos(
    image: np.ndarray,
    *,
    min_area_ratio: float = 0.05,
    padding_ratio: float = 0.0,
    deskew: bool = True,
    trim_borders: bool = True,
    trim_tolerance: int = 18,
) -> list[np.ndarray]:
    """Return cropped photo regions detected in a scanner image."""
    if image.ndim != 3:
        raise ValueError("Expected a color image (H x W x 3)")

    height, width = image.shape[:2]
    scanner_color = _estimate_scanner_color(image)
    scanner_bg = _scanner_background_mask(image, scanner_color)

    contours = _find_all_photo_contours(
        image,
        scanner_color,
        scanner_bg,
        min_area_ratio=min_area_ratio,
    )

    crops: list[np.ndarray] = []
    for contour in contours:
        bbox = _refine_photo_bounds(image, contour, scanner_bg)
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue

        if deskew:
            quad = _deskew_quad_in_bbox(image, bbox, scanner_color)
            if padding_ratio > 0:
                quad = _pad_quad(quad, padding_ratio, (width, height))
            cropped = _four_point_transform(image, quad)
        else:
            left, top, right, bottom = bbox
            cropped = image[top : bottom + 1, left : right + 1]

        if cropped.size == 0:
            continue
        if trim_borders:
            cropped = _trim_white_borders(cropped, scanner_color, tolerance=trim_tolerance)
        crops.append(cropped)

    return crops

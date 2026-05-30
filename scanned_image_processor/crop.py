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


def _is_border_contour(contour: np.ndarray, shape: tuple[int, ...]) -> bool:
    height, width = shape[:2]
    x, y, box_w, box_h = cv2.boundingRect(contour)
    img_area = height * width
    contour_area = cv2.contourArea(contour)

    if contour_area > 0.95 * img_area:
        return True

    margin_x = width * 0.02
    margin_y = height * 0.02
    touches_border = (
        x <= margin_x
        and y <= margin_y
        and (x + box_w) >= (width - margin_x)
        and (y + box_h) >= (height - margin_y)
    )
    return touches_border


def _find_contours_otsu(gray: np.ndarray) -> list[np.ndarray]:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thresh = cv2.bitwise_not(thresh)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return list(contours)


def _find_contours_canny(gray: np.ndarray) -> list[np.ndarray]:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=3)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return list(contours)


def _find_contours(gray: np.ndarray) -> list[np.ndarray]:
    return _find_contours_otsu(gray) or _find_contours_canny(gray)


def _filter_contours(
    contours: list[np.ndarray],
    shape: tuple[int, ...],
    min_area_ratio: float,
) -> list[np.ndarray]:
    height, width = shape[:2]
    min_area = height * width * min_area_ratio

    candidates: list[tuple[float, np.ndarray]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        if _is_border_contour(contour, shape):
            continue
        candidates.append((area, contour))

    candidates.sort(key=lambda item: item[0], reverse=True)
    return [contour for _, contour in candidates]


def _sample_border_color(image: np.ndarray, sample: int = 12) -> np.ndarray:
    """Estimate scanner-bed color from the image corners."""
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
    *,
    tolerance: int = 18,
    edge_coverage: float = 0.985,
    search_frac: float = 0.12,
    content_luminance: int = 200,
    content_edge_density: float = 60.0,
) -> np.ndarray:
    """Remove scanner-bed and photo-paper margins from a cropped image."""
    if image.size == 0:
        return image

    image = _peel_border_lines(image, search_frac=search_frac)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 30, 100)
    height, width = gray.shape
    search_y = max(1, int(height * search_frac))
    search_x = max(1, int(width * search_frac))

    def is_content_line(gray_line: np.ndarray, edge_line: np.ndarray) -> bool:
        return (
            float(gray_line.mean()) < content_luminance
            and float(edge_line.mean()) < content_edge_density
        )

    top = 0
    for y in range(search_y):
        if is_content_line(gray[y], edges[y]):
            top = y
            break

    bottom = height - 1
    for offset in range(search_y):
        y = height - 1 - offset
        if is_content_line(gray[y], edges[y]):
            bottom = y
            break

    left = 0
    for x in range(search_x):
        if is_content_line(gray[:, x], edges[:, x]):
            left = x
            break

    right = width - 1
    for offset in range(search_x):
        x = width - 1 - offset
        if is_content_line(gray[:, x], edges[:, x]):
            right = x
            break

    if top >= bottom or left >= right:
        return _trim_uniform_white(
            image,
            tolerance=tolerance,
            edge_coverage=edge_coverage,
            search_frac=search_frac,
        )

    trimmed = image[top : bottom + 1, left : right + 1]
    return _trim_white_corners(_strip_bright_edges(trimmed))


def _peel_border_lines(image: np.ndarray, *, search_frac: float) -> np.ndarray:
    """Remove light border and transition lines before locating stable content."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 30, 100)
    height, width = gray.shape
    search_y = max(1, int(height * search_frac))
    search_x = max(1, int(width * search_frac))

    def is_border_line(gray_line: np.ndarray, edge_line: np.ndarray) -> bool:
        mean_gray = float(gray_line.mean())
        mean_edges = float(edge_line.mean())
        return mean_gray >= 220 or (mean_gray >= 165 and mean_edges >= 35)

    top = 0
    for y in range(search_y):
        if is_border_line(gray[y], edges[y]):
            top = y + 1
            continue
        break

    bottom = height - 1
    for offset in range(search_y):
        y = height - 1 - offset
        if is_border_line(gray[y], edges[y]):
            bottom = y - 1
            continue
        break

    left = 0
    for x in range(search_x):
        if is_border_line(gray[:, x], edges[:, x]):
            left = x + 1
            continue
        break

    right = width - 1
    for offset in range(search_x):
        x = width - 1 - offset
        if is_border_line(gray[:, x], edges[:, x]):
            right = x - 1
            continue
        break

    if top >= bottom or left >= right:
        return image

    return image[top : bottom + 1, left : right + 1]


def _strip_bright_edges(
    image: np.ndarray,
    *,
    luminance: int = 232,
    coverage: float = 0.82,
    max_frac: float = 0.04,
) -> np.ndarray:
    """Remove any remaining near-white rows/columns at the image edge."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    max_y = max(1, int(height * max_frac))
    max_x = max(1, int(width * max_frac))

    top = 0
    while top < max_y and gray[top].mean() >= luminance:
        top += 1

    bottom = height - 1
    while (height - 1 - bottom) < max_y and gray[bottom].mean() >= luminance:
        bottom -= 1

    left = 0
    while left < max_x and (gray[:, left] >= luminance).mean() >= coverage:
        left += 1

    right = width - 1
    while (width - 1 - right) < max_x and (gray[:, right] >= luminance).mean() >= coverage:
        right -= 1

    if top >= bottom or left >= right:
        return image

    return image[top : bottom + 1, left : right + 1]


def _trim_white_corners(image: np.ndarray, *, luminance: int = 215, max_iter: int = 30) -> np.ndarray:
    """Iteratively shrink the crop while any corner is still near-white."""
    trimmed = image
    for _ in range(max_iter):
        gray = cv2.cvtColor(trimmed, cv2.COLOR_BGR2GRAY)
        height, width = gray.shape
        corners = (gray[0, 0], gray[0, width - 1], gray[height - 1, 0], gray[height - 1, width - 1])
        if max(corners) < luminance:
            return trimmed

        top = 1 if corners[0] >= luminance or corners[1] >= luminance else 0
        bottom = 1 if corners[2] >= luminance or corners[3] >= luminance else 0
        left = 1 if corners[0] >= luminance or corners[2] >= luminance else 0
        right = 1 if corners[1] >= luminance or corners[3] >= luminance else 0
        if top + bottom + left + right == 0:
            return trimmed

        next_height = height - top - bottom
        next_width = width - left - right
        if next_height <= 0 or next_width <= 0:
            return trimmed

        trimmed = trimmed[top : height - bottom, left : width - right]

    return trimmed


def _trim_uniform_white(
    image: np.ndarray,
    *,
    tolerance: int,
    edge_coverage: float,
    search_frac: float,
) -> np.ndarray:
    """Fallback trim for scans with a uniform white scanner-bed border."""
    background = _sample_border_color(image)
    diff = np.abs(image.astype(np.int16) - background.astype(np.int16))
    is_background = np.all(diff <= tolerance, axis=2)

    height, width = is_background.shape
    max_top = max(1, int(height * search_frac))
    max_side = max(1, int(width * search_frac))

    top = 0
    while top < max_top and is_background[top, :].mean() >= edge_coverage:
        top += 1

    bottom = height - 1
    while (height - 1 - bottom) < max_top and is_background[bottom, :].mean() >= edge_coverage:
        bottom -= 1

    left = 0
    while left < max_side and is_background[:, left].mean() >= edge_coverage:
        left += 1

    right = width - 1
    while (width - 1 - right) < max_side and is_background[:, right].mean() >= edge_coverage:
        right -= 1

    if top >= bottom or left >= right:
        return _trim_white_corners(_strip_bright_edges(image))

    trimmed = image[top : bottom + 1, left : right + 1]
    return _trim_white_corners(_strip_bright_edges(trimmed))


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
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    contours = _filter_contours(_find_contours(gray), image.shape, min_area_ratio)

    crops: list[np.ndarray] = []
    for contour in contours:
        if deskew:
            quad = _contour_to_quad(contour)
            if padding_ratio > 0:
                quad = _pad_quad(quad, padding_ratio, (width, height))
            cropped = _four_point_transform(image, quad)
        else:
            x, y, box_w, box_h = cv2.boundingRect(contour)
            pad_x = int(box_w * padding_ratio)
            pad_y = int(box_h * padding_ratio)
            x1 = max(0, x - pad_x)
            y1 = max(0, y - pad_y)
            x2 = min(width, x + box_w + pad_x)
            y2 = min(height, y + box_h + pad_y)
            cropped = image[y1:y2, x1:x2]

        if cropped.size == 0:
            continue
        if trim_borders:
            cropped = _trim_white_borders(cropped, tolerance=trim_tolerance)
        crops.append(cropped)

    return crops

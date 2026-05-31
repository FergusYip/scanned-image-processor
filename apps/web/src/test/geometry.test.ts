import { describe, expect, it } from "vitest";
import { cropOutputSize, defaultQuad, isValidQuad, moveQuadPoint, nudgeQuadPoint } from "../lib/geometry";
import type { Quad } from "../types";

describe("geometry", () => {
  it("rejects self-crossing quadrilaterals", () => {
    const crossed: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ];
    expect(isValidQuad(crossed)).toBe(false);
  });

  it("keeps invalid point moves from replacing the crop", () => {
    const quad = defaultQuad(400, 300);
    const moved = moveQuadPoint(quad, 1, { x: 40, y: 260 }, 400, 300);
    expect(moved).toEqual(quad);
  });

  it("nudges handles in image coordinates and clamps to bounds", () => {
    const quad = defaultQuad(400, 300);
    const moved = nudgeQuadPoint(quad, 0, -500, -500, 400, 300);
    expect(moved[0]).toEqual({ x: 0, y: 0 });
  });

  it("computes perspective output dimensions from the longest opposing sides", () => {
    const size = cropOutputSize([
      { x: 0, y: 0 },
      { x: 120, y: 10 },
      { x: 100, y: 80 },
      { x: 10, y: 90 },
    ]);
    expect(size.width).toBeGreaterThanOrEqual(90);
    expect(size.height).toBeGreaterThanOrEqual(70);
  });
});

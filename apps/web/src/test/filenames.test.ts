import { describe, expect, it } from "vitest";
import { cropFileName, uniqueZipName } from "../lib/filenames";

describe("filenames", () => {
  it("keeps a single crop at the source stem", () => {
    expect(cropFileName("scan001.png", 1, 1)).toBe("scan001.jpg");
  });

  it("adds crop indexes for multi-crop sources", () => {
    expect(cropFileName("scan 001.webp", 2, 3)).toBe("scan_001_2.jpg");
  });

  it("deduplicates flat zip names", () => {
    const used = new Set<string>();
    expect(uniqueZipName("scan.jpg", used)).toBe("scan.jpg");
    expect(uniqueZipName("scan.jpg", used)).toBe("scan_2.jpg");
    expect(uniqueZipName("scan.jpg", used)).toBe("scan_3.jpg");
  });
});

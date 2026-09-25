import { describe, expect, it } from "vitest";
import { applyFilters, DEFAULT_FILTERS } from "../store/search";
import { bytes, displayPath, parentPath } from "./format";
import type { ResultGroup } from "./types";

const group = (over: Partial<ResultGroup>): ResultGroup => ({
  id: "g",
  username: "u",
  directory: "d",
  folder_name: "Album",
  parent_name: null,
  has_free_slot: true,
  upload_speed: 1,
  queue_length: 0,
  files: [{ filename: "d\\1.flac", name: "1.flac", size: 1, ext: "flac", bitrate: null, bit_depth: 16, sample_rate: 44100, length: 1, is_audio: true, tier: 1, quality: "FLAC", locked: false }],
  tier: 1,
  tier_name: "lossless",
  quality: "FLAC",
  mixed: false,
  audio_count: 1,
  total_size: 1,
  audio_size: 1,
  locked: false,
  in_library: null,
  ...over,
});

describe("search filters", () => {
  it("hides locked folders by default and low quality on request", () => {
    const gs = [group({ id: "a" }), group({ id: "b", locked: true }), group({ id: "c", tier: 3 })];
    expect(applyFilters(gs, DEFAULT_FILTERS).map((g) => g.id)).toEqual(["a", "c"]);
    expect(applyFilters(gs, { ...DEFAULT_FILTERS, minTier: 2 }).map((g) => g.id)).toEqual(["a"]);
    expect(applyFilters(gs, { ...DEFAULT_FILTERS, format: "lossless", hideLocked: false }).map((g) => g.id)).toEqual(["a", "b"]);
  });
  it("can hide albums already in the library", () => {
    const gs = [group({ id: "a", in_library: "full" }), group({ id: "b", in_library: "partial" })];
    expect(applyFilters(gs, { ...DEFAULT_FILTERS, hideInLibrary: true }).map((g) => g.id)).toEqual(["b"]);
  });
});

describe("format helpers", () => {
  it("formats sizes and paths", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(parentPath("library/A/B")).toBe("library/A");
    expect(displayPath("library/A/B")).toBe("Library / A / B");
  });
});

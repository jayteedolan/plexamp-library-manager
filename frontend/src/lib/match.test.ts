import { describe, expect, it } from "vitest";
import { buildQuery, fileTitle, matchGroup, normTitle, simplerQuery, sortByMatch, type MatchTarget } from "./match";
import type { ResultFile, ResultGroup } from "./types";

const file = (filename: string, is_audio = true): ResultFile => ({
  filename,
  name: filename.split("\\").pop()!,
  size: 1,
  ext: "flac",
  bitrate: null,
  bit_depth: 16,
  sample_rate: 44100,
  length: 100,
  is_audio,
  tier: is_audio ? 1 : null,
  quality: is_audio ? "FLAC" : null,
  locked: false,
});

const group = (id: string, names: string[]): ResultGroup => ({
  id,
  username: "u",
  directory: "d",
  folder_name: "d",
  parent_name: null,
  has_free_slot: true,
  upload_speed: 1,
  queue_length: 0,
  files: names.map((n) => file(`Music\\d\\${n}`, !n.endsWith(".jpg"))),
  tier: 1,
  tier_name: "lossless",
  quality: "FLAC",
  mixed: false,
  audio_count: names.length,
  total_size: 1,
  audio_size: 1,
  locked: false,
  in_library: null,
});

const album: MatchTarget = {
  kind: "album",
  artists: ["brakence"],
  album: "hypochondriac (Deluxe Edition)",
  tracks: ["bugging!", "caffeine", "venus fly trap", "teeth - 2023 Remaster", "intellectual greed (feat. Someone)"],
};

describe("normalising titles", () => {
  it("drops feat., remaster and edition noise", () => {
    expect(normTitle("teeth - 2023 Remaster")).toBe("teeth");
    expect(normTitle("intellectual greed (feat. Someone)")).toBe("intellectual greed");
    expect(normTitle("Sigur Rós & Friends")).toBe("sigur ros and friends");
  });

  it("extracts the title from Soulseek file names", () => {
    expect(fileTitle("Music\\brakence\\01 - bugging!.flac")).toBe("bugging");
    expect(fileTitle("03. brakence - venus fly trap.flac", ["brakence"])).toBe("venus fly trap");
    expect(fileTitle("1-04 teeth.mp3")).toBe("teeth");
    expect(fileTitle("A2 caffeine.flac")).toBe("caffeine");
  });
});

describe("matching result folders against a Spotify release", () => {
  it("counts matching tracks and ignores non-audio files", () => {
    const g = group("g", ["01. brakence - bugging!.flac", "02. brakence - caffeine.flac", "cover.jpg"]);
    const m = matchGroup(g, album);
    expect([m.matched, m.total, m.level]).toEqual([2, 5, "partial"]);
  });

  it("treats a complete folder as a full match", () => {
    const g = group("g", ["01 bugging!.flac", "02 caffeine.flac", "03 venus fly trap.flac", "04 teeth.flac", "05 intellectual greed.flac"]);
    expect(matchGroup(g, album).level).toBe("full");
  });

  it("finds the one file for a single-song target", () => {
    const song: MatchTarget = { kind: "track", artists: ["brakence"], album: "hypochondriac", tracks: ["caffeine"] };
    const g = group("g", ["01 bugging!.flac", "02 caffeine.flac"]);
    const m = matchGroup(g, song);
    expect(m.level).toBe("full");
    expect(m.files).toEqual(["Music\\d\\02 caffeine.flac"]);
  });

  it("sorts full matches first, otherwise keeping the quality order", () => {
    const a = group("a", ["01 bugging!.flac"]);
    const b = group("b", ["01 bugging!.flac", "02 caffeine.flac", "03 venus fly trap.flac", "04 teeth.flac", "05 intellectual greed.flac"]);
    const c = group("c", ["x.flac"]);
    const matches = Object.fromEntries([a, b, c].map((g) => [g.id, matchGroup(g, album)]));
    expect(sortByMatch([a, b, c], matches).map((g) => g.id)).toEqual(["b", "a", "c"]);
  });
});

describe("building Soulseek queries", () => {
  it("uses the artist and the cleaned album title", () => {
    expect(buildQuery(album)).toBe("brakence hypochondriac");
  });

  it("offers a looser retry without the artist", () => {
    expect(simplerQuery(album)).toBe("hypochondriac");
    const short: MatchTarget = { kind: "track", artists: ["ABBA"], album: "x", tracks: ["SOS"] };
    expect(buildQuery(short)).toBe("abba sos");
    expect(simplerQuery(short)).toBe(null); // too short on its own, and the same query otherwise
  });
});

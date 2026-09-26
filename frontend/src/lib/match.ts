import type { ResultGroup } from "./types";

/** A Spotify release or song that a Soulseek search is trying to find. */
export interface MatchTarget {
  kind: "album" | "track";
  artists: string[];
  album: string;
  /** Track titles to look for: the album's tracklist, or just the one song. */
  tracks: string[];
}

export interface GroupMatch {
  matched: number;
  total: number;
  level: "full" | "partial" | "none";
  /** Remote filenames of the matching audio files. */
  files: string[];
}

// Version/credit text that Spotify adds but file names often leave out, or vice versa.
const NOISE_BRACKETS = /[([][^)\]]*\b(feat|ft|with|remaster(ed)?|deluxe|edition|expanded|anniversary|bonus|version|mono|stereo)\b[^)\]]*[)\]]/gi;
const NOISE_SUFFIX = /\s+-\s+(.*\bremaster(ed)?\b.*|.*\bversion\b.*|\d{4}\s+mix|live.*|mono|stereo)$/i;
const FEAT_TAIL = /\s+(feat\.?|ft\.?|featuring)\s+.*$/i;

function stripAccents(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Lowercase, accent-free, punctuation-free words, without feat./remaster/edition noise. */
export function normTitle(s: string): string {
  let t = stripAccents(s).replace(NOISE_BRACKETS, " ").replace(NOISE_SUFFIX, "").replace(FEAT_TAIL, "");
  t = t.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ");
  return t.trim().replace(/\s+/g, " ");
}

/** Title part of a Soulseek file name: drops folders, extension, track numbers and a leading artist. */
export function fileTitle(filename: string, artists: string[] = []): string {
  let name = filename.split(/[\\/]/).pop() ?? filename;
  name = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  // "01 ", "01. ", "01 - ", "1-01 ", "A1 ", "(01) "
  name = name.replace(/^\(?(?:\d{1,2}[-.])?\d{1,3}\)?(?:\s*[-.)_]\s*|\s+)/, "").replace(/^[A-D]\d{1,2}\s+/, "");
  let t = normTitle(name);
  for (const a of artists) {
    const na = normTitle(a);
    if (na && t.startsWith(na + " ")) t = t.slice(na.length).trim();
  }
  return t;
}

function titlesMatch(fileT: string, trackT: string): boolean {
  if (!fileT || !trackT) return false;
  if (fileT === trackT) return true;
  // One side may still carry extra words, e.g. "title bonus track" or "artist title".
  const shorter = fileT.length < trackT.length ? fileT : trackT;
  const longer = shorter === fileT ? trackT : fileT;
  return shorter.length >= 4 && (` ${longer} `).includes(` ${shorter} `);
}

export function matchGroup(group: ResultGroup, target: MatchTarget): GroupMatch {
  const audio = group.files.filter((f) => f.is_audio);
  const fileTitles = audio.map((f) => ({ filename: f.filename, title: fileTitle(f.name, target.artists) }));
  const used = new Set<string>();
  let matched = 0;
  for (const track of target.tracks) {
    const t = normTitle(track);
    const hit = fileTitles.find((f) => !used.has(f.filename) && titlesMatch(f.title, t));
    if (hit) {
      used.add(hit.filename);
      matched++;
    }
  }
  const total = target.tracks.length;
  const level = total && matched / total >= 0.9 ? "full" : matched > 0 ? "partial" : "none";
  return { matched, total, level, files: [...used] };
}

const LEVEL_RANK = { full: 0, partial: 1, none: 2 } as const;

/** Stable sort: match level first; groups arrive already ordered by quality, then speed. */
export function sortByMatch(groups: ResultGroup[], matches: Record<string, GroupMatch>): ResultGroup[] {
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const la = LEVEL_RANK[matches[a.g.id]?.level ?? "none"];
      const lb = LEVEL_RANK[matches[b.g.id]?.level ?? "none"];
      return la - lb || a.i - b.i;
    })
    .map((x) => x.g);
}

function words(s: string): string[] {
  return normTitle(s).split(" ").filter(Boolean);
}

function limit(ws: string[], n = 6): string {
  return ws.slice(0, n).join(" ");
}

/** Soulseek matches every word, so keep queries short and free of edition/feature noise. */
export function buildQuery(target: MatchTarget): string {
  const artist = words(target.artists[0] ?? "");
  const title = words(target.kind === "album" ? target.album : target.tracks[0] ?? "");
  return limit([...artist.slice(0, 3), ...title]);
}

/** A looser retry when the first search finds nothing: just the title if it's distinctive enough. */
export function simplerQuery(target: MatchTarget): string | null {
  const title = words(target.kind === "album" ? target.album : target.tracks[0] ?? "");
  const artist = words(target.artists[0] ?? "");
  const candidate = title.join(" ").length >= 5 ? limit(title, 4) : limit([...artist.slice(0, 1), ...title], 4);
  return candidate && candidate !== buildQuery(target) ? candidate : null;
}

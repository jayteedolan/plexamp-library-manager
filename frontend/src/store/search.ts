import { create } from "zustand";
import { api } from "../lib/api";
import { buildQuery, type MatchTarget } from "../lib/match";
import type { ResultGroup, SearchResults } from "../lib/types";

export interface Filters {
  format: "all" | "lossless" | "mp3";
  minTier: 1 | 2 | 3 | 4;
  hideLocked: boolean;
  freeSlotOnly: boolean;
  hideInLibrary: boolean;
}

interface SearchState {
  /** Which tab of the Search page is showing: Soulseek results or the Spotify catalog. */
  mode: "soulseek" | "spotify";
  source: string; // download provider used for searches
  query: string;
  catalogQuery: string;
  searchId: string | null;
  results: SearchResults | null;
  running: boolean;
  startedAt: number | null;
  filters: Filters;
  expanded: Record<string, boolean>;
  selection: Record<string, string[]>; // group id -> selected remote filenames
  browsed: Record<string, ResultGroup>; // group id -> full folder listing
  /** The Spotify release being looked for on Soulseek, if any. */
  target: MatchTarget | null;
  fallbackTried: boolean;
  set: (patch: Partial<SearchState>) => void;
  setFilters: (patch: Partial<Filters>) => void;
  reset: (query: string, searchId: string) => void;
}

export const DEFAULT_FILTERS: Filters = {
  format: "all",
  minTier: 4,
  hideLocked: true,
  freeSlotOnly: false,
  hideInLibrary: false,
};

/** Kept outside the page so results survive navigating to Downloads and back. */
export const useSearchStore = create<SearchState>((set) => ({
  mode: "soulseek",
  source: "soulseek",
  query: "",
  catalogQuery: "",
  searchId: null,
  results: null,
  running: false,
  startedAt: null,
  filters: DEFAULT_FILTERS,
  expanded: {},
  selection: {},
  browsed: {},
  target: null,
  fallbackTried: false,
  set: (patch) => set(patch),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  reset: (query, searchId) =>
    set({ query, searchId, results: null, running: true, startedAt: Date.now(), expanded: {}, selection: {}, browsed: {} }),
}));

/** Start a Soulseek search. The server paces search starts, so this may take a few seconds to return. */
export async function startSoulseekSearch(query: string): Promise<void> {
  const { source, reset } = useSearchStore.getState();
  const r = await api.post<{ id: string }>("/api/search", { query, source });
  reset(query, r.id);
}

/** Look for a Spotify album or song on Soulseek, matching results against its tracklist. */
export async function findOnSoulseek(target: MatchTarget): Promise<void> {
  useSearchStore.getState().set({ mode: "soulseek", target, fallbackTried: false });
  await startSoulseekSearch(buildQuery(target));
}

export function applyFilters(groups: ResultGroup[], f: Filters): ResultGroup[] {
  return groups.filter((g) => {
    if (f.hideLocked && g.locked) return false;
    if (f.freeSlotOnly && !g.has_free_slot) return false;
    if (f.hideInLibrary && g.in_library === "full") return false;
    if (g.tier > f.minTier) return false;
    if (f.format === "lossless" && g.tier !== 1) return false;
    if (f.format === "mp3" && !g.files.some((x) => x.is_audio && x.ext === "mp3")) return false;
    return true;
  });
}

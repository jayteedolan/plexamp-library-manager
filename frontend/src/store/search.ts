import { create } from "zustand";
import type { ResultGroup, SearchResults } from "../lib/types";

export interface Filters {
  format: "all" | "lossless" | "mp3";
  minTier: 1 | 2 | 3 | 4;
  hideLocked: boolean;
  freeSlotOnly: boolean;
  hideInLibrary: boolean;
}

interface SearchState {
  source: string;
  query: string;
  searchId: string | null;
  results: SearchResults | null;
  running: boolean;
  startedAt: number | null;
  filters: Filters;
  expanded: Record<string, boolean>;
  selection: Record<string, string[]>; // group id -> selected remote filenames
  browsed: Record<string, ResultGroup>; // group id -> full folder listing
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
  source: "soulseek",
  query: "",
  searchId: null,
  results: null,
  running: false,
  startedAt: null,
  filters: DEFAULT_FILTERS,
  expanded: {},
  selection: {},
  browsed: {},
  set: (patch) => set(patch),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  reset: (query, searchId) =>
    set({ query, searchId, results: null, running: true, startedAt: Date.now(), expanded: {}, selection: {}, browsed: {} }),
}));

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

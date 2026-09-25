import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDot,
  Download,
  FolderSearch,
  Gauge,
  Library as LibraryIcon,
  ListMusic,
  Lock,
  Search as SearchIcon,
  Square,
  User,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, PageHeader, Spinner, cx, inputClass } from "../components/ui";
import { api } from "../lib/api";
import { bytes, duration, speed } from "../lib/format";
import type { Job, ResultGroup, SearchResults, SearchSource } from "../lib/types";
import { confirm } from "../store/dialogs";
import { DEFAULT_FILTERS, applyFilters, useSearchStore } from "../store/search";
import { toast } from "../store/toasts";

const TIER_TONE = { 1: "tier1", 2: "tier2", 3: "tier3", 4: "tier4" } as const;
const MAX_SEARCH_MS = 45000;

export function QualityBadge({ tier, label }: { tier: number; label: string }) {
  const tone = TIER_TONE[tier as 1 | 2 | 3 | 4] ?? "tier4";
  return (
    <Badge tone={tone} title={tier === 1 ? "Lossless" : tier === 2 ? "High quality lossy" : tier === 3 ? "Low bitrate" : "Unknown bitrate"}>
      {label}
      {tier === 3 && <AlertTriangle className="size-3" />}
    </Badge>
  );
}

export function SearchPage() {
  const s = useSearchStore();
  const [text, setText] = useState(s.query);
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.get<SearchSource[]>("/api/search/sources"), staleTime: 30000 });
  const current = sources.data?.find((x) => x.key === s.source);
  const pollRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Poll results while the search is running; results stream in as users respond.
  useEffect(() => {
    if (!s.searchId || !s.running) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.get<SearchResults>(`/api/search/${s.searchId}?source=${s.source}`);
        if (cancelled) return;
        const timedOut = Date.now() - (useSearchStore.getState().startedAt ?? 0) > MAX_SEARCH_MS;
        useSearchStore.getState().set({ results: r, running: !r.complete && !timedOut });
        if (!r.complete && !timedOut) pollRef.current = setTimeout(tick, 1500);
      } catch (e) {
        if (cancelled) return;
        useSearchStore.getState().set({ running: false });
        toast.error(e);
      }
    };
    pollRef.current = setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      clearTimeout(pollRef.current);
    };
  }, [s.searchId, s.running, s.source]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q.length < 2) return;
    try {
      const r = await api.post<{ id: string }>("/api/search", { query: q, source: s.source });
      s.reset(q, r.id);
    } catch (err) {
      toast.error(err);
    }
  };

  const stop = async () => {
    s.set({ running: false });
    if (s.searchId) api.post(`/api/search/${s.searchId}/stop?source=${s.source}`).catch(() => {});
  };

  const groups = useMemo(() => applyFilters(s.results?.groups ?? [], s.filters), [s.results, s.filters]);
  const hiddenCount = (s.results?.groups.length ?? 0) - groups.length;

  return (
    <div>
      <PageHeader title="Search" subtitle="Find albums and tracks, ranked by quality first, then speed." />

      {sources.data && sources.data.length > 1 && (
        <div className="mb-3 flex gap-1 rounded-xl bg-surface-2 p-1" role="tablist" aria-label="Search source">
          {sources.data.map((src) => (
            <button
              key={src.key}
              role="tab"
              aria-selected={s.source === src.key}
              onClick={() => s.set({ source: src.key, results: null, searchId: null, running: false })}
              className={cx("flex-1 rounded-lg py-2 text-sm", s.source === src.key ? "bg-surface font-semibold shadow" : "text-muted")}
            >
              {src.label}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={start} className="mb-3 flex gap-2">
        <label className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            className={cx(inputClass, "h-11 pl-9 text-base")}
            placeholder="Artist, album or track"
            value={text}
            onChange={(e) => setText(e.target.value)}
            enterKeyHint="search"
            autoCapitalize="none"
          />
        </label>
        {s.running ? (
          <Button type="button" className="h-11" onClick={stop} icon={<Square className="size-4" />}>
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="primary" className="h-11" disabled={text.trim().length < 2}>
            Search
          </Button>
        )}
      </form>

      {current && !current.ok && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{current.message}</span>
        </div>
      )}

      <FiltersBar />

      {s.searchId && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted">
          {s.running && <Spinner className="size-4" />}
          <span>
            {s.running ? "Searching…" : "Search finished."} {s.results?.response_count ?? 0} user{s.results?.response_count === 1 ? "" : "s"} responded ·{" "}
            {groups.length} folder{groups.length === 1 ? "" : "s"} shown
            {hiddenCount > 0 && ` (${hiddenCount} hidden by filters)`}
          </span>
        </div>
      )}

      {!s.searchId ? (
        <EmptyState icon={<FolderSearch />} title="Search Soulseek">
          Results are grouped by user and folder. Lossless (FLAC) ranks first, then MP3 320/V0, then lower bitrates — within each, users with a free
          slot and fast uploads come first.
        </EmptyState>
      ) : groups.length === 0 && !s.running ? (
        <EmptyState icon={<FolderSearch />} title="No results">
          {hiddenCount > 0 ? "Everything was hidden by your filters — try loosening them." : "Try a shorter query, or just the album name."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <ResultCard key={g.id} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function FiltersBar() {
  const { filters, setFilters, set } = useSearchStore();
  const chip = (active: boolean) =>
    cx("h-8 rounded-full border px-3 text-xs whitespace-nowrap", active ? "border-accent bg-accent/15 text-accent" : "border-border text-muted");
  return (
    <div className="mb-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
      {(
        [
          ["all", "All formats"],
          ["lossless", "Lossless only"],
          ["mp3", "MP3"],
        ] as const
      ).map(([v, l]) => (
        <button key={v} className={chip(filters.format === v)} onClick={() => setFilters({ format: v })}>
          {l}
        </button>
      ))}
      <button className={chip(filters.minTier === 2)} onClick={() => setFilters({ minTier: filters.minTier === 2 ? 4 : 2 })}>
        Hide low quality
      </button>
      <button className={chip(filters.freeSlotOnly)} onClick={() => setFilters({ freeSlotOnly: !filters.freeSlotOnly })}>
        Free slot only
      </button>
      <button className={chip(filters.hideInLibrary)} onClick={() => setFilters({ hideInLibrary: !filters.hideInLibrary })}>
        Hide albums I have
      </button>
      <button className={chip(!filters.hideLocked)} onClick={() => setFilters({ hideLocked: !filters.hideLocked })}>
        Show locked
      </button>
      {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
        <button className="h-8 px-2 text-xs text-muted underline" onClick={() => set({ filters: DEFAULT_FILTERS })}>
          Reset
        </button>
      )}
    </div>
  );
}

function ResultCard({ group: base }: { group: ResultGroup }) {
  const { expanded, selection, browsed, set, source } = useSearchStore();
  const group = browsed[base.id] ? { ...base, files: browsed[base.id].files } : base;
  const open = !!expanded[base.id];
  const downloadable = group.files.filter((f) => !f.locked);
  const selected = new Set(selection[base.id] ?? downloadable.filter((f) => f.is_audio).map((f) => f.filename));
  const selectedFiles = downloadable.filter((f) => selected.has(f.filename));
  const selectedSize = selectedFiles.reduce((a, f) => a + f.size, 0);
  const [browsing, setBrowsing] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const setSelected = (next: Set<string>) => set({ selection: { ...useSearchStore.getState().selection, [base.id]: [...next] } });
  const toggle = (fn: string) => {
    const n = new Set(selected);
    if (n.has(fn)) n.delete(fn);
    else n.add(fn);
    setSelected(n);
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      const full = await api.post<ResultGroup>("/api/search/browse", { username: group.username, directory: group.directory, source });
      set({ browsed: { ...useSearchStore.getState().browsed, [base.id]: full } });
      // Pre-select any newly found audio files too.
      const n = new Set(selected);
      for (const f of full.files) if (f.is_audio && !f.locked) n.add(f.filename);
      setSelected(n);
      toast.ok(`Folder has ${full.files.length} file${full.files.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBrowsing(false);
    }
  };

  const download = async (files = selectedFiles) => {
    if (!files.length) return;
    setQueuing(true);
    try {
      const body = { username: group.username, directory: group.directory, files: files.map((f) => ({ filename: f.filename, size: f.size })), title: group.folder_name };
      const space = await api.post<{ ok: boolean; message: string | null }>("/api/downloads/space-check", body);
      if (!space.ok && !(await confirm("Low disk space", space.message ?? "The drive is nearly full.", "Download anyway"))) return;
      const job = await api.post<Job>("/api/downloads", body);
      qc.invalidateQueries({ queryKey: ["downloads"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      toast.ok(`Queued ${files.length} file${files.length === 1 ? "" : "s"} from ${group.username}`, {
        label: "View",
        run: () => navigate(`/downloads#job-${job.id}`),
      });
    } catch (e) {
      toast.error(e);
    } finally {
      setQueuing(false);
    }
  };

  return (
    <Card className="p-0">
      <button className="flex w-full items-start gap-3 p-3 text-left sm:p-4" onClick={() => set({ expanded: { ...expanded, [base.id]: !open } })} aria-expanded={open}>
        <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <ListMusic className="size-5 text-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium break-all">{group.folder_name}</span>
            {group.in_library === "full" && (
              <Badge tone="ok">
                <LibraryIcon className="size-3" /> In library
              </Badge>
            )}
            {group.in_library === "partial" && (
              <Badge tone="warn">
                <LibraryIcon className="size-3" /> Partly in library
              </Badge>
            )}
          </div>
          {group.parent_name && <div className="truncate text-xs text-muted">in {group.parent_name}</div>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <QualityBadge tier={group.tier} label={group.quality} />
            {group.mixed && <Badge>mixed formats</Badge>}
            {group.locked && (
              <Badge tone="danger">
                <Lock className="size-3" /> locked
              </Badge>
            )}
            <span>
              {group.audio_count} track{group.audio_count === 1 ? "" : "s"} · {bytes(group.total_size)}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="flex items-center gap-1">
              <User className="size-3" />
              {group.username}
            </span>
            <span className="flex items-center gap-1">
              <Gauge className="size-3" />
              {speed(group.upload_speed)}
            </span>
            <span className={cx("flex items-center gap-1", group.has_free_slot ? "text-ok" : "text-warn")}>
              {group.has_free_slot ? <CircleCheck className="size-3" /> : <CircleDot className="size-3" />}
              {group.has_free_slot ? "free slot" : `queue ${group.queue_length}`}
            </span>
          </div>
        </div>
        {open ? <ChevronUp className="size-5 shrink-0 text-muted" /> : <ChevronDown className="size-5 shrink-0 text-muted" />}
      </button>

      {!open && (
        <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
          <Button size="sm" onClick={() => set({ expanded: { ...expanded, [base.id]: true } })}>
            Pick tracks
          </Button>
          <Button size="sm" variant="primary" loading={queuing} disabled={group.locked} icon={<Download className="size-4" />} onClick={() => download(downloadable.filter((f) => f.is_audio))}>
            Download all
          </Button>
        </div>
      )}

      {open && (
        <div className="border-t border-border">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-5 accent-[var(--accent)]"
                checked={selectedFiles.length === downloadable.length && downloadable.length > 0}
                onChange={(e) => setSelected(new Set(e.target.checked ? downloadable.map((f) => f.filename) : []))}
              />
              Select all
            </label>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(downloadable.filter((f) => f.is_audio).map((f) => f.filename)))}>
              Audio only
            </Button>
            <Button size="sm" variant="ghost" loading={browsing} onClick={browse} icon={<FolderSearch className="size-4" />}>
              {browsed[base.id] ? "Reload full folder" : "Show full folder"}
            </Button>
          </div>
          <ul className="max-h-[50vh] overflow-y-auto">
            {group.files.map((f) => (
              <li key={f.filename} className={cx("flex items-center gap-3 border-t border-border/60 px-3 py-2", !f.is_audio && "opacity-70")}>
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-[var(--accent)]"
                  aria-label={`Select ${f.name}`}
                  disabled={f.locked}
                  checked={selected.has(f.filename)}
                  onChange={() => toggle(f.filename)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{f.name}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {f.quality && <QualityBadge tier={f.tier ?? 4} label={f.quality} />}
                    {f.length ? <span>{duration(f.length)}</span> : null}
                    <span>{bytes(f.size)}</span>
                    {f.locked && <Lock className="size-3" />}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
            <span className="mr-auto text-xs text-muted">
              {selectedFiles.length} selected · {bytes(selectedSize)}
            </span>
            <Button size="sm" variant="primary" loading={queuing} disabled={!selectedFiles.length} icon={<Download className="size-4" />} onClick={() => download()}>
              Download selected
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

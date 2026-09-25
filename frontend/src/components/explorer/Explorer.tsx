import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownAZ,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  File,
  FileAudio,
  FolderClosed,
  FolderPlus,
  FolderSymlink,
  Image,
  Info,
  MoreVertical,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  SquareCheck,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, qs } from "../../lib/api";
import { deleteItems, renameItem, transfer } from "../../lib/fileActions";
import { bytes, dateTime, displayPath, parentPath, ROOT_LABELS } from "../../lib/format";
import type { FsEntry, Listing } from "../../lib/types";
import { useClipboard } from "../../store/clipboard";
import { confirm, prompt } from "../../store/dialogs";
import { toast } from "../../store/toasts";
import { Button, EmptyState, IconButton, Spinner, cx, inputClass } from "../ui";
import { DetailsModal } from "./DetailsModal";

type SortKey = "name" | "mtime" | "size" | "kind";

function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function EntryIcon({ entry }: { entry: FsEntry }) {
  const cls = "size-5 shrink-0";
  if (entry.is_dir) return <FolderClosed className={cx(cls, "text-accent")} />;
  if (entry.kind === "audio") return <FileAudio className={cx(cls, "text-tier2")} />;
  if (entry.kind === "image") return <Image className={cx(cls, "text-muted")} />;
  return <File className={cx(cls, "text-muted")} />;
}

export interface PickMode {
  /** e.g. "File 12 files here" */
  label: (folderName: string) => string;
  busy?: boolean;
  onPick: (path: string) => void;
  onCancel: () => void;
  extra?: ReactNode;
}

interface Props {
  path: string;
  onNavigate: (path: string) => void;
  pick?: PickMode;
  onScan?: () => void;
  scanning?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

const ROW_HEIGHT = 56;

export function Explorer({ path, onNavigate, pick, onScan, scanning }: Props) {
  const qc = useQueryClient();
  const [showHidden, setShowHidden] = useState(() => loadPref("lm-hidden", false));
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>(() => loadPref("lm-sort", { key: "name", desc: false }));
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clipboard = useClipboard();
  const scrollRef = useRef<HTMLDivElement>(null);
  const longPress = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false });

  useEffect(() => savePref("lm-hidden", showHidden), [showHidden]);
  useEffect(() => savePref("lm-sort", sort), [sort]);
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
    setFilter("");
    scrollRef.current?.scrollTo({ top: 0 });
  }, [path]);

  const query = useQuery({
    queryKey: ["files", path, showHidden],
    queryFn: () => api.get<Listing>(`/api/files?${qs({ path, hidden: showHidden })}`),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
  const notFound = query.error instanceof ApiError && query.error.status === 404;

  const entries = useMemo(() => {
    const list = (query.data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
    const dir = sort.desc ? -1 : 1;
    const cmp = (a: FsEntry, b: FsEntry) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let r = 0;
      if (sort.key === "mtime") r = a.mtime - b.mtime;
      else if (sort.key === "size") r = a.size - b.size;
      else if (sort.key === "kind") r = a.kind.localeCompare(b.kind);
      if (r === 0) r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return r * dir;
    };
    return [...list].sort(cmp);
  }, [query.data, filter, sort]);

  // Drop selections that no longer exist (e.g. changed from another device).
  useEffect(() => {
    if (!query.data) return;
    const names = new Set(query.data.entries.map((e) => e.path));
    setSelected((s) => {
      const next = new Set([...s].filter((p) => names.has(p)));
      return next.size === s.size ? s : next;
    });
  }, [query.data]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const selectionMode = selected.size > 0;
  const refresh = () => qc.invalidateQueries({ queryKey: ["files"] });

  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const onRowClick = (e: React.MouseEvent, entry: FsEntry, index: number) => {
    if (longPress.current.fired) {
      longPress.current.fired = false;
      return;
    }
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.path)));
      return;
    }
    if (e.metaKey || e.ctrlKey || selectionMode) {
      toggle(entry.path);
      setAnchor(index);
      return;
    }
    if (entry.is_dir) onNavigate(entry.path);
    else setDetails(entry.path);
  };

  const startLongPress = (entry: FsEntry, index: number) => {
    longPress.current.fired = false;
    clearTimeout(longPress.current.timer);
    longPress.current.timer = setTimeout(() => {
      longPress.current.fired = true;
      toggle(entry.path);
      setAnchor(index);
      navigator.vibrate?.(15);
    }, 450);
  };
  const cancelLongPress = () => clearTimeout(longPress.current.timer);

  // ------------------------------------------------------------------------------------ actions
  const newFolder = async () => {
    const name = await prompt("New folder", "Folder name", "", "Create");
    if (!name) return;
    try {
      await api.post("/api/files/mkdir", { parent: path, name });
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const doRename = async (entry: FsEntry) => {
    const name = await prompt(`Rename ${entry.is_dir ? "folder" : "file"}`, "New name", entry.name, "Rename");
    if (!name || name === entry.name) return;
    if (await renameItem(entry, name)) {
      setSelected(new Set());
      refresh();
    }
  };

  const doDelete = async (items: FsEntry[]) => {
    if (!items.length) return;
    const label = items.length === 1 ? `“${items[0].name}”` : `${items.length} items`;
    const ok = await confirm(
      "Move to Trash?",
      <>
        {label} will be moved to the Trash. You can restore {items.length === 1 ? "it" : "them"} from the Trash page until it is
        emptied.
      </>,
      "Move to Trash",
      true,
    );
    if (!ok) return;
    if (await deleteItems(items.map((i) => i.path))) {
      setSelected(new Set());
      refresh();
    }
  };

  const setClip = (mode: "cut" | "copy", items: FsEntry[]) => {
    if (!items.length) return;
    clipboard.set(
      mode,
      items.map((i) => i.path),
    );
    toast.info(`${items.length} item${items.length === 1 ? "" : "s"} ${mode === "cut" ? "cut" : "copied"} — open a folder and paste`);
    setSelected(new Set());
  };

  const paste = async (dest = path) => {
    if (!clipboard.mode || !clipboard.paths.length) return;
    const mode = clipboard.mode === "cut" ? "move" : "copy";
    const op = await transfer(clipboard.paths, dest, mode);
    if (op && mode === "move" && !op.error) clipboard.clear();
    refresh();
  };

  const dropOn = async (dest: string, paths: string[], copy: boolean) => {
    const srcs = paths.filter((p) => p !== dest && parentPath(p) !== dest);
    if (!srcs.length) return;
    await transfer(srcs, dest, copy ? "copy" : "move");
    setSelected(new Set());
    refresh();
  };

  // --------------------------------------------------------------------------------- keyboard
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [role=dialog]")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(entries.map((x) => x.path)));
      } else if (mod && e.key.toLowerCase() === "c") setClip("copy", selectedEntries);
      else if (mod && e.key.toLowerCase() === "x") setClip("cut", selectedEntries);
      else if (mod && e.key.toLowerCase() === "v") paste();
      else if (e.key === "Delete") doDelete(selectedEntries);
      else if (e.key === "F2" && selectedEntries.length === 1) doRename(selectedEntries[0]);
      else if (e.key === "Escape") setSelected(new Set());
      else if (e.key === "Backspace" && path.includes("/")) onNavigate(parentPath(path));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, selectedEntries, path, clipboard.mode, clipboard.paths],
  );
  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const openMenu = (x: number, y: number, entry: FsEntry) => {
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
    setMenu({ x: Math.min(x, window.innerWidth - 220), y: Math.min(y, window.innerHeight - 320), entry });
  };

  const menuTargets = menu ? (selected.has(menu.entry.path) && selected.size > 1 ? selectedEntries : [menu.entry]) : [];

  // ---------------------------------------------------------------------------------- render
  const segments = path.split("/");
  const crumbs = segments.map((seg, i) => ({ label: i === 0 ? ROOT_LABELS[seg] ?? seg : seg, path: segments.slice(0, i + 1).join("/") }));
  const inLibrary = path === "library" || path.startsWith("library/");
  const clipCount = clipboard.paths.length;
  const totalSize = entries.reduce((a, e) => a + e.size, 0);

  const dragProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/x-lm-paths")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? "copy" : "move";
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((d) => (d === target ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const paths = JSON.parse(e.dataTransfer.getData("application/x-lm-paths") || "[]") as string[];
      dropOn(target, paths, e.ctrlKey || e.altKey);
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
      {/* Roots + breadcrumbs */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        <IconButton label="Up one level" disabled={!path.includes("/")} onClick={() => onNavigate(parentPath(path))}>
          <ArrowUp className="size-5" />
        </IconButton>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center overflow-x-auto text-sm [scrollbar-width:none]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight className="size-4 text-muted" />}
              <button
                {...dragProps(c.path)}
                onClick={() => onNavigate(c.path)}
                className={cx(
                  "max-w-[14rem] truncate rounded-md px-2 py-1 hover:bg-surface-2",
                  i === crumbs.length - 1 ? "font-semibold" : "text-muted",
                  dropTarget === c.path && "bg-accent/20 ring-1 ring-accent",
                )}
              >
                {c.label}
              </button>
            </span>
          ))}
          {notFound && pick && <span className="ml-2 shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-xs text-accent">new folder</span>}
        </nav>
        {!pick && (
          <div className="hidden gap-1 sm:flex">
            {(["library", "staging"] as const).map((r) => (
              <Button key={r} size="sm" variant={path.split("/")[0] === r ? "primary" : "ghost"} onClick={() => onNavigate(r)}>
                {ROOT_LABELS[r]}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {!pick && (
          <div className="flex gap-1 sm:hidden">
            {(["library", "staging"] as const).map((r) => (
              <Button key={r} size="sm" variant={path.split("/")[0] === r ? "primary" : "ghost"} onClick={() => onNavigate(r)}>
                {ROOT_LABELS[r]}
              </Button>
            ))}
          </div>
        )}
        <IconButton label="New folder" onClick={newFolder} disabled={notFound}>
          <FolderPlus className="size-5" />
        </IconButton>
        <IconButton label={clipCount ? `Paste ${clipCount} item(s) here` : "Nothing to paste"} disabled={!clipCount || notFound} onClick={() => paste()}>
          <ClipboardPaste className="size-5" />
        </IconButton>
        <IconButton label="Refresh" onClick={refresh}>
          <RefreshCw className={cx("size-5", query.isFetching && "animate-spin")} />
        </IconButton>
        <IconButton label={showHidden ? "Hide hidden files" : "Show hidden files"} active={showHidden} onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? <Eye className="size-5" /> : <EyeOff className="size-5" />}
        </IconButton>
        <label className="relative flex items-center">
          <ArrowDownAZ className="pointer-events-none absolute left-2 size-4 text-muted" />
          <select
            aria-label="Sort by"
            className="h-9 rounded-lg border border-border bg-bg pl-7 pr-2 text-sm"
            value={`${sort.key}:${sort.desc ? "desc" : "asc"}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(":");
              setSort({ key: key as SortKey, desc: dir === "desc" });
            }}
          >
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="mtime:desc">Newest</option>
            <option value="mtime:asc">Oldest</option>
            <option value="size:desc">Largest</option>
            <option value="kind:asc">Type</option>
          </select>
        </label>
        <label className="relative ml-auto flex min-w-[8rem] flex-1 items-center sm:max-w-56">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted" />
          <input
            className={cx(inputClass, "h-9 pl-8")}
            placeholder="Filter this folder"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {onScan && inLibrary && (
          <Button size="sm" onClick={onScan} loading={scanning} icon={<RefreshCw className="size-4" />}>
            <span className="hidden sm:inline">Scan library</span>
            <span className="sm:hidden">Scan</span>
          </Button>
        )}
      </div>

      {clipCount > 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-accent/10 px-3 py-1.5 text-sm">
          {clipboard.mode === "cut" ? <Scissors className="size-4 text-accent" /> : <Copy className="size-4 text-accent" />}
          <span className="min-w-0 flex-1 truncate">
            {clipCount} item{clipCount === 1 ? "" : "s"} {clipboard.mode === "cut" ? "cut" : "copied"}
            <span className="text-muted"> from {displayPath(parentPath(clipboard.paths[0]))}</span>
          </span>
          <Button size="sm" variant="primary" onClick={() => paste()} disabled={notFound}>
            Paste here
          </Button>
          <IconButton label="Clear clipboard" className="size-8" onClick={clipboard.clear}>
            <X className="size-4" />
          </IconButton>
        </div>
      )}

      {/* File list */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto" onContextMenu={(e) => e.target === e.currentTarget && e.preventDefault()}>
        {query.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : notFound && pick ? (
          <EmptyState icon={<FolderPlus />} title="This folder will be created">
            {displayPath(path)} doesn’t exist yet. It will be created when you file the download here — or browse to a different folder.
          </EmptyState>
        ) : query.error ? (
          <EmptyState icon={<FolderSymlink />} title="Can’t open this folder">
            {(query.error as Error).message}
            <div className="mt-3">
              <Button size="sm" onClick={() => onNavigate(path.split("/")[0])}>
                Go to {ROOT_LABELS[path.split("/")[0]] ?? "top"}
              </Button>
            </div>
          </EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState icon={<FolderClosed />} title={filter ? "No matches" : "This folder is empty"} />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} role="list">
            {virtualizer.getVirtualItems().map((v) => {
              const entry = entries[v.index];
              const isSel = selected.has(entry.path);
              return (
                <div
                  key={entry.path}
                  role="listitem"
                  aria-selected={isSel}
                  draggable
                  onDragStart={(e) => {
                    const paths = isSel ? [...selected] : [entry.path];
                    e.dataTransfer.setData("application/x-lm-paths", JSON.stringify(paths));
                    e.dataTransfer.effectAllowed = "copyMove";
                  }}
                  {...(entry.is_dir ? dragProps(entry.path) : {})}
                  onClick={(e) => onRowClick(e, entry, v.index)}
                  onDoubleClick={() => entry.is_dir && onNavigate(entry.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e.clientX, e.clientY, entry);
                  }}
                  onTouchStart={() => startLongPress(entry, v.index)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  className={cx(
                    "absolute left-0 right-0 flex cursor-default items-center gap-3 border-b border-border/60 px-2 select-none sm:px-3",
                    isSel ? "bg-accent/12" : "hover:bg-surface-2",
                    dropTarget === entry.path && "bg-accent/20 ring-1 ring-inset ring-accent",
                  )}
                  style={{ top: v.start, height: ROW_HEIGHT }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.name}`}
                    checked={isSel}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => {
                      toggle(entry.path);
                      setAnchor(v.index);
                    }}
                    className={cx("size-5 shrink-0 accent-[var(--accent)]", !selectionMode && "sm:opacity-40")}
                  />
                  <EntryIcon entry={entry} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{entry.name}</div>
                    <div className="truncate text-xs text-muted sm:hidden">
                      {entry.is_dir ? "Folder" : bytes(entry.size)} · {dateTime(entry.mtime)}
                    </div>
                  </div>
                  <div className="hidden w-24 shrink-0 text-right text-xs text-muted sm:block">{entry.is_dir ? "—" : bytes(entry.size)}</div>
                  <div className="hidden w-40 shrink-0 text-right text-xs text-muted md:block">{dateTime(entry.mtime)}</div>
                  <IconButton
                    label={`Actions for ${entry.name}`}
                    className="size-9"
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      openMenu(r.right - 210, r.bottom, entry);
                    }}
                  >
                    <MoreVertical className="size-4" />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status / selection bar */}
      {selectionMode ? (
        <div className="flex items-center gap-0.5 border-t border-border bg-surface-2 px-2 py-2">
          <span className="mr-auto pl-1 text-sm font-medium whitespace-nowrap">
            {selected.size}<span className="hidden min-[400px]:inline"> selected</span>
          </span>
          <IconButton className="size-9 sm:size-10" label="Select all" onClick={() => setSelected(new Set(entries.map((x) => x.path)))}>
            <SquareCheck className="size-5" />
          </IconButton>
          <IconButton className="size-9 sm:size-10" label="Cut" onClick={() => setClip("cut", selectedEntries)}>
            <Scissors className="size-5" />
          </IconButton>
          <IconButton className="size-9 sm:size-10" label="Copy" onClick={() => setClip("copy", selectedEntries)}>
            <Copy className="size-5" />
          </IconButton>
          <IconButton className="size-9 sm:size-10" label="Rename" disabled={selected.size !== 1} onClick={() => doRename(selectedEntries[0])}>
            <Pencil className="size-5" />
          </IconButton>
          <IconButton className="size-9 sm:size-10" label="Details" disabled={selected.size !== 1} onClick={() => setDetails(selectedEntries[0].path)}>
            <Info className="size-5" />
          </IconButton>
          <IconButton label="Move to Trash" className="size-9 text-danger sm:size-10" onClick={() => doDelete(selectedEntries)}>
            <Trash2 className="size-5" />
          </IconButton>
          <IconButton className="size-9 sm:size-10" label="Clear selection" onClick={() => setSelected(new Set())}>
            <X className="size-5" />
          </IconButton>
        </div>
      ) : (
        !pick &&
        query.data && (
          <div className="border-t border-border px-3 py-1.5 text-xs text-muted">
            {entries.length} item{entries.length === 1 ? "" : "s"}
            {totalSize > 0 && ` · ${bytes(totalSize)} in files`}
            <span className="hidden sm:inline"> · Tip: right-click for actions, drag onto a folder to move (hold Ctrl to copy)</span>
          </div>
        )
      )}

      {pick && (
        <div className="pb-safe flex flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-3">
          {pick.extra}
          <div className="ml-auto flex gap-2">
            <Button onClick={pick.onCancel}>Cancel</Button>
            <Button variant="primary" loading={pick.busy} onClick={() => pick.onPick(path)} disabled={!path.startsWith("library")}>
              {path.startsWith("library") ? pick.label(crumbs[crumbs.length - 1].label) : "Choose a folder in the Library"}
            </Button>
          </div>
        </div>
      )}

      {menu && (
        <div
          role="menu"
          className="fixed z-40 w-52 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl"
          style={{ left: Math.max(8, menu.x), top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuTargets.length === 1 && menu.entry.is_dir && (
            <MenuItem icon={<FolderClosed />} onClick={() => (setMenu(null), onNavigate(menu.entry.path))}>
              Open
            </MenuItem>
          )}
          {menuTargets.length === 1 && (
            <MenuItem icon={<Pencil />} onClick={() => (setMenu(null), doRename(menu.entry))}>
              Rename
            </MenuItem>
          )}
          <MenuItem icon={<Scissors />} onClick={() => (setMenu(null), setClip("cut", menuTargets))}>
            Cut{menuTargets.length > 1 ? ` ${menuTargets.length} items` : ""}
          </MenuItem>
          <MenuItem icon={<Copy />} onClick={() => (setMenu(null), setClip("copy", menuTargets))}>
            Copy{menuTargets.length > 1 ? ` ${menuTargets.length} items` : ""}
          </MenuItem>
          {menuTargets.length === 1 && menu.entry.is_dir && clipCount > 0 && (
            <MenuItem icon={<ClipboardPaste />} onClick={() => (setMenu(null), paste(menu.entry.path))}>
              Paste into folder
            </MenuItem>
          )}
          {menuTargets.length === 1 && (
            <MenuItem icon={<Info />} onClick={() => (setMenu(null), setDetails(menu.entry.path))}>
              Details
            </MenuItem>
          )}
          <MenuItem icon={<Trash2 />} danger onClick={() => (setMenu(null), doDelete(menuTargets))}>
            Move to Trash
          </MenuItem>
        </div>
      )}

      <DetailsModal path={details} onClose={() => setDetails(null)} />
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cx("flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-2 [&>svg]:size-4", danger && "text-danger")}
    >
      {icon}
      {children}
    </button>
  );
}

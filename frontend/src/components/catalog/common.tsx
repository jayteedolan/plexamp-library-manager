import { Disc3, Library as LibraryIcon, Music, Search as SearchIcon, Settings, TimerReset } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { duration } from "../../lib/format";
import type { MatchTarget } from "../../lib/match";
import type { CatalogAlbum, CatalogAlbumDetail, CatalogTrack, LibraryHint } from "../../lib/types";
import { findOnSoulseek } from "../../store/search";
import { toast } from "../../store/toasts";
import { Badge, Button, Card, cx } from "../ui";

export function LibraryBadge({ hint }: { hint: LibraryHint }) {
  if (hint === "full")
    return (
      <Badge tone="ok">
        <LibraryIcon className="size-3" /> In library
      </Badge>
    );
  if (hint === "partial")
    return (
      <Badge tone="warn">
        <LibraryIcon className="size-3" /> Partly in library
      </Badge>
    );
  return null;
}

export function Cover({ src, alt, className, round }: { src: string | null; alt: string; className?: string; round?: boolean }) {
  const [failed, setFailed] = useState(false);
  const shape = round ? "rounded-full" : "rounded-lg";
  if (!src || failed)
    return (
      <div className={cx("flex shrink-0 items-center justify-center bg-surface-2 text-muted", shape, className)}>
        {round ? <Music className="size-1/3" /> : <Disc3 className="size-1/3" />}
      </div>
    );
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={cx("shrink-0 object-cover", shape, className)} />;
}

const TYPE_LABEL: Record<string, string> = { album: "Album", single: "Single", compilation: "Compilation" };

export function releaseMeta(a: CatalogAlbum): string {
  return [a.year, TYPE_LABEL[a.type] ?? a.type, `${a.total_tracks} track${a.total_tracks === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
}

export function ReleaseCard({ album, showArtist }: { album: CatalogAlbum; showArtist?: boolean }) {
  return (
    <Link to={`/search/spotify/album/${album.id}`} className="group flex min-w-0 flex-col gap-2 rounded-xl p-1 hover:bg-surface-2">
      <Cover src={album.image} alt="" className="aspect-square w-full" />
      <div className="min-w-0 px-1 pb-1">
        <div className="truncate text-sm font-medium">{album.name}</div>
        {showArtist && <div className="truncate text-xs text-muted">{album.artist}</div>}
        <div className="truncate text-xs text-muted">{releaseMeta(album)}</div>
        {album.in_library && (
          <div className="mt-1">
            <LibraryBadge hint={album.in_library} />
          </div>
        )}
      </div>
    </Link>
  );
}

export function ReleaseGrid({ albums, showArtist }: { albums: CatalogAlbum[]; showArtist?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {albums.map((a) => (
        <ReleaseCard key={a.id} album={a} showArtist={showArtist} />
      ))}
    </div>
  );
}

export function albumTarget(album: CatalogAlbumDetail): MatchTarget {
  return { kind: "album", artists: album.artists, album: album.name, tracks: album.tracks.map((t) => t.name) };
}

export function trackTarget(track: CatalogTrack, albumName = track.album?.name ?? ""): MatchTarget {
  return { kind: "track", artists: track.artists, album: albumName, tracks: [track.name] };
}

/** Returns a function that starts a Soulseek search for a target and jumps to the results. */
export function useFindOnSoulseek() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const find = async (key: string, target: MatchTarget | (() => Promise<MatchTarget>)) => {
    setBusy(key);
    try {
      const t = typeof target === "function" ? await target() : target;
      navigate("/search");
      await findOnSoulseek(t);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return { find, busy };
}

/** Fetches an album's full tracklist first, so the whole album can be matched. */
export function albumTargetById(id: string) {
  return async () => albumTarget(await api.get<CatalogAlbumDetail>(`/api/catalog/album/${id}`));
}

export function TrackRow({
  track,
  index,
  onFind,
  finding,
  showAlbum,
}: {
  track: CatalogTrack;
  index?: number;
  onFind: () => void;
  finding: boolean;
  showAlbum?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-border/60 px-3 py-2 last:border-0">
      {showAlbum ? (
        <Cover src={track.album?.image ?? null} alt="" className="size-10" />
      ) : (
        <span className="w-6 shrink-0 text-right text-sm text-muted tabular-nums">{index ?? track.track_number}</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {track.name}
          {track.explicit && <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] font-semibold text-muted">E</span>}
        </div>
        <div className="truncate text-xs text-muted">
          {track.artist}
          {showAlbum && track.album ? ` · ${track.album.name}` : ""}
        </div>
      </div>
      <span className="hidden text-xs text-muted tabular-nums sm:inline">{duration((track.duration_ms ?? 0) / 1000)}</span>
      <Button size="sm" variant="ghost" loading={finding} onClick={onFind} icon={<SearchIcon className="size-4" />} aria-label={`Find ${track.name} on Soulseek`}>
        <span className="hidden sm:inline">Find</span>
      </Button>
    </li>
  );
}

/** Explains catalog errors: Spotify rate limits (with a countdown), missing setup, or anything else. */
export function CatalogError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const retryAfter = error instanceof ApiError && error.status === 429 ? ((error.extra as { retry_after?: number })?.retry_after ?? 30) : 0;
  const [left, setLeft] = useState(retryAfter);
  useEffect(() => {
    setLeft(retryAfter);
    if (!retryAfter) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [retryAfter, error]);

  const navigate = useNavigate();
  const message = error instanceof Error ? error.message : String(error);
  const notSetUp = /isn't set up|Client ID/i.test(message);
  return (
    <Card className="flex flex-col items-start gap-3 text-sm">
      {retryAfter ? (
        <div className="flex items-start gap-2 text-warn">
          <TimerReset className="mt-0.5 size-4 shrink-0" />
          <span>Spotify asked us to slow down. {left > 0 ? `You can try again in ${left}s.` : "You can try again now."}</span>
        </div>
      ) : (
        <span className="text-danger">{message}</span>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={onRetry} disabled={left > 0}>
          Try again
        </Button>
        {notSetUp && (
          <Button size="sm" variant="primary" icon={<Settings className="size-4" />} onClick={() => navigate("/settings")}>
            Open settings
          </Button>
        )}
      </div>
    </Card>
  );
}

export const catalogQueryOptions = {
  staleTime: 5 * 60 * 1000,
  // Never retry automatically: a retry storm is exactly what gets an IP rate-limited.
  retry: false,
  refetchOnWindowFocus: false,
} as const;

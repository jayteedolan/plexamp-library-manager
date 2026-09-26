import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Search as SearchIcon } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CatalogError,
  Cover,
  LibraryBadge,
  TrackRow,
  albumTarget,
  catalogQueryOptions,
  releaseMeta,
  trackTarget,
  useFindOnSoulseek,
} from "../components/catalog/common";
import { Button, Card, Spinner } from "../components/ui";
import { api } from "../lib/api";
import type { CatalogAlbumDetail } from "../lib/types";

export function CatalogAlbum() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["catalog", "album", id],
    queryFn: () => api.get<CatalogAlbumDetail>(`/api/catalog/album/${id}`),
    ...catalogQueryOptions,
  });
  const { find, busy } = useFindOnSoulseek();

  if (q.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  if (q.error) return <CatalogError error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data!;
  const multiDisc = a.tracks.some((t) => t.disc_number > 1);

  return (
    <div>
      <Button size="sm" variant="ghost" className="mb-3 -ml-2" onClick={() => navigate(-1)} icon={<ArrowLeft className="size-4" />}>
        Back
      </Button>
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Cover src={a.image} alt="" className="size-40 self-center sm:size-48 sm:self-auto" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold sm:text-2xl">{a.name}</h1>
          <div className="mt-1 text-sm">
            {a.artists.map((name, i) => (
              <span key={name}>
                {i > 0 && ", "}
                {name}
              </span>
            ))}
          </div>
          <div className="mt-1 text-xs text-muted">
            {releaseMeta(a)}
            {a.label ? ` · ${a.label}` : ""}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <LibraryBadge hint={a.in_library} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" loading={busy === "album"} onClick={() => find("album", albumTarget(a))} icon={<SearchIcon className="size-4" />}>
              Find album on Soulseek
            </Button>
            {a.url && (
              <a
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm text-text transition hover:bg-surface-2"
              >
                <ExternalLink className="size-4" /> Spotify
              </a>
            )}
          </div>
        </div>
      </div>
      <Card className="p-0">
        <ul>
          {a.tracks.map((t, i) => (
            <TrackRow
              key={t.id ?? i}
              track={t}
              index={multiDisc ? undefined : (t.track_number ?? i + 1)}
              finding={busy === t.id}
              onFind={() => find(t.id, trackTarget(t, a.name))}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

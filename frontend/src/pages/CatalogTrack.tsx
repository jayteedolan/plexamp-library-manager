import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Disc3, Search as SearchIcon } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CatalogError,
  Cover,
  LibraryBadge,
  ReleaseCard,
  albumTargetById,
  catalogQueryOptions,
  trackTarget,
  useFindOnSoulseek,
} from "../components/catalog/common";
import { Button, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { duration } from "../lib/format";
import type { CatalogTrack as Track } from "../lib/types";

export function CatalogTrack() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["catalog", "track", id],
    queryFn: () => api.get<Track>(`/api/catalog/track/${id}`),
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
  const t = q.data!;

  return (
    <div>
      <Button size="sm" variant="ghost" className="mb-3 -ml-2" onClick={() => navigate(-1)} icon={<ArrowLeft className="size-4" />}>
        Back
      </Button>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Cover src={t.album?.image ?? null} alt="" className="size-40 self-center sm:size-48 sm:self-auto" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold sm:text-2xl">{t.name}</h1>
          <div className="mt-1 text-sm">{t.artist}</div>
          <div className="mt-1 text-xs text-muted">
            {t.album?.name}
            {t.duration_ms ? ` · ${duration(t.duration_ms / 1000)}` : ""}
          </div>
          {t.album && (
            <div className="mt-2">
              <LibraryBadge hint={t.album.in_library} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" loading={busy === "track"} onClick={() => find("track", trackTarget(t))} icon={<SearchIcon className="size-4" />}>
              Find this song
            </Button>
            {t.album && (
              <Button loading={busy === "album"} onClick={() => find("album", albumTargetById(t.album!.id))} icon={<Disc3 className="size-4" />}>
                Find the album
              </Button>
            )}
          </div>
        </div>
      </div>
      {t.album && (
        <div className="max-w-[12rem]">
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">From</h2>
          <ReleaseCard album={t.album} showArtist />
        </div>
      )}
    </div>
  );
}

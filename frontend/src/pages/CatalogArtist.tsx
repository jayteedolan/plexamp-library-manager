import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { CatalogError, Cover, ReleaseGrid, catalogQueryOptions } from "../components/catalog/common";
import { Button, EmptyState, Spinner } from "../components/ui";
import { api } from "../lib/api";
import type { CatalogArtistDetail } from "../lib/types";

export function CatalogArtist() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["catalog", "artist", id],
    queryFn: () => api.get<CatalogArtistDetail>(`/api/catalog/artist/${id}`),
    ...catalogQueryOptions,
  });

  if (q.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  if (q.error) return <CatalogError error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data!;
  const sections = [
    ["Albums", a.releases.albums],
    ["Singles & EPs", a.releases.singles],
    ["Compilations", a.releases.compilations],
  ] as const;
  const owned = [...a.releases.albums, ...a.releases.singles, ...a.releases.compilations].filter((r) => r.in_library).length;

  return (
    <div>
      <Button size="sm" variant="ghost" className="mb-3 -ml-2" onClick={() => navigate(-1)} icon={<ArrowLeft className="size-4" />}>
        Back
      </Button>
      <div className="mb-6 flex items-center gap-4">
        <Cover src={a.image} alt="" round className="size-24 sm:size-32" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">{a.name}</h1>
          {a.genres.length > 0 && <div className="mt-1 text-sm text-muted">{a.genres.join(" · ")}</div>}
          {owned > 0 && (
            <div className="mt-1 text-xs text-muted">
              {owned} release{owned === 1 ? "" : "s"} already in your library
            </div>
          )}
        </div>
      </div>
      {sections.every(([, list]) => list.length === 0) && <EmptyState title="No releases found on Spotify" />}
      {sections.map(
        ([title, list]) =>
          list.length > 0 && (
            <section key={title} className="mb-6">
              <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">
                {title} <span className="font-normal">({list.length})</span>
              </h2>
              <ReleaseGrid albums={list} />
            </section>
          ),
      )}
    </div>
  );
}

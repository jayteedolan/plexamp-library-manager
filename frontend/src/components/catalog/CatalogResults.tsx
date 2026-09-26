import { useQuery } from "@tanstack/react-query";
import { Disc3 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { CatalogSearchResults } from "../../lib/types";
import { Card, EmptyState, Spinner } from "../ui";
import { CatalogError, Cover, ReleaseGrid, TrackRow, catalogQueryOptions, trackTarget, useFindOnSoulseek } from "./common";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

export function CatalogResults({ query }: { query: string }) {
  const q = useQuery({
    queryKey: ["catalog", "search", query],
    queryFn: () => api.get<CatalogSearchResults>(`/api/catalog/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
    ...catalogQueryOptions,
  });
  const { find, busy } = useFindOnSoulseek();

  if (!query)
    return (
      <EmptyState icon={<Disc3 />} title="Browse Spotify's catalog">
        Search for an artist, album or song, or paste a Spotify link. Then find the release on Soulseek with one tap, matched against its
        tracklist.
      </EmptyState>
    );
  if (q.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  if (q.error) return <CatalogError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  if (!r.albums.length && !r.artists.length && !r.tracks.length) return <EmptyState icon={<Disc3 />} title="No matches on Spotify" />;

  return (
    <div>
      {r.artists.length > 0 && (
        <Section title="Artists">
          <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none]">
            {r.artists.map((a) => (
              <Link key={a.id} to={`/search/spotify/artist/${a.id}`} className="flex w-24 shrink-0 flex-col items-center gap-1.5 rounded-xl p-1 text-center hover:bg-surface-2">
                <Cover src={a.image} alt="" round className="size-20" />
                <span className="w-full truncate text-xs font-medium">{a.name}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}
      {r.albums.length > 0 && (
        <Section title="Albums">
          <ReleaseGrid albums={r.albums} showArtist />
        </Section>
      )}
      {r.tracks.length > 0 && (
        <Section title="Songs">
          <Card className="p-0">
            <ul>
              {r.tracks.map((t) => (
                <TrackRow key={t.id} track={t} showAlbum finding={busy === t.id} onFind={() => find(t.id, trackTarget(t))} />
              ))}
            </ul>
          </Card>
        </Section>
      )}
    </div>
  );
}

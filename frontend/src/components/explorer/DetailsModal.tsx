import { useQuery } from "@tanstack/react-query";
import { api, qs } from "../../lib/api";
import { bytes, dateTime, displayPath, duration } from "../../lib/format";
import type { FileInfo } from "../../lib/types";
import { Badge, Modal, Spinner } from "../ui";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 text-right break-words">{value}</span>
    </div>
  );
}

export function DetailsModal({ path, onClose }: { path: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["info", path],
    queryFn: () => api.get<FileInfo>(`/api/files/info?${qs({ path: path! })}`),
    enabled: !!path,
  });
  const info = q.data;
  const a = info?.audio;
  return (
    <Modal open={!!path} onClose={onClose} title={info?.name ?? "Details"}>
      {q.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : q.error ? (
        <p className="text-sm text-danger">{(q.error as Error).message}</p>
      ) : info ? (
        <div>
          <Row label="Location" value={displayPath(info.path)} />
          <Row label="Type" value={info.is_dir ? "Folder" : info.kind} />
          <Row label="Size" value={bytes(info.size)} />
          {info.is_dir && <Row label="Files inside" value={info.file_count} />}
          <Row label="Modified" value={dateTime(info.mtime)} />
          {a && (
            <>
              <div className="mt-4 mb-1 flex items-center gap-2">
                <span className="text-sm font-semibold">Audio</span>
                <Badge tone={["FLAC", "ALAC", "WAV", "AIFF"].some((f) => a.quality.startsWith(f)) ? "tier1" : "tier2"}>{a.quality}</Badge>
              </div>
              <Row label="Title" value={a.title} />
              <Row label="Artist" value={a.artist} />
              <Row label="Album artist" value={a.album_artist} />
              <Row label="Album" value={a.album} />
              <Row label="Track" value={a.track} />
              <Row label="Disc" value={a.disc} />
              <Row label="Year" value={a.date} />
              <Row label="Genre" value={a.genre} />
              <Row label="Duration" value={duration(a.duration)} />
              <Row label="Bitrate" value={a.bitrate ? `${a.bitrate} kbps` : null} />
              <Row label="Sample rate" value={a.sample_rate ? `${a.sample_rate / 1000} kHz` : null} />
              <Row label="Bit depth" value={a.bit_depth ? `${a.bit_depth}-bit` : null} />
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

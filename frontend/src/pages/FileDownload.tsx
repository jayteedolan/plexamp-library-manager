import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Info, Tags } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Explorer } from "../components/explorer/Explorer";
import { FullHeight } from "../components/Layout";
import { Badge, Button, EmptyState, Modal, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { bytes, displayPath } from "../lib/format";
import type { Job, Suggestion } from "../lib/types";
import { toast } from "../store/toasts";

interface FileResult {
  destination: string;
  results: { id: number; status: string; name?: string; renamed?: boolean }[];
  scan: { started: boolean; message: string } | null;
}

/** "Pick destination" mode: the explorer opens at the suggested Artist/Album folder. */
export function FileDownload() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const job = useQuery({ queryKey: ["download", Number(id)], queryFn: () => api.get<Job>(`/api/downloads/${id}`) });
  const suggestion = useQuery({
    queryKey: ["suggest", Number(id)],
    queryFn: () => api.get<Suggestion>(`/api/downloads/${id}/suggest`),
    staleTime: Infinity,
  });
  const [path, setPath] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<number> | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (suggestion.data && path === null) setPath(suggestion.data.path);
  }, [suggestion.data, path]);

  const files = useMemo(() => (job.data?.files ?? []).filter((f) => f.state === "completed" && !f.filed), [job.data]);
  const selected = chosen ?? new Set(files.map((f) => f.id));
  const count = files.filter((f) => selected.has(f.id)).length;

  if (job.isLoading || suggestion.isLoading || path === null) {
    if (suggestion.error || job.error) {
      return <EmptyState title="Can't load this download">{((suggestion.error || job.error) as Error).message}</EmptyState>;
    }
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (!files.length) {
    return (
      <EmptyState title="Nothing left to file">
        <Button className="mt-3" onClick={() => navigate("/downloads")}>
          Back to downloads
        </Button>
      </EmptyState>
    );
  }

  const s = suggestion.data!;
  const doFile = async (dest: string) => {
    if (!count) {
      toast.info("Select at least one file to file.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<FileResult>(`/api/downloads/${id}/file`, {
        destination: dest,
        file_ids: chosen ? [...chosen] : null,
      });
      const filed = r.results.filter((x) => x.status === "filed");
      const renamed = filed.filter((x) => x.renamed);
      let msg = `Filed ${filed.length} file${filed.length === 1 ? "" : "s"} into ${displayPath(r.destination)}.`;
      if (renamed.length) msg += ` ${renamed.length} renamed to avoid replacing existing files (${renamed.map((x) => x.name).join(", ")}).`;
      if (r.scan) msg += r.scan.started ? " Plex scan started." : ` Plex: ${r.scan.message}`;
      toast.ok(msg);
      qc.invalidateQueries({ queryKey: ["downloads"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["plex"] });
      navigate(`/library?path=${encodeURIComponent(r.destination)}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FullHeight>
      <div className="mb-3 flex items-start gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate("/downloads")} icon={<ArrowLeft className="size-4" />}>
          <span className="sr-only sm:not-sr-only">Back</span>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">File “{job.data!.title}”</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={s.source === "tags" ? "ok" : "warn"}>
              <Tags className="size-3" /> {s.source === "tags" ? "Suggested from tags" : "Guessed from folder name"}
            </Badge>
            <span>
              {s.artist ?? "Unknown artist"} — {s.album ?? "Unknown album"}
            </span>
            {s.exists && <Badge>folder already exists</Badge>}
          </div>
        </div>
      </div>
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Browse to the right album folder (or keep the suggestion). You can tidy up here first — e.g. delete older tracks you’re replacing — then press
          the button below. If a file with the same name already exists, the new one is saved as “name (2)” so nothing is overwritten.
        </span>
      </div>
      <Explorer
        path={path}
        onNavigate={setPath}
        pick={{
          label: () => `File ${count} file${count === 1 ? "" : "s"} here`,
          busy,
          onPick: doFile,
          onCancel: () => navigate("/downloads"),
          extra: (
            <Button size="sm" variant="ghost" onClick={() => setShowFiles(true)}>
              {count} of {files.length} files selected
            </Button>
          ),
        }}
      />
      <Modal
        open={showFiles}
        onClose={() => setShowFiles(false)}
        title="Files to file"
        footer={
          <Button variant="primary" onClick={() => setShowFiles(false)}>
            Done
          </Button>
        }
      >
        <ul className="flex flex-col">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
              <input
                type="checkbox"
                className="size-5 accent-[var(--accent)]"
                checked={selected.has(f.id)}
                onChange={() => {
                  const n = new Set(selected);
                  if (n.has(f.id)) n.delete(f.id);
                  else n.add(f.id);
                  setChosen(n);
                }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <span className="text-xs text-muted">{bytes(f.size)}</span>
            </li>
          ))}
        </ul>
      </Modal>
    </FullHeight>
  );
}

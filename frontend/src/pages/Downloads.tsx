import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FolderInput,
  Loader2,
  RotateCcw,
  Trash2,
  User,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, PageHeader, ProgressBar, Spinner, cx } from "../components/ui";
import { api } from "../lib/api";
import { bytes, eta, relativeTime, speed } from "../lib/format";
import type { Job, JobFile } from "../lib/types";
import { choose, confirm } from "../store/dialogs";
import { toast } from "../store/toasts";

export function useDownloads() {
  return useQuery({
    queryKey: ["downloads"],
    queryFn: () => api.get<Job[]>("/api/downloads"),
    // Server-sent events keep this fresh; poll slowly as a fallback.
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "active") ? 5000 : 30000),
  });
}

const STATUS_LABEL: Record<Job["status"], string> = {
  active: "Downloading",
  ready: "Ready to file",
  cancelled: "Cancelled",
  filed: "Filed",
  failed: "Failed",
  discarded: "Deleted",
};

export function Downloads() {
  const q = useDownloads();
  const qc = useQueryClient();
  const jobs = q.data ?? [];
  const active = jobs.filter((j) => j.status === "active");
  const decide = jobs.filter((j) => j.status === "cancelled");
  const ready = jobs.filter((j) => j.status === "ready");
  const history = jobs.filter((j) => ["filed", "failed", "discarded"].includes(j.status));
  const { hash } = useLocation();

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hash, q.isSuccess]);

  const clearHistory = async () => {
    await api.post("/api/downloads/clear-history");
    qc.invalidateQueries({ queryKey: ["downloads"] });
  };

  if (q.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  return (
    <div>
      <PageHeader title="Downloads" subtitle="Downloads continue on the Pi even when this page is closed." />
      {jobs.length === 0 && (
        <EmptyState icon={<Download />} title="No downloads yet">
          Find something on the Search page and choose Download.
        </EmptyState>
      )}
      <Section title="Needs your decision" jobs={decide} />
      <Section title="Ready to file" jobs={ready} />
      <Section title="In progress" jobs={active} />
      {history.length > 0 && (
        <Section
          title="History"
          jobs={history}
          action={
            <Button size="sm" variant="ghost" onClick={clearHistory}>
              Clear history
            </Button>
          }
          collapsedByDefault
        />
      )}
    </div>
  );
}

function Section({ title, jobs, action, collapsedByDefault }: { title: string; jobs: Job[]; action?: React.ReactNode; collapsedByDefault?: boolean }) {
  if (!jobs.length) return null;
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
          {title} <span className="font-normal">({jobs.length})</span>
        </h2>
        {action}
      </div>
      <div className="flex flex-col gap-3">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} compact={collapsedByDefault} />
        ))}
      </div>
    </section>
  );
}

function FileStateIcon({ f }: { f: JobFile }) {
  const cls = "size-4 shrink-0";
  if (f.state === "completed") return <CheckCircle2 className={cx(cls, "text-ok")} />;
  if (f.state === "failed") return <XCircle className={cx(cls, "text-danger")} />;
  if (f.state === "cancelled") return <X className={cx(cls, "text-muted")} />;
  if (f.state === "downloading") return <Loader2 className={cx(cls, "animate-spin text-accent")} />;
  return <Clock className={cx(cls, "text-muted")} />;
}

export function JobCard({ job, compact }: { job: Job; compact?: boolean }) {
  const [open, setOpen] = useState(!compact && job.status !== "filed" && job.files.length <= 25);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pct = job.total_bytes ? (job.done_bytes / job.total_bytes) * 100 : 0;
  const c = job.counts;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ["downloads"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const decideAfterCancel = async (j: Job) => {
    const done = j.files.filter((f) => f.state === "completed" && !f.filed).length;
    if (!done) {
      await api.post(`/api/downloads/${j.id}/keep`);
      toast.info("Download cancelled.");
      return;
    }
    const choice = await choose(
      "What should happen to the downloaded files?",
      <>
        {done} of {j.files.length} files finished before you cancelled. Keep them to file into your library, or delete them (they go to the Trash).
      </>,
      [
        { label: "Delete downloaded files", value: "discard", variant: "danger" },
        { label: `Keep ${done} file${done === 1 ? "" : "s"}`, value: "keep", variant: "primary" },
      ],
    );
    if (choice === "discard") {
      await api.post(`/api/downloads/${j.id}/discard`);
      toast.ok("Downloaded files moved to the Trash.");
    } else if (choice === "keep") {
      await api.post(`/api/downloads/${j.id}/keep`);
      toast.ok("Kept. File them into your library when you're ready.");
    }
  };

  const cancel = () =>
    run("cancel", async () => {
      if (!(await confirm("Cancel this download?", "Files still downloading or queued will be stopped.", "Cancel download", true))) return;
      const j = await api.post<Job>(`/api/downloads/${job.id}/cancel`);
      await decideAfterCancel(j);
    });

  const discard = () =>
    run("discard", async () => {
      if (!(await confirm("Delete downloaded files?", `${job.unfiled_completed} file(s) will be moved to the Trash.`, "Delete", true))) return;
      await api.post(`/api/downloads/${job.id}/discard`);
    });

  const retryFailed = () => run("retry", () => api.post(`/api/downloads/${job.id}/retry`, { file_ids: null }));
  const remove = () => run("remove", () => api.del(`/api/downloads/${job.id}`));

  const tone = job.status === "failed" ? "danger" : job.status === "ready" ? "ok" : job.status === "cancelled" ? "warn" : "neutral";

  return (
    <Card className="p-0" >
      <div id={`job-${job.id}`} className="scroll-mt-24 p-3 sm:p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{job.title}</span>
              <Badge tone={tone}>{STATUS_LABEL[job.status]}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
              <span className="flex items-center gap-1">
                <User className="size-3" />
                {job.username}
              </span>
              <span>
                {c.completed}/{job.files.length - c.cancelled} files · {bytes(job.done_bytes)} of {bytes(job.total_bytes)}
              </span>
              {job.status === "active" && job.speed > 0 && (
                <span>
                  {speed(job.speed)} · {eta(job.eta_seconds)}
                </span>
              )}
              {c.failed > 0 && <span className="text-danger">{c.failed} failed</span>}
              {job.status === "filed" && job.filed_path && <span>→ {job.filed_path.replace(/^library\/?/, "Library/")}</span>}
              {job.status !== "active" && <span>{relativeTime(job.updated_at)}</span>}
            </div>
          </div>
          <button className="text-muted" aria-label={open ? "Hide files" : "Show files"} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronUp className="size-5" /> : <ChevronDown className="size-5" />}
          </button>
        </div>

        {job.status === "active" && <ProgressBar className="mt-3" value={pct} />}

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {job.status === "active" && (
            <Button size="sm" loading={busy === "cancel"} onClick={cancel} icon={<X className="size-4" />}>
              Cancel
            </Button>
          )}
          {job.status === "cancelled" && (
            <Button size="sm" variant="primary" onClick={() => run("decide", () => decideAfterCancel(job))}>
              Choose what to keep
            </Button>
          )}
          {c.failed > 0 && job.status !== "active" && (
            <Button size="sm" loading={busy === "retry"} onClick={retryFailed} icon={<RotateCcw className="size-4" />}>
              Retry failed
            </Button>
          )}
          {job.status === "ready" && (
            <>
              <Button size="sm" variant="ghost" className="text-danger" loading={busy === "discard"} onClick={discard} icon={<Trash2 className="size-4" />}>
                Delete files
              </Button>
              <Button size="sm" variant="primary" onClick={() => navigate(`/downloads/${job.id}/file`)} icon={<FolderInput className="size-4" />}>
                File into library
              </Button>
            </>
          )}
          {["filed", "failed", "discarded"].includes(job.status) && (
            <Button size="sm" variant="ghost" loading={busy === "remove"} onClick={remove}>
              Remove from list
            </Button>
          )}
        </div>
      </div>

      {open && (
        <ul className="max-h-[50vh] overflow-y-auto border-t border-border">
          {job.files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 border-b border-border/60 px-3 py-2 last:border-0 sm:px-4">
              <FileStateIcon f={f} />
              <div className="min-w-0 flex-1">
                <div className={cx("truncate text-sm", f.state === "cancelled" && "text-muted line-through")}>{f.name}</div>
                <div className="text-xs text-muted">
                  {f.state === "downloading" && (
                    <>
                      {bytes(f.bytes_transferred)} / {bytes(f.size)} · {speed(f.speed)}
                    </>
                  )}
                  {f.state === "queued" && (f.place_in_queue ? `Queued remotely · position ${f.place_in_queue}` : f.remote_state ?? "Queued")}
                  {f.state === "completed" && (f.filed ? "Filed" : `Downloaded · ${bytes(f.size)}`)}
                  {f.state === "failed" && (
                    <span className="flex items-center gap-1 text-danger">
                      <AlertCircle className="size-3" />
                      {f.error ?? "Failed"}
                    </span>
                  )}
                  {f.state === "cancelled" && "Cancelled"}
                </div>
                {f.state === "downloading" && <ProgressBar className="mt-1 h-1" value={f.size ? (f.bytes_transferred / f.size) * 100 : 0} />}
              </div>
              {(f.state === "failed" || (f.state === "cancelled" && job.status !== "active")) && (
                <Button size="sm" variant="ghost" onClick={() => run(`r${f.id}`, () => api.post(`/api/downloads/${job.id}/retry`, { file_ids: [f.id] }))}>
                  Retry
                </Button>
              )}
              {(f.state === "queued" || f.state === "downloading") && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Cancel ${f.name}`}
                  onClick={() => run(`c${f.id}`, () => api.post(`/api/downloads/${job.id}/cancel-files`, { file_ids: [f.id] }))}
                >
                  <X className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

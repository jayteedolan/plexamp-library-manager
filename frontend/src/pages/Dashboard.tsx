import { AlertTriangle, CheckCircle2, Download, FolderInput, FolderOpen, HardDrive, Inbox, RefreshCw, Search, Server, Wifi } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSystemStatus } from "../components/Layout";
import { Badge, Button, Card, PageHeader, ProgressBar, Spinner, cx } from "../components/ui";
import { bytes, eta, relativeTime, speed } from "../lib/format";
import { usePlexStatus, useScan } from "../lib/plex";
import { useDownloads } from "./Downloads";

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={cx("inline-block size-2.5 rounded-full", ok ? "bg-ok" : warn ? "bg-warn" : "bg-danger")} />;
}

function Tile({ icon, title, right, children, className }: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cx("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <span className="text-muted [&>svg]:size-5">{icon}</span>
        <h2 className="font-semibold">{title}</h2>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </Card>
  );
}

export function Dashboard() {
  const status = useSystemStatus();
  const plex = usePlexStatus();
  const scan = useScan();
  const downloads = useDownloads();
  const navigate = useNavigate();
  const st = status.data;
  const p = plex.data;
  const jobs = downloads.data ?? [];
  const active = jobs.filter((j) => j.status === "active");
  const ready = jobs.filter((j) => j.status === "ready" || j.status === "cancelled");
  const disk = st?.storage.disk;
  const usedPct = disk ? (disk.used / disk.total) * 100 : 0;
  const totalDone = active.reduce((a, j) => a + j.done_bytes, 0);
  const totalAll = active.reduce((a, j) => a + j.total_bytes, 0);
  const totalSpeed = active.reduce((a, j) => a + j.speed, 0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <Button onClick={() => navigate("/search")} icon={<Search className="size-4" />}>
              Search
            </Button>
            <Button onClick={() => navigate("/library")} icon={<FolderOpen className="size-4" />}>
              Library
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        {ready.length > 0 && (
          <Tile icon={<Inbox />} title="Ready to file" className="border-accent/50 md:col-span-2" right={<Badge tone="accent">{ready.length}</Badge>}>
            <ul className="flex flex-col divide-y divide-border">
              {ready.map((j) => (
                <li key={j.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{j.title}</div>
                    <div className="text-xs text-muted">
                      {j.unfiled_completed} file{j.unfiled_completed === 1 ? "" : "s"} · from {j.username}
                      {j.status === "cancelled" && " · cancelled — choose what to keep"}
                    </div>
                  </div>
                  {j.status === "ready" ? (
                    <Button size="sm" variant="primary" icon={<FolderInput className="size-4" />} onClick={() => navigate(`/downloads/${j.id}/file`)}>
                      File
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => navigate(`/downloads#job-${j.id}`)}>
                      Decide
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Tile>
        )}

        <Tile
          icon={<Server />}
          title="Plex"
          right={p && <StatusDot ok={p.ok} warn={!p.configured} />}
        >
          {plex.isLoading ? (
            <Spinner />
          ) : p?.ok ? (
            <>
              <div className="text-sm">
                <div className="font-medium">{p.section?.title}</div>
                {p.counts && (
                  <div className="text-muted">
                    {p.counts.artists.toLocaleString()} artists · {p.counts.albums.toLocaleString()} albums · {p.counts.tracks.toLocaleString()} tracks
                  </div>
                )}
                <div className="mt-1 text-xs text-muted">
                  Last scan requested here: {relativeTime(p.last_scan_requested)}
                  {p.section?.scanned_at ? ` · Plex last scanned ${relativeTime(p.section.scanned_at)}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  loading={scan.isPending || !!p.refreshing}
                  onClick={() => scan.mutate(undefined)}
                  icon={<RefreshCw className="size-4" />}
                >
                  {p.refreshing ? "Scanning…" : "Scan library"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-start gap-2 text-sm">
              <span className="text-muted">{p?.message ?? "Unavailable"}</span>
              <Button size="sm" onClick={() => navigate("/settings")}>
                Open settings
              </Button>
            </div>
          )}
        </Tile>

        <Tile icon={<Wifi />} title="Soulseek" right={st && <StatusDot ok={st.soulseek.ok} />}>
          {st ? (
            <div className="flex flex-col items-start gap-2 text-sm">
              <span className={st.soulseek.ok ? "text-text" : "text-muted"}>{st.soulseek.message}</span>
              {!st.soulseek.ok && (
                <Button size="sm" onClick={() => navigate("/settings")}>
                  Check slskd settings
                </Button>
              )}
            </div>
          ) : (
            <Spinner />
          )}
        </Tile>

        <Tile
          icon={<Download />}
          title="Downloads"
          right={
            <Link to="/downloads" className="text-sm text-accent">
              View all
            </Link>
          }
        >
          {active.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <CheckCircle2 className="size-4" /> Nothing downloading right now.
            </div>
          ) : (
            <>
              <div className="text-sm">
                {active.length} active · {bytes(totalDone)} of {bytes(totalAll)}
                {totalSpeed > 0 && <span className="text-muted"> · {speed(totalSpeed)}</span>}
              </div>
              <ProgressBar value={totalAll ? (totalDone / totalAll) * 100 : 0} />
              <ul className="flex flex-col gap-1 text-xs text-muted">
                {active.slice(0, 4).map((j) => (
                  <li key={j.id} className="flex justify-between gap-2">
                    <span className="truncate">{j.title}</span>
                    <span className="shrink-0">{j.speed > 0 ? eta(j.eta_seconds) : "queued"}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Tile>

        <Tile icon={<HardDrive />} title="Storage" right={st && <StatusDot ok={st.storage.ok && usedPct < 90} warn={st.storage.ok} />}>
          {st ? (
            <div className="flex flex-col gap-2 text-sm">
              {!st.storage.ok && (
                <div className="flex items-start gap-2 text-danger">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {st.storage.reason}
                </div>
              )}
              {disk && (
                <>
                  <ProgressBar value={usedPct} tone={usedPct > 90 ? "danger" : "accent"} />
                  <div className="text-muted">
                    {bytes(disk.free)} free of {bytes(disk.total)} ({usedPct.toFixed(0)}% used)
                  </div>
                </>
              )}
              <div className="text-xs text-muted">
                Trash: {bytes(st.trash_size)} ·{" "}
                <Link to="/trash" className="text-accent">
                  open
                </Link>{" "}
                · Filesystem: {st.storage.fs_type}
              </div>
            </div>
          ) : (
            <Spinner />
          )}
        </Tile>
      </div>
    </div>
  );
}

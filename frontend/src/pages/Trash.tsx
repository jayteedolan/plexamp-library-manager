import { useQuery, useQueryClient } from "@tanstack/react-query";
import { File, FolderClosed, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Card, EmptyState, PageHeader, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { bytes, displayPath, relativeTime } from "../lib/format";
import type { TrashItem } from "../lib/types";
import { choose, confirm } from "../store/dialogs";
import { toast } from "../store/toasts";

interface TrashList {
  retention_days: number;
  total_size: number;
  items: TrashItem[];
}

export function TrashPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["trash"], queryFn: () => api.get<TrashList>("/api/trash") });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["trash"] });
    qc.invalidateQueries({ queryKey: ["files"] });
    qc.invalidateQueries({ queryKey: ["status"] });
  };

  const restore = async (item: TrashItem, resolution?: string) => {
    setBusy(item.id);
    try {
      const r = await api.post<{ restored_to: string }>(`/api/trash/${item.id}/restore`, { resolution: resolution ?? null });
      toast.ok(`Restored to ${displayPath(r.restored_to)}`);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const choice = await choose("Something is already there", e.message, [
          { label: "Cancel", value: null, variant: "secondary" },
          { label: "Replace it", value: "replace", variant: "danger" },
          { label: "Keep both", value: "keep_both", variant: "primary" },
        ]);
        if (choice) await restore(item, choice);
      } else toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const purge = async (item: TrashItem) => {
    if (!(await confirm("Delete permanently?", `“${item.name}” will be deleted forever.`, "Delete forever", true))) return;
    try {
      await api.del(`/api/trash/${item.id}`);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const empty = async () => {
    if (!(await confirm("Empty the Trash?", "Everything in the Trash will be deleted forever. This cannot be undone.", "Empty Trash", true))) return;
    try {
      const r = await api.post<{ deleted: number }>("/api/trash/empty");
      toast.ok(`Deleted ${r.deleted} item(s) permanently`);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const data = q.data;
  return (
    <div>
      <PageHeader
        title="Trash"
        subtitle={data ? `${data.items.length} item(s) · ${bytes(data.total_size)} · items are deleted automatically after ${data.retention_days} days` : undefined}
        actions={
          data?.items.length ? (
            <Button variant="danger" onClick={empty} icon={<Trash2 className="size-4" />}>
              Empty Trash
            </Button>
          ) : undefined
        }
      />
      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !data?.items.length ? (
        <EmptyState icon={<Trash2 />} title="The Trash is empty">
          Deleted files and folders land here so you can restore them.
        </EmptyState>
      ) : (
        <Card className="p-0">
          <ul>
            {data.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 border-b border-border/60 px-3 py-3 last:border-0 sm:flex-nowrap sm:px-4">
                {item.is_dir ? <FolderClosed className="size-5 shrink-0 text-accent" /> : <File className="size-5 shrink-0 text-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="truncate text-xs text-muted">
                    from {displayPath(item.original_path.split("/").slice(0, -1).join("/"))} · {bytes(item.size)} · deleted {relativeTime(item.deleted_at)}
                  </div>
                </div>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" loading={busy === item.id} onClick={() => restore(item)} icon={<RotateCcw className="size-4" />}>
                    Restore
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => purge(item)} aria-label={`Delete ${item.name} permanently`}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

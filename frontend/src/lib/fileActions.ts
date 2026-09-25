import { resolveConflicts } from "../components/explorer/ConflictDialog";
import { useOps } from "../store/ops";
import { toast, useToasts } from "../store/toasts";
import { api, ApiError } from "./api";
import { baseName, bytes, parentPath } from "./format";
import type { Conflict, FsEntry, Operation } from "./types";

/** Copy or move items, asking about name clashes and showing progress for long copies. */
export async function transfer(
  sources: string[],
  destination: string,
  mode: "copy" | "move",
  opts: { undoable?: boolean } = { undoable: true },
): Promise<Operation | null> {
  let resolutions: Record<string, string> = {};
  let op: Operation;
  for (;;) {
    try {
      op = await api.post<Operation>("/api/files/transfer", { sources, destination, mode, resolutions });
      break;
    } catch (e) {
      const conflicts = (e as ApiError).extra as { conflicts?: Conflict[] } | undefined;
      if (e instanceof ApiError && e.status === 409 && conflicts?.conflicts) {
        const r = await resolveConflicts(conflicts.conflicts);
        if (!r) return null;
        resolutions = { ...resolutions, ...r };
        continue;
      }
      toast.error(e);
      return null;
    }
  }
  if (!op.finished) op = await trackOperation(op);
  reportTransfer(op, mode, opts.undoable ?? true);
  return op;
}

function trackOperation(initial: Operation): Promise<Operation> {
  const verb = initial.kind === "copy" ? "Copying" : "Moving";
  const store = useToasts.getState();
  const id = store.push(
    {
      message: `${verb}…`,
      tone: "info",
      sticky: true,
      progress: 0,
      onCancel: () => api.post(`/api/ops/${initial.id}/cancel`).catch(() => {}),
    },
    0,
  );
  return new Promise((resolve) => {
    let finished = false;
    const finish = (op: Operation) => {
      if (finished) return;
      finished = true;
      unwatch();
      clearInterval(poll);
      useToasts.getState().dismiss(id);
      resolve(op);
    };
    const onUpdate = (op: Operation) => {
      if (op.finished) return finish(op);
      const pct = op.total_bytes ? (op.done_bytes / op.total_bytes) * 100 : 0;
      useToasts
        .getState()
        .update(id, { progress: pct, message: `${verb} ${op.current || ""} · ${bytes(op.done_bytes)} of ${bytes(op.total_bytes)}` });
    };
    const unwatch = useOps.getState().watch(initial.id, onUpdate);
    // Poll as a fallback in case the event stream is down.
    const poll = setInterval(() => {
      api.get<Operation>(`/api/ops/${initial.id}`).then(onUpdate).catch(() => {});
    }, 2000);
  });
}

function reportTransfer(op: Operation, mode: "copy" | "move", undoable: boolean) {
  if (op.error) {
    toast.error(op.error);
    return;
  }
  const done = op.results.filter((r) => r.status === "done");
  const skipped = op.results.filter((r) => r.status === "skipped").length;
  const cancelled = op.results.filter((r) => r.status === "cancelled").length;
  const renamed = done.filter((r) => r.renamed).length;
  const parts = [`${mode === "copy" ? "Copied" : "Moved"} ${done.length} item${done.length === 1 ? "" : "s"}`];
  if (renamed) parts.push(`${renamed} renamed to avoid clashes`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  const undo =
    undoable && mode === "move" && done.length
      ? {
          label: "Undo",
          run: async () => {
            // Move each item back to the folder it came from.
            const byParent = new Map<string, string[]>();
            for (const r of done) {
              const back = parentPath(r.source);
              byParent.set(back, [...(byParent.get(back) ?? []), r.target!]);
            }
            for (const [dest, srcs] of byParent) await transfer(srcs, dest, "move", { undoable: false });
          },
        }
      : undefined;
  toast.ok(parts.join(" · "), undo);
}

export async function deleteItems(paths: string[]) {
  try {
    const r = await api.post<{ trashed: { id: string }[] }>("/api/files/delete", { paths });
    const n = r.trashed.length;
    toast.ok(`Moved ${n} item${n === 1 ? "" : "s"} to the Trash`, {
      label: "Undo",
      run: async () => {
        try {
          for (const t of r.trashed) await api.post(`/api/trash/${t.id}/restore`, {});
          toast.ok("Restored");
        } catch (e) {
          toast.error(e);
        }
      },
    });
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  }
}

export async function renameItem(entry: FsEntry, newName: string) {
  try {
    const r = await api.post<FsEntry>("/api/files/rename", { path: entry.path, name: newName });
    toast.ok(`Renamed to ${r.name}`, {
      label: "Undo",
      run: () => {
        api.post("/api/files/rename", { path: r.path, name: baseName(entry.path) }).catch(toast.error);
      },
    });
    return r;
  } catch (e) {
    toast.error(e);
    return null;
  }
}

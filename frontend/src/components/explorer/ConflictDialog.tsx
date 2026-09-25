import { useEffect, useState } from "react";
import { create } from "zustand";
import { bytes, dateTime } from "../../lib/format";
import type { Conflict } from "../../lib/types";
import { Badge, Button, Modal, cx } from "../ui";

export type Resolution = "replace" | "keep_both" | "skip";

interface State {
  conflicts: Conflict[] | null;
  resolve: ((r: Record<string, Resolution> | null) => void) | null;
  open: (c: Conflict[], resolve: (r: Record<string, Resolution> | null) => void) => void;
  close: () => void;
}

const useConflicts = create<State>((set) => ({
  conflicts: null,
  resolve: null,
  open: (conflicts, resolve) => set({ conflicts, resolve }),
  close: () => set({ conflicts: null, resolve: null }),
}));

/** Ask the user what to do with each name clash. Resolves null when cancelled. */
export function resolveConflicts(conflicts: Conflict[]): Promise<Record<string, Resolution> | null> {
  return new Promise((resolve) => useConflicts.getState().open(conflicts, resolve));
}

const LABELS: Record<Resolution, string> = { replace: "Replace", keep_both: "Keep both", skip: "Skip" };

function Side({ title, info, better }: { title: string; info: Conflict["existing"]; better?: boolean }) {
  return (
    <div className={cx("flex-1 rounded-lg border p-2 text-xs", better ? "border-ok/50" : "border-border")}>
      <div className="mb-1 font-medium text-text">{title}</div>
      <div className="text-muted">{info.is_dir ? "Folder" : info.quality ?? "File"}</div>
      <div className="text-muted">{bytes(info.size)}</div>
      <div className="text-muted">{dateTime(info.mtime)}</div>
    </div>
  );
}

export function ConflictHost() {
  const { conflicts, resolve, close } = useConflicts();
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  useEffect(() => {
    if (conflicts) setChoices(Object.fromEntries(conflicts.map((c) => [c.name, "keep_both" as Resolution])));
  }, [conflicts]);
  if (!conflicts || !resolve) return null;

  const done = (r: Record<string, Resolution> | null) => {
    close();
    resolve(r);
  };
  const all = (r: Resolution) => setChoices(Object.fromEntries(conflicts.map((c) => [c.name, r])));

  return (
    <Modal
      open
      wide
      title={conflicts.length === 1 ? "An item with this name already exists" : `${conflicts.length} items already exist`}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => done(choices)}>
            Continue
          </Button>
        </>
      }
    >
      {conflicts.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Apply to all:</span>
          {(Object.keys(LABELS) as Resolution[]).map((r) => (
            <Button key={r} size="sm" onClick={() => all(r)}>
              {LABELS[r]}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {conflicts.map((c) => (
          <div key={c.name} className="rounded-xl border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="truncate font-medium">{c.name}</span>
              {c.existing.is_dir && c.incoming.is_dir && <Badge>folders are not merged</Badge>}
            </div>
            <div className="mb-2 flex gap-2">
              <Side title="Already there" info={c.existing} />
              <Side title="Incoming" info={c.incoming} />
            </div>
            <div className="flex gap-1" role="radiogroup" aria-label={`What to do with ${c.name}`}>
              {(Object.keys(LABELS) as Resolution[]).map((r) => (
                <button
                  key={r}
                  role="radio"
                  aria-checked={choices[c.name] === r}
                  onClick={() => setChoices((s) => ({ ...s, [c.name]: r }))}
                  className={cx(
                    "h-9 flex-1 rounded-lg border text-sm",
                    choices[c.name] === r ? "border-accent bg-accent/15 text-accent" : "border-border text-muted",
                  )}
                >
                  {LABELS[r]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">Replaced items go to the Trash, so you can restore them later.</p>
    </Modal>
  );
}

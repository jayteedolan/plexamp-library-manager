import { useEffect, useState } from "react";
import { create } from "zustand";
import { Button, Modal, inputClass } from "../components/ui";

interface ChoiceOption<T> {
  label: string;
  value: T;
  variant?: "primary" | "secondary" | "danger";
}

type DialogRequest =
  | { kind: "choose"; title: string; message: React.ReactNode; options: ChoiceOption<unknown>[]; resolve: (v: unknown) => void }
  | { kind: "prompt"; title: string; label: string; initial: string; confirmLabel: string; resolve: (v: string | null) => void };

interface DialogState {
  current: DialogRequest | null;
  open: (d: DialogRequest) => void;
  close: () => void;
}

const useDialogs = create<DialogState>((set) => ({
  current: null,
  open: (d) => set({ current: d }),
  close: () => set({ current: null }),
}));

export function choose<T>(title: string, message: React.ReactNode, options: ChoiceOption<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    useDialogs.getState().open({
      kind: "choose",
      title,
      message,
      options: options as ChoiceOption<unknown>[],
      resolve: resolve as (v: unknown) => void,
    });
  });
}

export async function confirm(
  title: string,
  message: React.ReactNode,
  confirmLabel = "OK",
  danger = false,
): Promise<boolean> {
  const v = await choose(title, message, [
    { label: "Cancel", value: false, variant: "secondary" },
    { label: confirmLabel, value: true, variant: danger ? "danger" : "primary" },
  ]);
  return v === true;
}

export function prompt(title: string, label: string, initial = "", confirmLabel = "Save"): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().open({ kind: "prompt", title, label, initial, confirmLabel, resolve });
  });
}

export function DialogHost() {
  const { current, close } = useDialogs();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (current?.kind === "prompt") setValue(current.initial);
  }, [current]);

  if (!current) return null;
  const finish = (v: unknown) => {
    close();
    (current.resolve as (v: unknown) => void)(v);
  };

  if (current.kind === "prompt") {
    const submit = () => value.trim() && finish(value.trim());
    return (
      <Modal
        open
        title={current.title}
        onClose={() => finish(null)}
        footer={
          <>
            <Button onClick={() => finish(null)}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!value.trim()}>
              {current.confirmLabel}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{current.label}</span>
          <input
            className={inputClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            onFocus={(e) => {
              // Select the name without the extension, like desktop file managers do.
              const dot = e.target.value.lastIndexOf(".");
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
            }}
          />
        </label>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title={current.title}
      onClose={() => finish(null)}
      footer={current.options.map((o, i) => (
        <Button key={i} variant={o.variant ?? "secondary"} onClick={() => finish(o.value)} data-autofocus={i === current.options.length - 1 ? true : undefined}>
          {o.label}
        </Button>
      ))}
    >
      <div className="text-sm text-muted">{current.message}</div>
    </Modal>
  );
}

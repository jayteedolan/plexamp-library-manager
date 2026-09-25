import { create } from "zustand";
import type { Operation } from "../lib/types";

type Listener = (op: Operation) => void;

interface OpsState {
  ops: Record<string, Operation>;
  listeners: Record<string, Listener[]>;
  update: (op: Operation) => void;
  watch: (id: string, fn: Listener) => () => void;
}

export const useOps = create<OpsState>((set, get) => ({
  ops: {},
  listeners: {},
  update: (op) => {
    set((s) => ({ ops: { ...s.ops, [op.id]: op } }));
    for (const fn of get().listeners[op.id] ?? []) fn(op);
  },
  watch: (id, fn) => {
    set((s) => ({ listeners: { ...s.listeners, [id]: [...(s.listeners[id] ?? []), fn] } }));
    return () => set((s) => ({ listeners: { ...s.listeners, [id]: (s.listeners[id] ?? []).filter((f) => f !== fn) } }));
  },
}));

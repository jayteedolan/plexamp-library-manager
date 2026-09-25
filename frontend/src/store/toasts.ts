import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "ok" | "error";
  action?: { label: string; run: () => void };
  progress?: number; // 0-100 for long operations
  onCancel?: () => void;
  sticky?: boolean;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ttl?: number) => number;
  update: (id: number, patch: Partial<Toast>, ttl?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ttl = 5000) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    if (!t.sticky) timers.set(id, setTimeout(() => get().dismiss(id), ttl));
    return id;
  },
  update: (id, patch, ttl) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    if (ttl) {
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => get().dismiss(id), ttl));
    }
  },
  dismiss: (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = {
  ok: (message: string, action?: Toast["action"]) =>
    useToasts.getState().push({ message, tone: "ok", action }, action ? 10000 : 4000),
  info: (message: string) => useToasts.getState().push({ message, tone: "info" }),
  error: (err: unknown) =>
    useToasts.getState().push({ message: err instanceof Error ? err.message : String(err), tone: "error" }, 8000),
};

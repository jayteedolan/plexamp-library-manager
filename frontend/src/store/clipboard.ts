import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ClipboardState {
  mode: "cut" | "copy" | null;
  paths: string[];
  set: (mode: "cut" | "copy", paths: string[]) => void;
  clear: () => void;
}

/** Explorer clipboard; survives navigation and reloads (per device). */
export const useClipboard = create<ClipboardState>()(
  persist(
    (set) => ({
      mode: null,
      paths: [],
      set: (mode, paths) => set({ mode, paths }),
      clear: () => set({ mode: null, paths: [] }),
    }),
    {
      name: "lm-clipboard",
      storage: {
        getItem: (k) => {
          try {
            const v = localStorage.getItem(k);
            return v ? JSON.parse(v) : null;
          } catch {
            return null;
          }
        },
        setItem: (k, v) => {
          try {
            localStorage.setItem(k, JSON.stringify(v));
          } catch {
            /* storage unavailable: clipboard just won't persist */
          }
        },
        removeItem: (k) => {
          try {
            localStorage.removeItem(k);
          } catch {
            /* ignore */
          }
        },
      },
    },
  ),
);

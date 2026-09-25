import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useOps } from "../store/ops";
import type { Job, Operation } from "./types";

/** Subscribes to server-sent events and keeps React Query caches fresh across tabs and devices. */
export function useServerEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      es = new EventSource("/api/events", { withCredentials: true });
      es.addEventListener("hello", () => {
        // Anything could have changed while disconnected.
        qc.invalidateQueries();
      });
      es.addEventListener("fs", () => {
        qc.invalidateQueries({ queryKey: ["files"] });
      });
      es.addEventListener("trash", () => {
        qc.invalidateQueries({ queryKey: ["trash"] });
        qc.invalidateQueries({ queryKey: ["status"] });
      });
      es.addEventListener("download", (e) => {
        const job = JSON.parse((e as MessageEvent).data) as Job;
        qc.setQueryData<Job[]>(["downloads"], (old) => {
          if (!old) return old;
          const i = old.findIndex((j) => j.id === job.id);
          if (i === -1) return [job, ...old];
          const copy = old.slice();
          copy[i] = job;
          return copy;
        });
        qc.setQueryData(["download", job.id], job);
        if (job.status !== "active") qc.invalidateQueries({ queryKey: ["status"] });
      });
      es.addEventListener("op", (e) => {
        useOps.getState().update(JSON.parse((e as MessageEvent).data) as Operation);
      });
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [enabled, qc]);
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "../store/toasts";
import { api } from "./api";
import type { PlexStatus } from "./types";

export function usePlexStatus() {
  return useQuery({
    queryKey: ["plex"],
    queryFn: () => api.get<PlexStatus>("/api/plex/status"),
    refetchInterval: (q) => (q.state.data?.refreshing ? 4000 : 30000),
  });
}

export function useScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path?: string) => api.post<{ started: boolean; message: string }>("/api/plex/scan", { path: path ?? null }),
    onSuccess: (r) => {
      if (r.started) toast.ok(r.message);
      else toast.info(r.message);
      setTimeout(() => qc.invalidateQueries({ queryKey: ["plex"] }), 1500);
    },
    onError: (e) => toast.error(e),
  });
}

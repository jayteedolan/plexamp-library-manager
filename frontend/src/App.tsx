import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { ConflictHost } from "./components/explorer/ConflictDialog";
import { Layout } from "./components/Layout";
import { Toaster } from "./components/Toaster";
import { Spinner } from "./components/ui";
import { api, setUnauthorizedHandler } from "./lib/api";
import { useServerEvents } from "./lib/events";
import { Dashboard } from "./pages/Dashboard";
import { Downloads } from "./pages/Downloads";
import { FileDownload } from "./pages/FileDownload";
import { Library } from "./pages/Library";
import { Login } from "./pages/Login";
import { SearchPage } from "./pages/Search";
import { SettingsPage } from "./pages/Settings";
import { TrashPage } from "./pages/Trash";
import { DialogHost } from "./store/dialogs";

interface AuthStatus {
  setup_required: boolean;
  authenticated: boolean;
  username: string | null;
}

export function App() {
  const qc = useQueryClient();
  const auth = useQuery({
    queryKey: ["auth"],
    queryFn: () => api.get<AuthStatus>("/api/auth/status"),
    staleTime: Infinity,
    retry: 3,
  });
  const authed = !!auth.data?.authenticated;

  useEffect(() => {
    // Any 401 (expired session) shows the login screen; the current URL is kept so you land back here.
    setUnauthorizedHandler(() => qc.setQueryData<AuthStatus>(["auth"], (a) => (a ? { ...a, authenticated: false } : a)));
  }, [qc]);
  useServerEvents(authed);

  if (auth.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (auth.error || !auth.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="font-semibold">Can’t reach the Library Manager server</div>
        <div className="text-sm text-muted">{(auth.error as Error)?.message}</div>
      </div>
    );
  }
  if (!authed) {
    return (
      <>
        <Login setup={auth.data.setup_required} onDone={() => qc.invalidateQueries()} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="downloads" element={<Downloads />} />
          <Route path="downloads/:id/file" element={<FileDownload />} />
          <Route path="library" element={<Library />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
      <DialogHost />
      <ConflictHost />
    </>
  );
}

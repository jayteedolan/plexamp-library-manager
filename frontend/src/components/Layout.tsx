import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, FolderOpen, Home, Music2, Search, Settings, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../lib/api";
import type { SystemStatus } from "../lib/types";
import { Toaster } from "./Toaster";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", short: "Home", icon: Home, end: true },
  { to: "/search", label: "Search", short: "Search", icon: Search },
  { to: "/downloads", label: "Downloads", short: "Downloads", icon: Download },
  { to: "/library", label: "Library", short: "Library", icon: FolderOpen },
  { to: "/trash", label: "Trash", short: "Trash", icon: Trash2 },
];

export function useSystemStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.get<SystemStatus>("/api/status"),
    refetchInterval: 20000,
  });
}

function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-bold leading-5 text-accent-contrast">{n}</span>;
}

export function Layout() {
  const status = useSystemStatus();
  const dl = status.data?.downloads;
  const badge = (to: string) => (to === "/downloads" && dl ? dl.active + dl.ready + dl.awaiting_decision : 0);
  const storage = status.data?.storage;

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-contrast">
            <Music2 className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold">Library Manager</div>
            <div className="text-xs text-muted">Plex music</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {[...NAV, { to: "/settings", label: "Settings", short: "Settings", icon: Settings }].map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={"end" in n ? n.end : false}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition",
                  isActive ? "bg-accent/15 font-semibold text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
                )
              }
            >
              <n.icon className="size-5" />
              {n.label}
              <Count n={badge(n.to)} />
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header. Sticky so iOS home-screen apps see a pinned top bar and extend its color into
            the top edge instead of blurring it; the padding keeps content clear of that edge either way. */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 md:hidden">
          <div className="flex items-center gap-2 font-semibold">
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-contrast">
              <Music2 className="size-4" />
            </div>
            Library Manager
          </div>
          <NavLink to="/settings" aria-label="Settings" className="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
            <Settings className="size-5" />
          </NavLink>
        </header>

        {storage && !storage.ok && (
          <div role="alert" className="flex items-start gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{storage.reason}</span>
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6">
            <Outlet />
          </div>
        </main>

        {/* Mobile tab bar */}
        <nav className="pb-safe grid grid-cols-5 border-t border-border bg-surface md:hidden">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx("relative flex flex-col items-center gap-0.5 py-2 text-[11px]", isActive ? "text-accent" : "text-muted")
              }
            >
              <n.icon className="size-5" />
              {n.short}
              {badge(n.to) > 0 && (
                <span className="absolute top-1 left-1/2 ml-2 rounded-full bg-accent px-1 text-[10px] font-bold leading-4 text-accent-contrast">
                  {badge(n.to)}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
      <Toaster />
    </div>
  );
}

export function FullHeight({ children }: { children: ReactNode }) {
  // Pages like the explorer fill the viewport and scroll internally.
  return <div className="flex min-h-[28rem] flex-1 flex-col md:h-[calc(100dvh-3rem)] md:flex-none">{children}</div>;
}

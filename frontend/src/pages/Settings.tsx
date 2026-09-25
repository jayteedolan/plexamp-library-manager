import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LogOut, ShieldOff, XCircle } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button, Card, Field, PageHeader, Spinner, inputClass } from "../components/ui";
import { api } from "../lib/api";
import type { AuthStatus, PlexSection, SettingsView } from "../lib/types";
import { toast } from "../store/toasts";

interface TestResult {
  ok: boolean;
  message: string;
  sections?: PlexSection[];
}

function Result({ r }: { r: TestResult | null }) {
  if (!r) return null;
  return (
    <div className={`flex items-start gap-2 text-sm ${r.ok ? "text-ok" : "text-danger"}`}>
      {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      {r.message}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="mb-4">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="mt-1 mb-4 text-sm text-muted">{description}</p>}
      <div className="flex flex-col gap-4">{children}</div>
    </Card>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsView>("/api/settings") });
  const [form, setForm] = useState({
    slskd_url: "",
    slskd_api_key: "",
    plex_url: "",
    plex_token: "",
    plex_section_id: "",
    plex_library_path: "",
    trash_retention_days: 30,
  });
  const [slskdTest, setSlskdTest] = useState<TestResult | null>(null);
  const [plexTest, setPlexTest] = useState<TestResult | null>(null);
  const [sections, setSections] = useState<PlexSection[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setForm((f) => ({ ...f, ...q.data, slskd_api_key: "", plex_token: "" }));
  }, [q.data]);

  const upd = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: k === "trash_retention_days" ? Number(e.target.value) : e.target.value }));

  const testSlskd = async () => {
    setTesting("slskd");
    try {
      setSlskdTest(await api.post<TestResult>("/api/settings/test-slskd", { url: form.slskd_url, api_key: form.slskd_api_key || null }));
    } catch (e) {
      setSlskdTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(null);
    }
  };

  const testPlex = async () => {
    setTesting("plex");
    try {
      const r = await api.post<TestResult>("/api/plex/test", { url: form.plex_url, token: form.plex_token || null });
      setPlexTest(r);
      setSections(r.sections ?? []);
      if (r.sections?.length === 1 && !form.plex_section_id) setForm((f) => ({ ...f, plex_section_id: r.sections![0].id }));
    } catch (e) {
      setPlexTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(null);
    }
  };

  useEffect(() => {
    // Load the library list once when Plex is already configured.
    if (q.data?.plex_token_set && sections.length === 0) {
      api
        .post<TestResult>("/api/plex/test", {})
        .then((r) => setSections(r.sections ?? []))
        .catch(() => {});
    }
  }, [q.data?.plex_token_set]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put("/api/settings", form);
      toast.ok("Settings saved");
      qc.invalidateQueries();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (q.isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  const selectedSection = sections.find((s) => s.id === form.plex_section_id);

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" />
      <form onSubmit={save}>
        <Section title="Soulseek (slskd)" description="Library Manager uses slskd to search and download. Create an API key in slskd's settings (web.authentication.api_keys).">
          <Field label="slskd URL" hint="From inside Docker this is usually http://slskd:5030 or http://host.docker.internal:5030">
            <input className={inputClass} value={form.slskd_url} onChange={upd("slskd_url")} placeholder="http://slskd:5030" />
          </Field>
          <Field label="API key" hint={q.data?.slskd_api_key_set ? "A key is saved. Leave blank to keep it." : "Not set yet."}>
            <input className={inputClass} type="password" value={form.slskd_api_key} onChange={upd("slskd_api_key")} autoComplete="off" />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={testSlskd} loading={testing === "slskd"}>
              Test connection
            </Button>
            <Result r={slskdTest} />
          </div>
        </Section>

        <Section
          title="Plex"
          description={
            <>
              Find your token in Plex's <code>Preferences.xml</code> (<code>PlexOnlineToken</code>) or via “View XML” on any item in Plex Web.
            </>
          }
        >
          <Field label="Plex URL" hint="Plex runs on the Pi itself: http://host.docker.internal:32400">
            <input className={inputClass} value={form.plex_url} onChange={upd("plex_url")} />
          </Field>
          <Field label="Plex token" hint={q.data?.plex_token_set ? "A token is saved. Leave blank to keep it." : "Not set yet."}>
            <input className={inputClass} type="password" value={form.plex_token} onChange={upd("plex_token")} autoComplete="off" />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={testPlex} loading={testing === "plex"}>
              Test &amp; list libraries
            </Button>
            <Result r={plexTest} />
          </div>
          <Field label="Music library">
            <select className={inputClass} value={form.plex_section_id} onChange={upd("plex_section_id")}>
              <option value="">— choose —</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.locations.join(", ")})
                </option>
              ))}
              {form.plex_section_id && !sections.some((s) => s.id === form.plex_section_id) && (
                <option value={form.plex_section_id}>Library #{form.plex_section_id}</option>
              )}
            </select>
          </Field>
          <Field
            label="Library folder as Plex sees it"
            hint={
              <>
                Used for targeted folder scans.
                {selectedSection?.locations.length ? <> Plex reports: {selectedSection.locations.join(", ")}</> : null}
              </>
            }
          >
            <input className={inputClass} value={form.plex_library_path} onChange={upd("plex_library_path")} />
          </Field>
        </Section>

        <Section title="Trash">
          <Field label="Delete items from the Trash after (days)">
            <input className={inputClass} type="number" min={1} max={365} value={form.trash_retention_days} onChange={upd("trash_retention_days")} />
          </Field>
        </Section>

        <div className="mb-8 flex justify-end">
          <Button type="submit" variant="primary" loading={saving}>
            Save settings
          </Button>
        </div>
      </form>

      <AccountSection />
    </div>
  );
}

function AccountSection() {
  const qc = useQueryClient();
  // Shares the cache with App.tsx's own auth check, so this is a free read in practice.
  const auth = useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthStatus>("/api/auth/status") });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  if (auth.data && !auth.data.auth_enabled) {
    return (
      <Section title="Account">
        <div className="flex items-start gap-2 text-sm text-muted">
          <ShieldOff className="mt-0.5 size-4 shrink-0" />
          <span>
            Login is turned off for this instance (<code>AUTH_ENABLED=false</code>), so there's no account to manage here. Anything
            that can reach this server can use it without signing in.
          </span>
        </div>
      </Section>
    );
  }

  const change = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>("/api/auth/password", { current_password: current, new_password: next });
      toast.ok(r.message);
      qc.invalidateQueries({ queryKey: ["auth"] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api.post("/api/auth/logout").catch(() => {});
    qc.invalidateQueries({ queryKey: ["auth"] });
  };

  return (
    <Section title="Account">
      <form onSubmit={change} className="flex flex-col gap-4">
        <Field label="Current password">
          <input className={inputClass} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" hint="At least 10 characters. Changing it signs out all devices.">
          <input className={inputClass} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="flex flex-wrap justify-between gap-2">
          <Button type="button" variant="ghost" onClick={logout} icon={<LogOut className="size-4" />}>
            Sign out
          </Button>
          <Button type="submit" loading={busy} disabled={!current || next.length < 10}>
            Change password
          </Button>
        </div>
      </form>
    </Section>
  );
}

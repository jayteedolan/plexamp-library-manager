import { Music2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Card, Field, inputClass } from "../components/ui";
import { api } from "../lib/api";

export function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState(setup ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.post(setup ? "/api/auth/setup" : "/api/auth/login", { username, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-contrast">
            <Music2 className="size-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">{setup ? "Create your admin account" : "Sign in"}</h1>
            <p className="text-sm text-muted">
              {setup ? "This account is the only one that can use Library Manager." : "Plex Library Manager"}
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Username">
            <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
          </Field>
          <Field label="Password" hint={setup ? "At least 10 characters." : undefined}>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setup ? "new-password" : "current-password"}
              required
            />
          </Field>
          {setup && (
            <Field label="Repeat password">
              <input className={inputClass} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </Field>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy}>
            {setup ? "Create account" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

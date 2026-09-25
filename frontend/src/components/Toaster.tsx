import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToasts } from "../store/toasts";
import { Button, ProgressBar, cx } from "./ui";

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div
      aria-live="polite"
      className="pt-safe pointer-events-none fixed inset-x-0 top-2 z-[60] flex flex-col items-center gap-2 px-3 md:top-4 md:right-6 md:left-auto md:items-end"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border bg-surface px-3 py-3 text-sm shadow-xl",
            t.tone === "error" ? "border-danger/50" : "border-border",
          )}
        >
          {t.tone === "ok" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
          ) : t.tone === "error" ? (
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-accent" />
          )}
          <div className="min-w-0 flex-1">
            <div className="break-words">{t.message}</div>
            {t.progress !== undefined && <ProgressBar className="mt-2" value={t.progress} />}
          </div>
          {t.action && (
            <Button
              size="sm"
              variant="ghost"
              className="-my-1 text-accent"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </Button>
          )}
          {t.onCancel ? (
            <Button size="sm" variant="ghost" className="-my-1" onClick={t.onCancel}>
              Cancel
            </Button>
          ) : (
            <button aria-label="Dismiss" className="text-muted hover:text-text" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

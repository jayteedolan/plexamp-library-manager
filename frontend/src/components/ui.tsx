import { Loader2, X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from "react";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:brightness-110 font-semibold",
  secondary: "bg-surface-2 text-text hover:bg-border border border-border",
  ghost: "text-text hover:bg-surface-2",
  danger: "bg-danger text-white hover:brightness-110 font-semibold",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg transition select-none whitespace-nowrap",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-sm",
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-text transition hover:bg-surface-2",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        active && "bg-surface-2 text-accent",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl border border-border bg-surface p-4", className)}>{children}</div>;
}

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent" | "tier1" | "tier2" | "tier3" | "tier4";
  className?: string;
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-muted border-border",
    ok: "text-ok border-ok/40 bg-ok/10",
    warn: "text-warn border-warn/40 bg-warn/10",
    danger: "text-danger border-danger/40 bg-danger/10",
    accent: "text-accent border-accent/40 bg-accent/10",
    tier1: "text-tier1 border-tier1/40 bg-tier1/10",
    tier2: "text-tier2 border-tier2/40 bg-tier2/10",
    tier3: "text-tier3 border-tier3/40 bg-tier3/10",
    tier4: "text-tier4 border-tier4/40 bg-tier4/10",
  };
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ProgressBar({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "ok" | "danger" }) {
  const pct = Math.max(0, Math.min(100, value));
  const color = tone === "ok" ? "bg-ok" : tone === "danger" ? "bg-danger" : "bg-accent";
  return (
    <div
      className={cx("h-2 w-full overflow-hidden rounded-full bg-surface-2", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cx("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-muted", className)} />;
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted">
      {icon && <div className="text-muted [&>svg]:size-10">{icon}</div>}
      <div className="font-medium text-text">{title}</div>
      {children && <div className="max-w-md text-sm">{children}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button[data-autofocus]");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx(
          "pb-safe flex max-h-[90dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-2xl sm:rounded-2xl",
          wide ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X className="size-5" />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none";

export function PageHeader({ title, actions, subtitle }: { title: string; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

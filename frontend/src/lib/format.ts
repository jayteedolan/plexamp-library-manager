export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function speed(bps: number | null | undefined): string {
  if (!bps) return "–";
  return `${bytes(bps)}/s`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function eta(seconds: number | null | undefined): string {
  if (!seconds) return "";
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

export function relativeTime(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return "never";
  const t = typeof input === "number" ? input * 1000 : Date.parse(input.endsWith("Z") || input.includes("+") ? input : input + "Z");
  const diff = (Date.now() - t) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function dateTime(mtime: number): string {
  return new Date(mtime * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(0, i);
}

export function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export const ROOT_LABELS: Record<string, string> = { library: "Library", staging: "Staging" };

export function displayPath(p: string): string {
  const [root, ...rest] = p.split("/");
  return [ROOT_LABELS[root] ?? root, ...rest].join(" / ");
}

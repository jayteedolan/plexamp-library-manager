export class ApiError extends Error {
  status: number;
  extra: unknown;
  constructor(status: number, message: string, extra?: unknown) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(fn: UnauthorizedHandler) {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "lm" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check your connection (is Tailscale on?).");
  }
  if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized();
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const d = data as { detail?: unknown; extra?: unknown } | null;
    const msg =
      typeof d?.detail === "string"
        ? d.detail
        : Array.isArray(d?.detail)
          ? "Invalid request."
          : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, d?.extra);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T>(url: string, body: unknown = {}) => request<T>("PUT", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export function qs(params: Record<string, string | number | boolean | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
}

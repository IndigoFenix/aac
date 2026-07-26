import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { API_BASE_URL } from "./api-base";
import { getHost } from "./platform";
import { pushLog } from "./debug-log";

// API_BASE_URL is resolved per environment (staging/demo/electron/dev) in
// api-base.ts. An empty string means same-origin.

// ── iPad cookie fix ─────────────────────────────────────────────────────────
// On the Capacitor (iPad) host the app is served from capacitor://localhost and
// the backend is a cross-origin https server. WKWebView treats the server's
// session cookie (SameSite=None) as third-party and, under ITP, refuses to
// store or send it — so `credentials: "include"` silently carries no cookie and
// every authed request 401s (the login flow flashes the institute page, then
// bounces back to login).
//
// The fix routes JSON API calls through CapacitorHttp, which performs the
// request in NATIVE code using the shared native cookie store — not subject to
// WKWebView's third-party-cookie rules. This is done ONLY on the Capacitor
// host; the web and Electron builds keep normal fetch (which also preserves
// fetch streaming those builds rely on). The plugin is invoked directly, so we
// deliberately do NOT enable CapacitorHttp's global fetch patch in
// capacitor.config.ts — streaming/EventSource/WebSocket stay on WKWebView.
const useNativeHttp = getHost() === "capacitor";

/** Build a standard Response from a CapacitorHttp result so callers keep using
 *  res.ok / res.status / res.json() / res.text() unchanged. Exported for tests. */
export function toResponse(result: { status: number; data: unknown; headers: Record<string, string> }): Response {
  const nullBody = result.status === 204 || result.status === 205 || result.status === 304;
  const body = nullBody
    ? null
    : typeof result.data === "string"
      ? result.data
      : result.data == null
        ? ""
        : JSON.stringify(result.data);
  let headers: Headers | undefined;
  try { headers = new Headers(result.headers ?? {}); } catch { headers = undefined; }
  return new Response(body, { status: result.status, headers });
}

/**
 * fetch() replacement that uses native HTTP on Capacitor (for cookies) and the
 * platform fetch everywhere else. Always sends credentials. FormData bodies
 * fall back to WKWebView fetch — CapacitorHttp can't marshal them, and the
 * native client never uploads files during the cookie-critical auth flow.
 */
async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();

  if (!useNativeHttp || init.body instanceof FormData) {
    return fetch(url, { credentials: "include", ...init });
  }

  try {
    const { CapacitorHttp } = await import("@capacitor/core");
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    // CapacitorHttp takes `data` (object or string); our bodies are JSON strings.
    let data: unknown;
    if (typeof init.body === "string") {
      try { data = JSON.parse(init.body); } catch { data = init.body; }
    }
    const result = await CapacitorHttp.request({ url, method, headers, data });
    return toResponse(result as { status: number; data: unknown; headers: Record<string, string> });
  } catch (err) {
    pushLog("error", ["[API] native request failed", method, url, err]);
    throw err;
  }
}

// Helper to join base + path safely — exported as apiUrl for img src etc.
export function apiUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, ""); // strip leading slashes
  // If API_BASE_URL is empty, this just returns "/path"
  return API_BASE_URL ? `${API_BASE_URL}/${cleanPath}` : `/${cleanPath}`;
}

export class ServiceUnavailableError extends Error {
  status = 503;
  code = "SERVICE_UNAVAILABLE" as const;
  constructor() {
    super("SERVICE_UNAVAILABLE");
    this.name = "ServiceUnavailableError";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ServiceUnavailableError();
    }
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

/**
 * Make an authenticated API request
 * Always includes credentials for session-based auth
 */
export async function apiRequest(
  method: string,
  path: string,
  data?: unknown,
): Promise<Response> {
  const url = apiUrl(path);

  // Check if data is FormData (for file uploads)
  const isFormData = data instanceof FormData;

  const res = await apiFetch(url, {
    method,
    // Don't set Content-Type for FormData - browser will set it with boundary
    headers: data && !isFormData ? { "Content-Type": "application/json" } : {},
    body: isFormData ? data : (data ? JSON.stringify(data) : undefined),
  });

  if (!res.ok) pushLog("warn", ["[API]", method, path, "→", res.status]);
  await throwIfResNotOk(res);
  return res;
}

/**
 * Make an authenticated GET request and return JSON
 */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await apiRequest("GET", path);
  return res.json();
}

/**
 * Make an authenticated POST request and return JSON
 */
export async function apiPost<T>(path: string, data?: unknown): Promise<T> {
  const res = await apiRequest("POST", path, data);
  return res.json();
}

/**
 * Make an authenticated PATCH request and return JSON
 */
export async function apiPatch<T>(path: string, data?: unknown): Promise<T> {
  const res = await apiRequest("PATCH", path, data);
  return res.json();
}

/**
 * Make a raw fetch with credentials (for cases where you need the Response object)
 */
export async function fetchWithAuth(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  // Accept both a bare API path ("/api/foo") and an already-resolved absolute
  // URL (StudentSelector passes `${apiBase}/...`), so callers that built the
  // URL themselves still get native-HTTP cookie handling on iPad.
  const url = /^https?:|^capacitor:|^app:/.test(path) ? path : apiUrl(path);
  return apiFetch(url, options);
}

type UnauthorizedBehavior = "returnNull" | "throw";

export function getQueryFn<T>(options: {
  on401: UnauthorizedBehavior;
}): QueryFunction<T | null> {
  const { on401: unauthorizedBehavior } = options;

  return async ({ queryKey }) => {
    const path =
      Array.isArray(queryKey) ? queryKey.join("/") : String(queryKey);

    const url = apiUrl(path);

    const res = await apiFetch(url);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null as any;
    }

    if (!res.ok) pushLog("warn", ["[API]", "GET", path, "→", res.status]);
    await throwIfResNotOk(res);
    return (await res.json()) as T;
  };
}

function isServiceUnavailable(error: unknown): boolean {
  return error instanceof ServiceUnavailableError;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: (failureCount, error) =>
        isServiceUnavailable(error) && failureCount < 5,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
    },
    mutations: {
      retry: (failureCount, error) =>
        isServiceUnavailable(error) && failureCount < 3,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
    },
  },
});

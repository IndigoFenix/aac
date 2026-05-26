import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Read and sanitize the base URL from Vite env
const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

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

export class UnauthorizedError extends Error {
  status = 401;
  code = "UNAUTHORIZED" as const;
  constructor(message?: string) {
    super(message || "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

// Global handler invoked when a request unexpectedly returns 401 — i.e. the
// session expired server-side. Registered by the AuthProvider so it can clear
// the cached auth state and bounce the user to the login page instead of
// letting every subsequent call fail with a raw error. Lives at module scope
// because apiRequest/getQueryFn run outside of React.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

function notifyUnauthorized() {
  onUnauthorized?.();
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ServiceUnavailableError();
    }
    const text = (await res.text()) || res.statusText;
    if (res.status === 401) {
      notifyUnauthorized();
      throw new UnauthorizedError(`${res.status}: ${text}`);
    }
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  path: string,
  data?: unknown,
): Promise<Response> {
  const url = apiUrl(path);

  // Check if data is FormData (for file uploads)
  const isFormData = data instanceof FormData;

  const res = await fetch(url, {
    method,
    // Don't set Content-Type for FormData - browser will set it with boundary
    headers: data && !isFormData ? { "Content-Type": "application/json" } : {},
    body: isFormData ? data : (data ? JSON.stringify(data) : undefined),
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
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

    const res = await fetch(url, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      // Returning null explicitly when configured to do so
      return null as any; // still satisfies QueryFunction<T | null>
    }

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


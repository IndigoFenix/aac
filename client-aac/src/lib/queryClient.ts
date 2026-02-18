import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Read and sanitize the base URL from Vite env
const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

// Helper to join base + path safely — exported as apiUrl for img src etc.
export function apiUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, ""); // strip leading slashes
  // If API_BASE_URL is empty, this just returns "/path"
  return API_BASE_URL ? `${API_BASE_URL}/${cleanPath}` : `/${cleanPath}`;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
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
  const url = apiUrl(path);
  return fetch(url, {
    ...options,
    credentials: "include",
  });
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
      return null as any;
    }

    await throwIfResNotOk(res);
    return (await res.json()) as T;
  };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

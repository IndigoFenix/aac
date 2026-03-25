// src/store/symbol-store.ts
//
// Global symbol resolution store. Manages SSE connection to
// /api/custom-symbols/watch for real-time symbol generation updates.
// Independent of React component lifecycle.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { apiUrl } from "@/lib/queryClient";

type SymbolStatus = "pending" | "resolved" | "failed";

interface SymbolEntry {
  status: SymbolStatus;
  symbolPath?: string;
  error?: string;
}

interface SymbolStoreState {
  symbols: Record<string, SymbolEntry>;

  /** Get the resolved symbol path for an imageKey, or undefined */
  getSymbolPath: (imageKey: string) => string | undefined;

  /** Check if a symbol is currently pending generation */
  isPending: (imageKey: string) => boolean;

  /**
   * Request resolution for a set of imageKeys.
   * Opens/reopens the SSE connection with all pending keys.
   */
  requestResolution: (imageKeys: string[]) => void;

  /** Disconnect the SSE stream (call on panel unmount) */
  disconnect: () => void;
}


// SSE connection state (outside Zustand to avoid re-renders)
let abortController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = 1000;
}

/**
 * Parse SSE events from a text buffer.
 * Returns parsed events and any remaining incomplete text.
 */
function parseSSEBuffer(buffer: string): {
  events: Array<{ event: string; data: string }>;
  remaining: string;
} {
  const events: Array<{ event: string; data: string }> = [];
  const lines = buffer.split("\n");

  let currentEvent = "";
  let currentData = "";
  let remaining = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Last line may be incomplete
    if (i === lines.length - 1 && line !== "") {
      remaining = line;
      continue;
    }

    // Skip comments (keepalive)
    if (line.startsWith(":")) continue;

    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentEvent && currentData) {
      events.push({ event: currentEvent, data: currentData });
      currentEvent = "";
      currentData = "";
    }
  }

  return { events, remaining };
}

async function connectSSE(store: typeof useSymbolStore) {
  // Disconnect any existing connection
  abortController?.abort();
  clearReconnect();

  const state = store.getState();
  const pendingKeys = Object.entries(state.symbols)
    .filter(([, entry]) => entry.status === "pending")
    .map(([key]) => key);

  if (pendingKeys.length === 0) return;

  abortController = new AbortController();
  const url = apiUrl(`/api/custom-symbols/watch?keys=${pendingKeys.join(",")}`);

  try {
    const response = await fetch(url, {
      signal: abortController.signal,
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    reconnectDelay = 1000; // Reset backoff on successful connect

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, remaining } = parseSSEBuffer(buffer);
      buffer = remaining;

      for (const { event, data } of events) {
        try {
          const payload = JSON.parse(data);
          switch (event) {
            case "symbol_resolved":
              store.setState((s) => ({
                symbols: {
                  ...s.symbols,
                  [payload.imageKey]: {
                    status: "resolved" as const,
                    symbolPath: apiUrl(payload.symbolPath),
                  },
                },
              }));
              break;

            case "symbol_pending":
              // Already marked as pending, no-op
              break;

            case "symbol_failed":
              store.setState((s) => ({
                symbols: {
                  ...s.symbols,
                  [payload.imageKey]: {
                    status: "failed" as const,
                    error: payload.error,
                  },
                },
              }));
              break;

            case "all_resolved":
              // Server closed stream naturally, no reconnect needed
              return;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError") return; // Intentional disconnect

    // Auto-reconnect with exponential backoff
    console.warn("[SymbolStore] SSE disconnected, reconnecting in", reconnectDelay, "ms");
    reconnectTimer = setTimeout(() => {
      connectSSE(store);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }
}

export const useSymbolStore = create<SymbolStoreState>((set, get) => ({
  symbols: {},

  getSymbolPath: (imageKey: string) => {
    const entry = get().symbols[imageKey];
    return entry?.status === "resolved" ? entry.symbolPath : undefined;
  },

  isPending: (imageKey: string) => {
    return get().symbols[imageKey]?.status === "pending";
  },

  requestResolution: (imageKeys: string[]) => {
    const current = get().symbols;
    let hasNewKeys = false;

    const updated = { ...current };
    for (const key of imageKeys) {
      // Skip already resolved or already pending
      if (updated[key]?.status === "resolved" || updated[key]?.status === "pending") continue;
      updated[key] = { status: "pending" };
      hasNewKeys = true;
    }

    if (!hasNewKeys) return;

    set({ symbols: updated });

    // (Re)connect SSE with all pending keys
    connectSSE(useSymbolStore);
  },

  disconnect: () => {
    abortController?.abort();
    abortController = null;
    clearReconnect();
  },
}));

/** Selectors for aggregate counts (used by UI indicators) */
export function useSymbolCounts() {
  return useSymbolStore(
    useShallow((s) => {
      const entries = Object.values(s.symbols);
      return {
        pending: entries.filter((e) => e.status === "pending").length,
        resolved: entries.filter((e) => e.status === "resolved").length,
        failed: entries.filter((e) => e.status === "failed").length,
        total: entries.length,
      };
    }),
  );
}

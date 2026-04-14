import { useEffect, useRef } from "react";

export interface UserChatSocketEvent {
  type: string;
  topic?: string;
  payload?: any;
}

function resolveWsUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = path;
    return url.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export function useUserChatSocket(
  onEvent: (event: UserChatSocketEvent) => void,
  enabled: boolean,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(resolveWsUrl("/ws/user-chat"));

      ws.onopen = () => {
        backoffMs = 1000;
      };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onEventRef.current(data);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch { /* ignore */ }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [enabled]);
}

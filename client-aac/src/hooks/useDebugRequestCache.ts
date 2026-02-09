// client-aac/src/hooks/useDebugRequestCache.ts
// Ring buffer of recent outgoing request summaries for the debug panel

import { useState, useCallback, useRef } from "react";

export interface CachedRequest {
  id: string;
  timestamp: number;
  endpoint: string;          // '/detect', '/message', '/voice', '/initialize'
  hasImage: boolean;
  hasAudio: boolean;
  hasGestureContext: boolean;
  boardSlotCount: number;
  messagePreview?: string;   // First 80 chars of message text
  interactionMode?: string;
  gridFrameCount?: number;   // For detect: how many frames in composite grid
}

export interface UseDebugRequestCacheReturn {
  cache: CachedRequest[];
  addRequest: (entry: Omit<CachedRequest, "id" | "timestamp">) => void;
}

export function useDebugRequestCache(maxEntries = 15): UseDebugRequestCacheReturn {
  const [cache, setCache] = useState<CachedRequest[]>([]);
  const counterRef = useRef(0);

  const addRequest = useCallback((entry: Omit<CachedRequest, "id" | "timestamp">) => {
    const id = `req-${++counterRef.current}`;
    const newEntry: CachedRequest = {
      ...entry,
      id,
      timestamp: Date.now(),
    };

    setCache(prev => {
      const next = [...prev, newEntry];
      // Keep only the last maxEntries
      return next.length > maxEntries ? next.slice(-maxEntries) : next;
    });
  }, [maxEntries]);

  return { cache, addRequest };
}

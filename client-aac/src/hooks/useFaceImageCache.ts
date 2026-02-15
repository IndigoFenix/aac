// client-aac/src/hooks/useFaceImageCache.ts
// In-memory face image cache — session-scoped, no persistence

import { useRef, useCallback } from "react";

interface CachedFace {
  dataUrl: string;
  quality: number;
}

export interface FaceImageCache {
  cacheFaceImage: (contactId: string, dataUrl: string, quality: number) => void;
  getFaceImage: (contactId: string) => string | null;
  hasCachedImage: (contactId: string) => boolean;
}

export function useFaceImageCache(): FaceImageCache {
  const cacheRef = useRef<Map<string, CachedFace>>(new Map());

  const cacheFaceImage = useCallback((contactId: string, dataUrl: string, quality: number) => {
    const existing = cacheRef.current.get(contactId);
    if (existing && quality <= existing.quality) return;
    cacheRef.current.set(contactId, { dataUrl, quality });
  }, []);

  const getFaceImage = useCallback((contactId: string): string | null => {
    return cacheRef.current.get(contactId)?.dataUrl ?? null;
  }, []);

  const hasCachedImage = useCallback((contactId: string): boolean => {
    return cacheRef.current.has(contactId);
  }, []);

  return { cacheFaceImage, getFaceImage, hasCachedImage };
}

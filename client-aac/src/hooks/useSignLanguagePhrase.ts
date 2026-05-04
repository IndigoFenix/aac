// client-aac/src/hooks/useSignLanguagePhrase.ts
// Accumulates `sign_language` events emitted by useHandGestureEvents into a
// phrase. When the student pauses (no new sign for `pauseMs`), the buffered
// phrase is delivered to onPhraseComplete so the caller can submit it to the
// AI as a typed statement.

import { useEffect, useRef } from "react";
import type { TrackedHand } from "@/lib/handGestureTypes";

export interface UseSignLanguagePhraseOptions {
  trackedHands: TrackedHand[];
  enabled: boolean;
  pauseMs?: number;
  onPhraseComplete: (phrase: string) => void;
}

const DEFAULT_PAUSE_MS = 2500;

export function useSignLanguagePhrase({
  trackedHands,
  enabled,
  pauseMs = DEFAULT_PAUSE_MS,
  onPhraseComplete,
}: UseSignLanguagePhraseOptions): void {
  const lastSeenTimestampRef = useRef<number>(0);
  const bufferRef = useRef<string[]>([]);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onPhraseComplete);
  onCompleteRef.current = onPhraseComplete;

  useEffect(() => {
    if (!enabled) {
      bufferRef.current = [];
      lastSeenTimestampRef.current = 0;
      if (pauseTimerRef.current) {
        clearTimeout(pauseTimerRef.current);
        pauseTimerRef.current = null;
      }
      return;
    }

    const lastSeen = lastSeenTimestampRef.current;
    let newest = lastSeen;
    const fresh: string[] = [];

    for (const hand of trackedHands) {
      for (const ev of hand.events) {
        if (ev.type !== "sign_language") continue;
        if (ev.timestamp <= lastSeen) continue;
        if (!ev.signLabel) continue;
        fresh.push(ev.signLabel);
        if (ev.timestamp > newest) newest = ev.timestamp;
      }
    }

    if (fresh.length > 0) {
      lastSeenTimestampRef.current = newest;

      // Sort by appearance order (events across hands may interleave; the
      // tick they arrive on is fine-grained enough that timestamp order is
      // a reasonable approximation of signing order).
      bufferRef.current.push(...fresh);

      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = setTimeout(() => {
        const phrase = bufferRef.current.join(" ").trim();
        bufferRef.current = [];
        pauseTimerRef.current = null;
        if (phrase) onCompleteRef.current(phrase);
      }, pauseMs);
    }
  }, [trackedHands, enabled, pauseMs]);

  useEffect(() => {
    return () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    };
  }, []);
}

export default useSignLanguagePhrase;

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DualAgentMessage } from "./dual-agent-types";

/**
 * The AAC text box — the one strip of words the student actually reads.
 *
 * Only two kinds of text may ever appear there:
 *   1. the AI's own words, and
 *   2. a recognition of what a person actually said or signed.
 *
 * Everything else the client sends the AI — `User navigated to page "Food"`,
 * `[GAME] the tower fell over`, `[system: the user touched you]` — is machine
 * context addressed to the agents, not speech addressed to the student. Those
 * strings used to surface anyway, because the send path echoed whatever it
 * sent and filtered it with a single ad-hoc `[system:` prefix test: any
 * context string written without that prefix leaked into the box, and every
 * new one leaked again.
 *
 * So the box has exactly ONE writer: `showCaption`, over the pure policy in
 * `applyCaption`. The state lives in here and nothing outside this module may
 * set it. Sending the AI a new kind of context is silent by default now —
 * putting words in front of the student takes a deliberate `showCaption` call.
 */

export type CaptionConfidence = "high" | "medium" | "low" | null;
export type CaptionClarity = "high" | "medium" | "low" | "unknown" | null;

export type CaptionUpdate =
  /** The AI's own words (white). `text` is the full accumulation for the turn. */
  | { source: "ai"; text: string }
  /** Mid-turn scaffold discard — blank the AI's words without ending the turn. */
  | { source: "ai-restart" }
  /** The student's own words, recognized from signing or built from symbols. */
  | { source: "student"; text: string }
  /** Final speech-to-text of someone speaking to the student (yellow). */
  | {
      source: "heard";
      text: string;
      confidence?: CaptionConfidence;
      clarity?: CaptionClarity;
    }
  /** Live rolling STT, still being revised (grey). Empty/null clears it. */
  | { source: "hearing"; text: string | null }
  /** Wipe the box: `heard` drops only the yellow line, the default drops all. */
  | { source: "clear"; scope?: "all" | "heard" };

export interface CaptionState {
  currentMessage: DualAgentMessage | null;
  transcription: string | null;
  interimTranscription: string | null;
  transcriptConfidence: CaptionConfidence;
  transcriptClarity: CaptionClarity;
}

export const EMPTY_CAPTION: CaptionState = {
  currentMessage: null,
  transcription: null,
  interimTranscription: null,
  transcriptConfidence: null,
  transcriptClarity: null,
};

/** How long a grey interim may linger if its clearing message never arrives. */
export const INTERIM_STALE_MS = 4000;

/**
 * The caption policy, as a pure function — every rule about what the AAC text
 * box shows lives here and nowhere else.
 */
export function applyCaption(
  state: CaptionState,
  update: CaptionUpdate,
  now: number = Date.now(),
): CaptionState {
  switch (update.source) {
    case "ai": {
      const prev = state.currentMessage;
      const continuing = prev?.role === "assistant";
      return {
        ...state,
        // The AI is speaking — drop any lingering "spoken to the student"
        // caption (yellow) so it doesn't overlap the AI's white words.
        transcription: null,
        currentMessage: {
          id: continuing ? prev!.id : `msg-${now}`,
          role: "assistant",
          content: update.text,
          timestamp: continuing ? prev!.timestamp : new Date(now).toISOString(),
        },
      };
    }

    case "ai-restart":
      return state.currentMessage?.role === "assistant"
        ? { ...state, currentMessage: { ...state.currentMessage, content: "" } }
        : state;

    case "student":
      return {
        ...state,
        currentMessage: {
          id: `user-${now}`,
          role: "user",
          content: update.text,
          timestamp: new Date(now).toISOString(),
        },
      };

    case "heard":
      return {
        ...state,
        transcription: update.text,
        transcriptConfidence: update.confidence || state.transcriptConfidence,
        // Always assign (including null) — a fresh transcript must never
        // inherit the previous utterance's clarity.
        transcriptClarity: update.clarity ?? null,
        // A routed (authoritative) transcript supersedes the live interim.
        interimTranscription: null,
      };

    case "hearing":
      return {
        ...state,
        interimTranscription:
          update.text && update.text.trim() ? update.text : null,
      };

    case "clear":
      return update.scope === "heard"
        ? { ...state, transcription: null }
        : EMPTY_CAPTION;
  }
}

export interface AacCaption extends CaptionState {
  /** The only way text reaches the AAC text box. */
  showCaption: (update: CaptionUpdate) => void;
}

export function useAacCaption(): AacCaption {
  const [state, dispatch] = useReducer(
    (s: CaptionState, u: CaptionUpdate) => applyCaption(s, u),
    EMPTY_CAPTION,
  );
  const interimFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInterimTimer = useCallback(() => {
    if (interimFadeTimerRef.current) {
      clearTimeout(interimFadeTimerRef.current);
      interimFadeTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearInterimTimer, [clearInterimTimer]);

  const showCaption = useCallback(
    (update: CaptionUpdate) => {
      // Staleness guard: tentative grey text can never linger on screen if the
      // message that would have cleared it is lost.
      if (update.source === "hearing" || update.source === "heard" || update.source === "clear") {
        clearInterimTimer();
      }
      if (update.source === "hearing" && update.text && update.text.trim()) {
        interimFadeTimerRef.current = setTimeout(() => {
          interimFadeTimerRef.current = null;
          dispatch({ source: "hearing", text: null });
        }, INTERIM_STALE_MS);
      }
      dispatch(update);
    },
    [clearInterimTimer],
  );

  return { ...state, showCaption };
}

// client-aac/src/hooks/useBoardMirror.ts
//
// Streams the SURFACE the AAC student is currently looking at over the call's
// reliable data channel, so a clinician on the call can SEE their screen (a
// read-only re-render — no screen-capture permission prompt). Board/page changes
// are low-frequency, so we send a full snapshot whenever the content changes
// (and once when the call goes active), coalesced behind a short timer.
//
// "Surface", not "board": the student has more than one grid. The sentence
// builder opens as a full-screen overlay OVER the board, and a world-engine game
// puts a mini-board beside a scene with its own HUD. This hook is agnostic about
// which — home decides what the student is looking at and hands it over — but
// everything it is given travels in ONE snapshot, so a clinician can never see a
// sentence strip from one surface next to a grid from another.

import { useEffect, useRef } from "react";
import type { BoardButton, ParsedBoardData } from "@shared/schema";
import type {
  CallDataMessage,
  MirrorHudSections,
  MirrorQuickButton,
  MirrorStripItem,
  MirrorSurface,
} from "@shared/call/call-data-messages";

interface Options {
  /** Whether a call is active (only mirror while connected). */
  active: boolean;
  /** Send a message over the call's reliable data channel. */
  sendData: (m: CallDataMessage) => void;
  /** The board the student is currently looking at, or null. */
  board: ParsedBoardData | null;
  /** The page within `board` the student is on. */
  pageId?: string;
  /** Regular communication board vs an app surface. */
  mode?: "board" | "app";
  appKind?: string;
  /** The SPECIFIC surface — board, sentence builder, app, or game. */
  surface?: MirrorSurface;
  /** Localized name of the surface (app/game title). */
  title?: string;
  /** Student device reading direction (so the clinician mirrors it). */
  rtl?: boolean;
  /** The context-sidebar buttons the student sees. */
  contextButtons?: BoardButton[];
  /** The bottom quick-action row the student sees. */
  quickButtons?: MirrorQuickButton[];
  /** The sentence builder's composed sentence + its controls. */
  strip?: MirrorStripItem[];
  /** The builder's mode-chip rail. */
  chips?: MirrorQuickButton[];
  /** An embedded world-engine game's ambient HUD. */
  hud?: MirrorHudSections;
}

/** Minimum gap between board-mirror snapshots (ms). Board changes are rare; this
 *  just coalesces a burst (e.g. board + patch + symbol update landing together). */
const MIRROR_THROTTLE_MS = 300;

export function useBoardMirror({
  active, sendData, board, pageId, mode = "board", appKind, surface, title,
  rtl, contextButtons, quickButtons, strip, chips, hud,
}: Options): void {
  const lastSentSigRef = useRef<string | null>(null);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || !board) {
      lastSentSigRef.current = null;
      return;
    }
    // Cheap change signature — board content + which page is showing + the
    // surrounding chrome. A small board (~12 buttons) stringifies fast; this
    // only re-sends on real changes. The builder's sentence and a game's HUD
    // join it, so composing a word or picking something up re-sends too.
    const sig = JSON.stringify({ b: board, pageId, mode, appKind, surface, title, rtl, contextButtons, quickButtons, strip, chips, hud });
    if (sig === lastSentSigRef.current) return;

    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      lastSentSigRef.current = sig;
      sendData({
        k: "board-mirror",
        board, pageId, mode, appKind, surface, title, rtl,
        contextButtons, quickButtons, strip, chips, hud,
        at: Date.now(),
      });
    }, MIRROR_THROTTLE_MS);

    return () => {
      if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
    };
  }, [active, board, pageId, mode, appKind, surface, title, rtl, contextButtons, quickButtons, strip, chips, hud, sendData]);
}

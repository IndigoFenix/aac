// shared/call/call-data-messages.ts
//
// Typed envelopes carried over the call's RELIABLE "aac" peer-to-peer data
// channel (PeerMesh → CallClient.sendData / the "data" CallClientEvent). These
// are 1:1 student↔clinician concerns that never need the server (the call relay
// is a dumb SDP/ICE pipe), so they ride the existing channel rather than new
// `call:` signaling commands.
//
//   - board-mirror / board-dwell / board-selection: the AAC streams the board
//     the student is looking at so the clinician can SEE their screen (a
//     read-only re-render — no screen-capture permission prompt).
//   - facilitator-press: the clinician presses a button on that mirrored board;
//     the AAC re-emits it through its own button-press pipeline (student-voice
//     TTS + sentence builder), gated by a per-student consent flag.
//   - screen-share: a notice that a getDisplayMedia track was added/removed, so
//     the receiver can tell the screen track apart from the camera track
//     (ontrack only exposes streams[0]).
//
// Anything received over the data channel that isn't a valid envelope is
// ignored (older clients, game extras, etc.).

import type { BoardButton, ParsedBoardData } from "../schema";

/** The board the student is currently looking at, re-rendered read-only on the
 *  clinician side. Sent on every board / page / tier change (low frequency). */
export interface BoardMirrorMessage {
  k: "board-mirror";
  board: ParsedBoardData;
  /** The page within `board` the student is on (board.currentPageId fallback). */
  pageId?: string;
  /** Whether this is the regular communication board or an app surface. */
  mode: "board" | "app";
  /** When mode === "app", a label for what's showing (e.g. "social_world"). */
  appKind?: string;
  at: number;
}

/** The button id the student is currently dwelling on (gaze hover), or null
 *  when nothing is hovered. `progress` is the 0..1 dwell fill, when known. */
export interface BoardDwellMessage {
  k: "board-dwell";
  buttonId: string | null;
  progress?: number;
  at: number;
}

/** A momentary press the student made — the clinician flashes the button. */
export interface BoardSelectionMessage {
  k: "board-selection";
  buttonId: string;
  at: number;
}

/** The clinician pressed a button on the mirrored board. The AAC routes it
 *  through the student's own press pipeline (facilitator mode). */
export interface FacilitatorPressMessage {
  k: "facilitator-press";
  button: BoardButton;
  /** The text to voice (spokenText/sentence/label, resolved on the clinician). */
  spokenText: string;
  at: number;
}

/** A getDisplayMedia screen-share track was added (on) or removed (off). The
 *  receiver maps `trackId` to the inbound track so it can be shown distinctly. */
export interface ScreenShareMessage {
  k: "screen-share";
  on: boolean;
  trackId: string;
  at: number;
}

export type CallDataMessage =
  | BoardMirrorMessage
  | BoardDwellMessage
  | BoardSelectionMessage
  | FacilitatorPressMessage
  | ScreenShareMessage;

/** Narrow an unknown data-channel payload to a CallDataMessage, or null. Keeps
 *  the receivers (both CallContexts) from having to trust the wire. */
export function parseCallDataMessage(raw: unknown): CallDataMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { k?: unknown };
  switch (m.k) {
    case "board-mirror": {
      const v = raw as Partial<BoardMirrorMessage>;
      if (!v.board || typeof v.board !== "object") return null;
      return {
        k: "board-mirror",
        board: v.board as ParsedBoardData,
        pageId: typeof v.pageId === "string" ? v.pageId : undefined,
        mode: v.mode === "app" ? "app" : "board",
        appKind: typeof v.appKind === "string" ? v.appKind : undefined,
        at: typeof v.at === "number" ? v.at : 0,
      };
    }
    case "board-dwell": {
      const v = raw as Partial<BoardDwellMessage>;
      return {
        k: "board-dwell",
        buttonId: typeof v.buttonId === "string" ? v.buttonId : null,
        progress: typeof v.progress === "number" ? v.progress : undefined,
        at: typeof v.at === "number" ? v.at : 0,
      };
    }
    case "board-selection": {
      const v = raw as Partial<BoardSelectionMessage>;
      if (typeof v.buttonId !== "string") return null;
      return { k: "board-selection", buttonId: v.buttonId, at: typeof v.at === "number" ? v.at : 0 };
    }
    case "facilitator-press": {
      const v = raw as Partial<FacilitatorPressMessage>;
      if (!v.button || typeof v.button !== "object") return null;
      return {
        k: "facilitator-press",
        button: v.button as BoardButton,
        spokenText: typeof v.spokenText === "string" ? v.spokenText : "",
        at: typeof v.at === "number" ? v.at : 0,
      };
    }
    case "screen-share": {
      const v = raw as Partial<ScreenShareMessage>;
      if (typeof v.trackId !== "string") return null;
      return { k: "screen-share", on: !!v.on, trackId: v.trackId, at: typeof v.at === "number" ? v.at : 0 };
    }
    default:
      return null;
  }
}

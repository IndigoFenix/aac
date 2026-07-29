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

/** A fixed quick-action button (the bottom row on the AAC), serialized so the
 *  clinician's mirror can show it with the student's own label + icon. */
export interface MirrorQuickButton {
  id: string;
  label: string;
  /** Emoji / single-char icon (most quick buttons). */
  emoji?: string;
  /** Background color (hex). */
  color?: string;
  /** Highlighted state (e.g. Word Finder while guessing). */
  active?: boolean;
}

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
  /** The student device's reading direction — the clinician renders the mirror
   *  in this direction regardless of the clinician UI's own language. */
  rtl?: boolean;
  /** The context-sidebar buttons the student sees beside the board. */
  contextButtons?: BoardButton[];
  /** The bottom quick-action row the student sees. */
  quickButtons?: MirrorQuickButton[];
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

/** A getDisplayMedia screen capture was started (on) or stopped (off). `streamId`
 *  is the captured MediaStream's id — the MSID is signaled, so the receiver's
 *  inbound `stream.id` matches it, letting the screen be told apart from the
 *  camera (both arrive as separate `ontrack` streams for the same peer). */
export interface ScreenShareMessage {
  k: "screen-share";
  on: boolean;
  streamId: string;
  at: number;
}

/** The clinician asks the AAC to start (on) or stop (off) sharing its screen.
 *  The AAC responds by calling getDisplayMedia — the student device is the one
 *  being viewed, so the capture must originate there. */
export interface ScreenRequestMessage {
  k: "screen-request";
  on: boolean;
  at: number;
}

/** A RELIABLE command for an iframe world game shared by the call (engine
 *  "iframe-quest") — a follower's board press / built sentence relayed to the
 *  sim-owner peer, or a rare event like a spark→body claim. `cmd` is an
 *  engine-versioned payload the platform ferries into the game iframe
 *  verbatim (`world_cmd` bridge message) and never inspects. `toId` narrows
 *  delivery: receivers whose personId differs drop the message. */
export interface WorldCommandMessage {
  k: "world-cmd";
  /** The game the command belongs to (CallGame.appId, e.g. "dollhouse"). */
  gameId: string;
  cmd: unknown;
  toId?: string;
  at: number;
}

export type CallDataMessage =
  | BoardMirrorMessage
  | BoardDwellMessage
  | BoardSelectionMessage
  | FacilitatorPressMessage
  | ScreenShareMessage
  | ScreenRequestMessage
  | WorldCommandMessage;

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
        rtl: typeof v.rtl === "boolean" ? v.rtl : undefined,
        contextButtons: Array.isArray(v.contextButtons) ? (v.contextButtons as BoardButton[]) : undefined,
        quickButtons: Array.isArray(v.quickButtons) ? (v.quickButtons as MirrorQuickButton[]) : undefined,
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
      if (typeof v.streamId !== "string") return null;
      return { k: "screen-share", on: !!v.on, streamId: v.streamId, at: typeof v.at === "number" ? v.at : 0 };
    }
    case "screen-request": {
      const v = raw as Partial<ScreenRequestMessage>;
      return { k: "screen-request", on: !!v.on, at: typeof v.at === "number" ? v.at : 0 };
    }
    case "world-cmd": {
      const v = raw as Partial<WorldCommandMessage>;
      if (typeof v.gameId !== "string" || v.cmd === undefined) return null;
      return {
        k: "world-cmd",
        gameId: v.gameId,
        cmd: v.cmd,
        toId: typeof v.toId === "string" ? v.toId : undefined,
        at: typeof v.at === "number" ? v.at : 0,
      };
    }
    default:
      return null;
  }
}

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
//   - facilitator-press / facilitator-builder: the clinician presses a button
//     on that mirrored surface; the AAC re-emits it through its own press
//     pipeline (student-voice TTS + sentence builder), gated by a per-student
//     consent flag. Two messages because the board and the sentence builder
//     have genuinely different press vocabularies — a board button is a whole
//     utterance, a builder press is one move in composing one.
//   - screen-share: a notice that a getDisplayMedia track was added/removed, so
//     the receiver can tell the screen track apart from the camera track
//     (ontrack only exposes streams[0]).
//
// Anything received over the data channel that isn't a valid envelope is
// ignored (older clients, game extras, etc.).

import type { BoardButton, ParsedBoardData } from "../schema";
import type { GameMessage } from "../games-bridge";
import { type BuilderTarget, parseBuilderTarget, formatBuilderTarget } from "./builder-mirror";

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

/** One cell of the row ABOVE the mirrored grid. Today that row is the sentence
 *  builder's composed sentence plus its play/backspace/clear controls — the
 *  half of the builder a bare grid cannot show, and the half that says what the
 *  student is actually trying to say. */
export interface MirrorStripItem {
  /** Builder target id (see builder-mirror.ts) — pressable when Interact is on. */
  id: string;
  /** A filled sentence slot, or one of the sentence controls. */
  kind: "slot" | "control";
  /** Glyph string to draw (slots). */
  glyph?: string;
  /** Emoji face (controls, and the slot fallback). */
  emoji?: string;
  /** Localized label, when the item has one. */
  label?: string;
  /** The slot the student has selected. */
  active?: boolean;
}

/** An embedded world-engine game's ambient HUD, exactly as the game emits it
 *  over the `world_hud` bridge message. Relayed VERBATIM: the AAC already
 *  renders these sections beside its board, so mirroring the same value means
 *  the two views cannot drift apart, and a game that adds a section gets it on
 *  the clinician's screen without a protocol change. */
export type MirrorHudSections = Extract<GameMessage, { type: "world_hud" }>["sections"];

/** Which AAC surface the student is looking at. Finer-grained than
 *  `BoardMirrorMessage.mode`, which only distinguishes board from app. */
export const MIRROR_SURFACES = ["board", "builder", "app", "game"] as const;
export type MirrorSurface = (typeof MIRROR_SURFACES)[number];

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
  /**
   * The SPECIFIC surface (`mode` only separates board from app). Absent from
   * older AAC builds, which is why `mode` stays: a clinician talking to one of
   * those still gets a board mirror, just without the surface badge.
   */
  surface?: MirrorSurface;
  /** Localized name of the surface — the app's or game's own title. */
  title?: string;
  /** The row above the grid: the sentence builder's composed sentence. */
  strip?: MirrorStripItem[];
  /**
   * A SECOND chip rail — the builder's mode chips. Distinct from
   * `quickButtons`, which stays the AAC's real bottom quick-action bar: the
   * builder overlay does not cover that bar, so both are on screen at once and
   * collapsing them into one row would invent a layout the student never saw.
   */
  chips?: MirrorQuickButton[];
  /** An embedded world-engine game's ambient HUD. */
  hud?: MirrorHudSections;
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

/** The clinician pressed something on the mirrored SENTENCE BUILDER. The AAC
 *  routes it through the very handler the student's own press would take, so
 *  there is no second composition pipeline to keep in step. Gated by the same
 *  per-student consent flag as `facilitator-press`. */
export interface FacilitatorBuilderMessage {
  k: "facilitator-builder";
  target: BuilderTarget;
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
  | FacilitatorBuilderMessage
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
        surface: MIRROR_SURFACES.includes(v.surface as MirrorSurface) ? (v.surface as MirrorSurface) : undefined,
        title: typeof v.title === "string" ? v.title : undefined,
        strip: Array.isArray(v.strip) ? (v.strip as MirrorStripItem[]) : undefined,
        chips: Array.isArray(v.chips) ? (v.chips as MirrorQuickButton[]) : undefined,
        hud: Array.isArray(v.hud) ? (v.hud as MirrorHudSections) : undefined,
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
    case "facilitator-builder": {
      const v = raw as Partial<FacilitatorBuilderMessage>;
      // Re-derived from the id form rather than trusted as an object: the
      // target decides which of the builder's handlers fires, so a malformed
      // one must fail closed, not press something adjacent.
      const target = parseBuilderTarget(v.target ? formatBuilderTarget(v.target) : null);
      if (!target) return null;
      return { k: "facilitator-builder", target, at: typeof v.at === "number" ? v.at : 0 };
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

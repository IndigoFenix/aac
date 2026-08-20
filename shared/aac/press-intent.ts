/**
 * press-intent.ts
 *
 * WHAT A BOARD BUTTON PRESS MEANS, separated from what it DOES. Pure — the
 * classification only; every effect (speaking, launching, reporting to the
 * server) stays with the component that owns the handlers.
 *
 * Worth separating because the meaning is a priority ORDER, not a set of
 * independent flags, and the order carries real behaviour: a `link` that names
 * another saved board is board navigation, but only when a handler is wired to
 * load one — on the AI's dynamic path there is none, and the same button must
 * fall through to page navigation instead of dying silently.
 *
 * The companion rule, `pressWireFor` in ./press-routing, answers a different
 * question: which WIRE an utterance leaves on (`button_press` vs `game_press`).
 * This module decides whether the press is an utterance at all.
 */

import type { BoardButton } from "@shared/schema";

export type PressIntent =
  /** Load a different saved board entirely. */
  | { kind: "navigate-board"; boardId: string }
  /** Move to another page of THIS board. */
  | { kind: "navigate-page"; pageId: string }
  | { kind: "page-back" }
  | { kind: "page-home" }
  /**
   * Leave a loaded board.
   *
   * `instruction` is the button's `action.text`, and it is NOT decoration: on
   * the home board every button carries a DIRECTIVE tag there (`[FEELINGS]`,
   * `[HELP]`, `[APPS BOARD]`, `[CONSTRUCTION BOARD]`, …) and that tag is the
   * only thing telling the AI what the press meant. `board_exit` sent without
   * it gives the agents a bare "they left the board" and they improvise.
   */
  | { kind: "exit"; instruction: string }
  | { kind: "open-website"; url: string; label: string }
  | { kind: "open-app"; appId: string; appData?: string }
  | { kind: "open-board"; boardKey: string }
  /** Fire a clinician-authored smart-home slot. */
  | { kind: "home-action"; actionId: string; requiresConfirmation: boolean }
  /**
   * The ordinary case: the student said something.
   * `meta` marks presses that are ABOUT the board rather than utterances —
   * they must never be voiced locally (see `isMetaButton`).
   */
  | { kind: "speak"; text: string; meta: boolean };

/**
 * Button types that are requests to the system, not things the student said.
 *
 *   more        — "give me other options"; produces no speech at all.
 *   wordfinder  — enters the Word Finder; a mode change.
 *   suggestion  — a Word Finder suggestion. Voiced by the parent's handler
 *                 instead, which speaks even mid-session where local speech is
 *                 otherwise suppressed.
 *   narrow      — voiced by the parent through server student-voice TTS, paired
 *                 with the `guessing_narrow` intent. Speaking locally too would
 *                 double-voice it.
 *
 * Every one of these would be a spurious utterance if voiced here.
 */
export const META_BUTTON_TYPES: ReadonlySet<string> = new Set([
  "suggestion",
  "wordfinder",
  "more",
  "narrow",
]);

export function isMetaButton(button: BoardButton): boolean {
  const bt = (button as { buttonType?: string }).buttonType;
  return !!bt && META_BUTTON_TYPES.has(bt);
}

export interface PressIntentOptions {
  /**
   * Whether a board-to-board load handler is wired. False on the AI's dynamic
   * path, where a `toBoardId` link falls through to normal handling rather than
   * becoming a dead button.
   */
  canNavigateToBoard?: boolean;
}

/**
 * Classify one press. The order below IS the behaviour — earlier branches win.
 */
export function pressIntentFor(button: BoardButton, opts: PressIntentOptions = {}): PressIntent {
  const action = button.action;

  if (action?.type === "link" && action.toBoardId && opts.canNavigateToBoard) {
    return { kind: "navigate-board", boardId: action.toBoardId };
  }
  if (action?.type === "link" && action.toPageId) {
    return { kind: "navigate-page", pageId: action.toPageId };
  }
  if (action?.type === "back") return { kind: "page-back" };
  if (action?.type === "home") return { kind: "page-home" };

  // `exitBoard` is the flag form of the same intent, set on buttons that leave
  // a loaded board without carrying an explicit exit action.
  if (action?.type === "exit" || (button as { exitBoard?: boolean }).exitBoard) {
    return { kind: "exit", instruction: action?.text ?? "" };
  }

  if (action?.type === "open_website" && action.url) {
    return { kind: "open-website", url: action.url, label: button.label };
  }
  if (action?.type === "open_app" && action.appId) {
    // `appData` rides through to request_app_open — a search app opened without
    // it drops whatever the student just agreed to look for.
    return { kind: "open-app", appId: action.appId, appData: action.appData };
  }
  if (action?.type === "open_board" && action.boardKey) {
    return { kind: "open-board", boardKey: action.boardKey };
  }
  if (action?.type === "run_home_action" && action.actionId) {
    return {
      kind: "home-action",
      actionId: action.actionId,
      requiresConfirmation: !!action.requiresConfirmation,
    };
  }

  return {
    kind: "speak",
    text: button.spokenText || button.label,
    meta: isMetaButton(button),
  };
}

/**
 * Whether THIS window should voice the press itself through speechSynthesis.
 *
 * Three independent reasons not to, and all three have bitten before:
 *   - the press is meta, so there is no utterance to voice;
 *   - the server is already voicing it (`suppressLocalSpeech`), so speaking
 *     here would double it;
 *   - the header's audio-output mute is on, which silences EVERYTHING from this
 *     window — the streaming player is gated elsewhere, and this Web-Speech
 *     path was the leak.
 */
export function shouldSpeakLocally(
  intent: PressIntent,
  opts: { suppressLocalSpeech?: boolean; outputMuted?: boolean },
): boolean {
  if (intent.kind !== "speak") return false;
  if (intent.meta) return false;
  if (opts.suppressLocalSpeech) return false;
  if (opts.outputMuted) return false;
  return true;
}

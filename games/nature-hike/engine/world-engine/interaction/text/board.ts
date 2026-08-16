// shared/world-engine/interaction/text/board.ts
//
// A SCREEN IS A LIST, AND ITS COST IS PART OF THE OUTPUT (law ④).
//
// Text mode prints EXACTLY the page the presenter was handed — the page
// `boardChrome` already paginated (BOARD_PAGE = 8) — numbered INCLUDING the
// more/back chrome. It never re-paginates, never re-orders, never drops a
// button: how many presses a wanted word costs IS the measurement this harness
// exists to take, and any tidying here would erase it.
//
// Per §7: `label`, then the composed `[glyph]` beside it (a garbled composition
// is a target defect and must show), then `spokenText` quoted ONLY when it
// differs from the label. `SlotNeed` roles are never shown — internal ranking,
// invisible to a student, and so invisible here.
//
// ── Deviation, stated ───────────────────────────────────────────────────────
// §7 asks for the PAGE COUNT on its own NOTE line. `QuestBoardView` does not
// carry one: the host runs `boardChrome` and hands the presenter the resulting
// page, keeping `pages`/`page` to itself. So the NOTE reports what the page
// itself proves — how many real choices it holds and whether the list pages on.
// TODO step ⑧: surface the real `pages`/`page` when builder driving needs the
// press/screen accounting ("reached in N presses across M screens").

import { BOARD_BACK_ID, BOARD_MORE_ID } from "../quest/board-chrome.js";
import type { QuestBoardOption, QuestBoardView } from "../quest/quest-host.js";
import type { TextBoardOption, TextEvent } from "./types.js";

/** The chrome role of a board id, or undefined for a content button. */
export function chromeOf(id: string): "more" | "back" | undefined {
  if (id === BOARD_MORE_ID) return "more";
  if (id === BOARD_BACK_ID) return "back";
  return undefined;
}

/** The page's buttons, numbered 1..n — chrome counted in (law ④). */
export function textBoardOptions(options: readonly QuestBoardOption[]): TextBoardOption[] {
  return options.map((o, i) => {
    const chrome = chromeOf(o.id);
    return {
      n: i + 1,
      id: o.id,
      label: o.label,
      ...(o.glyph ? { glyph: o.glyph } : {}),
      ...(o.spokenText ? { spokenText: o.spokenText } : {}),
      ...(chrome ? { chrome } : {}),
    };
  });
}

export interface BoardEventOpts {
  /** How the poser is named in the transcript (a latched text id when the
   *  session can resolve one; the raw entity id otherwise). */
  posedByLabel?: (entityId: string) => string;
}

/** A pushed board → its `BOARD` block plus the law-④ `NOTE` about its cost. */
export function boardEvents(view: QuestBoardView, opts: BoardEventOpts = {}): TextEvent[] {
  const options = textBoardOptions(view.options);
  const content = options.filter((o) => !o.chrome).length;
  const pages = options.some((o) => o.chrome === "more");
  const back = options.some((o) => o.chrome === "back");
  const chrome = [pages ? "more" : "", back ? "back" : ""].filter(Boolean);
  return [
    {
      tag: "BOARD",
      nodeId: view.nodeId,
      board: view.kind,
      posedBy: opts.posedByLabel?.(view.posedByEntityId) ?? view.posedByEntityId,
      promptText: view.promptText,
      ...(view.prompt ? { prompt: view.prompt } : {}),
      options,
    },
    {
      tag: "NOTE",
      text: chrome.length
        ? `${content} choice(s) on this page, plus ${chrome.join(" + ")}.`
        : `${content} choice(s), the whole list.`,
    },
  ];
}

/** The board went away. */
export function closeBoardEvent(): TextEvent {
  return { tag: "CLOSE" };
}

/**
 * Which button a `press` names: a 1-based number over the page AS PRINTED, or a
 * label (case- and space-insensitive; an exact match wins over a prefix, so
 * "more" can't be stolen by "more juice"). Chrome is pressable either way.
 */
export function findBoardOption(
  options: readonly TextBoardOption[],
  sel: { index?: number; label?: string },
): TextBoardOption | undefined {
  if (sel.index !== undefined) return options.find((o) => o.n === sel.index);
  if (sel.label === undefined) return undefined;
  const want = sel.label.trim().toLowerCase();
  if (!want) return undefined;
  return (
    options.find((o) => o.label.trim().toLowerCase() === want) ??
    options.find((o) => o.chrome === want) ??
    options.find((o) => o.glyph?.toLowerCase() === want) ??
    options.find((o) => o.label.trim().toLowerCase().startsWith(want))
  );
}

/** The chrome button for `more` / `back`, when this page has one. */
export function findChrome(
  options: readonly TextBoardOption[],
  which: "more" | "back",
): TextBoardOption | undefined {
  return options.find((o) => o.chrome === which);
}

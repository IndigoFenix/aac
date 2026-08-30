// shared/call/builder-mirror.ts
//
// THE SENTENCE BUILDER, AS THE CLINICIAN SEES IT — and as they can drive it.
//
// The board mirror (call-data-messages.ts) streams "a grid of buttons plus its
// chrome", and the clinician re-renders it read-only. The sentence builder is
// also a grid of buttons plus chrome, so it rides the SAME message rather than
// growing a second protocol: this module turns the builder's visible state into
// those shapes, and turns a click on the mirrored result back into a
// `BuilderTarget` the AAC can press.
//
// Why the builder needed this at all: the builder opens as a full-screen
// overlay OVER the board. Before this module the mirror kept streaming the
// board underneath it, so a clinician watched a surface the student had left,
// with nothing on screen to say so.
//
// PURE ON PURPOSE. `SentenceConstructorBoard` is 3000 lines of eyegaze-tuned
// React; none of it is needed to decide what a mirrored cell looks like or what
// a mirrored press means, and a jest suite should not have to mount it to check
// those. Labels arrive ALREADY TRANSLATED — `t()` lives in the client, and the
// student's device is the one that knows which language their board is in.
//
// The `bx:` id scheme is the whole trick: a builder target is carried inside
// `BoardButton.id`, so `MirroredBoardView` renders builder cells with the exact
// code path it renders board buttons with, and only the press handler has to
// know the difference.

import type { BoardButton, ParsedBoardData } from "../schema";
import type { MirrorQuickButton, MirrorStripItem } from "./call-data-messages";
import { BUILDER_GRID_CELLS, BUILDER_PAGE_CONTROLS } from "../aac-builder-paging";

// ── Targets ─────────────────────────────────────────────────────────────────

/**
 * Every builder action a clinician can drive remotely. Each maps 1:1 onto a
 * handler `SentenceConstructorBoard` already has for the student's own press —
 * a remote press takes the SAME path as a local one, so there is no second
 * pipeline to keep in step (and no way for the two to diverge in behaviour).
 */
export type BuilderTarget =
  /** A main-grid word from the glyph registry (`handleGridPress`). */
  | { kind: "word"; key: string }
  /** A main-grid word surfaced by a game's engine (`handleEngineWordPress`). */
  | { kind: "engineWord"; key: string }
  /** A category tab — registry (`handleTabSelect`) or engine (`handleEngineTabSelect`). */
  | { kind: "tab"; tab: string }
  | { kind: "engineTab"; tab: string }
  /** A mode/group chip — registry (`handleModeChipSelect`) or engine (`handleEngineChipSelect`). */
  | { kind: "chip"; chip: string }
  | { kind: "engineChip"; chip: string }
  /** The grid's paging controls. Paging WRAPS, per aac-builder-paging.ts. */
  | { kind: "page"; dir: "back" | "more" }
  /** Select (or deselect) a slot in the composed sentence (`handleSlotPress`). */
  | { kind: "slot"; index: number }
  /** Speak / interpret the composed sentence (`handlePlay`). */
  | { kind: "play" }
  /** Remove the last slot (`handleBackspace`). */
  | { kind: "backspace" }
  /** Clear the selected slot (`handleClearSelected`). */
  | { kind: "clear" }
  /**
   * A WORD FINDER button, by its own board-button id. Guessing mode replaces
   * the builder's grid with a server-authored board, and its buttons carry
   * three different meanings (`suggestion` / `narrow` / free guess) that only
   * the builder's own dispatch can tell apart. Carrying the id — rather than
   * routing these through `facilitator-press` like a communication-board
   * button — is what keeps a remote press on the same path as the child's.
   */
  | { kind: "guess"; buttonId: string };

/** Prefix that marks a mirrored button id as a builder target. Board buttons
 *  carry server-generated ids and never start with this. */
export const BUILDER_TARGET_PREFIX = "bx:";

/** Short tag per target kind — kept terse because every grid cell carries one. */
const TAG: Record<BuilderTarget["kind"], string> = {
  word: "w",
  engineWord: "ew",
  tab: "tab",
  engineTab: "etab",
  chip: "chip",
  engineChip: "echip",
  page: "page",
  slot: "slot",
  guess: "g",
  play: "play",
  backspace: "bksp",
  clear: "clear",
};

/** Encode a target into a `BoardButton.id`. */
export function formatBuilderTarget(target: BuilderTarget): string {
  const head = `${BUILDER_TARGET_PREFIX}${TAG[target.kind]}`;
  switch (target.kind) {
    case "word":
    case "engineWord":
      return `${head}:${target.key}`;
    case "tab":
    case "engineTab":
      return `${head}:${target.tab}`;
    case "chip":
    case "engineChip":
      return `${head}:${target.chip}`;
    case "page":
      return `${head}:${target.dir}`;
    case "slot":
      return `${head}:${target.index}`;
    case "guess":
      return `${head}:${target.buttonId}`;
    default:
      return head;
  }
}

/**
 * Decode a `BoardButton.id` back into a target, or null when the id is an
 * ordinary board button. The argument is taken VERBATIM after the tag rather
 * than by splitting on every colon: a person word's key is `face:<id>`, so a
 * naive split would truncate exactly the buttons a clinician most wants to
 * press. Called on untrusted wire data — everything unrecognised is null.
 */
export function parseBuilderTarget(id: string | undefined | null): BuilderTarget | null {
  if (typeof id !== "string" || !id.startsWith(BUILDER_TARGET_PREFIX)) return null;
  const body = id.slice(BUILDER_TARGET_PREFIX.length);
  const cut = body.indexOf(":");
  const tag = cut === -1 ? body : body.slice(0, cut);
  const arg = cut === -1 ? "" : body.slice(cut + 1);

  switch (tag) {
    case "w":
      return arg ? { kind: "word", key: arg } : null;
    case "ew":
      return arg ? { kind: "engineWord", key: arg } : null;
    case "tab":
      return arg ? { kind: "tab", tab: arg } : null;
    case "etab":
      return arg ? { kind: "engineTab", tab: arg } : null;
    case "chip":
      return arg ? { kind: "chip", chip: arg } : null;
    case "echip":
      return arg ? { kind: "engineChip", chip: arg } : null;
    case "page":
      return arg === "back" || arg === "more" ? { kind: "page", dir: arg } : null;
    case "slot": {
      const index = Number(arg);
      return Number.isInteger(index) && index >= 0 ? { kind: "slot", index } : null;
    }
    case "g":
      return arg ? { kind: "guess", buttonId: arg } : null;
    case "play":
      return { kind: "play" };
    case "bksp":
      return { kind: "backspace" };
    case "clear":
      return { kind: "clear" };
    default:
      return null;
  }
}

// ── Serialization ───────────────────────────────────────────────────────────

/** One cell of the builder's visible main grid, with its label already
 *  localized by the student's device. */
export interface BuilderMirrorCell {
  /** Vocabulary / engine key — what the press composes. */
  key: string;
  /** Already-translated label, as printed under the student's own button. */
  label: string;
  /** Glyph string to draw. Alias expansions (`tomorrow` → `day.next`) are
   *  applied by the caller, so the mirror shows the button's RESULT the way the
   *  student's own cell does. */
  glyph?: string;
  /** Emoji face when there is no glyph to compose. */
  emoji?: string;
  /** Surfaced by a game's engine rather than the glyph registry — decides which
   *  press handler the target routes to. */
  engine?: boolean;
  /** Person/creature present in the scene right now (the green "here" tint). */
  present?: boolean;
}

/** A tab or chip in the builder's chrome, already localized. */
export interface BuilderMirrorChip {
  id: string;
  label: string;
  glyph?: string;
  emoji?: string;
  active?: boolean;
}

/** The builder's visible state, as the component hands it over. */
export interface BuilderMirrorInput {
  /** Main-grid cells in reading order. */
  cells: BuilderMirrorCell[];
  /** Whether the paging controls take their two cells (the list overflows). */
  paging?: boolean;
  /** Category tabs (the rail beside the grid). */
  tabs?: BuilderMirrorChip[];
  /** Mode / group chips for the active tab. */
  chips?: BuilderMirrorChip[];
  /** Composed sentence, one glyph string per slot. */
  slots?: string[];
  /** The slot the student has explicitly selected, if any. */
  activeSlot?: number | null;
  /** Whether the engine (not the registry) is driving tabs/chips/words. */
  engine?: boolean;
  /** Localized labels for the three sentence controls. */
  labels?: { play?: string; backspace?: string; clear?: string };
  /** Grid geometry. Defaults to the builder's own fixed 9×2. */
  rows?: number;
  cols?: number;
  /**
   * WORD FINDER. When guessing is active the builder hands its grid over to a
   * server-authored board, and these buttons REPLACE `cells` — they are the
   * grid the child is looking at, so the mirror shows them rather than a blank
   * space with a badge saying "word finder".
   *
   * Passed through with their own art and labels intact and only their ids
   * rewritten, because a word-finder button is not builder vocabulary: it is a
   * narrowing step whose meaning lives in `suggestionKey` / `narrowDimension`,
   * which only the builder's own dispatch can read.
   */
  guessButtons?: BoardButton[];
}

/** What `serializeBuilderMirror` produces — exactly the fields the existing
 *  `board-mirror` message already carries, plus the two new rails. */
export interface BuilderMirrorSnapshot {
  board: ParsedBoardData;
  contextButtons: BoardButton[];
  chips: MirrorQuickButton[];
  strip: MirrorStripItem[];
}

/** The builder's main grid is 9 wide × 2 tall — a fact `aac-builder-paging`
 *  owns, restated here only as a fallback shape. */
const DEFAULT_COLS = 9;
const DEFAULT_ROWS = BUILDER_GRID_CELLS / DEFAULT_COLS;

/**
 * Tint for a word that is present in the scene — the student's own green "here
 * now" treatment (EngineWordButton's `bg-green-50`).
 *
 * 🚨 PALE, not saturated. Every mirrored fill is a BACKGROUND behind DARK text,
 * exactly as `BoardButtonVisual` paints the real board: the AAC palette is all
 * pastels (shared/button-color.ts COLOR_MAP) and the label is `text-gray-800`.
 * A dark plate here puts dark text on a dark fill and the word disappears.
 */
const PRESENT_TINT = "#DCFCE7";

/** The active category tab. Same rule as PRESENT_TINT — pale, dark text on it. */
const ACTIVE_TAB_TINT = "#EDE9FE";

/**
 * Turn the builder's visible state into mirror shapes.
 *
 * Cells are laid out in reading order and CLAMPED to the grid: the student's
 * own grid is a fixed template that a 19th button would silently reflow, and a
 * mirror that reflowed differently would be showing a board nobody is looking
 * at. When the list overflows, two cells become the paging controls — the same
 * budget `aac-builder-paging.ts` spends — and they BRACKET the words: Back in
 * the FIRST cell, More in the last (user, 2026-08-27). The student's board is
 * what this mirrors, so the positions are not a choice made here.
 */
export function serializeBuilderMirror(input: BuilderMirrorInput): BuilderMirrorSnapshot {
  // Word Finder owns the whole grid when it is up. It FLOWS four across
  // (`gridAutoRows` on the student's side), so the buttons' own row/col are
  // ignored there and must be ignored here too.
  if (input.guessButtons) {
    return {
      ...emptyChrome(input),
      board: guessBoard(input.guessButtons),
    };
  }
  const cols = input.cols ?? DEFAULT_COLS;
  const rows = input.rows ?? DEFAULT_ROWS;
  const capacity = rows * cols;
  const wordCells = input.paging ? Math.max(0, capacity - BUILDER_PAGE_CONTROLS) : capacity;

  const buttons: BoardButton[] = [];
  const place = (index: number) => ({ row: Math.floor(index / cols), col: index % cols });

  // Back takes the first cell when the list pages, so the words start one in.
  const firstWord = input.paging ? 1 : 0;

  input.cells.slice(0, wordCells).forEach((cell, i) => {
    buttons.push({
      ...place(firstWord + i),
      id: formatBuilderTarget(
        (cell.engine ?? input.engine)
          ? { kind: "engineWord", key: cell.key }
          : { kind: "word", key: cell.key },
      ),
      label: cell.label,
      glyph: cell.glyph ?? cell.key,
      glyphFallback: cell.emoji,
      iconRef: cell.emoji,
      color: cell.present ? PRESENT_TINT : undefined,
    });
  });

  if (input.paging) {
    // Fixed positions, the two ENDS of the list — the student's controls do not
    // move as the word list changes, and neither may the mirror's. Back is
    // pushed FIRST so the buttons stay in reading order, which is the order a
    // clinician's own grid renders them in.
    buttons.unshift({
      ...place(0),
      id: formatBuilderTarget({ kind: "page", dir: "back" }),
      label: "◀",
      iconRef: "◀",
    });
    buttons.push({
      ...place(capacity - 1),
      id: formatBuilderTarget({ kind: "page", dir: "more" }),
      label: "▶",
      iconRef: "▶",
    });
  }

  const board: ParsedBoardData = {
    name: "builder",
    grid: { rows, cols },
    currentPageId: "builder",
    pages: [{ id: "builder", name: "builder", buttons }],
  };

  const contextButtons: BoardButton[] = (input.tabs ?? []).map((tab, i) => ({
    id: formatBuilderTarget(input.engine ? { kind: "engineTab", tab: tab.id } : { kind: "tab", tab: tab.id }),
    row: i,
    col: 0,
    label: tab.label,
    glyph: tab.glyph,
    glyphFallback: tab.emoji,
    iconRef: tab.emoji,
    // The active tab is the student's current context; without it the clinician
    // cannot tell which of nine identical-looking rails is live.
    color: tab.active ? ACTIVE_TAB_TINT : undefined,
  }));

  const chips: MirrorQuickButton[] = (input.chips ?? []).map((chip) => ({
    id: formatBuilderTarget(input.engine ? { kind: "engineChip", chip: chip.id } : { kind: "chip", chip: chip.id }),
    label: chip.label,
    emoji: chip.emoji,
    active: chip.active,
  }));

  const slots = input.slots ?? [];
  const strip: MirrorStripItem[] = slots.map((glyph, index) => ({
    id: formatBuilderTarget({ kind: "slot", index }),
    kind: "slot",
    glyph,
    active: input.activeSlot === index,
  }));

  // Controls sit after the sentence, and only when they can do something —
  // mirroring a dead control invites a clinician to press it and conclude the
  // link is broken.
  if (slots.length > 0) {
    if (input.activeSlot != null) {
      strip.push({
        id: formatBuilderTarget({ kind: "clear" }),
        kind: "control",
        label: input.labels?.clear,
        emoji: "🗑",
      });
    } else {
      strip.push({
        id: formatBuilderTarget({ kind: "backspace" }),
        kind: "control",
        label: input.labels?.backspace,
        emoji: "⌫",
      });
    }
    strip.push({
      id: formatBuilderTarget({ kind: "play" }),
      kind: "control",
      label: input.labels?.play,
      emoji: "▶",
    });
  }

  return { board, contextButtons, chips, strip };
}

/** Tabs, chips and the sentence strip, without the main grid — shared by the
 *  Word Finder path, where the grid comes from the server instead. */
function emptyChrome(input: BuilderMirrorInput): BuilderMirrorSnapshot {
  const { board, ...chrome } = serializeBuilderMirror({ ...input, guessButtons: undefined, cells: [] });
  return { ...chrome, board };
}

/** Cells per row in the Word Finder grid — the student's own `repeat(4, …)`. */
const GUESS_COLS = 4;

/** The Word Finder's board, re-laid the way the student's flows and re-keyed so
 *  a press comes back as a `guess` target rather than a board-button press. */
function guessBoard(guessButtons: BoardButton[]): ParsedBoardData {
  const buttons = guessButtons.map((b, i) => ({
    ...b,
    id: formatBuilderTarget({ kind: "guess", buttonId: b.id }),
    row: Math.floor(i / GUESS_COLS),
    col: i % GUESS_COLS,
    // The student's grid flows; a span carried over from an authored layout
    // would tear a hole in a grid that never had one.
    rowSpan: 1,
    colSpan: 1,
  }));
  return {
    name: "wordfinder",
    grid: { rows: Math.max(1, Math.ceil(buttons.length / GUESS_COLS)), cols: GUESS_COLS },
    currentPageId: "wordfinder",
    pages: [{ id: "wordfinder", name: "wordfinder", buttons }],
  };
}

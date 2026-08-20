/**
 * project.ts — WHAT THE SIMULATED CHILD IS HANDED (harness design ④).
 *
 * Turns the virtual device's state into the numbered surface the child reads,
 * filtered through their perception profile. This is where the harness's first
 * three laws are actually enforced, so each one is a function here rather than a
 * convention someone has to remember:
 *
 *   ① THE PROJECTION IS THE FIDELITY LINE. Only what is perceivable from the
 *     glass. `spokenText`, button ids, `buttonType`, glyph keys, the Observer's
 *     read and the Board Manager's reasoning are NEVER emitted. A cell carries a
 *     label (if the child can read), a picture, a colour, and a number to press.
 *   ② A BUTTON'S FACE IS COPIED, NEVER COMPOSED. Labels pass through
 *     byte-for-byte — untranslated, un-cased, untidied. A raw `aac.glyph.apple`
 *     on a Hebrew board must arrive as `aac.glyph.apple`. That is the test.
 *   ③ EVERY PRESSABLE SURFACE IS IN THE PROJECTION. Board cells, the quick row,
 *     the context strip, the overlay. A surface the child cannot press is one no
 *     finding can ever come from.
 *
 * The PICTURE is the emoji or the image key, per the harness's §3.2 decision —
 * art descriptions are a separate test. That means a picture leaks its concept,
 * and for an image key it leaks the English word; both are accepted and neither
 * may be read as evidence about symbol quality.
 */

import type { BoardButton } from "@shared/schema";
import { resolveEmoji } from "@shared/emoji-registry";
import type { SlotState } from "@shared/aac/board-slots";
import type { QuickActionSlot } from "@shared/aac/quick-actions";
import type { ContextButton } from "@shared/aac/context-sidebar";
import type { SimClientModel } from "./client-model.js";

// The perception dial lives with the PROFILE (shared/aac/sim-profiles), not
// here: a profile also seeds the student's settings row, and if the two
// definitions drifted the harness would test a child the settings do not
// describe. Re-exported so callers of the projection need only one import.
export type { PerceptionProfile } from "@shared/aac/sim-profiles";
import type { PerceptionProfile } from "@shared/aac/sim-profiles";

export const FLUENT_READER: PerceptionProfile = { reading: "fluent", colourSalience: true };

/** One pressable thing, as the child sees it. */
export interface ProjectedCell {
  /** What the child types to press it. Stable within one view. */
  n: number;
  /**
   * Where it lives, so a report can say "the corner one".
   *
   * The last three are SENTENCE-BUILDER surfaces: its category tabs, the
   * sub-category chips within the open tab, and its own controls (Play, undo,
   * More). They are separate from `board` because reaching a word through a tab
   * costs a press that reaching it on the ranked grid does not — and that
   * difference is the reachability measurement.
   */
  where: "board" | "quick" | "context" | "overlay" | "tab" | "chip" | "control";
  /** The visible label, or null when this child cannot read it. */
  label: string | null;
  /** The picture: an emoji, or an image key when that is all there is. */
  picture: string | null;
  colour?: string;
  /** Rendered but inert (a dimmed Back). Pressing it is a real finding. */
  disabled?: boolean;
  /** Lit control (Guess on, board held, builder open). */
  active?: boolean;
}

export interface ProjectedView {
  surface: "board" | "overlay";
  boardName: string | null;
  pageName: string | null;
  grid: { rows: number; cols: number };
  /** Cells in reading order, blanks included — an empty cell is information. */
  cells: ProjectedCell[];
  /** Empty-cell positions, by `n`-adjacent index, for the report. */
  emptyCount: number;
  heard: { source: string; text: string; at: number; speaker?: string }[];
  status: ReturnType<SimClientModel["status"]>;
}

/**
 * The picture on a button, in the order the real renderer resolves art:
 * an explicit emoji (`iconRef`), the emoji a glyph key resolves to, then the
 * image key as a bare word, then nothing.
 *
 * Never derived from the LABEL — that would hand a non-reading profile the word
 * and make every symbol score perfect (§3.2).
 */
export function pictureOf(button: Partial<BoardButton> & Record<string, unknown>): string | null {
  const iconRef = typeof button.iconRef === "string" ? button.iconRef : "";
  if (iconRef && !iconRef.startsWith("fa")) return iconRef;

  const glyph = typeof button.glyph === "string" ? button.glyph : "";
  if (glyph) {
    // Single keys only — a composed glyph has no one emoji, and guessing at one
    // would be composing a face the renderer never draws.
    const emoji = /[+.()]/.test(glyph) ? undefined : resolveEmoji(glyph);
    if (emoji) return emoji;
  }

  const imageKey = typeof button.imageKey === "string" ? button.imageKey : "";
  if (imageKey) return resolveEmoji(imageKey) ?? imageKey;

  const fallback = typeof button.glyphFallback === "string" ? button.glyphFallback : "";
  if (fallback) return fallback;

  // A generated symbol with no emoji and no key: there IS a picture, and the
  // child can see it — they just cannot be told what it depicts.
  if (typeof button.symbolPath === "string" && button.symbolPath) return "PICTURE (undescribed)";
  return null;
}

/** Apply the reading dial to one label. `seen` carries the logographic memory. */
export function readLabel(
  label: string,
  profile: PerceptionProfile,
  seen?: Set<string>,
): string | null {
  const raw = label ?? "";
  if (!raw) return null;
  switch (profile.reading) {
    case "fluent":
      return raw;
    case "none":
      return null;
    case "logographic":
      // A word is readable once it has been MET — the sight-word model. The
      // caller decides what counts as meeting it (pressing, or hearing it).
      return seen?.has(raw.toLowerCase()) ? raw : null;
    case "emerging": {
      const limit = profile.longWordChars ?? 8;
      // Redact per WORD, not per label: "I want the elephant" is mostly
      // readable to a child who stalls only on the long one.
      return raw
        .split(/(\s+)/)
        .map((tok) => (/\s/.test(tok) || tok.length <= limit ? tok : "▮".repeat(tok.length)))
        .join("");
    }
  }
}

export interface ProjectOptions {
  profile?: PerceptionProfile;
  /** Words this child has met, for the logographic dial. Mutated by the caller. */
  seenWords?: Set<string>;
  isRTL?: boolean;
  /** Heard lines newer than this stamp. Omit for all of them. */
  heardSince?: number;
  /**
   * Translator for the quick row's i18n KEYS.
   *
   * REQUIRED for a run that means anything. The AAC's translation tables live in
   * `client-aac/src/i18n/`, which the server tsconfig cannot reach (`@shared/*`
   * only), so the projection stays i18n-agnostic and the caller supplies this.
   * Without it the child is shown `quickActions.back` — a string no child has
   * ever seen on the device, and exactly the kind of false surface law ① exists
   * to keep out. The default only keeps the shape valid; it is not a run.
   */
  t?: (key: string) => string;
}

/** Last resort when no translator is supplied: the key's leaf, so output stays
 *  legible while still looking obviously wrong. */
function leafOf(key: string): string {
  const leaf = key.split(".").pop() ?? key;
  return leaf.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * Project the device into the view the child reads.
 *
 * Numbering runs across ALL surfaces in one sequence — board, then context,
 * then quick row — so `press 14` is unambiguous and the child never has to name
 * a surface to reach a button (law ③). An overlay REPLACES the board, because on
 * the real device it does: the buttons underneath are not pressable.
 */
export function projectView(model: SimClientModel, opts: ProjectOptions = {}): ProjectedView {
  const { profile = FLUENT_READER, seenWords, isRTL = false, heardSince, t = leafOf } = opts;
  const cells: ProjectedCell[] = [];
  let n = 1;

  const overlay = model.overlay();
  const board = model.board();
  const page = model.page();

  if (overlay) {
    for (const opt of overlay.options) {
      cells.push({
        n: n++,
        where: "overlay",
        label: readLabel(String(opt.label ?? ""), profile, seenWords),
        picture: pictureOf(opt as never),
        ...(profile.colourSalience && opt.color ? { colour: opt.color } : {}),
      });
    }
    if (overlay.escapeKind) {
      cells.push({
        n: n++,
        where: "overlay",
        label: readLabel(overlay.escapeKind, profile, seenWords),
        picture: overlay.escapeKind === "maybe" ? "🤷" : "🚫",
      });
    }
  } else {
    for (const slot of model.cells()) {
      if (slot.type === "blank") {
        // A blank still occupies a position, and an eye-gaze child aims at
        // positions — so it is numbered and reported, not silently skipped.
        cells.push({ n: n++, where: "board", label: null, picture: null });
        continue;
      }
      const b = slot.button as BoardButton & Record<string, unknown>;
      cells.push({
        n: n++,
        where: "board",
        label: readLabel(String(b.label ?? ""), profile, seenWords),
        picture: pictureOf(b),
        ...(profile.colourSalience && typeof b.color === "string" ? { colour: b.color } : {}),
      });
    }
  }

  for (const c of model.contextButtons() as ContextButton[]) {
    cells.push({
      n: n++,
      where: "context",
      label: readLabel(c.label, profile, seenWords),
      picture: pictureOf(c as never),
    });
  }

  for (const q of projectQuickRow(model, { isRTL, t, startAt: n })) {
    cells.push(q);
    n = q.n + 1;
  }

  return {
    surface: overlay ? "overlay" : "board",
    boardName: board?.name ?? null,
    pageName: page?.name ?? null,
    grid: model.grid(),
    cells,
    emptyCount: cells.filter((c) => c.where === "board" && !c.label && !c.picture).length,
    heard: model.heard.filter((h) => heardSince === undefined || h.at > heardSince),
    status: model.status(),
  };
}

/**
 * The fixed bottom row, projected on its own.
 *
 * Extracted because it appears on TWO surfaces: the board and the sentence
 * builder, which the AAC renders as an overlay ABOVE the board area while
 * leaving this row visible and live (home.tsx passes it `inSentenceBuilder`,
 * which is only meaningful if the child can still see it). One definition, so
 * the two screens cannot disagree about what the child can always reach.
 */
export function projectQuickRow(
  model: SimClientModel,
  opts: { isRTL?: boolean; t?: (key: string) => string; startAt?: number } = {},
): ProjectedCell[] {
  const { isRTL = false, t = leafOf, startAt = 1 } = opts;
  let n = startAt;
  const out: ProjectedCell[] = [];
  for (const q of model.quickActions(isRTL) as QuickActionSlot[]) {
    out.push({
      n: n++,
      where: "quick",
      // Quick actions are recognised by SHAPE and POSITION, not read — they are
      // fixed chrome a student learns once. So their label survives the reading
      // dial; suppressing it would model a child who cannot use a device they
      // have used every day. It is TRANSLATED, though: the device shows words,
      // never the `quickActions.*` key.
      label: t(q.labelKey),
      picture: q.icon.emoji,
      colour: q.color,
      ...(q.enabled ? {} : { disabled: true }),
      ...(q.active ? { active: true } : {}),
    });
  }
  return out;
}

/**
 * Render the view as the tagged lines the child (and the transcript) read.
 * Rigid grammar so transcripts diff: TAG at column 0, padded to 6, one fact per
 * line. Same discipline as world-engine text mode.
 */
export function renderView(view: ProjectedView): string[] {
  const tag = (t: string, rest: string) => `${t.padEnd(6)} ${rest}`;
  const lines: string[] = [];

  lines.push(
    tag(
      "SURF",
      [
        view.surface,
        view.boardName ? `board "${view.boardName}"` : null,
        view.pageName ? `page "${view.pageName}"` : null,
        `grid ${view.grid.rows}x${view.grid.cols}`,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );

  for (const c of view.cells) {
    if (c.where === "board" && !c.label && !c.picture) {
      lines.push(tag("CELL", `${c.n}  (empty)`));
      continue;
    }
    const bits = [
      `${c.n}`.padStart(2),
      c.label === null ? "—" : `"${c.label}"`,
      c.picture ? `pic ${c.picture}` : "",
      c.colour ? `colour ${c.colour}` : "",
      c.disabled ? "(dimmed)" : "",
      c.active ? "(lit)" : "",
    ].filter(Boolean);
    lines.push(tag(c.where === "board" ? "CELL" : c.where.toUpperCase().slice(0, 5), bits.join("  ")));
  }

  for (const h of view.heard) {
    const t = h.source === "ai" ? "HEARD" : h.source === "self" ? "SAID" : "HEARD";
    lines.push(tag(t, `${h.speaker ? `${h.speaker}: ` : ""}"${h.text}"  (+${h.at}ms)`));
  }

  const busy = Object.entries(view.status.busy)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (busy.length) lines.push(tag("WAIT", `${busy.join(", ")} still working…`));

  return lines;
}

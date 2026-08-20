/**
 * builder.ts — THE SENTENCE BUILDER, PROJECTED (harness design ④, second half).
 *
 * The builder is not reimplemented here. The AAC's builder is already driven by
 * the world engine's surfacer (`builderSurfaceFor`) through
 * `EngineBuilderBackend`, and the engine already ships a pure, host-free text
 * driver over the same surfacer — `createTextBuilder`, written for its own
 * AI-driven players. So the harness reuses that, and this module's only job is
 * to make it page and speak like the AAC rather than like text mode:
 *
 *   CAPACITY  — `BUILDER_SURFACE_CAPACITY` (54), what the AAC board asks for,
 *               not text mode's default 8. A different budget ranks a different
 *               set of words into reach, which would change every press count.
 *   PAGING    — the AAC's own rule (`pageBuilderGrid`: 18 cells, 17 once More
 *               takes one, wrapping forever). Text mode slices cleanly and
 *               refuses to page past the end; measuring reachability with THAT
 *               would describe the text harness's board, not the child's.
 *
 * That seam is the whole reason `createTextBuilder` takes an injected pager.
 *
 * WHAT IS STILL TEXT MODE'S MODEL, and therefore a known divergence: the
 * composition is a token list joined with " + " and modifiers composed with
 * ".", which is the glyph string the AAC also produces — but the AAC additionally
 * carries TONE tags (`#question`), mode chips, and a slot-level active-slot
 * cursor. A sim run exercises word reach, modifier reach and interpretation; it
 * does not exercise tone or the slot cursor.
 */

import {
  createTextBuilder,
  type BuilderPager,
  type TextBuilder,
} from "@shared/world-engine/interaction/text/index.js";
import { defaultBuilderNouns } from "@shared/world-engine/interaction/intent/builder-surface.js";
import { pageBuilderGrid } from "@shared/aac-builder-paging.js";
import { resolveEmoji } from "@shared/emoji-registry.js";
import type { ClientMessage } from "../dual-agent/live-relay.js";
import type { ProjectedCell } from "./project.js";
import type { ActResult } from "./act.js";

/**
 * What the AAC board asks the surfacer for. Mirrors
 * `client-aac/src/lib/engine-builder.ts` — three of the board's grid pages.
 * Restated (not imported) because that module is client-side; if the board's
 * budget changes, this must follow, and the test pins them together.
 */
export const AAC_BUILDER_CAPACITY = 54;

/**
 * The AAC's pager, in the shape `createTextBuilder` injects. `pages: null`
 * because the AAC's More button CYCLES — there is no last page, and reporting a
 * total would invent one.
 */
export const aacBuilderPager: BuilderPager = (words, page) => ({
  items: pageBuilderGrid(words, page).items,
  pages: null,
  page,
});

export interface SimBuilderOptions {
  locale?: string;
  /** Override the noun library (a game host supplies its own scene nouns). */
  nouns?: ReturnType<typeof defaultBuilderNouns>;
}

/** Open a builder session that behaves like the AAC's out-of-game builder. */
export function createSimBuilder(opts: SimBuilderOptions = {}): TextBuilder {
  return createTextBuilder({
    locale: opts.locale ?? "en",
    grid: AAC_BUILDER_CAPACITY,
    nouns: opts.nouns ?? defaultBuilderNouns(),
    pager: aacBuilderPager,
  });
}

/** The builder screen as the child reads it. */
export interface ProjectedBuilder {
  surface: "builder";
  /** The glyph string composed so far — the thing Play would send. */
  partial: string;
  /** What it WOULD say, translated. The child hears this on Play, not before. */
  preview: string;
  /** The surfacer's own verdict that the sentence is sayable. */
  complete: boolean;
  /** Words and the modifier rail, numbered continuously. */
  cells: ProjectedCell[];
  /** Category tabs the engine serves, and which is open. */
  tabs: string[];
  openTab: string | null;
  /** Sub-category chips within the open view. */
  groups: { id: string; label: string; count: number }[];
  openGroup: string | null;
  /** 1-based. No total: the AAC's More cycles. */
  page: number;
  /** The next free number, so the caller can continue numbering the quick row. */
  nextN: number;
}

/**
 * The face a builder word draws, per the harness's §3.2 rule: the emoji when the
 * glyph resolves to one, else the glyph string itself.
 *
 * ⚠️ The fallback LEAKS the English key to a profile that supposedly cannot
 * read — the same accepted distortion the board projection makes for an
 * `imageKey`, and for the same reason: art descriptions are a separate test. A
 * composed face (`apple.hot`) has no single emoji and arrives as the composed
 * string, which is at least honestly what the button is showing.
 */
function faceOf(glyph: string): string | null {
  if (!glyph) return null;
  if (!/[+.()]/.test(glyph)) {
    const emoji = resolveEmoji(glyph);
    if (emoji) return emoji;
  }
  return glyph;
}

interface BuilderBlock {
  partial: string;
  preview: string;
  complete: boolean;
  options: { n: number; id: string; label: string; glyph?: string; modifier?: boolean }[];
  groups?: { id: string; label: string; count: number }[];
  tabs?: string[];
  tab?: string;
  group?: string;
  page?: number;
}

/**
 * Project one builder screen.
 *
 * Law ① holds in the usual sense: the child gets a label, a picture and a
 * number, and the option's `id` is never a FIELD of the view — presses route by
 * number through the caller's index.
 *
 * But be precise about what that does and does not buy: when a word's glyph has
 * no emoji, the face falls back to the key string, so the key can still reach a
 * non-reading child AS the picture (see `faceOf`). That is the same accepted
 * §3.2 leak the board projection makes, not a claim that keys are hidden.
 *
 * `preview` is included because the AAC shows the composed sentence back to the
 * student as they build; withholding it would model a stricter board than the
 * real one.
 */
export function projectBuilder(
  builder: TextBuilder,
  opts: { readLabel?: (label: string) => string | null; startAt?: number } = {},
): ProjectedBuilder {
  const block = builder.block() as unknown as BuilderBlock;
  const read = opts.readLabel ?? ((l: string) => l);
  let n = opts.startAt ?? 1;

  const cells: ProjectedCell[] = block.options.map((o) => ({
    n: n++,
    where: "board",
    label: read(o.label),
    // EVERY builder button has a face. `createTextBuilder` only annotates
    // `glyph` where the drawn face DIFFERS from the pressed key (a place draws
    // as a composed icon), so taking it alone left most words with no picture —
    // which would show a non-reading child an empty board and generate findings
    // about a screen the AAC never draws. The face is the glyph, and the glyph
    // is the key unless the option says otherwise.
    picture: faceOf(o.glyph ?? o.id),
    ...(o.modifier ? { active: true } : {}),
  }));

  // EVERY BUILDER SURFACE IS PRESSABLE (law ③). Tabs and chips are how a word
  // that did not rank into the grid is reached at all, and the Play control is
  // the only thing that sends the sentence — a projection that listed them as
  // prose would show the child a screen it could not use.
  for (const tab of block.tabs ?? []) {
    cells.push({ n: n++, where: "tab", label: read(tab), picture: null, active: block.tab === tab });
  }
  for (const g of block.groups ?? []) {
    cells.push({
      n: n++,
      where: "chip",
      label: read(g.label),
      picture: null,
      active: block.group === g.id,
    });
  }
  // Controls last and in a fixed order, so they hold the same numbers from one
  // screen to the next — a control that moved would be a control an eye-gaze
  // child has to re-find every turn.
  cells.push({ n: n++, where: "control", label: "PLAY", picture: "▶" });
  cells.push({ n: n++, where: "control", label: "undo", picture: "↩" });
  cells.push({ n: n++, where: "control", label: "more words", picture: "🔄" });

  return {
    surface: "builder",
    partial: block.partial,
    preview: block.preview,
    complete: block.complete,
    cells,
    tabs: block.tabs ?? [],
    openTab: block.tab ?? null,
    groups: block.groups ?? [],
    openGroup: block.group ?? null,
    page: block.page ?? 1,
    nextN: n,
  };
}

/** The three fixed controls, in the order `projectBuilder` emits them. */
export const BUILDER_CONTROLS = ["PLAY", "undo", "more words"] as const;

/** Render a builder screen as tagged lines, same grammar as the board view. */
export function renderBuilder(view: ProjectedBuilder): string[] {
  const tag = (t: string, rest: string) => `${t.padEnd(6)} ${rest}`;
  const lines: string[] = [];

  lines.push(
    tag(
      "BUILD",
      [
        view.partial ? `"${view.partial}"` : "(empty)",
        view.complete ? "sayable" : "not yet sayable",
        `page ${view.page}`,
        view.openTab ? `tab ${view.openTab}` : null,
        view.openGroup ? `group ${view.openGroup}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  if (view.preview) lines.push(tag("SAYS", `"${view.preview}"`));
  if (view.tabs.length) lines.push(tag("TABS", view.tabs.join(", ")));
  if (view.groups.length) {
    lines.push(tag("CHIPS", view.groups.map((g) => `${g.id} (${g.count})`).join(", ")));
  }
  for (const c of view.cells) {
    const bits = [
      `${c.n}`.padStart(2),
      c.label === null ? "—" : `"${c.label}"`,
      c.picture ? `pic ${c.picture}` : "",
      c.active ? "(modifier)" : "",
    ].filter(Boolean);
    lines.push(tag("WORD", bits.join("  ")));
  }
  return lines;
}

// ── acting ─────────────────────────────────────────────────────────────────

const local = (note: string): ActResult => ({ message: null, note, local: true });

/**
 * Press a word or a modifier by its printed number.
 *
 * Composing is LOCAL — nothing reaches the server until Play. That is the real
 * behaviour and it matters for the measurement: a sentence costs N presses of
 * which exactly one is a message, and a harness that reported traffic per press
 * would make the builder look chattier than it is.
 */
export function pressBuilderCell(builder: TextBuilder, n: number): ActResult {
  const r = builder.tap(String(n));
  if (!r.ok) return local(`tried to press ${n} — ${r.error ?? "it did nothing"}`);
  return local(r.modifier ? `described it as "${r.applied}"` : `added "${r.applied}"`);
}

export function pressBuilderTab(builder: TextBuilder, name: string): ActResult {
  const r = builder.setTab(name);
  return local(r.ok ? `opened the ${r.applied} tab` : `tried the ${name} tab — ${r.error}`);
}

export function pressBuilderGroup(builder: TextBuilder, id: string): ActResult {
  const r = builder.setGroup(id);
  return local(r.ok ? `opened the ${r.applied} group` : `tried the ${id} group — ${r.error}`);
}

/** The More button. On the AAC it cycles, so it never refuses. */
export function pressBuilderMore(builder: TextBuilder): ActResult {
  const r = builder.page("more");
  return local(r.ok ? "asked for more words" : `pressed More — ${r.error}`);
}

export function pressBuilderUndo(builder: TextBuilder): ActResult {
  const r = builder.undo();
  return local(r.ok ? `took back "${r.applied}"` : `pressed undo — ${r.error}`);
}

/**
 * PLAY — the one press that reaches the server. The composed glyph goes up as
 * `glyph_press`; the server's `interpret` turns it into the sentence the AI
 * actually speaks, which is the thing a scenario checks against the child's
 * intent. An empty Play is an error, never a silent no-op (law ⑦).
 */
export function pressBuilderPlay(builder: TextBuilder): ActResult {
  const glyph = builder.play();
  if (!glyph) return local("pressed Play with nothing composed");
  return {
    message: { type: "glyph_press", glyph } as ClientMessage,
    note: `played "${glyph}"`,
    local: false,
  };
}

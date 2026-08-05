// shared/world-engine/interaction/text/builder.ts
//
// THE SENTENCE BUILDER, DRIVEN BY TEXT (design §7, law ④).
//
// A SCREEN IS A LIST, AND ITS COST IS PART OF THE OUTPUT. Every screen here
// comes from `builderSurfaceFor` at the REAL grid budget — the same engine
// surfacer the platform's builder is driven by when a game hosts it. Never
// board-island's local label tables (they are the game's chrome, not the
// engine's answer), and never `surfaceNext` directly (that would skip the
// category ladder, the modifier rail and the group chips — precisely the three
// costs this harness exists to measure).
//
// THE RANKED GRID IS A BUDGET, NOT A MENU. `capacity` is the grid the student
// actually sees; a word that did not rank into it is reachable only through a
// TAB or a GROUP chip, and that extra tap IS the finding. So this module never
// widens the capacity to be helpful, never merges the tabs into one long list,
// and pages a tab listing at exactly the grid size.
//
// ── The grammar (session.ts dispatches; this module holds the state) ────────
//   builder             reprint the current screen         (a screen, no press)
//   build <word|n|.mod> tap a word — or, with a leading ".", the modifier rail,
//                       which composes onto the CURRENT HEAD with a "."
//   build tab <name>    open a category tab
//   build group <id>    open a sub-category chip within the active view
//   build undo          drop the last token
//   build clear         empty the composition
//   build play          speak it (session hands the sentence to host.speak)
//   more / back         page the active listing, while a builder is open
//
// `undo` DROPS THE WHOLE TOKEN, modifiers and all — the build order's own
// wording ("drop last token"), and the only reading that stays predictable once
// a token carries two of them. `clear` is there for the other case.
//
// Pure and host-free: no clock, no world, no host. The session owns the counting
// and the speaking; this module owns the screen.

import {
  builderSurfaceFor,
  type BuilderNounEntry,
  type BuilderSurfaceJson,
  type BuilderSurfaceOpts,
  type BuilderWordJson,
} from "../intent/builder-surface.js";
import { translateGlyph } from "../lang/index.js";
import type { TextBoardOption, TextBuilderGroup, TextEvent } from "./types.js";

/** The grid a boot that names none is driven at (the CLI's `--grid` default). */
export const BUILDER_DEFAULT_GRID = 8;

/** What the driver may type instead of a tab name to get back to the ranked
 *  grid. Not a category — the ranked view is the ABSENCE of one. */
const RANKED_WORDS: ReadonlySet<string> = new Set(["none", "ranked", "grid", "clear", "off"]);

export interface TextBuilderDeps {
  locale?: string;
  /** The main-grid budget. Also the page size of a tab listing (§7). */
  grid?: number;
  /** The host's speakable nouns. Absent ⇒ `builderSurfaceFor`'s own curated
   *  fallback library, which is what an out-of-game builder offers. */
  nouns?: BuilderNounEntry[];
  /** THE SURFACER. Defaults to the real `builderSurfaceFor`; injectable so a
   *  test can pin an exact screen without pinning the whole lexicon's ranking. */
  surface?: (partial: string, opts: BuilderSurfaceOpts) => BuilderSurfaceJson;
}

/** What a tap did, or why it did nothing. `applied` is the key that landed. */
export interface BuilderTap {
  ok: boolean;
  error?: string;
  applied?: string;
  /** The tap composed onto the head with a "." rather than adding a word. */
  modifier?: boolean;
}

export interface TextBuilder {
  tokens(): readonly string[];
  /** The composition as one glyph sentence — what the surfacer is asked about
   *  and, at `play`, what the host is handed. */
  partial(): string;
  empty(): boolean;
  /** The BUILDER event for the current view. Pure: the CALLER counts screens. */
  block(): TextEvent;
  /** `build <label | key | n | .modifier>`. */
  tap(arg: string): BuilderTap;
  setTab(name: string): BuilderTap;
  setGroup(id: string): BuilderTap;
  /** `more` / `back` inside builder context. */
  page(dir: "more" | "back"): BuilderTap;
  undo(): BuilderTap;
  clear(): void;
  /** The sentence, with the whole screen state reset. Null when nothing is
   *  composed — an empty `play` is an error, never a silent no-op. */
  play(): string | null;
}

/** Normalized for matching: a driver types captions, not keys. */
const norm = (s: string): string => s.trim().toLowerCase();

export function createTextBuilder(deps: TextBuilderDeps = {}): TextBuilder {
  const grid = Math.max(1, deps.grid ?? BUILDER_DEFAULT_GRID);
  const surface = deps.surface ?? builderSurfaceFor;

  let tokens: string[] = [];
  let tab: string | null = null;
  let group: string | null = null;
  let page = 0;

  const partial = (): string => tokens.join(" + ");

  const ask = (): BuilderSurfaceJson =>
    surface(partial(), {
      capacity: grid,
      ...(deps.locale ? { locale: deps.locale } : {}),
      ...(deps.nouns ? { nouns: deps.nouns } : {}),
      ...(tab ? { category: tab } : {}),
      ...(group ? { group } : {}),
    });

  /** One numbered row. The `[glyph]` rides beside the caption ONLY where the
   *  drawn face differs from the pressed key — a place is one word that draws
   *  as a composed shell+symbol icon, and that difference is worth showing. */
  const row = (w: BuilderWordJson, n: number, modifier?: boolean): TextBoardOption => ({
    n,
    id: w.key,
    label: w.label,
    ...(w.glyph && w.glyph !== w.key ? { glyph: w.glyph } : {}),
    ...(modifier ? { modifier: true } : {}),
  });

  /** THE SCREEN as printed: this page of the listing, then the modifier rail,
   *  numbered continuously so `build 11` can reach a modifier. */
  interface View {
    surface: BuilderSurfaceJson;
    words: TextBoardOption[];
    modifiers: TextBoardOption[];
    all: TextBoardOption[];
    groups: TextBuilderGroup[];
    page: number;
    pages: number;
  }

  function view(): View {
    const s = ask();
    const buttons = s.buttons ?? [];
    const pages = Math.max(1, Math.ceil(buttons.length / grid));
    if (page >= pages) page = pages - 1;
    const words = buttons.slice(page * grid, page * grid + grid).map((w, i) => row(w, i + 1));
    const modifiers = (s.modifiers ?? []).map((w, i) => row(w, words.length + i + 1, true));
    const groups: TextBuilderGroup[] = (s.groups ?? []).map((g) => ({
      id: g.id,
      label: g.label,
      // The chip's EXEMPLAR count — the surface's own measure of how much lives
      // behind it, and therefore of what a tap on it is worth.
      count: g.glyphs?.length ?? (g.glyph ? 1 : 0),
    }));
    return { surface: s, words, modifiers, all: [...words, ...modifiers], groups, page, pages };
  }

  function block(): TextEvent {
    const v = view();
    const glyph = partial();
    return {
      tag: "BUILDER",
      partial: glyph,
      // TRANSLATED, never re-composed (law ②'s sibling): the preview says what
      // the sentence WOULD say, in the locale, spoken as the player.
      preview: glyph ? translateGlyph(glyph, deps.locale, { firstPerson: true }) : "",
      complete: v.surface.complete === true,
      options: v.all,
      ...(v.groups.length ? { groups: v.groups } : {}),
      ...(v.surface.categories?.length ? { tabs: [...v.surface.categories] } : {}),
      ...(tab ? { tab } : {}),
      ...(group ? { group } : {}),
      page: v.page + 1,
      pages: v.pages,
    };
  }

  /** A word tap resets the VIEW: a new head re-ranks everything, so an open tab
   *  or chip is stale the instant it is used (the SpeakMenu's own behaviour). */
  function resetView(): void {
    tab = null;
    group = null;
    page = 0;
  }

  function find(v: View, want: string): TextBoardOption | undefined {
    return (
      v.all.find((o) => o.id.toLowerCase() === want) ??
      v.all.find((o) => norm(o.label) === want) ??
      v.all.find((o) => o.glyph?.toLowerCase() === want) ??
      v.all.find((o) => norm(o.label).startsWith(want))
    );
  }

  function apply(o: TextBoardOption): BuilderTap {
    if (o.modifier) {
      // The registry modifier composes onto the CURRENT HEAD with a "." — the
      // SpeakMenu rule. With no head there is nothing to describe.
      if (!tokens.length) {
        return { ok: false, error: `nothing to describe yet — press a word first, then ${o.label}.` };
      }
      tokens[tokens.length - 1] = `${tokens[tokens.length - 1]}.${o.id}`;
      page = 0;
      return { ok: true, applied: o.id, modifier: true };
    }
    tokens.push(o.id);
    resetView();
    return { ok: true, applied: o.id };
  }

  return {
    tokens: () => tokens,
    partial,
    empty: () => tokens.length === 0,
    block,

    tap(arg) {
      const raw = arg.trim();
      if (!raw) return { ok: false, error: "build what? a word, a number, or .a-modifier." };
      const v = view();

      // A LEADING DOT IS THE RAIL, explicitly: `build .red` never falls through
      // to a word called "red" that happens to be on the grid.
      if (raw.startsWith(".")) {
        const want = norm(raw.slice(1));
        const m =
          v.modifiers.find((o) => o.id.toLowerCase() === want) ??
          v.modifiers.find((o) => norm(o.label) === want) ??
          v.modifiers.find((o) => norm(o.label).startsWith(want));
        if (!m) {
          return {
            ok: false,
            error: v.modifiers.length
              ? `no modifier "${want}" here. This head offers: ${v.modifiers.map((o) => o.label).join(", ")}.`
              : `this head has no modifiers.`,
          };
        }
        return apply(m);
      }

      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        const o = v.all.find((x) => x.n === n);
        if (!o) return { ok: false, error: `no such word. This screen has 1-${v.all.length}.` };
        return apply(o);
      }

      const o = find(v, norm(raw));
      if (!o) {
        return {
          ok: false,
          error: `"${raw}" is not on this screen. Try a tab (build tab …) or a group chip (build group …).`,
        };
      }
      return apply(o);
    },

    setTab(name) {
      const want = norm(name);
      if (RANKED_WORDS.has(want)) {
        resetView();
        return { ok: true, applied: "ranked" };
      }
      const tabs = view().surface.categories ?? [];
      const hit = tabs.find((t) => t.toLowerCase() === want) ?? tabs.find((t) => t.toLowerCase().startsWith(want));
      if (!hit) return { ok: false, error: `no tab "${name}". Tabs: ${tabs.join(", ")}.` };
      tab = hit;
      group = null;
      page = 0;
      return { ok: true, applied: hit };
    },

    setGroup(id) {
      const want = norm(id);
      const groups = view().groups;
      const hit =
        groups.find((g) => g.id.toLowerCase() === want) ??
        groups.find((g) => norm(g.label) === want) ??
        groups.find((g) => norm(g.label).startsWith(want));
      if (!hit) {
        return {
          ok: false,
          error: groups.length
            ? `no group "${id}" here. Groups: ${groups.map((g) => g.id).join(", ")}.`
            : "this screen has no group chips.",
        };
      }
      group = hit.id;
      page = 0;
      return { ok: true, applied: hit.id };
    },

    page(dir) {
      const v = view();
      if (dir === "more") {
        if (v.page + 1 >= v.pages) return { ok: false, error: "this is the last page of the list." };
        page = v.page + 1;
      } else {
        if (v.page === 0) return { ok: false, error: "this is the first page of the list." };
        page = v.page - 1;
      }
      return { ok: true, applied: dir };
    },

    undo() {
      if (!tokens.length) return { ok: false, error: "nothing to undo — the sentence is empty." };
      const dropped = tokens.pop()!;
      resetView();
      return { ok: true, applied: dropped };
    },

    clear() {
      tokens = [];
      resetView();
    },

    play() {
      if (!tokens.length) return null;
      const sentence = partial();
      tokens = [];
      resetView();
      return sentence;
    },
  };
}

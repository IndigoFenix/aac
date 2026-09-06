// games/dollhouse/src/board-island.tsx
//
// The dollhouse's response board — the SAME renderer the AAC uses (ported from
// world-lab's board-island). It mounts a small React root that draws the shared
// `<BoardButtonVisual>` (client-shared) in a 2×4 grid, exactly as `AppMiniBoard`
// does during a game, fed by the quest host's board view through the same
// `lockedBoardFrom` shape. The glyph composition is the shared `GlyphCompositor`
// with the game's bundled-icon resolver, so a button reads pixel-identical to
// the student's real board.
//
// Plus the FOOTER (concept-parser.md design contract): Yes / No / More are the
// always-present response affordances, and Speak opens the VOCABULARY — every
// word the concept parser understands (its `LEXICON`), each drawn with its glyph
// icon (if the registry has one). Tapping words composes a sentence; Play parses
// it and drives the addressed creature.
//
// The game is otherwise vanilla TS; this is the only React island, wrapped in
// an imperative handle (mount / set / dispose) the vanilla host drives.

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import { GlyphTriad } from "@client-shared/board/GlyphTriad";
import { restSpaceRatio } from "@shared/button-shape";
import type { BoardButtonInput, BoardRenderDeps, GlyphRenderProps, IconVisual } from "@client-shared/board/types";
// The component lives in the .tsx (the bare `@shared/glyph-compositor`
// resolves to the types-only .ts) — import it explicitly, as the AAC does.
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { CityHudChip, FamilyHudEntry, PocketEntry, QuestBoardView } from "@shared/world-engine/interaction/quest/quest-host";
import { familyStateGlyph } from "@shared/world-engine/interaction/quest/family-hud";
import { wellbeingGlyph } from "@shared/world-engine/interaction/quest/city-hud";
import { iconGlyph } from "@shared/world-engine/interaction/quest/activity-bubble";
import { parseSentence, type IntentKind } from "@shared/world-engine/interaction/intent/parse-intent";
import {
  emptyRecency,
  noteUtterance,
  type RecencyMemory,
} from "@shared/world-engine/interaction/intent/surface-next";
import {
  builderSurfaceFor,
  type BuilderGroupJson,
  type BuilderNounEntry,
  type BuilderWordJson,
} from "@shared/world-engine/interaction/intent/builder-surface";
import { getVocabularyItem } from "@shared/glyph-registry";
import { gameImageResolver } from "./glyph-resolver";

// Icon/text sizing mirrors AppMiniBoard's 4-row column, so the buttons read the
// same on the lab bench as in the student's board.
const ICON_FONT = "clamp(1rem, calc((100dvh - 10.5rem) / 4 * 0.45), 6rem)";
const TEXT_FONT = "clamp(0.5rem, calc((100dvh - 10.5rem) / 4 * 0.10), 1.25rem)";

/** The lab's Glyph wrapper: the shared compositor with the bundled-icon
 *  resolver (the AAC injects its own; the lab injects this). */
function LabGlyph(p: GlyphRenderProps) {
  return (
    <GlyphCompositor
      glyph={p.glyph ?? p.fallback ?? ""}
      resolveImage={gameImageResolver}
      noBackground={p.noBackground}
      ariaLabel={p.ariaLabel}
      fillSlot
    />
  );
}

/** Glyph-first icon resolution (game buttons always carry a composed glyph;
 *  fall back to the emoji iconRef). */
const resolveIcon = (button: BoardButtonInput): IconVisual => {
  if (button.glyph || button.glyphFallback) {
    return { kind: "glyph", glyph: button.glyph, fallback: button.glyphFallback };
  }
  if (button.iconRef) return { kind: "emoji", text: button.iconRef };
  return { kind: "placeholder" };
};

const deps: BoardRenderDeps = { resolveIcon, GlyphComponent: LabGlyph };

// The lab's board is a 2x4 strip of small buttons, so it takes the `small`
// corner space — same mechanism as the student's board, less of it. `gapPx`
// must match `.quest-boardpanel-grid { gap: 8px }` in styles.css, since the cut
// circles are centred in the gutter.
const BOARD_CORNER_SPACE = { ratio: restSpaceRatio("small"), gapPx: 8 };

function BoardStrip({ view, onSelect }: { view: QuestBoardView | null; onSelect: (id: string) => void }) {
  const options = view?.options.slice(0, 8) ?? [];
  return (
    <div className="quest-boardpanel-inner">
      <div className="quest-boardpanel-prompt">{view?.promptText ?? ""}</div>
      <div
        className="quest-boardpanel-grid"
        style={{
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gridTemplateRows: "repeat(4, minmax(0, 1fr))",
        }}
      >
        {options.map((o, i) => {
          const button: BoardButtonInput = {
            label: o.label,
            glyph: o.glyph,
            iconRef: o.iconRef,
            sentence: o.spokenText,
          };
          return (
            <BoardButtonVisual
              key={o.id + i}
              button={button}
              deps={deps}
              variant="board"
              onClick={() => onSelect(o.id)}
              iconFontSize={ICON_FONT}
              textFontSize={TEXT_FONT}
              borderClassName="board-btn-border"
              cornerSpace={BOARD_CORNER_SPACE}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Family strip: the dollhouse household, one state-glyph chip per member ────
// (family-hud.ts). Each member's state renders as a COMPOSED glyph image through
// the same GlyphCompositor the board buttons and over-head bubbles use — art
// where the state has it, its emoji through the compositor otherwise, never a
// raw text-node emoji (`familyStateGlyph`). A tap ADDRESSES that member — spoken
// commands go to it — so the chip is the stable eyegaze target a moving body
// can't be.

function FamilyStrip({ members, onSelect }: { members: FamilyHudEntry[]; onSelect: (id: string) => void }) {
  if (members.length === 0) return null;
  return (
    <div className="lab-family">
      {members.map((m) => (
        <button
          key={m.id}
          data-dwell
          className={`lab-family-chip${m.selected ? " selected" : ""}${m.present ? "" : " away"}`}
          title={m.state}
          onClick={() => onSelect(m.id)}
        >
          <span className="lab-family-emoji">
            <LabGlyph glyph={familyStateGlyph(m.state, m.emoji)} fallback={m.emoji} ariaLabel={m.state} noBackground />
          </span>
          <span className="lab-family-name">{m.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── City strip: per-district cohort chips + the city-total row (④) ───────────
// (city-hud.ts). The family HUD's civic sibling — one glanceable chip per
// district: its glyph, souls, the wellbeing face, key stocks worst-shortage
// first. Appears only once the town outgrows the tracked cap.

function CityStrip({ chips }: { chips: CityHudChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="lab-city">
      {chips.map((c) => (
        <div
          key={String(c.district)}
          className={`lab-city-chip${c.district === "city" ? " total" : ""}`}
          title={`${c.label} — ${c.tracked} tracked + ${c.pooled} pooled`}
        >
          <span className="lab-city-glyph">
            <LabGlyph glyph={c.glyph} fallback={c.label} ariaLabel={c.label} noBackground />
          </span>
          <span className="lab-city-pop">👥{c.population}</span>
          <span className="lab-city-well">
            <LabGlyph glyph={iconGlyph(wellbeingGlyph(c.wellbeing), c.emoji)} fallback={c.emoji} ariaLabel="wellbeing" noBackground />
          </span>
          {c.stocks.map((s) => (
            <span key={s.glyph} className={`lab-city-stock${s.shortage > 0.5 ? " short" : ""}`}>
              <span className="lab-city-stock-glyph">
                <LabGlyph glyph={s.glyph} fallback={s.glyph} ariaLabel={s.glyph} noBackground />
              </span>
              {s.count}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Inventory strip: pocketed small items, hover/tap to select ────────────────

function PocketStrip({ items, onSelect }: { items: PocketEntry[]; onSelect: (glyph: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="lab-pocket">
      {items.map((it) => (
        <button
          key={it.glyph}
          data-dwell
          className={`lab-pocket-item${it.selected ? " selected" : ""}`}
          title={it.label}
          onClick={() => onSelect(it.glyph)}
        >
          <LabGlyph glyph={it.icon ?? it.glyph} fallback={it.label} ariaLabel={it.label} noBackground />
          {it.count > 1 && <span className="lab-pocket-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Footer: the always-present response affordances (concept-parser.md §3) ────

function Footer({
  onAffirm,
  onDecline,
  onMore,
  onSpeak,
}: {
  onAffirm: () => void;
  onDecline: () => void;
  onMore: () => void;
  onSpeak: () => void;
}) {
  return (
    <div className="lab-footer">
      <button className="lab-footer-btn lab-yes" onClick={onAffirm}>✓ Yes</button>
      <button className="lab-footer-btn lab-no" onClick={onDecline}>✗ No</button>
      <button className="lab-footer-btn" onClick={onMore}>⋯ More</button>
      <button className="lab-footer-btn lab-speak" onClick={onSpeak}>💬 Speak</button>
    </div>
  );
}

// ── Speak menu: the ENGINE's sentence-builder surface, drawn ──────────────────
//
// ⚖️ ONE WORD BANK (user law, 2026-09-06): *"the word bank in the sentence
// builder should always be the same with a default world-spec lexicon, even
// outside the game — the context is irrelevant. The only exception is the
// individual people list."*
//
// So this menu asks `builderSurfaceFor` — the SAME entry point the AAC's own
// builder (`client-shared/src/game/engine-builder.ts`) and text mode
// (`interaction/text/builder.ts`) call — instead of driving `surfaceNext` over
// the host's raw noun push. `builderSurfaceFor` merges `defaultBuilderNouns()`
// under whatever the caller pushed, so the bank is the SPEC's whole vocabulary
// in every session and out of a game entirely; the host contributes NAMES and
// nothing else (`quest-host.ts pushKnownNouns`).
//
// ⚠️ THAT DIVERGENCE IS WHAT HID A REAL BUG. This file used to map the raw push
// straight into `surfaceNext`, so the host push WAS the board here while text
// mode and the AAC — both on `builderSurfaceFor` — were immune to anything the
// host failed to push. A furniture block gated on `session.dollhouse !== null`
// therefore left a founding frontier able to name a box and a bin and not a
// bed, a table, a chair or a workbench, and no test, transcript or validator
// could see it. One caller, one bank.
//
// The menu draws what the surface says: `buttons` (the ranked words, or one
// chip's members, or one tab's listing), `groups` (sub-category chips),
// `modifiers` (the active head's rail), `categories` (the tab ladder),
// `typeChips` (sentence-type controls, empty board only) and `complete` (Play
// is ready). WORDS stay visually distinct from CONTROLS — the user-decided dual
// surface — and every label arrives already localized by the lang layer.

/** Friendly English names for the engine's category ids. Bench chrome, not
 *  vocabulary: the WORDS are localized by the engine, these tabs are not. */
const CATEGORY_LABEL: Record<string, string> = {
  things: "Things",
  person: "People",
  verb: "Actions",
  attribute: "Descriptions",
  quantity: "Amounts",
  relation: "Links",
  question: "Questions",
  connective: "Joiners",
  social: "Social",
};

/**
 * A noun the HOST knows about. Under the ONE WORD BANK rule that is a NAME —
 * a household member, a pet — and nothing else; every other word is default
 * vocabulary. Structurally the engine's own entry type, so the list is handed
 * to `builderSurfaceFor` unchanged (and `individual: true` files a name on the
 * builder's [contacts] chip).
 */
export type NounEntry = BuilderNounEntry;

/** One speakable WORD button. The PRESSED token is `key` — what the sentence
 *  keeps and the parser reads — while the face is `glyph`, which differs for a
 *  place (one word, a composed shell+symbol icon). */
function WordButton({ word, onTap }: { word: BuilderWordJson; onTap: (key: string) => void }) {
  return (
    <button className="lab-word" title={word.key} onClick={() => onTap(word.key)}>
      <span className="lab-word-icon">
        <LabGlyph glyph={word.glyph ?? word.key} fallback={word.key} ariaLabel={word.label} noBackground />
      </span>
      <span className="lab-word-label">{word.label}</span>
    </button>
  );
}

/** One sub-category CHIP — a control that opens its cluster in place, wearing
 *  up to three of its members' faces so a category shows what it holds. */
function GroupCell({ group, onOpen }: { group: BuilderGroupJson; onOpen: (id: string) => void }) {
  const glyphs = group.glyphs ?? (group.glyph ? [group.glyph] : []);
  return (
    <button className="lab-word lab-group" title={group.id} onClick={() => onOpen(group.id)}>
      <span className="lab-word-icon">
        <GlyphTriad glyphs={glyphs} GlyphComponent={LabGlyph} fallback={group.id} ariaLabel={group.label} />
      </span>
      <span className="lab-word-label">{group.label} ▾</span>
    </button>
  );
}

function SpeakMenu({
  onClose,
  onSpeak,
  nouns,
  locale,
  recency,
  onUttered,
}: {
  onClose: () => void;
  onSpeak: (sentence: string) => void;
  nouns: NounEntry[];
  /** The player's ruleset, so the bank reads in their language (the same locale
   *  the host stamps on the world). Absent ⇒ English. */
  locale?: string | undefined;
  recency: RecencyMemory;
  onUttered: (mem: RecencyMemory) => void;
}) {
  const [words, setWords] = useState<string[]>([]);
  const [seedKind, setSeedKind] = useState<IntentKind | undefined>(undefined);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const sentence = words.join(" + ");

  // THE ENGINE ANSWERS EVERY QUESTION THE MENU HAS. `category`/`group` echo the
  // chips back exactly as the AAC board does, so tabs and chips are the
  // engine's hierarchy rather than a second one drawn over it.
  const surface = useMemo(
    () =>
      builderSurfaceFor(sentence, {
        nouns,
        capacity: 16,
        recency,
        ...(locale ? { locale } : {}),
        ...(openCat ? { category: openCat } : {}),
        ...(openGroupId ? { group: openGroupId } : {}),
        ...(seedKind ? { seedKind } : {}),
      }),
    [sentence, nouns, locale, recency, openCat, openGroupId, seedKind],
  );
  const groups = surface.groups ?? [];
  const typeChips = surface.typeChips ?? [];
  const railMods = surface.modifiers ?? [];

  const tapWord = (w: string) => {
    setWords((cur) => {
      // A DESCRIPTOR composes onto the head it modifies (the AAC-board rule) —
      // whether reached via the modifier rail, the suggested grid, or a
      // category tab — instead of being appended as a stray new head word
      // ("banana" + "hot" → "banana.hot", never "banana + hot"). Registry-
      // driven: the tapped word must be a modifier that applies to the current
      // head's part of speech, and not already present.
      const last = cur[cur.length - 1];
      if (last) {
        const head = getVocabularyItem(last.split(".")[0] ?? last);
        const tapped = getVocabularyItem(w);
        if (
          head &&
          tapped?.modifier?.appliesTo.includes(head.pos) &&
          !last.split(".").slice(1).includes(w)
        ) {
          return [...cur.slice(0, -1), `${last}.${w}`];
        }
      }
      return [...cur, w];
    });
    setOpenCat(null);
    setOpenGroupId(null);
  };
  const play = () => {
    if (!words.length) return;
    onSpeak(sentence); // the host parses, compiles, and drives the creature (then toasts)
    onUttered(noteUtterance(recency, parseSentence(sentence)));
    setWords([]);
    setSeedKind(undefined);
  };
  const openTab = (cat: string | null) => {
    setOpenCat(cat);
    setOpenGroupId(null);
  };

  return (
    <div className="lab-speak-overlay" data-dwell-trap onClick={onClose}>
      <div className="lab-speak-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lab-speak-head">
          <span>Speak</span>
          <button className="lab-footer-btn" onClick={onClose}>✕ Close</button>
        </div>
        <div className="lab-speak-compose">
          <div className="lab-speak-sentence">{sentence || <span className="lab-dim">tap words to build a sentence…</span>}</div>
          <button className="lab-footer-btn" disabled={!words.length} onClick={() => setWords((w) => w.slice(0, -1))}>⌫</button>
          <button className="lab-footer-btn" disabled={!words.length} onClick={() => { setWords([]); setSeedKind(undefined); }}>Clear</button>
          <button
            className={`lab-footer-btn lab-speak${surface.complete ? " ready" : ""}`}
            disabled={!words.length}
            onClick={play}
          >
            ▶ Play
          </button>
        </div>
        {/* Sentence-type chips — CONTROLS (refiners), never spoken words. The
            surfacer decides WHEN they exist (empty board only). */}
        {typeChips.length > 0 && (
          <div className="lab-typechips">
            {typeChips.map((c) => (
              <button
                key={c.kind}
                className={`lab-control lab-typechip${seedKind === c.kind ? " selected" : ""}`}
                onClick={() => setSeedKind((cur) => (cur === c.kind ? undefined : (c.kind as IntentKind)))}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {/* Modifier rail — CONTROLS that refine the active head word, ranked by
            its descriptor axes (the engine's own rail, so the lab bench and the
            student's board offer the same modifiers in the same order). */}
        {railMods.length > 0 && (
          <div className="lab-modrail">
            {railMods.map((m) => (
              <button
                key={m.key}
                className="lab-control lab-mod"
                title={m.key}
                onClick={() => setWords((cur) => [...cur.slice(0, -1), `${cur[cur.length - 1]}.${m.key}`])}
              >
                <span className="lab-mod-icon">
                  <LabGlyph glyph={m.glyph ?? m.key} fallback={m.key} ariaLabel={m.label} noBackground />
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="lab-speak-scroll">
          <section className="lab-speak-group">
            {openCat && <h4>{CATEGORY_LABEL[openCat] ?? openCat}</h4>}
            {/* Words first, then GROUP cells — likely subcategories rendered
                INSIDE the list as teal cards: CONTROLS that expand in place
                without speaking. An open group shows a back cell + the surface's
                filtered membership (the engine did the filtering). */}
            <div className="lab-speak-grid">
              {openGroupId !== null && (
                <button className="lab-word lab-group" onClick={() => setOpenGroupId(null)}>
                  <span className="lab-group-glyph">↩</span>
                  <span className="lab-word-label">back</span>
                </button>
              )}
              {surface.buttons.map((b) => (
                <WordButton key={b.key} word={b} onTap={tapWord} />
              ))}
              {/* ⚠️ `grp:` prefix: a chip id and a WORD key can be the same string
                  (the [clothing] chip sits beside the word "clothes" after
                  `make`), and they are siblings in this one grid. */}
              {openGroupId === null &&
                groups.map((g) => <GroupCell key={`grp:${g.id}`} group={g} onOpen={setOpenGroupId} />)}
            </div>
          </section>
          {/* Category tabs — the fallback ladder to the full vocabulary, and the
              engine's own tab set (`BUILDER_CATEGORIES`). */}
          <div className="lab-cattabs">
            <button
              className={`lab-control lab-cattab${openCat === null ? " selected" : ""}`}
              onClick={() => openTab(null)}
            >
              ★ suggested
            </button>
            {(surface.categories ?? []).map((c) => (
              <button
                key={c}
                className={`lab-control lab-cattab${openCat === c ? " selected" : ""}`}
                onClick={() => openTab(c)}
              >
                {CATEGORY_LABEL[c] ?? c}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The island: board + footer + (optional) speak menu, with imperative set ───

function BoardApp({
  onSelect,
  onSpeak,
  onPocketSelect,
  onFamilySelect,
  hideBoard,
  registerSet,
  registerSetNouns,
  registerSetPocket,
  registerSetFamily,
  registerSetCity,
  registerSetLocale,
}: {
  onSelect: (id: string) => void;
  onSpeak: (sentence: string) => void;
  onPocketSelect: (glyph: string) => void;
  onFamilySelect: (id: string) => void;
  /** EMBEDDED mode: the response board lives on the AAC sidebar (games-bridge
   *  `set_board_options`), so the in-iframe BoardStrip is not rendered — the
   *  Family/City/Pocket strips, footer and Speak menu stay. */
  hideBoard: boolean;
  registerSet: (fn: (v: QuestBoardView | null) => void) => void;
  registerSetNouns: (fn: (nouns: NounEntry[]) => void) => void;
  registerSetPocket: (fn: (items: PocketEntry[]) => void) => void;
  registerSetFamily: (fn: (members: FamilyHudEntry[]) => void) => void;
  registerSetCity: (fn: (chips: CityHudChip[]) => void) => void;
  /** ⚖️ THE PLAYER'S RULESET reaches the island LATE — the lab picks it from a
   *  dropdown, an embedded game learns it from the bridge's `init`, and both
   *  happen after mount. So it arrives through a setter like every other piece
   *  of live state rather than as a mount option. Absent ⇒ English. */
  registerSetLocale: (fn: (locale: string | undefined) => void) => void;
}) {
  const [view, setView] = useState<QuestBoardView | null>(null);
  const [nouns, setNouns] = useState<NounEntry[]>([]);
  const [pocket, setPocket] = useState<PocketEntry[]>([]);
  const [family, setFamily] = useState<FamilyHudEntry[]>([]);
  const [city, setCity] = useState<CityHudChip[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [locale, setLocale] = useState<string | undefined>(undefined);
  // Recent-utterance memory (surface-next.ts) — player-entered words only,
  // per session (a fresh session is a fresh board — predictability).
  const [recency, setRecency] = useState<RecencyMemory>(emptyRecency);
  useEffect(() => {
    registerSet(setView);
    registerSetNouns(setNouns);
    registerSetPocket(setPocket);
    registerSetFamily(setFamily);
    registerSetCity(setCity);
    registerSetLocale(setLocale);
  }, [registerSet, registerSetNouns, registerSetPocket, registerSetFamily, registerSetCity, registerSetLocale]);
  return (
    <>
      <CityStrip chips={city} />
      <FamilyStrip members={family} onSelect={onFamilySelect} />
      {!hideBoard && <BoardStrip view={view} onSelect={onSelect} />}
      <PocketStrip items={pocket} onSelect={onPocketSelect} />
      <Footer
        onAffirm={() => onSpeak("yes")}
        onDecline={() => onSpeak("no")}
        onMore={() => onSpeak("more")}
        onSpeak={() => setMenuOpen(true)}
      />
      {menuOpen && (
        <SpeakMenu
          nouns={nouns}
          locale={locale}
          recency={recency}
          onUttered={setRecency}
          onClose={() => setMenuOpen(false)}
          onSpeak={onSpeak}
        />
      )}
    </>
  );
}

export interface BoardIsland {
  set(view: QuestBoardView | null): void;
  /** Replace the "Things you know" vocabulary in the Speak menu (learned nouns). */
  setNouns(nouns: NounEntry[]): void;
  /** Replace the inventory strip (pocketed small items). */
  setPocket(items: PocketEntry[]): void;
  /** Replace the dollhouse family strip (emoji-state chips; empty = hidden). */
  setFamily(members: FamilyHudEntry[]): void;
  /** Replace the CITY HUD strip (④ per-district cohort chips; empty = hidden). */
  setCity(chips: CityHudChip[]): void;
  /** The ruleset the sentence builder reads its word bank in. */
  setLocale(locale: string | undefined): void;
  /** ⑫ — who is standing in the child's conversation, as spoken words. The
   *  island itself renders nothing for it; the AAC bridge captures it so the
   *  sentence builder can open an ADDRESSEE slot in a crowd
   *  (conversation-in-motion.md law ②). Optional: a host that never pushes one
   *  leaves the board exactly as it is. */
  setAddressees?(list: string[]): void;
  dispose(): void;
}

/** Mount the board island into `container`; `onSelect` fires a board button id
 *  (the host owns the voice, so the board never speaks). `onSpeak` sends a composed
 *  AAC sentence (or a footer word) to the host, which parses + drives a creature. */
export function mountBoardIsland(
  container: HTMLElement,
  onSelect: (id: string) => void,
  onSpeak: (sentence: string) => void = () => {},
  onPocketSelect: (glyph: string) => void = () => {},
  onFamilySelect: (id: string) => void = () => {},
  opts: { hideBoard?: boolean } = {},
): BoardIsland {
  const root: Root = createRoot(container);
  let setViewRef: ((v: QuestBoardView | null) => void) | null = null;
  let setNounsRef: ((n: NounEntry[]) => void) | null = null;
  let setPocketRef: ((p: PocketEntry[]) => void) | null = null;
  let setFamilyRef: ((m: FamilyHudEntry[]) => void) | null = null;
  let setCityRef: ((c: CityHudChip[]) => void) | null = null;
  let setLocaleRef: ((l: string | undefined) => void) | null = null;
  root.render(
    <StrictMode>
      <BoardApp
        onSelect={onSelect}
        onSpeak={onSpeak}
        onPocketSelect={onPocketSelect}
        onFamilySelect={onFamilySelect}
        hideBoard={opts.hideBoard === true}
        registerSet={(fn) => (setViewRef = fn)}
        registerSetNouns={(fn) => (setNounsRef = fn)}
        registerSetPocket={(fn) => (setPocketRef = fn)}
        registerSetFamily={(fn) => (setFamilyRef = fn)}
        registerSetCity={(fn) => (setCityRef = fn)}
        registerSetLocale={(fn) => (setLocaleRef = fn)}
      />
    </StrictMode>,
  );
  return {
    set: (view) => setViewRef?.(view),
    setNouns: (nouns) => setNounsRef?.(nouns),
    setPocket: (items) => setPocketRef?.(items),
    setFamily: (members) => setFamilyRef?.(members),
    setCity: (chips) => setCityRef?.(chips),
    setLocale: (l) => setLocaleRef?.(l),
    dispose: () => root.unmount(),
  };
}

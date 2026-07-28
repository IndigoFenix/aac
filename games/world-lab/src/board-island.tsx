// games/world-lab/src/board-island.tsx
//
// The lab's response board — the SAME renderer the AAC uses. It mounts a
// small React root that draws the shared `<BoardButtonVisual>` (client-shared)
// in a 2×4 grid, exactly as `AppMiniBoard` does during a game, fed by the
// quest host's board view through the same `lockedBoardFrom` shape. The glyph
// composition is the shared `GlyphCompositor` with the lab's bundled-icon
// resolver, so a button reads pixel-identical to the student's real board.
//
// Plus the FOOTER (concept-parser.md design contract): Yes / No / More are the
// always-present response affordances, and Speak opens the VOCABULARY — every
// word the concept parser understands (its `LEXICON`), each drawn with its glyph
// icon (if the registry has one). Tapping words composes a sentence; Play parses
// it and reports the intent, exercising the real parser end-to-end.
//
// The lab is otherwise vanilla TS; this is the only React island, wrapped in
// an imperative handle (mount / set / dispose) the vanilla host drives.

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import { restSpaceRatio } from "@shared/button-shape";
import type { BoardButtonInput, BoardRenderDeps, GlyphRenderProps, IconVisual } from "@client-shared/board/types";
// The component lives in the .tsx (the bare `@shared/glyph-compositor`
// resolves to the types-only .ts) — import it explicitly, as the AAC does.
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { CityHudChip, FamilyHudEntry, PocketEntry, QuestBoardView } from "@shared/world-engine/interaction/quest/quest-host";
import { familyStateGlyph } from "@shared/world-engine/interaction/quest/family-hud";
import { wellbeingGlyph } from "@shared/world-engine/interaction/quest/city-hud";
import { iconGlyph } from "@shared/world-engine/interaction/quest/activity-bubble";
import { LEXICON, parseSentence, type IntentKind } from "@shared/world-engine/interaction/intent/parse-intent";
import {
  emptyRecency,
  noteUtterance,
  surfaceNext,
  TYPE_CHIPS,
  type RecencyMemory,
  type SurfaceNoun,
} from "@shared/world-engine/interaction/intent/surface-next";
import { getVocabularyItem, modifiersFor, type GlyphPos } from "@shared/glyph-registry";
import { AXIS_WORDS, descriptorAxesFor } from "@shared/world-engine/object-properties";
import { labImageResolver } from "./glyph-resolver";

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
      resolveImage={labImageResolver}
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
          <LabGlyph glyph={it.glyph} fallback={it.label} ariaLabel={it.label} noBackground />
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

// ── Speak menu: the parser's whole vocabulary, grouped, with glyph icons ──────

const CATEGORY_ORDER = ["person", "verb", "attribute", "quantity", "relation", "question", "connective", "social"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  person: "People",
  verb: "Actions",
  attribute: "Descriptions",
  quantity: "Amounts",
  relation: "Links",
  question: "Questions",
  connective: "Joiners",
  social: "Social",
};
const WORD_LABEL: Record<string, string> = {
  i_me: "I / me",
  dont_understand: "don't understand",
  in_order_to: "in order to",
};
/** Friendly names for surface-next GROUP chips (property + kind clusters). */
const GROUP_LABEL: Record<string, string> = {
  food: "food",
  toy: "toys",
  clothing: "clothes",
  container: "containers",
  openable: "open & shut",
  furniture: "furniture",
  appliance: "appliances",
  device: "devices",
  tableware: "dishes",
  instrument: "music",
  book: "books",
  material: "materials",
  structure: "buildings",
  creatures: "people",
  places: "places",
  things: "things",
};
const wordLabel = (w: string): string => WORD_LABEL[w] ?? w.replace(/_/g, " ");

/** The parser vocabulary, grouped by lexical category in a friendly order. */
function useVocabularyGroups() {
  return useMemo(() => {
    const byCat = new Map<string, string[]>();
    for (const [word, lex] of Object.entries(LEXICON)) {
      const arr = byCat.get(lex.cat) ?? [];
      arr.push(word);
      byCat.set(lex.cat, arr);
    }
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({
      cat: c,
      label: CATEGORY_LABEL[c] ?? c,
      words: byCat.get(c)!,
    }));
  }, []);
}

/** A learned noun/subject the player can compose with — the vocabulary grows with
 *  knowledge (an item you've seen, the creature's need, a place you've heard of).
 *  `kind`/`affords` carry the noun's world semantics for the SURFACER. */
export interface NounEntry {
  symbol: string;
  label: string;
  kind?: "place" | "item" | "creature" | "unknown";
  affords?: string[];
  /** Spec-derived object properties (object-properties.ts) — how the things
   *  tab FILES this noun, and what the verb pre-load matches on. */
  properties?: string[];
}

/** One speakable WORD button (glyph icon + label). */
function WordButton({ symbol, label, onTap }: { symbol: string; label?: string; onTap: (w: string) => void }) {
  return (
    <button className="lab-word" title={symbol} onClick={() => onTap(symbol)}>
      <span className="lab-word-icon">
        <LabGlyph glyph={symbol} fallback={symbol} ariaLabel={symbol} noBackground />
      </span>
      <span className="lab-word-label">{label ?? wordLabel(symbol)}</span>
    </button>
  );
}

/**
 * The SURFACER-driven sentence builder (language-expansion.md): only
 * meaningful continuations show (surface-next.ts), WORDS visually distinct
 * from CONTROLS (sentence-type chips, category tabs, modifier rail — the
 * user-decided dual surface). Category tabs are the graceful fallback to the
 * full vocabulary; modifiers compose onto the last word's head (the AAC
 * SentenceConstructorBoard pattern).
 */
function SpeakMenu({
  onClose,
  onSpeak,
  nouns,
  recency,
  onUttered,
}: {
  onClose: () => void;
  onSpeak: (sentence: string) => void;
  nouns: NounEntry[];
  recency: RecencyMemory;
  onUttered: (mem: RecencyMemory) => void;
}) {
  const groups = useVocabularyGroups();
  const [words, setWords] = useState<string[]>([]);
  const [seedKind, setSeedKind] = useState<IntentKind | undefined>(undefined);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const sentence = words.join(" + ");

  const surfaceNouns: SurfaceNoun[] = useMemo(
    () =>
      nouns.map((n) => ({
        symbol: n.symbol.split(".")[0] ?? n.symbol,
        label: n.label,
        kind: n.kind ?? "unknown",
        affords: n.affords ?? ["want", "get", "give"],
        properties: n.properties ?? [],
      })),
    [nouns],
  );
  const suggestion = useMemo(
    () => surfaceNext(words, { nouns: surfaceNouns, recency, seedKind, capacity: 16 }),
    [words, surfaceNouns, recency, seedKind],
  );
  // The modifier rail: the ACTIVE head's applicable modifiers (registry-driven,
  // the AAC pattern) — rendered as CONTROLS that compose onto the head, RANKED
  // by the head's DESCRIPTOR AXES (object-properties.ts): food leads with
  // hot/cold, places with my/your ("my city" — the scope-breadth rule). A game
  // noun the registry doesn't know falls back to a pos by its kind, so a
  // learned "city" still gets the place rail instead of no rail at all.
  const lastWord = words[words.length - 1];
  const railMods = useMemo(() => {
    if (!lastWord) return [];
    const headSym = lastWord.split(".")[0] ?? lastWord;
    const item = getVocabularyItem(headSym);
    const noun = nouns.find((n) => (n.symbol.split(".")[0] ?? n.symbol) === headSym);
    const KIND_POS: Record<string, GlyphPos> = { creature: "animal", place: "place", item: "noun", unknown: "noun" };
    const pos = item?.pos ?? (noun ? KIND_POS[noun.kind ?? "unknown"] : undefined);
    if (!pos) return [];
    const POS_KIND: Partial<Record<GlyphPos, "creature" | "place" | "item" | "unknown">> = {
      person: "creature", animal: "creature", place: "place", noun: "item",
    };
    const axes = descriptorAxesFor(noun?.kind ?? POS_KIND[pos] ?? "unknown", noun?.properties ?? []);
    const axisRank = new Map<string, number>();
    axes.forEach((a, i) => {
      for (const w of AXIS_WORDS[a]) if (!axisRank.has(w)) axisRank.set(w, i);
    });
    return modifiersFor(pos)
      .slice()
      .sort(
        (m1, m2) =>
          (axisRank.get(m1.key) ?? 99) - (axisRank.get(m2.key) ?? 99) ||
          m1.modifier!.order - m2.modifier!.order,
      )
      .slice(0, 8);
  }, [lastWord, nouns]);

  const tapWord = (w: string) => {
    setWords((cur) => {
      // A DESCRIPTOR composes onto the head it modifies (the AAC-board rule) —
      // whether reached via the modifier rail, the suggested grid, or a
      // category tab — instead of being appended as a stray new head word
      // ("banana" + "hot" → "banana.hot", never "banana + hot"). Registry-
      // driven, exactly like the rail: the tapped word must be a modifier that
      // applies to the current head's part of speech, and not already present.
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

  const catWords = openCat
    ? openCat === "things"
      ? nouns.map((n) => ({ symbol: n.symbol, label: n.label }))
      : (groups.find((g) => g.cat === openCat)?.words ?? []).map((w) => ({ symbol: w, label: wordLabel(w) }))
    : null;

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
            className={`lab-footer-btn lab-speak${suggestion.complete ? " ready" : ""}`}
            disabled={!words.length}
            onClick={play}
          >
            ▶ Play
          </button>
        </div>
        {/* Sentence-type chips — CONTROLS (refiners), never spoken words. */}
        {suggestion.typeChips.length > 0 && (
          <div className="lab-typechips">
            {TYPE_CHIPS.map((c) => (
              <button
                key={c.kind}
                className={`lab-control lab-typechip${seedKind === c.kind ? " selected" : ""}`}
                onClick={() => setSeedKind((cur) => (cur === c.kind ? undefined : c.kind))}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {/* Modifier rail — CONTROLS that refine the active head word. */}
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
                  <LabGlyph glyph={m.key} fallback={m.key} ariaLabel={m.key} noBackground />
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="lab-speak-scroll">
          {catWords ? (
            <section className="lab-speak-group">
              <h4>{openCat === "things" ? "Things" : (CATEGORY_LABEL[openCat!] ?? openCat)}</h4>
              <div className="lab-speak-grid">
                {catWords.map((w) => (
                  <WordButton key={w.symbol} symbol={w.symbol} label={w.label} onTap={tapWord} />
                ))}
              </div>
            </section>
          ) : (
            <section className="lab-speak-group">
              {/* Words first, then GROUP cells — likely subcategories
                  (surface-next `groups`) rendered INSIDE the list as teal
                  cards: CONTROLS that expand in place without speaking. An
                  open group shows a back cell + its full ranked membership. */}
              <div className="lab-speak-grid">
                {(() => {
                  const activeGroup = suggestion.groups.find((g) => g.id === openGroupId);
                  if (activeGroup) {
                    return (
                      <>
                        <button className="lab-word lab-group" onClick={() => setOpenGroupId(null)}>
                          <span className="lab-group-glyph">↩</span>
                          <span className="lab-word-label">back</span>
                        </button>
                        {activeGroup.members.map((b) => (
                          <WordButton key={b.symbol} symbol={b.symbol} label={b.label} onTap={tapWord} />
                        ))}
                      </>
                    );
                  }
                  return (
                    <>
                      {suggestion.buttons.map((b) => (
                        <WordButton key={b.symbol} symbol={b.symbol} label={b.label} onTap={tapWord} />
                      ))}
                      {suggestion.groups.map((g) => (
                        <button
                          key={g.id}
                          className="lab-word lab-group"
                          title={`${g.members.length} words`}
                          onClick={() => setOpenGroupId(g.id)}
                        >
                          <span className="lab-word-icon">
                            <LabGlyph
                              glyph={g.members[0]?.symbol ?? ""}
                              fallback={g.id}
                              ariaLabel={GROUP_LABEL[g.id] ?? g.id}
                              noBackground
                            />
                          </span>
                          <span className="lab-word-label">{GROUP_LABEL[g.id] ?? g.id} ▾</span>
                        </button>
                      ))}
                    </>
                  );
                })()}
              </div>
            </section>
          )}
          {/* Category tabs — the fallback ladder to the full vocabulary. */}
          <div className="lab-cattabs">
            <button
              className={`lab-control lab-cattab${openCat === null ? " selected" : ""}`}
              onClick={() => setOpenCat(null)}
            >
              ★ suggested
            </button>
            <button
              className={`lab-control lab-cattab${openCat === "things" ? " selected" : ""}`}
              onClick={() => setOpenCat("things")}
            >
              Things
            </button>
            {groups.map((g) => (
              <button
                key={g.cat}
                className={`lab-control lab-cattab${openCat === g.cat ? " selected" : ""}`}
                onClick={() => setOpenCat(g.cat)}
              >
                {g.label}
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
  registerSet,
  registerSetNouns,
  registerSetPocket,
  registerSetFamily,
  registerSetCity,
}: {
  onSelect: (id: string) => void;
  onSpeak: (sentence: string) => void;
  onPocketSelect: (glyph: string) => void;
  onFamilySelect: (id: string) => void;
  registerSet: (fn: (v: QuestBoardView | null) => void) => void;
  registerSetNouns: (fn: (nouns: NounEntry[]) => void) => void;
  registerSetPocket: (fn: (items: PocketEntry[]) => void) => void;
  registerSetFamily: (fn: (members: FamilyHudEntry[]) => void) => void;
  registerSetCity: (fn: (chips: CityHudChip[]) => void) => void;
}) {
  const [view, setView] = useState<QuestBoardView | null>(null);
  const [nouns, setNouns] = useState<NounEntry[]>([]);
  const [pocket, setPocket] = useState<PocketEntry[]>([]);
  const [family, setFamily] = useState<FamilyHudEntry[]>([]);
  const [city, setCity] = useState<CityHudChip[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // Recent-utterance memory (surface-next.ts) — player-entered words only,
  // per session (a fresh session is a fresh board — predictability).
  const [recency, setRecency] = useState<RecencyMemory>(emptyRecency);
  useEffect(() => {
    registerSet(setView);
    registerSetNouns(setNouns);
    registerSetPocket(setPocket);
    registerSetFamily(setFamily);
    registerSetCity(setCity);
  }, [registerSet, registerSetNouns, registerSetPocket, registerSetFamily, registerSetCity]);
  return (
    <>
      <CityStrip chips={city} />
      <FamilyStrip members={family} onSelect={onFamilySelect} />
      <BoardStrip view={view} onSelect={onSelect} />
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
): BoardIsland {
  const root: Root = createRoot(container);
  let setViewRef: ((v: QuestBoardView | null) => void) | null = null;
  let setNounsRef: ((n: NounEntry[]) => void) | null = null;
  let setPocketRef: ((p: PocketEntry[]) => void) | null = null;
  let setFamilyRef: ((m: FamilyHudEntry[]) => void) | null = null;
  let setCityRef: ((c: CityHudChip[]) => void) | null = null;
  root.render(
    <StrictMode>
      <BoardApp
        onSelect={onSelect}
        onSpeak={onSpeak}
        onPocketSelect={onPocketSelect}
        onFamilySelect={onFamilySelect}
        registerSet={(fn) => (setViewRef = fn)}
        registerSetNouns={(fn) => (setNounsRef = fn)}
        registerSetPocket={(fn) => (setPocketRef = fn)}
        registerSetFamily={(fn) => (setFamilyRef = fn)}
        registerSetCity={(fn) => (setCityRef = fn)}
      />
    </StrictMode>,
  );
  return {
    set: (view) => setViewRef?.(view),
    setNouns: (nouns) => setNounsRef?.(nouns),
    setPocket: (items) => setPocketRef?.(items),
    setFamily: (members) => setFamilyRef?.(members),
    setCity: (chips) => setCityRef?.(chips),
    dispose: () => root.unmount(),
  };
}

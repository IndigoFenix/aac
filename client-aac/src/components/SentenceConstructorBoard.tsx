// client-aac/src/components/SentenceConstructorBoard.tsx
//
// THE STUDENT'S SENTENCE BUILDER — the HOST, not the chrome.
//
// The chrome it draws (the two measured sidebar columns, the modifier band and
// its five picker rows, the 9×2 grid with its bracketed paging, and every leaf
// button) lives in `@client-shared/builder`, because the clinician's "Edit
// visual" dialog composes the SAME chrome: the two builders produce the same
// output, so one owner draws them and each client injects what differs (i18n,
// its Glyph wrapper, its icon-path resolver, its people sources) through
// `BuilderDepsProvider`. The press LAWS are shared too, in
// `@shared/glyph-builder-ops` — a press must mean the same thing on both.
//
// What stays here is orchestration, all of it AAC-only: engine surface
// requests, the AI strips, Word Finder / guessing, the call mirror
// (`onMirror` / `remoteRef` / `data-mirror-id`), the recency memory, and the
// glyph state itself.
//
// Eyegaze constraints baked in:
//   - No scrolling anywhere
//   - Stable target positions across tab changes
//   - Button-sized targets only (no chips smaller than a button)
//   - "More" lives in fixed positions

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { motion } from "framer-motion";
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import { renderComposedSentence, studentGender } from "@shared/aac/builder-speech";
import {
  type GlyphCategory,
  type VocabularyItem,
  getVocabularyItem,
  listByModeChip,
  modifiersFor,
  colorModifiersFor,
  emotionModifiersFor,
  gaugeModifiersFor,
  qualityPairsFor,
  listConnectors,
  MODE_CHIPS,
  defaultModeChip,
} from "@shared/glyph-registry";
import {
  EMPTY_GLYPH,
  MAX_SLOTS,
  replaceSlot,
  clearSlot,
  addModifier,
  removeModifier,
  applyRelationalModifier,
  resolveActiveSlot,
  serializeGlyph,
  setPayload,
  setToneTags,
  JOINS,
  type ParsedGlyph,
  type ToneTag,
} from "@shared/glyph-compositor";
import {
  applyExclusiveModifier,
  applyModifierPress,
  autoComposeSlot,
  canonicalizeForEngine,
  computeTargetSlot,
  cycleQualityPole,
  pushSlotWithJoin,
  resolveSlotItem,
  slotKeyForSelection,
} from "@shared/glyph-builder-ops";
import { placeArt } from "@shared/glyph-place-art";
import { defaultImageResolver, resolveIconPath } from "@/lib/glyph-images";
import { apiUrl } from "@/lib/queryClient";
import { resolveEmoji, rtlMirrorStyle } from "@shared/emoji-registry";
import { useLanguage } from "@/contexts/LanguageContext";
import { forwardTriangle } from "@/components/ui/directional-icons";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import type {
  ConstructionStateClient,
  ConstructionSuggestionsClient,
  ConstructionMemoryChipsClient,
} from "@/hooks/dual-agent-types";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import {
  formatBuilderTarget,
  serializeBuilderMirror,
  type BuilderMirrorCell,
  type BuilderMirrorSnapshot,
  type BuilderTarget,
} from "@shared/call/builder-mirror";
import type { BuilderRecency, BuilderSurface, BuilderWord } from "@shared/games-bridge";
// THE SHARED BUILDER CHROME — one owner for the layout and the leaf buttons,
// composed here and by the clinician's "Edit visual" dialog. The sidebar
// columns' geometry (measured capacity + paging) is pure arithmetic and tested
// on its own; the host still calls it, because the AAC has to publish the
// VISIBLE set to a clinician's call mirror.
import {
  ActionButton,
  BuilderDepsProvider,
  BuilderGrid,
  BuilderGridEmpty,
  BuilderSidebar,
  EngineWordButton,
  GridButton,
  ModifierBand,
  ModifierButton,
  MoreButton,
  PersonButton,
  ToneToggle,
  CONTACTS_CHIP_ICON,
  ENGINE_CONTACTS_CHIP,
  contactChipGlyphs,
  mergeContactTiles,
  orderDirectoryPeople,
  sidebarCapacity,
  sidebarPage,
  tabKeyActivate,
  type BuilderRenderDeps,
  type BuilderSidebarEntry,
  type ContactTile,
} from "@client-shared/builder";
import { BUILDER_SURFACE_CAPACITY, type EngineBuilderBackend } from "@/lib/engine-builder";
// ONE paging rule for both word sources (engine surface + registry fallback).
import { BUILDER_GRID_CELLS, BUILDER_ITEMS_WITH_MORE, pageBuilderGrid } from "@shared/aac-builder-paging";
// THE LEARNED LAYER, one call (the in-game SpeakMenu's own move —
// board-island.tsx:416). ⚠ `parseSentence` is imported from `intent/parse-intent`
// (sentence → IntentFrame) and aliased, because `lang/core.ts` exports an
// unrelated function of the same name (sentence → render Tokens).
import { parseSentence as parseIntentSentence } from "@shared/world-engine/interaction/intent/parse-intent";
import { noteUtterance } from "@shared/world-engine/interaction/intent/surface-next";
// The rules that need THIS client's build: the wire's noun kind as the parser
// names it, and the student's learned layer in localStorage. The press-ROUTING
// rules (autoComposeSlot / slotKeyForSelection / computeTargetSlot) moved to
// @shared/glyph-builder-ops so the clinician builder routes a press the same way.
import { engineNounKind, loadRecency, saveRecency } from "@/lib/builder-rules";
import { SentenceButton } from "@/components/SentenceButton";
import { Glyph } from "@/components/Glyph";
import { parseSuggestionKey, getSuggestionEntry } from "@shared/guessing-mode/suggestion-registry.js";

/**
 * Find a slot that is a composable host with no payload yet. Returns the
 * slot index, or null. When set, item presses route into the payload
 * rather than pushing a new slot.
 *
 * Stays HERE (not in the shared ops) because it is gated on this host's
 * `ENABLE_GLYPH_ARGUMENTS` flag — with the flag off it is a constant `null`.
 */
function findPendingPayloadSlot(glyph: ParsedGlyph): number | null {
  // Argument composition disabled (ENABLE_GLYPH_ARGUMENTS): no slot is ever
  // "waiting for a payload", so every caller falls through to plain
  // push/replace and nothing the builder produces can contain parentheses.
  if (!ENABLE_GLYPH_ARGUMENTS) return null;
  // Walk from most-recent to oldest — the freshly-placed host is usually last.
  for (let i = glyph.slots.length - 1; i >= 0; i--) {
    const slot = glyph.slots[i];
    const item = getVocabularyItem(slot.key);
    if (item?.composable && !slot.payload) return i;
  }
  return null;
}

const TABS: readonly GlyphCategory[] = ["chat", "who", "do", "what", "where", "when"] as const;

/**
 * While an engine backend ANSWERS, the builder's tab set IS the engine's
 * advertised categories (`BuilderSurface.categories`) behind a leading
 * "all" tab (the pure ranked surface) — the legacy who/do/what/where
 * taxonomy must never filter, alias or reorder engine content. Icons for
 * the engine's own ladder; an unknown id (a game's custom tab) gets 🔤.
 */
const ENGINE_TAB_ICON: Record<string, string> = {
  things: "📦",
  person: "👤",
  verb: "🤲",
  attribute: "🎨",
  quantity: "🔢",
  relation: "🔗",
  question: "❓",
  connective: "➕",
  social: "💬",
};
const ENGINE_ALL_TAB_ICON = "⭐";

/** Cap on engine modifier-rail buttons so the band never overflows. */
const ENGINE_MODIFIERS_SHOWN = 5;

/** Icon per SENTENCE-TYPE chip kind (the engine's TYPE_CHIPS). Controls, not
 *  words — they wear a plain pictogram, never a glyph, so they can never be
 *  mistaken for something the sentence would contain. An unknown kind (a future
 *  engine move) shows the generic one. */
const TYPE_CHIP_ICON: Record<string, string> = {
  request: "🙋",
  ask: "❓",
  state: "💬",
  command: "🤲",
  rule: "📏",
  greet: "👋",
};
const TYPE_CHIP_FALLBACK_ICON = "🗨️";

/**
 * The engine's descriptor axes (surface.modifiers) include words the AAC's
 * glyph renderer can't yet visualize as applied modifiers:
 *   - keys whose registry item has NO `modifier` facet (the feeling words —
 *     hungry/thirsty/happy/…) apply INVISIBLY: the compositor's badge stack
 *     only draws canonical modifier transforms or fully-unknown keys, so the
 *     press seems to do nothing;
 *   - keys unknown to BOTH the registry and the emoji registry (warm, new,
 *     old, broken, full, empty, three, less, …) take the unknown-badge path
 *     and fall all the way to the "•" fallback — a meaningless dot on the
 *     composed glyph.
 * Those entries read as broken on device ("mostly emojis, but they just
 * render as dots"), so they're filtered out of the rail until the compositor
 * learns to draw them. The rest of the 🎮 rail keeps working. Flip this flag
 * to surface the full engine rail again (e.g. after a compositor fix).
 */
const SHOW_UNRENDERABLE_ENGINE_MODIFIERS = false as boolean;

/** True when applying `key` as a ".modifier" produces a sensible visual:
 *  a canonical registry modifier transform, or an unknown key the emoji
 *  registry can badge-render. Everything else is invisible or a "•" dot. */
function engineModifierRenders(key: string): boolean {
  const item = getVocabularyItem(key);
  if (item) return !!item.modifier;
  return !!resolveEmoji(key);
}

/**
 * AI suggestion chips (the ✨ head strip and ✨ modifier strip fed by
 * suggest_construction_buttons) — hidden for now to reclaim screen space
 * (user request). The plumbing stays wired (state, handlers, incoming
 * suggestion consumption) so a flag flip brings them back.
 */
const SHOW_AI_SUGGESTION_STRIPS = false as boolean;

/**
 * Parenthesized-argument composition — a composable HOST taking its payload
 * in parentheses (`want(apple)`, `eat(cookie)`). Disabled (user request:
 * "too janky and unintuitive"), and the engine's `tokenizeSentence` splits
 * only on "+" so it can't parse the form anyway. With the flag off the
 * builder never routes a press into a pending payload (every press pushes or
 * replaces a whole slot), never hops tabs to suggest payload fillers, never
 * advertises a payloadTarget to the AI, and never renders the empty-host
 * affordance — so no composed string can contain parentheses. All the
 * plumbing (findPendingPayloadSlot, setPayload routes) stays wired; a flag
 * flip restores the feature.
 */
const ENABLE_GLYPH_ARGUMENTS = false as boolean;

const TAB_ICON: Record<GlyphCategory, string> = {
  chat: "💬",
  who: "👤",
  do: "🤲",
  what: "📦",
  where: "📍",
  when: "🕐",
};

/**
 * Emoji for each static mode-chip key. Memory chips render ✨ via the
 * `chip.memory` branch in the sidebar — they're AI-generated and don't have
 * a stable key to map. Keys that appear in multiple categories ("all",
 * "people", "places") share one icon.
 */
const CHIP_ICON: Record<string, string> = {
  // who
  all: "🔠",
  people: "👥",
  animals: "🐾",
  photos: "📷",
  // do
  common: "⭐",
  hands: "🤲",
  sensory: "👁️",
  body: "🧍",
  social: "💬",
  mental: "💭",
  relation: "🔁",
  // what
  food: "🍎",
  drink: "🥤",
  toys: "🧸",
  clothes: "👕",
  things: "📦",
  places: "🏠",
  body_parts: "🖐️",
  ideas: "💡",
  // where
  rooms: "🚪",
  spatial: "📍",
  // when
  quick: "⚡",
  days: "📅",
  "time-of-day": "🌅",
  clock: "🕐",
  routine: "🔁",
  frequency: "📊",
};

/** A stable empty list for "no join can be armed right now" — a fresh `[]`
 *  every render would re-run the band's memoised children for nothing. */
const EMPTY_JOIN_OPTIONS: VocabularyItem[] = [];

/** One selectable person for the [contacts] person list. */
export interface ConstructionPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string;
  hasPhoto: boolean;
}

export interface SentenceConstructorBoardProps {
  /** Called when the user presses Play with the current glyph string.
   *  `spokenFallback` is a plain-text rendering of the composed labels — a
   *  last-resort voicing when an engine executes the sentence but returns no
   *  spokenText of its own. */
  onPlay?: (glyphString: string, spokenFallback?: string) => void;
  /**
   * Engine-backed word surfacing (stage-3 builder merge, reworked). When
   * provided AND answering, the ENGINE's taxonomy drives the whole builder:
   * the tab column becomes "all" (the pure ranked surface) + the engine's
   * advertised categories, the chip column becomes the engine's group chips
   * for the active view, the main grid is the engine surface, the modifier
   * band gains the engine's modifier rail, and the person tab's engine
   * [contacts] chip merges the engine's own named individuals with this
   * student's people directory.
   * Absent (or not answering) → the legacy registry taxonomy.
   */
  engineBuilder?: EngineBuilderBackend | null;
  /** True after Play is pressed, until the interpreted sentence starts being
   *  voiced. Puts the Play button into a waiting state and blocks re-press so
   *  the user sees the interpretation is underway (the host closes the board
   *  when the voice begins). */
  awaitingInterpret?: boolean;
  /** Called when the user dismisses the board. */
  onClose?: () => void;
  /** The student's gender ("male"/"female") — grammatical agreement for the
   *  device-rendered sentence the Say button's colour reports on. */
  studentGender?: string;
  /**
   * Push state to the AI. Pass when the board renders outside the
   * DualAgentProvider subtree; otherwise the optional context is used.
   */
  sendConstructionState?: (state: ConstructionStateClient) => void;
  /** Latest suggestion event from the AI. */
  constructionSuggestions?: ConstructionSuggestionsClient | null;
  /** AI-driven memory chips per category. */
  constructionMemoryChips?: Partial<Record<ConstructionStateClient["category"], ConstructionMemoryChipsClient>>;
  /** Full selectable-people directory — the [contacts] person list. */
  people?: ConstructionPerson[];
  /** Resolve a `face:<id>` to an image URL (camera capture or stored photo). */
  getFaceImage?: (contactId: string) => string | null;
  /** Resolve a person id to a display name (so `face:<id>` shows "Mom"). */
  getPersonName?: (personId: string) => string | null;
  /** People seen on camera this session — surfaced first in the person list. */
  presentPersonIds?: string[];
  /** True while guessing mode is active (renders the narrowing buttons in the main grid). */
  guessingActive?: boolean;
  /** The guessing board (narrowing suggestion buttons) from the server, when guessing. */
  guessingBoard?: ParsedBoardData | null;
  /** Press a guessing narrowing button (routes to pressSuggestion via home). */
  onGuessingPress?: (suggestionKey: string) => void;
  /** Press an AI-generated guess button (a free-form rebuild_board button,
   *  not a suggestion: key). Routes through the normal board-button click
   *  path: voices the SENTENCE + emits button_pressed to the server. */
  onGuessButtonPress?: (button: BoardButton) => void;
  /** Press an AI-driven NARROW button (`buttonType: "narrow"`). Records the
   *  user's pick as a custom narrowing fact and re-injects [GUESSING STATE]
   *  so the AI can propose the next narrowing step. */
  onNarrowPress?: (dimension: string, value: string, sourceText?: string) => void;
  /** Launch guessing for the active slot (when the user can't find a symbol). */
  onEnterGuessing?: (builderContext: { targetSlot: number | null; partialGlyph: string; category: string }) => void;
  /** Cancel guessing mode (fired when the user picks a category tab or mode
   *  chip while guessing is active — the explicit category choice means they
   *  no longer want the narrowing assistant). */
  onExitGuessing?: () => void;
  /**
   * Publish what a clinician's CALL MIRROR should show of this board — the
   * visible grid, the tabs and chips around it, and the sentence built so far.
   * Fires `null` on unmount, so the mirror stops claiming a builder is open the
   * moment the student closes it.
   */
  onMirror?: (snapshot: BuilderMirrorSnapshot | null) => void;
  /** Imperative handle so a clinician's facilitated press can drive this board
   *  through the student's own handlers (consent-gated by the caller). */
  remoteRef?: Ref<BuilderRemote>;
}

/** What a facilitated (clinician-driven) press can do to this board. */
export interface BuilderRemote {
  /** True when the press landed on a live target; false when it did not (the
   *  surface moved on). The caller turns that into the clinician's ack. */
  press: (target: BuilderTarget) => boolean;
}

export function SentenceConstructorBoard(props: SentenceConstructorBoardProps) {
  const { t, isRTL, language } = useLanguage();
  const { onClose, onPlay, awaitingInterpret = false } = props;
  const ctx = useDualAgentContextOptional();
  // Props take precedence over context — the construction board may render
  // outside the DualAgentProvider subtree (as in the AAC home overlay).
  const sendConstructionState = props.sendConstructionState ?? ctx?.sendConstructionState;
  const constructionSuggestions = props.constructionSuggestions ?? ctx?.constructionSuggestions ?? null;
  const constructionMemoryChips = props.constructionMemoryChips ?? ctx?.constructionMemoryChips ?? {};
  const people = props.people ?? [];
  const getFaceImage = props.getFaceImage ?? ctx?.getFaceImage;
  const getPersonName = props.getPersonName;
  const presentPersonIds = props.presentPersonIds ?? [];
  const guessingActive = props.guessingActive ?? false;
  const guessingBoard = props.guessingBoard ?? null;
  const onGuessingPress = props.onGuessingPress;
  const onGuessButtonPress = props.onGuessButtonPress;
  const onNarrowPress = props.onNarrowPress;
  const onEnterGuessing = props.onEnterGuessing;
  const onExitGuessing = props.onExitGuessing;

  // Ordered person list for the [contacts] chip (and the legacy "who → photos"
  // mode chip): people seen this session first (most likely the student wants
  // to talk about who's here), then the rest alphabetically. Stable across
  // renders for eyegaze. THE LAW LIVES IN client-shared, because the
  // clinician's builder has to show the same list in the same order.
  const orderedPeople = useMemo(
    () => orderDirectoryPeople(people, presentPersonIds),
    [people, presentPersonIds],
  );
  /** The [contacts] chip's own face: the first few real contacts who have a
   *  stored photo, as `face:<id>` glyphs the GlyphTriad draws. */
  const contactFaceGlyphs = useMemo(
    () => contactChipGlyphs(people, presentPersonIds),
    [people, presentPersonIds],
  );

  const [activeTab, setActiveTab] = useState<GlyphCategory>("who");
  const [modeChip, setModeChip] = useState<string>(defaultModeChip("who"));
  const [glyph, setGlyph] = useState<ParsedGlyph>(EMPTY_GLYPH);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  // Only the two prosody tone tags are toggled here (tense tags past/future
  // are applied elsewhere), so this state covers just that subset of ToneTag.
  const [tone, setTone] = useState<Record<"question" | "exclamation", boolean>>({
    question: false,
    exclamation: false,
  });

  // AI head strip — HEAD-SYMBOL SUGGESTIONs that fill the next GLYPH when tapped.
  const [aiCandidates, setAiCandidates] = useState<
    Array<{ key: string; label?: string; symbolPath?: string; fallback?: string }>
  >([]);
  // AI modifier strip — MODIFIER-SYMBOL SUGGESTIONs that attach to the
  // student's current HEAD SYMBOL when tapped. Lives alongside the static
  // modifier carousel as the context-aware row.
  const [aiModifierCandidates, setAiModifierCandidates] = useState<
    Array<{ key: string; label?: string; symbolPath?: string; fallback?: string }>
  >([]);
  const [aiThinking, setAiThinking] = useState(false);
  const [excludeKeys, setExcludeKeys] = useState<string[]>([]);
  const [morePressCount, setMorePressCount] = useState(0);
  /** One-shot signal: send next construction_state with requestGuessingMode=true. */
  const [pendingHelpRequest, setPendingHelpRequest] = useState(false);
  // Last receivedAt the component consumed, so we don't reprocess stale events.
  const lastReceivedAtRef = useRef<number>(0);

  /** Threshold for auto-escalating "more" presses into guessing mode. */
  const MORE_ESCALATION_THRESHOLD = 3;

  // Modifier zone — paginates through applicable modifiers, 5 visible per page.
  const [modifierPage, setModifierPage] = useState(0);
  const MODIFIERS_PER_PAGE = 5;

  // Mode-chip sidebar pagination.
  const [chipPage, setChipPage] = useState(0);
  const [engineChipPage, setEngineChipPage] = useState(0);

  // Main grid pagination. The grid is a fixed 9×2 = 18 cells — wider
  // than tall per cell, since each button's label sits BELOW a square
  // image (the image dominates the visual identity; the cell can afford
  // to be narrower because the label is just a one-line hint). When the
  // mode-chip has 18 or fewer items we show them all; when there's
  // overflow we show 17 items plus a More button (which cycles the page).
  // The cap matches the grid-template — without it the button overflows
  // onto an implicit 3rd row and the browser compresses the declared
  // rows to make space.
  const [gridPage, setGridPage] = useState(0);
  const GRID_CELLS = BUILDER_GRID_CELLS;
  const GRID_ITEMS_WITH_MORE = BUILDER_ITEMS_WITH_MORE;

  // Merge tone toggle state into the glyph as tone tags. The compositor and
  // the play action both read from the displayed glyph.
  const displayedGlyph = useMemo(() => {
    const tags: ToneTag[] = [];
    if (tone.question) tags.push("question");
    if (tone.exclamation) tags.push("exclamation");
    return setToneTags(glyph, tags);
  }, [glyph, tone]);

  // CAN THE DEVICE SAY THIS ITSELF? The SAME call `playGlyph` makes with the
  // SAME string, so the Say button's colour is a truthful readout of which
  // path a press will take: green = the glyph language renders it (instant,
  // no model), yellow-green with a "?" = it goes to the AI to interpret.
  // Shown on the client precisely so that "is it parsable?" and "is it being
  // treated as parsable?" can be told apart by looking.
  const parsable = useMemo(
    () => displayedGlyph.slots.length > 0
      && renderComposedSentence(serializeGlyph(displayedGlyph), {
        locale: language,
        gender: studentGender(props.studentGender),
      }) !== null,
    [displayedGlyph, language, props.studentGender],
  );

  // The slot that just arrived, for the compositor's pop-in. Set on a growth
  // in slot count, cleared once the animation has run; a deletion instead
  // bumps the strip (see `stripBump`) since the removed slot is already gone.
  const [enteringSlot, setEnteringSlot] = useState<number | null>(null);
  const [stripBump, setStripBump] = useState(0);
  const prevSlotCountRef = useRef(displayedGlyph.slots.length);
  useEffect(() => {
    const prev = prevSlotCountRef.current;
    const next = displayedGlyph.slots.length;
    prevSlotCountRef.current = next;
    if (next > prev) {
      setEnteringSlot(next - 1);
      const id = setTimeout(() => setEnteringSlot(null), 300);
      return () => clearTimeout(id);
    }
    if (next < prev) setStripBump((n) => n + 1);
    return undefined;
  }, [displayedGlyph.slots.length]);

  // Effective active slot: explicit selection wins, else most-recently filled.
  // Used by the modifier zone; the GlyphCompositor outline uses the explicit
  // selection only so users see what they tapped.
  const effectiveActiveSlot = useMemo(
    () => resolveActiveSlot(displayedGlyph, activeSlot),
    [displayedGlyph, activeSlot]
  );

  const allGridItems = useMemo(
    () => listByModeChip(activeTab, modeChip),
    [activeTab, modeChip]
  );
  // Registry (fallback) paging — same rule as the engine grid below, from the
  // one module that owns it.
  const registryPage = useMemo(() => pageBuilderGrid(allGridItems, gridPage), [allGridItems, gridPage]);
  const gridNeedsMore = registryPage.needsMore;
  const gridItemsPerPage = registryPage.perPage;
  const gridItems = registryPage.items;

  // ── Engine mode (stage-3 builder merge, reworked) ─────────────────────────
  // When an engine backend is wired AND answering, the ENGINE's taxonomy is
  // the builder's: tabs = "all" + the advertised categories, chips = the
  // active view's group chips, grid = the surface for the current partial
  // sentence. The registry taxonomy is only the fallback for a null surface
  // (timeout / no engine) — the escape hatch, never an override.
  const engineBuilder = props.engineBuilder ?? null;
  const [engineSurface, setEngineSurface] = useState<BuilderSurface | null>(null);
  // Advertised engine categories — null until the first surface teaches them.
  const [engineCategories, setEngineCategories] = useState<string[] | null>(null);
  // Monotonic sequence so a late response can't clobber a newer one.
  const engineSeqRef = useRef(0);
  // key → engine label, remembered from every surface seen, so the Play
  // fallback text can speak engine words the registry doesn't know.
  const engineLabelsRef = useRef<Map<string, string>>(new Map());
  // head → engine noun KIND, remembered the same way. It is the classifier the
  // surfacer builds internally from its own noun library, and the only route
  // the platform has to it: without it a bare noun the parser can't classify
  // stays a "mention", so the frame the memory LEARNS from can disagree with
  // the frame the board was built from (§5 seam 5, the same hazard in-game).
  const engineKindsRef = useRef<Map<string, "place" | "item" | "creature" | "unknown">>(new Map());

  // THE LEARNED LAYER — this student's own habit, loaded once per mount and
  // written back after every successful Play. State (not just a ref) because
  // every surface request carries it: a word the student uses outranks an
  // unused peer of the same rank, which is the whole point.
  const [recency, setRecency] = useState<BuilderRecency>(loadRecency);

  // Engine tab/chip selection: `engineCategory` null = the "all" tab (the
  // pure ranked surfaceNext output — the DEFAULT view after any selection);
  // `engineChip` = a group id from the active surface's chips. Every chip is
  // the engine's now, [contacts] included: the host no longer pins one of its
  // own and borrows another tab's surface to fill it.
  const [engineCategory, setEngineCategory] = useState<string | null>(null);
  const [engineChip, setEngineChip] = useState<string | null>(null);
  const [engineTabPage, setEngineTabPage] = useState(0);
  // THE MEASURED COLUMN (2026-08-27). Both sidebars are siblings in the board's
  // `flex h-full` row, so they are always the same height — one observer
  // answers for both, and it lives in BuilderSidebar. Everything that decides
  // how many buttons a column shows, and how tightly they draw, reads this
  // instead of a constant. Held here because the PAGING it feeds decides what
  // the call mirror publishes, not just what is drawn.
  const [sidebarHeight, setSidebarHeight] = useState(0);
  const handleSidebarMeasure = useCallback((h: number) => {
    setSidebarHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);
  const sidebarSlots = sidebarCapacity(sidebarHeight);
  // A tapped SENTENCE-TYPE chip ("I want to ask something"), echoed back on the
  // next request so the openers narrow to that move. Empty board only — the
  // engine stops offering the chips the moment a word lands.
  const [engineSeedKind, setEngineSeedKind] = useState<string | null>(null);
  /** The engine's [contacts] chip on the person tab: the one grid whose content
   *  the engine cannot fully answer, because the child's own directory is
   *  platform data. The ENGINE half arrives as ordinary surface buttons (a
   *  game's named characters); the host merges its directory in. */
  const engineContacts = engineCategory === "person" && engineChip === ENGINE_CONTACTS_CHIP;

  // THE ENGINE'S AND THE PARSER'S view of the sentence. A slot may store a bare
  // emoji (slotKeyForSelection stores 💧 for `water`) and neither the surfacer
  // nor the intent parser knows emojis — canonicalizeForEngine spells those
  // heads back as registry keys. NOT what the AI, the call mirror or onPlay
  // get: those keep the raw glyph, emoji and all.
  const canonicalGlyph = useMemo(() => canonicalizeForEngine(glyph), [glyph]);

  // Debounced surface request per builder state change. The engine's taxonomy
  // IS the builder's while it answers: the selected engine tab/chip is sent
  // straight through as category/group — never mapped through the legacy tab
  // scheme. A null answer (timeout / no engine) clears the surface so the
  // whole builder falls back to the registry — it never hangs on the engine.
  useEffect(() => {
    if (!engineBuilder || guessingActive) return;
    const seq = ++engineSeqRef.current;
    // The selection goes straight through — tab as `category`, chip as `group`.
    // [contacts] used to be the exception (a host chip that secretly asked for
    // the "things" tab so it could sift persons out of the noun library, which
    // is how three pages of animals ended up in front of the child's family);
    // it is an engine group now and needs no twist.
    const category = engineCategory ?? undefined;
    const group = engineChip ?? undefined;
    const timer = setTimeout(() => {
      void engineBuilder
        .requestSurface(canonicalGlyph, category, group, {
          // ONE budget for both backends: the board's own three grid pages.
          // Sent on every request, so the in-game answer pages exactly like the
          // out-of-game one instead of quietly falling to the surfacer's 16.
          capacity: BUILDER_SURFACE_CAPACITY,
          recency,
          ...(engineSeedKind ? { seedKind: engineSeedKind } : {}),
        })
        .then((surface) => {
          if (engineSeqRef.current !== seq) return; // stale answer
          setEngineSurface(surface);
          if (surface?.categories?.length) setEngineCategories(surface.categories);
          if (surface) {
            for (const w of [...surface.buttons, ...(surface.modifiers ?? [])]) {
              if (w.label) engineLabelsRef.current.set(w.key, w.label);
              // Noun kinds ride only on nouns; remember them by HEAD (the form
              // the parser classifies), so a composed key still teaches one.
              if (w.kind) {
                const head = w.key.split(".")[0] ?? w.key;
                engineKindsRef.current.set(head, engineNounKind(w.kind));
              }
            }
          }
        });
    }, 150);
    return () => clearTimeout(timer);
    // activeTab/modeChip: while in the legacy FALLBACK (a timed-out surface),
    // any tab/chip press re-asks the engine so it can win the board back.
  }, [engineBuilder, guessingActive, engineCategory, engineChip, engineSeedKind, recency, canonicalGlyph, activeTab, modeChip]);

  // Engine chrome (tabs + chips + grid) renders while the engine ANSWERS; a
  // null surface (timeout / error) falls the whole builder back to the legacy
  // registry taxonomy, so content always appears. The legacy tabs never
  // reassert themselves over engine content.
  const engineUiActive = engineBuilder != null && engineSurface != null;

  // A game may re-advertise its category set; drop a selection it no longer serves.
  useEffect(() => {
    if (engineCategory && engineCategories && !engineCategories.includes(engineCategory)) {
      setEngineCategory(null);
      setEngineChip(null);
    }
  }, [engineCategories, engineCategory]);

  // Engine category tabs: "all" pinned first, then the advertised categories
  // (paged with a "…" tab when they overflow the column).
  // …budgeted against the whole column: the "all" tab is one of the six.
  const engineTabPageView = useMemo(
    () => sidebarPage(engineCategories ?? [], 1, engineTabPage, sidebarSlots),
    [engineCategories, engineTabPage, sidebarSlots],
  );
  const engineTabsNeedMore = engineTabPageView.needsMore;
  const visibleEngineTabs = engineTabPageView.items;

  // Sub-category chips for the active view — the ENGINE's own groups (its
  // vocabulary-menu hierarchy), localized engine-side. Every view has them now,
  // the person tab included ([contacts] · [people] · [animals]).
  const engineGroupChips = useMemo(
    () => (engineUiActive ? engineSurface?.groups ?? [] : []),
    [engineUiActive, engineSurface]
  );
  /** The engine can serve nine chips (five noun clusters + four action
   *  categories) and this column never paged them — it drew all nine. Budgeted
   *  against the pinned "all" chip, which is the only fixed one left. */
  const engineChipsFixed = 1;
  const engineChipPageView = useMemo(
    () => sidebarPage(engineGroupChips, engineChipsFixed, engineChipPage, sidebarSlots),
    [engineGroupChips, engineChipsFixed, engineChipPage, sidebarSlots],
  );
  const visibleEngineChips = engineChipPageView.items;
  const engineChipsNeedMore = engineChipPageView.needsMore;

  // Sentence-type CONTROL chips. The engine sends them on the empty board and
  // only there, so the row appears when a sentence is about to start and
  // disappears the moment one does — no client-side gating needed beyond
  // "is the engine driving, and are we not word-finding".
  const engineTypeChips = useMemo(
    () => (engineUiActive && !guessingActive ? engineSurface?.typeChips ?? [] : []),
    [engineUiActive, guessingActive, engineSurface]
  );

  const engineGridActive = engineUiActive && !guessingActive && !engineContacts;

  const engineWords = useMemo(
    () => (engineGridActive && engineSurface ? engineSurface.buttons : []),
    [engineGridActive, engineSurface]
  );
  const enginePage = useMemo(() => pageBuilderGrid(engineWords, gridPage), [engineWords, gridPage]);
  const engineNeedsMore = enginePage.needsMore;
  const engineItemsPerPage = enginePage.perPage;
  const engineGridWords = enginePage.items;

  // A new surface is a new ranked list — restart its paging. Engine mode only
  // (setGridPage(0) is a no-op-ish reset, but skip it entirely otherwise so
  // non-engine behavior stays untouched).
  useEffect(() => {
    if (engineBuilder) setGridPage(0);
  }, [engineBuilder, engineSurface]);

  // Engine modifier rail (compose with "." like every other modifier). The
  // engine computes its rail for the LAST composed word, so it only shows
  // when that word is the effective active slot — an earlier selected slot
  // gets the registry rail alone. Capped so the band keeps its geometry.
  const engineModifierItems = useMemo(() => {
    if (!engineBuilder || guessingActive) return [] as BuilderWord[];
    if (effectiveActiveSlot == null || effectiveActiveSlot !== displayedGlyph.slots.length - 1) {
      return [] as BuilderWord[];
    }
    const rail = engineSurface?.modifiers ?? [];
    const renderable = SHOW_UNRENDERABLE_ENGINE_MODIFIERS
      ? rail
      : rail.filter((w) => engineModifierRenders(w.key));
    return renderable.slice(0, ENGINE_MODIFIERS_SHOWN);
  }, [engineBuilder, guessingActive, effectiveActiveSlot, displayedGlyph.slots.length, engineSurface]);

  // The engine's OWN half of [contacts]: the surface for group=individuals IS
  // that cluster, so the buttons need no sifting. Out of game the cluster is
  // empty by construction (the spec has no contacts in it) and the grid is the
  // directory alone; in game it is the scene's named characters.
  const engineIndividualWords = useMemo(() => {
    if (!engineContacts || !engineSurface) return [] as BuilderWord[];
    return engineSurface.buttons;
  }, [engineContacts, engineSurface]);

  // The merged [contacts] grid (engine mode only). The ordering + de-dup law is
  // client-shared so the clinician's builder shows the same list; paged with
  // the same wrap-around More the main grid uses.
  type ContactCell = ContactTile<ConstructionPerson, BuilderWord>;
  const contactTiles = useMemo<ContactCell[] | null>(() => {
    if (!engineBuilder) return null;
    return mergeContactTiles<ConstructionPerson, BuilderWord>({
      people: orderedPeople,
      engine: engineIndividualWords,
      presentPersonIds,
    });
  }, [engineBuilder, engineIndividualWords, orderedPeople, presentPersonIds]);
  const contactsNeedMore = (contactTiles?.length ?? 0) > GRID_CELLS;
  // Both controls take a cell here too (`GRID_ITEMS_WITH_MORE` counts them).
  const contactsPerPage = contactsNeedMore ? GRID_ITEMS_WITH_MORE : GRID_CELLS;
  const pagedContactTiles = useMemo<ContactCell[]>(() => {
    if (!contactTiles) return [];
    if (!contactsNeedMore) return contactTiles.slice(0, GRID_CELLS);
    // Negative pages wrap: Back decrements `gridPage`, and JS `%` keeps the
    // sign (the same normalisation `pageBuilderGrid` does).
    const len = contactTiles.length;
    const start = (((gridPage * contactsPerPage) % len) + len) % len;
    const wrapped = [...contactTiles.slice(start), ...contactTiles.slice(0, start)];
    return wrapped.slice(0, contactsPerPage);
  }, [contactTiles, gridPage, contactsNeedMore, contactsPerPage]);

  // All applicable modifiers for the active slot (full list, before pagination).
  const allModifiers = useMemo(() => {
    if (effectiveActiveSlot == null) return [] as VocabularyItem[];
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    // resolveSlotItem, not getVocabularyItem: a slot may store an emoji.
    const item = slot ? resolveSlotItem(slot.key) : undefined;
    if (!item) return [];
    return modifiersFor(item.pos);
  }, [displayedGlyph, effectiveActiveSlot]);

  const modifierItems = useMemo(() => {
    if (allModifiers.length === 0) return allModifiers;
    const start = (modifierPage * MODIFIERS_PER_PAGE) % allModifiers.length;
    // Wrap-around slice so the visible set always fills the row if possible.
    const wrapped = [...allModifiers.slice(start), ...allModifiers.slice(0, start)];
    return wrapped.slice(0, MODIFIERS_PER_PAGE);
  }, [allModifiers, modifierPage]);

  // Active modifier keys on the currently-active slot — used to highlight
  // toggled-on modifiers in the carousel.
  const activeModifierKeys = useMemo(() => {
    if (effectiveActiveSlot == null) return new Set<string>();
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    return new Set(slot?.modifiers ?? []);
  }, [displayedGlyph, effectiveActiveSlot]);

  // Color modifiers applicable to the active slot. Exposed via a dedicated
  // color-picker popup rather than the main carousel — see colorPickerOpen
  // and the swatch row rendered below the modifier zone.
  const colorOptions = useMemo<VocabularyItem[]>(() => {
    if (effectiveActiveSlot == null) return [];
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    // resolveSlotItem, not getVocabularyItem: a slot may store an emoji.
    const item = slot ? resolveSlotItem(slot.key) : undefined;
    if (!item) return [];
    return colorModifiersFor(item.pos);
  }, [displayedGlyph, effectiveActiveSlot]);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  // Auto-close the color picker when the active slot changes or when no
  // colors apply to the current pos.
  useEffect(() => {
    if (colorOptions.length === 0) setColorPickerOpen(false);
  }, [colorOptions]);
  // Active color modifier on the slot (so the picker can highlight it and
  // tapping it again clears the color).
  const activeColorKey = useMemo(() => {
    if (effectiveActiveSlot == null) return null;
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    if (!slot) return null;
    for (const modKey of slot.modifiers) {
      const mod = getVocabularyItem(modKey);
      if (mod?.modifier?.transform === "color") return modKey;
    }
    return null;
  }, [displayedGlyph, effectiveActiveSlot]);

  // Emotion modifiers — same dedicated-popup pattern as colors.
  const emotionOptions = useMemo<VocabularyItem[]>(() => {
    if (effectiveActiveSlot == null) return [];
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    // resolveSlotItem, not getVocabularyItem: a slot may store an emoji.
    const item = slot ? resolveSlotItem(slot.key) : undefined;
    if (!item) return [];
    return emotionModifiersFor(item.pos);
  }, [displayedGlyph, effectiveActiveSlot]);
  const [emotionPickerOpen, setEmotionPickerOpen] = useState(false);
  useEffect(() => {
    if (emotionOptions.length === 0) setEmotionPickerOpen(false);
  }, [emotionOptions]);
  const activeEmotionKey = useMemo(() => {
    if (effectiveActiveSlot == null) return null;
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    if (!slot) return null;
    for (const modKey of slot.modifiers) {
      const mod = getVocabularyItem(modKey);
      if (mod?.modifier?.transform === "emotion") return modKey;
    }
    return null;
  }, [displayedGlyph, effectiveActiveSlot]);

  // Amount (gauge quantifier) modifiers — dedicated picker like colors.
  const amountOptions = useMemo<VocabularyItem[]>(() => {
    if (effectiveActiveSlot == null) return [];
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    // resolveSlotItem, not getVocabularyItem: a slot may store an emoji.
    const item = slot ? resolveSlotItem(slot.key) : undefined;
    if (!item) return [];
    return gaugeModifiersFor(item.pos);
  }, [displayedGlyph, effectiveActiveSlot]);
  const [amountPickerOpen, setAmountPickerOpen] = useState(false);
  useEffect(() => {
    if (amountOptions.length === 0) setAmountPickerOpen(false);
  }, [amountOptions]);
  const activeAmountKey = useMemo(() => {
    if (effectiveActiveSlot == null) return null;
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    if (!slot) return null;
    for (const modKey of slot.modifiers) {
      if (getVocabularyItem(modKey)?.modifier?.transform === "gauge") return modKey;
    }
    return null;
  }, [displayedGlyph, effectiveActiveSlot]);

  // Quality opposite-pairs — pole-toggle picker (none → pos → neg → none).
  const qualityPairs = useMemo(() => {
    if (effectiveActiveSlot == null) return [];
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    // resolveSlotItem, not getVocabularyItem: a slot may store an emoji.
    const item = slot ? resolveSlotItem(slot.key) : undefined;
    if (!item) return [];
    return qualityPairsFor(item.pos);
  }, [displayedGlyph, effectiveActiveSlot]);
  const [qualityPickerOpen, setQualityPickerOpen] = useState(false);
  useEffect(() => {
    if (qualityPairs.length === 0) setQualityPickerOpen(false);
  }, [qualityPairs]);

  // Forward pending-join (connectors + spatial). Selecting one arms it; the
  // next pushed slot consumes it as its `join`. Available once a slot exists.
  // Only words the compositor actually CONSUMES as joins belong in the arm
  // picker — with arrow notation off, spatial relations are ordinary board
  // words (they push slots and wear their own art), not armable joins.
  const joinOptions = useMemo(() => listConnectors().filter((j) => JOINS.has(j.key)), []);
  const [joinPickerOpen, setJoinPickerOpen] = useState(false);
  const [pendingJoin, setPendingJoin] = useState<string | null>(null);
  const canJoin = displayedGlyph.slots.length > 0 && displayedGlyph.slots.length < MAX_SLOTS;
  useEffect(() => {
    if (!canJoin) { setJoinPickerOpen(false); setPendingJoin(null); }
  }, [canJoin]);

  const handleTabSelect = useCallback((tab: GlyphCategory) => {
    // Picking a category while guessing is active is a clear "I'm done
    // narrowing — let me browse this category instead" signal. Cancel
    // guessing first so the AI knows and the main grid returns.
    if (guessingActive) onExitGuessing?.();
    setActiveTab(tab);
    setModeChip(defaultModeChip(tab));
  }, [guessingActive, onExitGuessing]);

  // Mode-chip picker (subcategory). Same exit-on-pick rule as the tab handler.
  const handleModeChipSelect = useCallback((chipKey: string) => {
    if (guessingActive) onExitGuessing?.();
    setModeChip(chipKey);
  }, [guessingActive, onExitGuessing]);

  // Engine tab / chip selection (engine chrome). Same exit-on-pick rule.
  const handleEngineTabSelect = useCallback((category: string | null) => {
    if (guessingActive) onExitGuessing?.();
    setEngineCategory(category);
    setEngineChip(null);
  }, [guessingActive, onExitGuessing]);

  const handleEngineChipSelect = useCallback((chipId: string | null) => {
    if (guessingActive) onExitGuessing?.();
    setEngineChip((cur) => (cur === chipId ? null : chipId));
  }, [guessingActive, onExitGuessing]);

  // Sentence-type chip: a CONTROL, not a word. It seeds the next surface
  // request with one communicative move; pressing it again clears the seed
  // (the in-game SpeakMenu's own toggle), as does pressing any word.
  const handleEngineTypeChipPress = useCallback((kind: string) => {
    if (guessingActive) onExitGuessing?.();
    setEngineSeedKind((cur) => (cur === kind ? null : kind));
  }, [guessingActive, onExitGuessing]);

  /** Localized engine tab label: client i18n for the engine's fixed ladder;
   *  an unknown id (a game's custom category) shows as itself. */
  const engineTabLabel = useCallback(
    (id: string) => {
      const key = `construction.engineTabs.${id}`;
      const translated = t(key);
      return translated === key ? id : translated;
    },
    [t]
  );

  /** Localized sentence-type chip label. The engine's own `label` is an English
   *  word ("want", "question"), so it is only the last resort for a move this
   *  client has no string for — never what a Hebrew board shows. */
  const engineTypeChipLabel = useCallback(
    (kind: string, engineLabel: string) => {
      const key = `construction.typeChips.${kind}`;
      const translated = t(key);
      return translated === key ? engineLabel : translated;
    },
    [t]
  );

  const onTabKey = useCallback(
    (e: React.KeyboardEvent, tab: GlyphCategory) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleTabSelect(tab);
      }
    },
    [handleTabSelect]
  );

  const handleGridPress = useCallback(
    (item: VocabularyItem) => {
      // For items the AI isn't taught about by snake_case key
      // (`exposeToAi !== true`), the sentence-builder fills the slot
      // with the item's CANONICAL EMOJI rather than the registry key.
      // The AI subsequently sees the emoji in the [GLYPH PRESS] string
      // and interprets intent visually — same path the AI uses when
      // emitting bundled-art items itself (e.g. walk → 🚶). Exposed
      // items keep their key form so the AI's vocabulary matches.
      const selectionKey = slotKeyForSelection(item);
      setGlyph((g) => {
        // Explicit slot selection: replace that slot. Filling a composable
        // host this way leaves its payload empty for the next press.
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, selectionKey);
        }
        // No explicit selection: if a composable host is waiting for its
        // payload AND the picked item is an acceptable type, fill the
        // payload instead of pushing a new slot.
        const pending = findPendingPayloadSlot(g);
        if (pending != null) {
          const host = getVocabularyItem(g.slots[pending].key);
          if (host?.composable?.accepts.includes(item.pos)) {
            return setPayload(g, pending, selectionKey);
          }
        }
        // A DESCRIPTOR joins the head it describes ("banana" + "hot" →
        // "banana.hot"). An ARMED JOIN is the student saying "a new word,
        // linked" — an explicit instruction, so it wins over the rule.
        // The MODIFIER is stored under its registry KEY, never the emoji
        // `slotKeyForSelection` would pick for a head: the compositor draws a
        // badge by key, and `apple.🔥` is not a thing the parser reads.
        if (pendingJoin == null) {
          const compose = autoComposeSlot(g, item.key);
          if (compose != null) return addModifier(g, compose, item.key);
        }
        return pushSlotWithJoin(g, selectionKey, pendingJoin);
      });
      setActiveSlot(null);
      setPendingJoin(null);
      // Any WORD press answers the sentence-type question — the move is
      // whatever the words turn out to mean now.
      setEngineSeedKind(null);
      // If we just placed a composable host with no payload, hop to the
      // first suggestCategory so the grid surfaces relevant fillers.
      // (Part of the argument affordance — gated with it.)
      if (ENABLE_GLYPH_ARGUMENTS && item.composable && item.composable.suggestCategories.length > 0) {
        const nextTab = item.composable.suggestCategories[0];
        setActiveTab(nextTab);
        setModeChip(defaultModeChip(nextTab));
      }
    },
    [activeSlot, pendingJoin]
  );

  // Person press (from the "who → photos" person list): insert a `face:<id>`
  // slot. Same fill/replace logic as the grid. The displayed glyph resolves
  // the face image through the shared face resolver, so the picked person
  // shows their photo in the preview immediately.
  const handlePersonPress = useCallback(
    (personId: string) => {
      const selectionKey = `face:${personId}`;
      setGlyph((g) => {
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, selectionKey);
        }
        const pending = findPendingPayloadSlot(g);
        if (pending != null) {
          const host = getVocabularyItem(g.slots[pending].key);
          // A person is a noun-like payload; composable hosts that accept
          // "noun" take them.
          if (host?.composable?.accepts.includes("noun")) {
            return setPayload(g, pending, selectionKey);
          }
        }
        return pushSlotWithJoin(g, selectionKey, pendingJoin);
      });
      setActiveSlot(null);
      setPendingJoin(null);
      // Same default-view rule as engine word presses (no-op outside engine mode).
      setEngineCategory(null);
      setEngineChip(null);
      setEngineSeedKind(null);
    },
    [activeSlot, pendingJoin]
  );

  // Engine-word press (from the engine-fed main grid / person merge): the
  // BuilderWord.key IS the canonical engine-lexicon word, and the engine's
  // surface grammar serializes exactly like the builder's, so the key
  // composes straight into a slot through the same fill/replace logic the
  // registry grid uses.
  const handleEngineWordPress = useCallback(
    (word: BuilderWord) => {
      if (word.label) engineLabelsRef.current.set(word.key, word.label);
      const selectionKey = word.key;
      setGlyph((g) => {
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, selectionKey);
        }
        const pending = findPendingPayloadSlot(g);
        if (pending != null && word.kind) {
          // Engine nouns (person/creature/item/place) are noun-like payloads;
          // composable hosts that accept "noun" take them.
          const host = getVocabularyItem(g.slots[pending].key);
          if (host?.composable?.accepts.includes("noun")) {
            return setPayload(g, pending, selectionKey);
          }
        }
        // The same descriptor rule the registry grid follows — an engine
        // attribute ("hot", "big") composes onto the head it describes, so the
        // AAC and the in-game menu build the SAME sentence from two presses.
        if (pendingJoin == null) {
          const compose = autoComposeSlot(g, selectionKey);
          if (compose != null) return addModifier(g, compose, selectionKey);
        }
        return pushSlotWithJoin(g, selectionKey, pendingJoin);
      });
      setActiveSlot(null);
      setPendingJoin(null);
      // Back to the DEFAULT view: after any selection the builder shows the
      // engine's pure ranked surface for the new partial sentence, never a
      // lingering category/group filter (the SpeakMenu's own tap rule) — and
      // the sentence-type seed goes with it.
      setEngineCategory(null);
      setEngineChip(null);
      setEngineSeedKind(null);
    },
    [activeSlot, pendingJoin]
  );

  const handleSlotPress = useCallback((idx: number | null) => {
    if (idx == null) return;
    setActiveSlot((cur) => (cur === idx ? null : idx));
  }, []);

  const handleClearSelected = useCallback(() => {
    if (activeSlot == null) return;
    setGlyph((g) => clearSlot(g, activeSlot));
    setActiveSlot(null);
  }, [activeSlot]);

  // Backspace — removes the LAST slot. Only relevant with no explicit
  // selection (a selected slot shows the delete button instead, in the same
  // spot): the two never coexist.
  const handleBackspace = useCallback(() => {
    setGlyph((g) => (g.slots.length === 0 ? g : clearSlot(g, g.slots.length - 1)));
  }, []);

  const handlePlay = useCallback(() => {
    if (displayedGlyph.slots.length === 0) return;
    if (awaitingInterpret) return;  // already interpreting — ignore repeat presses
    // Plain-text rendering of the composed heads — engine label → person name
    // → registry translation → bare key. Only voiced as a last resort (engine
    // executed the sentence but returned no spokenText).
    const spokenFallback = displayedGlyph.slots
      .map((slot) => {
        const key = slot.key;
        if (!key) return "";
        if (key.startsWith("face:")) {
          return getPersonName?.(key.substring(5).trim()) ?? "";
        }
        const engineLabel = engineLabelsRef.current.get(key);
        if (engineLabel) return engineLabel;
        const item = getVocabularyItem(key);
        if (item) {
          const translated = t(item.tKey);
          return translated === item.tKey ? key : translated;
        }
        return key;
      })
      .filter(Boolean)
      .join(" ");
    // LEARN FROM WHAT WAS SAID (the in-game board's own move, board-island.tsx:416).
    // The TONE-FREE sentence is what gets parsed — the same string the surfacer
    // was asked about — so the memory records words, never prosody. The engine's
    // own noun kinds ride along as the classifier when a surface has taught us
    // any, so a bare noun is learned in the role the board offered it in.
    try {
      const classifier = engineKindsRef.current;
      const frame = parseIntentSentence(
        // Canonical (emoji heads spelled out) so the learned layer and the
        // Say-button colour agree with the surfacer — see canonicalizeForEngine.
        canonicalGlyph,
        classifier.size ? { classifyEntity: (sym) => classifier.get(sym) ?? "unknown" } : {},
      );
      const next = noteUtterance(recency, frame);
      setRecency(next);
      saveRecency(next);
    } catch (e) {
      // The memory is an optimization; a sentence must always be sayable.
      console.warn("[builder] recency update failed", e);
    }
    onPlay?.(serializeGlyph(displayedGlyph), spokenFallback || undefined);
  }, [displayedGlyph, canonicalGlyph, recency, onPlay, awaitingInterpret, getPersonName, t]);

  // Help button state machine (per planning-docs/glyph-system.md):
  //   - Slot selected → re-suggest for that slot (excludes current AI strip).
  //   - No selection, glyph has empty slot(s) → guessing mode for first empty.
  //   - All filled, no selection → guessing mode for slot 3.
  // Guessing-mode entry sets `pendingHelpRequest`; the construction-state
  // effect picks it up and sends `requestGuessingMode: true` on the next
  // injection. The AI's existing <guessing_mode> behavior handles the rest.
  const handleHelpPress = useCallback(() => {
    // The Word Finder button toggles entry/exit based on the current
    // guessingActive flag (server-driven; same source of truth as the
    // quick-button toggle). Active → exit; inactive → enter with the
    // partial-sentence + active-slot category context.
    if (guessingActive) {
      console.debug("[guessing/builder] Help → exitGuessing (toggle off)");
      onExitGuessing?.();
      return;
    }
    const builderContext = {
      targetSlot: computeTargetSlot(glyph, activeSlot),
      partialGlyph: serializeGlyph(glyph),
      category: engineUiActive ? engineCategory ?? "all" : activeTab,
    };
    console.debug("[guessing/builder] Help → enterGuessing", builderContext, "| fn:", typeof onEnterGuessing);
    if (onEnterGuessing) {
      onEnterGuessing(builderContext);
    } else {
      // Bridge not wired (shouldn't happen) — fall back to the legacy path.
      console.warn("[guessing/builder] onEnterGuessing unavailable; using legacy requestGuessingMode");
      setPendingHelpRequest(true);
    }
  }, [guessingActive, onEnterGuessing, onExitGuessing, glyph, activeSlot, activeTab, engineUiActive, engineCategory]);

  // ── AI strip wiring ──────────────────────────────────────────────────────
  // Send state on every relevant change. The relay forwards it to the live
  // Gemini session as a [CONSTRUCTION STATE] injection; the model may reply
  // via suggest_construction_buttons, surfacing through `constructionSuggestions`.
  useEffect(() => {
    console.log("[construction] state effect fired", {
      hasSendFn: !!sendConstructionState,
      activeTab,
      modeChip,
      slots: glyph.slots.length,
      activeSlot,
      excludeKeyCount: excludeKeys.length,
      pendingHelpRequest,
    });
    if (!sendConstructionState) {
      console.warn("[construction] sendConstructionState unavailable — no prop and no context");
      return;
    }
    setAiThinking(true);
    // If a composable host has an empty payload, the AI should suggest
    // fillers for the *blank inside the host*, not the next sentence slot.
    const pendingPayload = findPendingPayloadSlot(glyph);
    let payloadTarget: ConstructionStateClient["payloadTarget"];
    if (pendingPayload != null) {
      const host = getVocabularyItem(glyph.slots[pendingPayload].key);
      if (host?.composable) {
        payloadTarget = {
          slotIndex: pendingPayload,
          hostKey: host.key,
          accepts: host.composable.accepts,
          suggestCategories: host.composable.suggestCategories,
        };
      }
    }
    sendConstructionState({
      category: activeTab,
      modeChip,
      glyph: serializeGlyph(glyph),
      activeSlot,
      targetSlot: payloadTarget ? payloadTarget.slotIndex : computeTargetSlot(glyph, activeSlot),
      excludeKeys,
      requestGuessingMode: pendingHelpRequest || undefined,
      payloadTarget,
    });
    if (pendingHelpRequest) setPendingHelpRequest(false);
    // Effect intentionally does NOT depend on tone toggles (sentence-level,
    // doesn't affect AI strip suggestions).
  }, [
    sendConstructionState,
    activeTab,
    modeChip,
    glyph,
    activeSlot,
    excludeKeys,
    pendingHelpRequest,
  ]);

  // Consume incoming suggestions when their receivedAt is newer than what we
  // last processed. Replace both AI strips wholesale. The head strip reads
  // from `headCandidates` (legacy server builds populate `candidates` only;
  // the hook normalizes both into `headCandidates`).
  useEffect(() => {
    const incoming = constructionSuggestions;
    console.log("[construction] suggestions effect", {
      hasIncoming: !!incoming,
      receivedAt: incoming?.receivedAt,
      lastReceived: lastReceivedAtRef.current,
      headCount: incoming?.headCandidates.length,
      modifierCount: incoming?.modifierCandidates.length,
    });
    if (!incoming || incoming.receivedAt <= lastReceivedAtRef.current) return;
    lastReceivedAtRef.current = incoming.receivedAt;
    setAiCandidates(incoming.headCandidates);
    setAiModifierCandidates(incoming.modifierCandidates);
    setAiThinking(false);
  }, [constructionSuggestions]);

  // Failsafe: if the AI never answers a [CONSTRUCTION STATE] injection (agent
  // error / dropped turn), stop pulsing the placeholders after a while so the
  // strip doesn't look permanently "thinking".
  useEffect(() => {
    if (!aiThinking) return;
    const t = setTimeout(() => setAiThinking(false), 12000);
    return () => clearTimeout(t);
  }, [aiThinking]);

  // Reset AI-strip pagination state when slot is filled or tab changes.
  useEffect(() => {
    setExcludeKeys([]);
    setMorePressCount(0);
  }, [activeTab, glyph.slots.length]);

  // Reset modifier page when the active slot changes.
  useEffect(() => {
    setModifierPage(0);
  }, [effectiveActiveSlot]);

  // Reset chip pagination when the tab switches.
  useEffect(() => {
    setChipPage(0);
  }, [activeTab]);

  // Reset grid pagination when the tab or mode-chip changes (different
  // vocabulary list) — engine tab/chip changes included.
  useEffect(() => {
    setGridPage(0);
  }, [activeTab, modeChip, engineCategory, engineChip]);

  // Build the combined static + memory chip list for the active tab.
  const allChips = useMemo(() => {
    const memChips = constructionMemoryChips?.[activeTab]?.chips ?? [];
    const staticChips = MODE_CHIPS[activeTab].map((chip) => {
      const key = `construction.chips.${chip}`;
      const translated = t(key);
      const label = translated === key ? chip : translated;
      return { key: chip, label, memory: false };
    });
    return [
      ...staticChips,
      ...memChips.map((c) => ({ key: c.key, label: c.label, memory: true })),
    ];
  }, [activeTab, constructionMemoryChips, t]);

  const chipPageView = useMemo(
    () => sidebarPage(allChips, 0, chipPage, sidebarSlots),
    [allChips, chipPage, sidebarSlots],
  );
  const visibleChips = chipPageView.items;
  const chipsNeedMore = chipPageView.needsMore;

  // ───────────────────────────────────────────────────────────────────────────
  // CALL MIRROR
  //
  // What a clinician on the call sees of this board, and how they press it.
  // The builder opens as a full-screen overlay OVER the communication board, so
  // a mirror that only knew about boards kept streaming the screen the student
  // had just left — the clinician watched a grid nobody was looking at, with
  // nothing to say so. `onMirror` publishes what is actually visible here;
  // `remoteRef` routes a facilitated press into the very handler the student's
  // own finger takes, so there is no second composition path to drift.
  // ───────────────────────────────────────────────────────────────────────────

  /** The label printed under a registry button (the non-hook half of `useItemLabel`). */
  const itemLabel = useCallback((item: VocabularyItem) => {
    const translated = t(item.tKey);
    return translated === item.tKey ? item.key : translated;
  }, [t]);

  /** Whichever of the builder's several word views is on screen right now. The
   *  legacy taxonomy keeps its own "who → photos" mode chip (that path never
   *  had an engine to ask). */
  const contactsActive = engineUiActive ? engineContacts : activeTab === "who" && modeChip === "photos";

  /**
   * WORD FINDER buttons, filtered exactly as the grid below filters them.
   * Hoisted out of the render because three things now need the same list: the
   * grid, the call mirror, and a clinician's remote press.
   */
  const guessGridButtons = useMemo<BoardButton[]>(() => {
    if (!guessingActive) return [];
    const all = guessingBoard?.pages?.[0]?.buttons ?? [];
    return all.filter((b) => {
      const bt = (b as any).buttonType;
      const sk = (b as any).suggestionKey;
      const nd = (b as any).narrowDimension;
      return (bt === "suggestion" && sk) || (bt === "narrow" && nd) || bt === "guess" || (!bt && !sk && !nd);
    });
  }, [guessingActive, guessingBoard]);

  /** The one dispatch for a Word Finder press — three button flavours, three
   *  destinations. Local clicks and a clinician's remote press share it, so a
   *  facilitated narrowing step is the same event as the child's own. */
  const pressGuessButton = useCallback((b: BoardButton) => {
    const sk = (b as any).suggestionKey as string | undefined;
    const nd = (b as any).narrowDimension as string | undefined;
    const nv = (b as any).narrowValue as string | undefined;
    if (sk) onGuessingPress?.(sk);
    else if (nd && nv) onNarrowPress?.(nd, nv, (b as any).sentence ?? (b as any).speech);
    else onGuessButtonPress?.(b);
  }, [onGuessingPress, onNarrowPress, onGuessButtonPress]);

  const mirrorCells = useMemo<BuilderMirrorCell[]>(() => {
    // Word Finder hands the grid to a server-authored board; it travels whole
    // through `guessButtons` below rather than as builder vocabulary cells.
    if (guessingActive) return [];

    if (contactsActive) {
      if (contactTiles) {
        return pagedContactTiles.map((tile) =>
          tile.type === "person"
            ? { key: `face:${tile.person.id}`, label: tile.person.name, glyph: `face:${tile.person.id}`, emoji: "🧑", present: presentPersonIds.includes(tile.person.id) }
            : { key: tile.word.key, label: tile.word.label || tile.word.key, glyph: tile.word.glyph ?? tile.word.key, engine: true, present: tile.word.present },
        );
      }
      return orderedPeople.map((person) => ({
        key: `face:${person.id}`,
        label: person.name,
        glyph: `face:${person.id}`,
        emoji: "🧑",
        present: presentPersonIds.includes(person.id),
      }));
    }

    if (engineGridActive) {
      return engineGridWords.map((word) => ({
        key: word.key,
        label: word.label || word.key,
        glyph: word.glyph ?? word.key,
        engine: true,
        present: word.present,
      }));
    }

    return gridItems.map((item) => ({
      key: item.key,
      label: itemLabel(item),
      // The student's own cell previews what the button INSERTS, so an alias
      // (`tomorrow` → `day.next`) must mirror as the composed form, not the alias.
      glyph: item.expandsTo ?? item.key,
      emoji: item.emoji,
    }));
  }, [guessingActive, contactsActive, contactTiles, pagedContactTiles, orderedPeople, presentPersonIds, engineGridActive, engineGridWords, gridItems, itemLabel]);

  const mirrorSnapshot = useMemo<BuilderMirrorSnapshot>(() => serializeBuilderMirror({
    cells: mirrorCells,
    // The child's Word Finder board IS the clinician's Word Finder board — the
    // same buttons the server sent, not a second rendering of them.
    guessButtons: guessingActive ? guessGridButtons : undefined,
    paging: contactsActive ? contactsNeedMore : engineGridActive ? engineNeedsMore : gridNeedsMore,
    engine: engineUiActive,
    tabs: engineUiActive
      ? [
          { id: "all", label: engineTabLabel("all"), emoji: ENGINE_ALL_TAB_ICON, active: engineCategory == null },
          ...visibleEngineTabs.map((cat) => ({ id: cat, label: engineTabLabel(cat), active: cat === engineCategory })),
        ]
      : TABS.map((tab) => ({ id: tab, label: t(`construction.tabs.${tab}`), emoji: TAB_ICON[tab], active: tab === activeTab })),
    chips: engineUiActive
      ? visibleEngineChips.map((chip) => ({ id: chip.id, label: chip.label, glyph: chip.glyph, active: chip.id === engineChip }))
      : visibleChips.map((chip) => ({ id: chip.key, label: chip.label, emoji: chip.memory ? "✨" : CHIP_ICON[chip.key], active: chip.key === modeChip })),
    // One glyph string per filled slot, composed the way `serializeGlyph`
    // composes the whole sentence — head, payload, then modifiers.
    slots: displayedGlyph.slots
      .filter((slot) => !!slot.key)
      .map((slot) => {
        const head = slot.payload ? `${slot.key}(${slot.payload})` : slot.key;
        return slot.modifiers.length ? [head, ...slot.modifiers].join(".") : head;
      }),
    activeSlot,
    labels: {
      play: t("construction.play"),
      backspace: t("construction.backspace"),
      clear: t("common.delete"),
    },
  }), [
    mirrorCells, guessingActive, guessGridButtons,
    contactsActive, contactsNeedMore, engineGridActive, engineNeedsMore, gridNeedsMore,
    engineUiActive, visibleEngineTabs, engineCategory, visibleEngineChips, engineChip,
    visibleChips, activeTab, modeChip, displayedGlyph, activeSlot, t,
  ]);

  const onMirror = props.onMirror;
  // Published by CONTENT, not by object identity. `t` is not guaranteed stable
  // across renders, so the memo above can hand back a fresh-but-identical
  // snapshot; forwarding that would set state in the host, re-render, and do it
  // again. The signature is cheap — 18 buttons and a short sentence.
  const lastMirrorSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onMirror) return;
    const sig = JSON.stringify(mirrorSnapshot);
    if (sig === lastMirrorSigRef.current) return;
    lastMirrorSigRef.current = sig;
    onMirror(mirrorSnapshot);
  }, [onMirror, mirrorSnapshot]);
  // The overlay is unmounted when the student leaves the builder, so clear the
  // published snapshot on the way out — a stale sentence strip beside the
  // communication board is exactly the kind of lie this whole thing removes.
  useEffect(() => () => { onMirror?.(null); }, [onMirror]);

  /** Drive this board from the clinician's mirror. Every branch lands on the
   *  handler a local press would have called. */
  useImperativeHandle(props.remoteRef, () => ({
    /** Returns whether the press actually landed — a target whose surface is
     *  not on screen (a word from a page that has since changed, a Word Finder
     *  button after the child left guessing) must be reported as undelivered,
     *  not silently swallowed. */
    press(target: BuilderTarget): boolean {
      switch (target.kind) {
        case "word": {
          if (target.key.startsWith("face:")) { handlePersonPress(target.key.slice(5)); return true; }
          const item = getVocabularyItem(target.key);
          if (!item) return false;
          handleGridPress(item);
          return true;
        }
        case "engineWord": {
          const word =
            engineGridWords.find((w) => w.key === target.key) ??
            engineIndividualWords.find((w) => w.key === target.key) ??
            engineSurface?.buttons.find((w) => w.key === target.key);
          if (!word) return false;
          handleEngineWordPress(word);
          return true;
        }
        case "guess": {
          // Same list, same dispatch, same effect as the child's own tap.
          const button = guessGridButtons.find((b) => b.id === target.buttonId);
          if (!button) return false;
          pressGuessButton(button);
          return true;
        }
        case "tab":
          if (!(TABS as readonly string[]).includes(target.tab)) return false;
          handleTabSelect(target.tab as GlyphCategory);
          return true;
        case "engineTab":
          handleEngineTabSelect(target.tab === "all" ? null : target.tab);
          return true;
        case "chip":
          handleModeChipSelect(target.chip);
          return true;
        case "engineChip":
          // "all" is the PINNED chip, and clearing the filter is what it does —
          // the same sentinel the engine tab above uses for the same reason.
          handleEngineChipSelect(target.chip === "all" ? null : target.chip);
          return true;
        case "page":
          setGridPage((page) => page + (target.dir === "more" ? 1 : -1));
          return true;
        case "slot":
          handleSlotPress(target.index);
          return true;
        case "play":
          handlePlay();
          return true;
        case "backspace":
          handleBackspace();
          return true;
        case "clear":
          handleClearSelected();
          return true;
      }
    },
  }), [
    handlePersonPress, handleGridPress, handleEngineWordPress, handleTabSelect,
    handleEngineTabSelect, handleModeChipSelect, handleEngineChipSelect,
    handleSlotPress, handlePlay, handleBackspace, handleClearSelected,
    engineGridWords, engineIndividualWords, engineSurface,
    guessGridButtons, pressGuessButton,
  ]);

  // ── The two sidebar columns, as DATA ─────────────────────────────────────
  // One entry list per column, whichever taxonomy is driving. The markup —
  // and the density step-down that keeps the labels readable — belongs to
  // BuilderSidebar; before the split, engine mode and legacy mode each carried
  // their own copy of it and the two had already drifted.
  //
  // `pinned` says where an entry sits relative to the "…" pager: the "all"
  // tab/chip LEADS, the person tab's "photos" chip TRAILS (it is a fixed
  // affordance, not part of the paged run) — the order the board has always
  // drawn them in.
  const sidebarTabs = useMemo<BuilderSidebarEntry[]>(() => {
    if (engineUiActive) {
      return [
        {
          id: "all",
          label: engineTabLabel("all"),
          icon: ENGINE_ALL_TAB_ICON,
          active: engineCategory == null,
          testId: "engine-tab-all",
          mirrorId: formatBuilderTarget({ kind: "engineTab", tab: "all" }),
          pinned: "lead" as const,
          onPress: () => handleEngineTabSelect(null),
        },
        ...visibleEngineTabs.map((cat) => ({
          id: cat,
          label: engineTabLabel(cat),
          icon: ENGINE_TAB_ICON[cat] ?? "🔤",
          active: cat === engineCategory,
          testId: `engine-tab-${cat}`,
          mirrorId: formatBuilderTarget({ kind: "engineTab", tab: cat }),
          onPress: () => handleEngineTabSelect(cat),
        })),
      ];
    }
    return TABS.map((tab) => ({
      id: tab,
      label: t(`construction.tabs.${tab}`),
      icon: TAB_ICON[tab],
      active: tab === activeTab,
      mirrorId: formatBuilderTarget({ kind: "tab", tab }),
      onPress: () => handleTabSelect(tab),
      onKeyDown: (e: React.KeyboardEvent) => tabKeyActivate(e, () => handleTabSelect(tab)),
    }));
  }, [engineUiActive, engineTabLabel, engineCategory, visibleEngineTabs, handleEngineTabSelect, t, activeTab, handleTabSelect]);

  const sidebarChips = useMemo<BuilderSidebarEntry[]>(() => {
    if (engineUiActive) {
      return [
        {
          id: "all",
          label: t("construction.chips.all"),
          icon: "🔠",
          active: engineChip == null,
          testId: "engine-chip-all",
          mirrorId: formatBuilderTarget({ kind: "engineChip", chip: "all" }),
          pinned: "lead" as const,
          onPress: () => handleEngineChipSelect(null),
        },
        ...visibleEngineChips.map((chip) => {
          // The chip wears THREE of its members (best examples first,
          // engine-ranked) rather than one word standing in for the whole
          // category; a group that advertises no art at all falls back to 📂.
          //
          // [contacts] is the one chip whose members the ENGINE cannot draw out
          // of game — they are this student's own directory — so its face is
          // the first few real contacts who have a photo, and only if there are
          // none does the engine's own exemplar art (a game's characters) show.
          const engineFaces = chip.glyph || chip.glyphs?.length
            ? chip.glyphs ?? (chip.glyph ? [chip.glyph] : [])
            : undefined;
          const faces =
            chip.id === ENGINE_CONTACTS_CHIP && contactFaceGlyphs.length
              ? contactFaceGlyphs
              : engineFaces;
          return {
            id: chip.id,
            label: chip.label,
            glyphs: faces,
            icon: faces ? undefined : chip.id === ENGINE_CONTACTS_CHIP ? CONTACTS_CHIP_ICON : "📂",
            active: chip.id === engineChip,
            testId: `engine-chip-${chip.id}`,
            mirrorId: formatBuilderTarget({ kind: "engineChip", chip: chip.id }),
            onPress: () => handleEngineChipSelect(chip.id),
          };
        }),
      ];
    }
    return visibleChips.map((chip) => ({
      id: chip.key,
      label: chip.label,
      icon: chip.memory ? "✨" : CHIP_ICON[chip.key],
      memory: chip.memory,
      active: chip.key === modeChip,
      mirrorId: formatBuilderTarget({ kind: "chip", chip: chip.key }),
      onPress: () => handleModeChipSelect(chip.key),
    }));
  }, [engineUiActive, t, engineChip, visibleEngineChips, contactFaceGlyphs, handleEngineChipSelect, visibleChips, modeChip, handleModeChipSelect]);

  const handleModifierPress = useCallback(
    (mod: VocabularyItem) => {
      if (effectiveActiveSlot == null) return;
      // Relational modifiers (next/prev/this) don't toggle — they stack,
      // cancel opposites, and the neutral member is axis-exclusive. The pure
      // helper owns all of that; a repeat press of `next` adds another arrow
      // (up to the cap) rather than removing the first.
      if (mod.modifier?.transform === "relational") {
        setGlyph((g) => applyRelationalModifier(g, effectiveActiveSlot, mod.key));
        return;
      }
      // Toggle, but never leave two members of one axis on the same head — a
      // thing cannot be hot AND cold, or one AND three. The conflict rules are
      // registry-declared (`pairKey` / exclusive transforms) and owned by
      // applyModifierPress, so this rail and the ENGINE's rail below it agree.
      setGlyph((g) => applyModifierPress(g, effectiveActiveSlot, mod.key));
    },
    [effectiveActiveSlot]
  );

  // AI- and ENGINE-modifier press. Canonical registry modifiers route through
  // handleModifierPress, so they get the same axis-exclusivity every other rail
  // has — which is what stops the engine rail composing "a hot cold apple".
  // Every descriptor the engine surfaces that the student can reach today
  // (hot/cold, the counts, the state pairs) is a registry item, so that covers
  // the rail in practice.
  //
  // KNOWN GAP: an AI-only or engine-only modifier SYMBOL with no VocabularyItem
  // falls back to the raw toggle below, which cannot know what it conflicts
  // with — `addModifier` operates by key, so the GLYPH stores the suggestion
  // verbatim and the compositor's registered symbol path renders it. The wire
  // now carries `BuilderWord.axis` for exactly this case; wiring it needs the
  // axis of ALREADY-APPLIED keys too, which the rail does not report.
  const handleAiModifierPress = useCallback(
    (candidate: { key: string }) => {
      if (effectiveActiveSlot == null) return;
      const item = getVocabularyItem(candidate.key);
      if (item) {
        handleModifierPress(item);
        return;
      }
      setGlyph((g) =>
        activeModifierKeys.has(candidate.key)
          ? removeModifier(g, effectiveActiveSlot, candidate.key)
          : addModifier(g, effectiveActiveSlot, candidate.key)
      );
    },
    [effectiveActiveSlot, activeModifierKeys, handleModifierPress]
  );

  const handleModifierMore = useCallback(() => {
    setModifierPage((p) => p + 1);
  }, []);

  /**
   * Apply (or toggle) a color modifier on the active slot. Colors are
   * mutually exclusive — picking a new color replaces any existing one
   * first, so the slot's frame can only be one color at a time.
   */
  const handleColorPick = useCallback(
    (colorItem: VocabularyItem) => {
      if (effectiveActiveSlot == null) return;
      setGlyph((g) => applyExclusiveModifier(g, effectiveActiveSlot, colorItem.key, "color"));
      setColorPickerOpen(false);
    },
    [effectiveActiveSlot]
  );

  const handleEmotionPick = useCallback(
    (emotionItem: VocabularyItem) => {
      if (effectiveActiveSlot == null) return;
      setGlyph((g) => applyExclusiveModifier(g, effectiveActiveSlot, emotionItem.key, "emotion"));
      setEmotionPickerOpen(false);
    },
    [effectiveActiveSlot]
  );

  /** Amount (gauge) modifier — mutually exclusive on the slot, like color. */
  const handleAmountPick = useCallback(
    (amountItem: VocabularyItem) => {
      if (effectiveActiveSlot == null) return;
      setGlyph((g) => applyExclusiveModifier(g, effectiveActiveSlot, amountItem.key, "gauge"));
      setAmountPickerOpen(false);
    },
    [effectiveActiveSlot]
  );

  /** Quality pole-toggle: cycle the active slot through none → pos → neg → none. */
  const handleQualityToggle = useCallback(
    (pair: { pos: VocabularyItem; neg: VocabularyItem }) => {
      if (effectiveActiveSlot == null) return;
      setGlyph((g) => cycleQualityPole(g, effectiveActiveSlot, pair.pos.key, pair.neg.key));
    },
    [effectiveActiveSlot]
  );

  /** Arm / disarm a forward-binding join for the next pushed slot. */
  const handleJoinPick = useCallback((key: string) => {
    setPendingJoin((cur) => (cur === key ? null : key));
    setJoinPickerOpen(false);
  }, []);

  // "More" press: hide the current SUGGESTIONs, exclude them next round.
  // After MORE_ESCALATION_THRESHOLD presses without a selection, escalate to
  // guessing mode by flagging the next state injection. Excludes from BOTH
  // strips so a refresh actually surfaces new modifiers too.
  const handleAiMore = useCallback(() => {
    setExcludeKeys((prev) => {
      const seen = new Set(prev);
      for (const c of aiCandidates) seen.add(c.key);
      for (const c of aiModifierCandidates) seen.add(c.key);
      return Array.from(seen);
    });
    setMorePressCount((n) => {
      const next = n + 1;
      if (next >= MORE_ESCALATION_THRESHOLD) {
        setPendingHelpRequest(true);
        return 0; // reset after escalation
      }
      return next;
    });
  }, [aiCandidates, aiModifierCandidates]);

  // AI-strip press: routes through the same fill/replace logic as the grid
  // — selected slot → replace; pending payload host → fill payload;
  // otherwise → push new slot.
  const handleAiCandidatePress = useCallback(
    (candidate: { key: string; label?: string }) => {
      const item = getVocabularyItem(candidate.key);
      const synthesized: VocabularyItem = item ?? {
        key: candidate.key,
        tKey: `aac.glyph.${candidate.key}`,
        pos: "noun",
        categories: [],
        modeChips: {},
        tone: "comment",
      };
      // Canonical items get the emoji-vs-key swap (same logic as the
      // grid). For AI-generated/synthesized keys there's nothing to
      // swap to — keep the bare key so the generated artwork lands on
      // it via `construction_symbol_ready`.
      const selectionKey = item ? slotKeyForSelection(item) : synthesized.key;
      setGlyph((g) => {
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, selectionKey);
        }
        const pending = findPendingPayloadSlot(g);
        if (pending != null) {
          // AI-generated keys (unknown to the registry) are assumed
          // noun-like and acceptable — composable hosts that accept "noun"
          // will take them.
          const host = getVocabularyItem(g.slots[pending].key);
          if (host?.composable?.accepts.includes(synthesized.pos)) {
            return setPayload(g, pending, selectionKey);
          }
        }
        return pushSlotWithJoin(g, selectionKey, pendingJoin);
      });
      setActiveSlot(null);
      setPendingJoin(null);
    },
    [activeSlot, pendingJoin]
  );

  // AI suggestion chips are gated off wholesale (SHOW_AI_SUGGESTION_STRIPS) —
  // the state/handlers above stay wired for when they return.
  const aiModifierStripVisible =
    SHOW_AI_SUGGESTION_STRIPS && aiModifierCandidates.length > 0 && effectiveActiveSlot != null;

  // WHAT THIS CLIENT LENDS THE SHARED CHROME: its translator, its reading
  // direction, its Glyph wrapper (animated + fillSlot), its bundled-icon
  // resolver, and its people sources. The clinician's builder hands over its
  // own four; nothing below this point knows which client it is drawing for.
  const builderDeps = useMemo<BuilderRenderDeps>(
    () => ({ t, rtl: isRTL, GlyphComponent: Glyph, resolveIconPath, getFaceImage, getPersonName }),
    [t, isRTL, getFaceImage, getPersonName],
  );

  return (
    <BuilderDepsProvider value={builderDeps}>
    <div
      dir={isRTL ? "rtl" : "ltr"}
      className="flex h-full w-full overflow-hidden bg-gray-50 dark:bg-gray-900"
      data-testid="construction-board"
    >
      {/* The two measured sidebar columns.

          TABS: while the engine answers, the tab set IS the engine's advertised
          categories behind a pinned "all" (ranked) tab — the legacy
          who/do/what/where taxonomy renders only as the fallback when no engine
          surface is available.

          CHIPS: in engine mode the ENGINE's own group chips for the active view
          (localized engine-side), behind an "all" chip that clears the group
          filter — plus the client-side "photos" chip under the person tab (the
          real-people directory). Fallback: the legacy mode chips (static +
          memory).

          Both columns are one component and one measurement: they are siblings
          in this `flex h-full` row, so they always have the same height. */}
      <BuilderSidebar
        ariaLabel={t("construction.tabsLabel")}
        heightPx={sidebarHeight}
        onMeasure={handleSidebarMeasure}
        tabs={sidebarTabs}
        chips={sidebarChips}
        tabsNeedMore={engineUiActive && engineTabsNeedMore}
        chipsNeedMore={engineUiActive ? engineChipsNeedMore : chipsNeedMore}
        onTabsMore={() => setEngineTabPage((p) => p + 1)}
        onChipsMore={() => (engineUiActive ? setEngineChipPage((p) => p + 1) : setChipPage((p) => p + 1))}
        tabsTestId={engineUiActive ? "engine-tabs" : undefined}
        chipsTestId={engineUiActive ? "engine-chips" : undefined}
        tabsMoreTestId="engine-tab-more"
        chipsMoreTestId={engineUiActive ? "engine-chip-more" : "chip-more"}
        chipsPagerStyle={engineUiActive ? "density" : "plain"}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top action row, in reading order: SAY - the sentence - backspace -
            tone - find-word - close. The Say button leads because it is the
            verb of the sentence; the glyphs grow away from it toward the
            eraser. */}
        <div className="flex items-stretch gap-2 p-3 border-b border-gray-200 dark:border-gray-700 shrink-0 h-36">
          {/* Say button — disabled when no slots filled. Arrow points along
              the reading direction so it reads as "forward / go". While the
              composed sentence is being interpreted, it shows a spinner and a
              "wait" label instead of closing instantly (the host closes the
              board the moment the interpreted sentence starts being voiced).

              COLOUR = WHICH PATH THE PRESS TAKES. Green: the device renders
              this sentence itself (no model, instant). Yellow-green with a "?":
              the AI will interpret it. It NEVER gates the press — a partial
              sentence is still the student's to say, and half a sentence said
              is worth more than a whole one withheld. */}
          <ActionButton
            label={awaitingInterpret ? t("processing.interpreting") : t("construction.play")}
            icon={forwardTriangle(isRTL)}
            primary
            parsable={displayedGlyph.slots.length > 0 ? parsable : null}
            ready={engineSurface?.complete === true && displayedGlyph.slots.length > 0}
            busy={awaitingInterpret}
            disabled={displayedGlyph.slots.length === 0}
            onPress={handlePlay}
            testId="construction-play"
            mirrorId={formatBuilderTarget({ kind: "play" })}
          />

          {/* Glyph display — preview of the assembled glyph (or empty
              placeholder), start-aligned so the sentence grows from the Say
              button and a new word never shoves the rest sideways. The bump
              on deletion is the only cue a removed slot can leave. */}
          <motion.div
            key={stripBump}
            initial={stripBump > 0 ? { scale: 0.97 } : false}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
            className="flex-1 min-w-0 bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 p-2 overflow-hidden"
          >
            <GlyphCompositor
              glyph={displayedGlyph}
              rtl={isRTL}
              resolveImage={defaultImageResolver}
              activeSlot={activeSlot}
              ariaLabel={t("construction.glyphPreviewLabel")}
              onSlotPress={handleSlotPress}
              showEmptyHostSlot={ENABLE_GLYPH_ARGUMENTS}
              align="start"
              enteringSlot={enteringSlot}
            />
          </motion.div>

          {/* Clear-selected button — only when a slot is selected. With no
              selection, the same spot shows Backspace (removes the last
              slot) whenever there's something to remove. It sits after the
              last glyph — the eraser at the end of the line. */}
          {activeSlot != null ? (
            <ActionButton
              label={t("common.delete")}
              icon="✕"
              onPress={handleClearSelected}
              testId="construction-clear"
              mirrorId={formatBuilderTarget({ kind: "clear" })}
            />
          ) : displayedGlyph.slots.length > 0 ? (
            <ActionButton
              label={t("construction.backspace")}
              icon="⌫"
              mirrorIcon={isRTL}
              onPress={handleBackspace}
              testId="construction-backspace"
              mirrorId={formatBuilderTarget({ kind: "backspace" })}
            />
          ) : null}

          {/* Tone toggles: ? and ! */}
          <div className="flex flex-col gap-2">
            <ToneToggle
              label="?"
              active={tone.question}
              onToggle={() => setTone((p) => ({ ...p, question: !p.question }))}
              ariaLabel={t("construction.toggleQuestion")}
            />
            <ToneToggle
              label="!"
              active={tone.exclamation}
              onToggle={() => setTone((p) => ({ ...p, exclamation: !p.exclamation }))}
              ariaLabel={t("construction.toggleExclamation")}
            />
          </div>

          {/* Find-word button — launches (or exits) word-finding mode for the
              active slot. Violet, matching the "Find word" quick-button. The
              `active` prop renders the highlight when guessing is on; the
              press toggles entry/exit via the same handler. */}
          <ActionButton
            label={t("quickActions.guess")}
            icon="🔍"
            color="#EDE9FE"
            borderColor="#C4B5FD"
            active={guessingActive}
            onPress={handleHelpPress}
            testId="construction-help"
          />

          {/* Close button (optional) */}
          {onClose && (
            <ActionButton
              label={t("common.close")}
              icon="✕"
              onPress={onClose}
              testId="construction-close"
            />
          )}
        </div>

        {/* THE MODIFIER BAND and its five picker rows — one shared component
            (see @client-shared/builder/ModifierBand for the layout laws).
            Hidden during guessing mode: the narrowing buttons take the grid and
            modifiers aren't relevant while the user is still picking a head.

            The ✨ AI-modifier strip is passed in rather than lived in: it is the
            AAC's alone (context-aware SUGGESTIONs from
            suggest_construction_buttons), shown only when the AI actually
            proposed something AND there's an active HEAD SYMBOL to attach
            modifiers to. */}
        {!guessingActive && (
          <ModifierBand
            engineModifiers={engineModifierItems}
            onEngineModifierPress={handleAiModifierPress}
            activeModifierKeys={activeModifierKeys}
            aiStrip={
              aiModifierStripVisible ? (
                <div className="flex items-center gap-2 shrink-0" data-testid="ai-modifier-strip">
                  <span className="self-center text-xl select-none" aria-hidden>
                    ✨
                  </span>
                  {aiModifierCandidates.map((m) => (
                    <ModifierButton
                      key={m.key}
                      item={
                        getVocabularyItem(m.key) ?? {
                          // Synthesized item for AI-only / generated modifier
                          // SYMBOLs that aren't in the canonical registry. The
                          // GLYPH stores the bare key; the compositor's
                          // registered symbol path renders it.
                          key: m.key,
                          tKey: `aac.modifier.${m.key}`,
                          pos: "modifier",
                          categories: [],
                          modeChips: {},
                          tone: "comment",
                          label: m.label,
                        } as unknown as VocabularyItem
                      }
                      active={activeModifierKeys.has(m.key)}
                      onPress={() => handleAiModifierPress(m)}
                    />
                  ))}
                </div>
              ) : undefined
            }
            modifiers={modifierItems}
            onModifierPress={handleModifierPress}
            modifiersHaveMore={allModifiers.length > MODIFIERS_PER_PAGE}
            onModifierMore={handleModifierMore}
            modifierMoreMirrorId={formatBuilderTarget({ kind: "page", dir: "more" })}
            colorOptions={colorOptions}
            colorPickerOpen={colorPickerOpen}
            activeColorKey={activeColorKey}
            onColorToggle={() => setColorPickerOpen((o) => !o)}
            onColorPick={handleColorPick}
            emotionOptions={emotionOptions}
            emotionPickerOpen={emotionPickerOpen}
            activeEmotionKey={activeEmotionKey}
            onEmotionToggle={() => setEmotionPickerOpen((o) => !o)}
            onEmotionPick={handleEmotionPick}
            amountOptions={amountOptions}
            amountPickerOpen={amountPickerOpen}
            activeAmountKey={activeAmountKey}
            onAmountToggle={() => setAmountPickerOpen((o) => !o)}
            onAmountPick={handleAmountPick}
            qualityPairs={qualityPairs}
            qualityPickerOpen={qualityPickerOpen}
            onQualityToggle={() => setQualityPickerOpen((o) => !o)}
            onQualityPress={handleQualityToggle}
            // A join that cannot be ARMED is not offered at all: no slot to bind
            // back to, or the sentence is already at MAX_SLOTS.
            joinOptions={canJoin ? joinOptions : EMPTY_JOIN_OPTIONS}
            joinPickerOpen={joinPickerOpen}
            pendingJoin={pendingJoin}
            onJoinToggle={() => setJoinPickerOpen((o) => !o)}
            onJoinPick={handleJoinPick}
          />
        )}


        {/* Sentence-type chips — CONTROLS (what KIND of thing am I saying?),
            never words: pressing one composes nothing, it re-asks the engine
            for that move's openers. Deliberately the group-chip chrome in a
            different accent (teal, not blue) so the row reads as "same kind of
            control, different question" and can never be mistaken for the
            words below. The engine offers them on the empty board only. */}
        {engineTypeChips.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 bg-gray-50 dark:bg-gray-800/60"
            data-testid="engine-type-chips"
          >
            {engineTypeChips.map((chip) => {
              const active = chip.kind === engineSeedKind;
              return (
                <motion.button
                  key={chip.kind}
                  data-dwell
                  data-testid={`engine-type-chip-${chip.kind}`}
                  aria-pressed={active}
                  onClick={() => handleEngineTypeChipPress(chip.kind)}
                  whileTap={{ scale: 0.95 }}
                  className={[
                    "rounded-xl border-2 text-xs font-medium py-2 px-3 flex flex-col items-center justify-center gap-1 min-w-[4.5rem]",
                    active
                      ? "bg-teal-600 border-teal-700 text-white"
                      : "bg-teal-50 dark:bg-teal-900/30 border-teal-300 dark:border-teal-700 text-teal-900 dark:text-teal-100",
                  ].join(" ")}
                >
                  <span className="text-2xl leading-none" aria-hidden>
                    {TYPE_CHIP_ICON[chip.kind] ?? TYPE_CHIP_FALLBACK_ICON}
                  </span>
                  <span className="truncate w-full text-center">
                    {engineTypeChipLabel(chip.kind, chip.label)}
                  </span>
                </motion.button>
              );
            })}
          </div>
        )}

        {/* AI strip — fixed height. Without this, an <img> with a large intrinsic
            size grows the button (and the strip) past its intended ~110px, squeezing
            the grid below. The percentage max-h on the img inside requires a
            definite parent height to resolve. GATED OFF for now
            (SHOW_AI_SUGGESTION_STRIPS) — the row's screen space goes to the grid. */}
        {SHOW_AI_SUGGESTION_STRIPS && (
        <div className="flex items-stretch gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 h-[110px]">
          {/* ✨ marker — gently pulses with a small caption while the AI is
              still finding suggestions, so the strip clearly reads as "working"
              rather than "empty". */}
          <span
            className={`self-center flex flex-col items-center justify-center text-xl select-none ${aiThinking ? "animate-pulse" : ""}`}
            role={aiThinking ? "status" : undefined}
            aria-label={aiThinking ? t("processing.suggesting") : undefined}
          >
            <span aria-hidden>✨</span>
            {aiThinking && (
              <span className="text-[9px] leading-none mt-0.5 text-violet-500 dark:text-violet-300 font-medium whitespace-nowrap">
                {t("processing.suggesting")}
              </span>
            )}
          </span>
          {[0, 1, 2, 3].map((i) => {
            const c = aiCandidates[i];
            if (c) {
              return (
                <AiCandidateButton
                  key={`${c.key}-${i}`}
                  candidate={c}
                  getFaceImage={getFaceImage}
                  getPersonName={getPersonName}
                  onPress={() => handleAiCandidatePress(c)}
                />
              );
            }
            return <AiPlaceholder key={`p-${i}`} pulsing={aiThinking} />;
          })}
          <MoreButton
            onPress={handleAiMore}
            testId="ai-strip-more"
            mirrorId={formatBuilderTarget({ kind: "page", dir: "more" })}
            disabled={aiCandidates.length === 0 && !aiThinking}
          />
        </div>
        )}

        {/* Main grid — absorbs remaining vertical space. While guessing is
            active the narrowing buttons replace the grid (the resolved concept
            comes back as a construction suggestion in the AI strip above). The
            [contacts] chip (engine) / "who → photos" mode chip (legacy)
            otherwise swaps the vocabulary grid for the person list. */}
        <div className="flex-1 min-h-0 p-3 overflow-hidden">
          {guessingActive ? (
            (() => {
              // Render THREE flavors of word-finder buttons:
              //   (1) suggestion: a registry-driven button (`buttonType="suggestion"`
              //       with a `suggestionKey`) — routes via onGuessingPress.
              //   (2) narrow: an AI-driven open-ended narrowing step
              //       (`buttonType="narrow"` with `narrowDimension` / `narrowValue`)
              //       — routes via onNarrowPress with the speech as sourceText.
              //   (3) guess: a free-form AI guess (untagged or `buttonType="guess"`)
              //       — routes through the normal board-button click path.
              // The list and the dispatch both live above (`guessGridButtons`
              // / `pressGuessButton`) — the call mirror and a clinician's
              // facilitated press use the same two, so a remote narrowing step
              // is the same event as the child's own.
              const guessButtons = guessGridButtons;
              const localizeGuess = (b: BoardButton): BoardButton => {
                const key = (b as any).suggestionKey as string | undefined;
                const parsed = key ? parseSuggestionKey(key) : null;
                const entry = parsed ? getSuggestionEntry(parsed.dimension, parsed.value) : null;
                if (!entry) return b;
                const translated = t(entry.labelKey);
                return { ...b, label: translated && translated !== entry.labelKey ? translated : b.label };
              };
              if (guessButtons.length === 0) {
                return (
                  <div className="flex items-center justify-center w-full h-full text-sm text-gray-400">
                    {t("board.guessingMode")}
                  </div>
                );
              }
              return (
                <div
                  className="grid gap-2 w-full h-full"
                  style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoRows: "minmax(0, 1fr)" }}
                >
                  {guessButtons.map((b, i) => {
                    const sk = (b as any).suggestionKey as string | undefined;
                    const nd = (b as any).narrowDimension as string | undefined;
                    const nv = (b as any).narrowValue as string | undefined;
                    return (
                      <SentenceButton
                        key={sk ?? (nd && nv ? `narrow-${nd}-${nv}` : `guess-${i}`)}
                        variant="board"
                        button={localizeGuess(b)}
                        getFaceImage={getFaceImage ?? undefined}
                        extraButtonProps={{ "data-mirror-id": formatBuilderTarget({ kind: "guess", buttonId: b.id }) }}
                        onClick={() => pressGuessButton(b)}
                      />
                    );
                  })}
                </div>
              );
            })()
          ) : contactsActive ? (
            <BuilderGrid
              needsMore={!!contactTiles && contactsNeedMore}
              onBack={() => setGridPage((p) => p - 1)}
              onMore={() => setGridPage((p) => p + 1)}
              backMirrorId={formatBuilderTarget({ kind: "page", dir: "back" })}
              moreMirrorId={formatBuilderTarget({ kind: "page", dir: "more" })}
              backTestId="who-back"
              moreTestId="who-more"
            >
              {contactTiles ? (
                // Engine mode: the engine's own named individuals merged with
                // the contact directory — everyone PRESENT first, paged like
                // the main grid.
                contactTiles.length === 0 ? (
                  <BuilderGridEmpty>{t("construction.noPeople")}</BuilderGridEmpty>
                ) : (
                  pagedContactTiles.map((tile) =>
                    tile.type === "person" ? (
                      <PersonButton
                        key={`p-${tile.person.id}`}
                        person={tile.person}
                        mirrorId={formatBuilderTarget({ kind: "word", key: `face:${tile.person.id}` })}
                        faceUrl={getFaceImage?.(tile.person.id) ?? null}
                        present={presentPersonIds.includes(tile.person.id)}
                        onPress={() => handlePersonPress(tile.person.id)}
                      />
                    ) : (
                      <EngineWordButton
                        key={`e-${tile.word.key}`}
                        word={tile.word}
                        mirrorId={formatBuilderTarget({ kind: "engineWord", key: tile.word.key })}
                        onPress={() => handleEngineWordPress(tile.word)}
                      />
                    )
                  )
                )
              ) : orderedPeople.length === 0 ? (
                <BuilderGridEmpty>{t("construction.noPeople")}</BuilderGridEmpty>
              ) : (
                orderedPeople.map((person) => (
                  <PersonButton
                    key={person.id}
                    person={person}
                    mirrorId={formatBuilderTarget({ kind: "word", key: `face:${person.id}` })}
                    faceUrl={getFaceImage?.(person.id) ?? null}
                    present={presentPersonIds.includes(person.id)}
                    onPress={() => handlePersonPress(person.id)}
                  />
                ))
              )}
            </BuilderGrid>
          ) : engineGridActive ? (
            // Engine-fed main grid: the engine's words for the current view —
            // the ranked surface on the "all" tab, a category/group listing
            // otherwise. Same 9×2 geometry + wrap paging as the registry grid.
            <BuilderGrid
              needsMore={engineNeedsMore}
              onBack={() => setGridPage((p) => p - 1)}
              onMore={() => setGridPage((p) => p + 1)}
              backMirrorId={formatBuilderTarget({ kind: "page", dir: "back" })}
              moreMirrorId={formatBuilderTarget({ kind: "page", dir: "more" })}
              backTestId="grid-back"
              moreTestId="grid-more"
              testId="engine-grid"
            >
              {engineGridWords.map((word) => (
                <EngineWordButton
                  key={word.key}
                  word={word}
                  mirrorId={formatBuilderTarget({ kind: "engineWord", key: word.key })}
                  onPress={() => handleEngineWordPress(word)}
                />
              ))}
            </BuilderGrid>
          ) : (
            <BuilderGrid
              needsMore={gridNeedsMore}
              onBack={() => setGridPage((p) => p - 1)}
              onMore={() => setGridPage((p) => p + 1)}
              backMirrorId={formatBuilderTarget({ kind: "page", dir: "back" })}
              moreMirrorId={formatBuilderTarget({ kind: "page", dir: "more" })}
              backTestId="grid-back"
              moreTestId="grid-more"
            >
              {gridItems.map((item) => (
                <GridButton
                  key={item.key}
                  item={item}
                  mirrorId={formatBuilderTarget({ kind: "word", key: item.key })}
                  onPress={() => handleGridPress(item)}
                />
              ))}
            </BuilderGrid>
          )}
        </div>
      </div>
    </div>
    </BuilderDepsProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-strip sub-components — AAC-ONLY.
//
// Everything else the builder draws now lives in `@client-shared/builder`
// (composed by the clinician's "Edit visual" dialog too). These three stay here
// because the AI suggestion strip is this client's alone: it is fed by the live
// Gemini session's `suggest_construction_buttons`, resolves server-generated
// symbol paths, and is currently gated off wholesale
// (SHOW_AI_SUGGESTION_STRIPS).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a candidate key (or fallback key) to a render plan. Mirrors the
 * glyph compositor's slot resolution chain so AI-strip suggestions and
 * board buttons render identically.
 *
 *   1. `symbol:ID`        → /api/custom-symbols/ID/image
 *   2. PLACE ART          → the composed shell+fixture glyph, drawn by the
 *                           compositor (a room/building is one symbol made of
 *                           two PNGs, so no single URL can carry it)
 *   3. registry imagePath → bundled icon URL
 *   4. server-resolved symbolPath (only for the primary key — fallbacks
 *      never carry one)
 *   5. emoji (registry item.emoji → resolveEmoji)
 *   6. null → caller falls through to the next link in the chain
 *
 * `face:<id>` keys resolve through `getFaceImage` (the shared camera +
 * stored-photo resolver). When no image is available they degrade to the
 * 👤 emoji via resolveEmoji ("face:" prefix shortcut in
 * shared/emoji-registry.ts).
 */
function resolveCandidateRender(
  key: string,
  serverSymbolPath: string | undefined,
  getFaceImage?: (contactId: string) => string | null,
): { url: string | null; emoji: string | null; glyph?: string } {
  if (!key) return { url: null, emoji: null };
  if (key.startsWith("symbol:")) {
    const id = key.substring(7).trim();
    if (id) return { url: apiUrl(`/api/custom-symbols/${id}/image`), emoji: null };
  }
  if (key.startsWith("face:")) {
    const id = key.substring(5).trim();
    const url = id ? getFaceImage?.(id) ?? null : null;
    // No cached/stored face → 👤 silhouette (resolveEmoji handles "face:").
    return { url, emoji: url ? null : resolveEmoji(key) ?? null };
  }
  if (placeArt(key)) return { url: null, emoji: null, glyph: key };
  const item = getVocabularyItem(key);
  if (item?.imagePath) {
    const u = resolveIconPath(item.imagePath);
    if (u) return { url: u, emoji: null };
  }
  if (serverSymbolPath) return { url: serverSymbolPath, emoji: null };
  const e = item?.emoji ?? resolveEmoji(key);
  if (e) return { url: null, emoji: e };
  return { url: null, emoji: null };
}

function AiCandidateButton(props: {
  candidate: { key: string; label?: string; symbolPath?: string; fallback?: string };
  getFaceImage?: (contactId: string) => string | null;
  getPersonName?: (personId: string) => string | null;
  onPress: () => void;
}) {
  const { t, isRTL } = useLanguage();
  const { candidate, getFaceImage, getPersonName } = props;
  const item = getVocabularyItem(candidate.key);

  // Try the primary key first; if nothing renders, fall back to the
  // server-validated fallback key. Image-load failure (404 / CORS /
  // pending generation) also routes to the fallback path so an
  // unresolved candidate doesn't sit with a broken-image glyph.
  const primary = resolveCandidateRender(candidate.key, candidate.symbolPath, getFaceImage);
  const fb = candidate.fallback
    ? resolveCandidateRender(candidate.fallback, undefined, getFaceImage)
    : { url: null, emoji: null };

  const [primaryFailed, setPrimaryFailed] = useState(false);
  useEffect(() => {
    // New URL — give the next load a fair chance to succeed.
    setPrimaryFailed(false);
  }, [primary.url]);

  // A composed PLACE symbol can't be one URL, so it short-circuits the
  // url/emoji chain and draws through the compositor like the board does.
  const renderGlyph = (!primaryFailed && primary.glyph) || fb.glyph || null;
  let renderUrl: string | null = null;
  let renderEmoji: string | null = null;
  if (primary.url && !primaryFailed) {
    renderUrl = primary.url;
  } else if (fb.url) {
    renderUrl = fb.url;
  } else if (primary.emoji && !primaryFailed) {
    renderEmoji = primary.emoji;
  } else if (fb.emoji) {
    renderEmoji = fb.emoji;
  } else {
    // ❓ matches the glyph compositor's "unknown slot" placeholder. Note
    // we deliberately don't fall back to ✨ here — that's `very`'s
    // canonical emoji, and the AI strip used to default to it which
    // made every unresolved candidate look like a `very` suggestion.
    renderEmoji = "❓";
  }

  // Label resolution: AI-provided label → person name (for `face:<id>`) →
  // registry translation → bare key. The face branch keeps the student from
  // ever seeing a raw "face:abc123" id on the button.
  let label = candidate.label;
  if (!label && candidate.key.startsWith("face:")) {
    label = getPersonName?.(candidate.key.substring(5).trim()) ?? undefined;
  }
  if (!label && item) {
    const translated = t(item.tKey);
    label = translated === item.tKey ? candidate.key : translated;
  }
  if (!label) label = candidate.key;
  return (
    <motion.button
      data-dwell
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className="flex-1 min-w-0 h-full rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-purple-50/60 dark:bg-purple-900/30 flex flex-col items-center justify-center overflow-hidden"
      style={{ padding: 5 }}
    >
      <div className="icon-fill-area">
        {renderGlyph ? (
          <Glyph glyph={renderGlyph} noBackground ariaLabel={label} />
        ) : renderUrl ? (
          // onError demotes the primary image — the resolver above then
          // tries the fallback key (which may itself be an emoji).
          <img
            src={renderUrl}
            alt=""
            className="icon-fill-img"
            style={rtlMirrorStyle(isRTL, { key: candidate.key, emoji: item?.emoji ?? resolveEmoji(candidate.key), item: item ?? undefined })}
            onError={() => {
              if (renderUrl === primary.url) setPrimaryFailed(true);
            }}
          />
        ) : (
          <span className="icon-fill-emoji" aria-hidden style={rtlMirrorStyle(isRTL, { key: candidate.key, emoji: renderEmoji ?? "❓", item: item ?? undefined })}>
            {renderEmoji ?? "❓"}
          </span>
        )}
      </div>
      <span className="text-xs font-medium truncate w-full text-center shrink-0" style={{ marginTop: 2 }}>
        {label}
      </span>
    </motion.button>
  );
}

function AiPlaceholder(props: { pulsing: boolean }) {
  return (
    <div
      className={[
        "flex-1 h-full rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-white/40 dark:bg-gray-800/40",
        props.pulsing ? "animate-pulse" : "",
      ].join(" ")}
      aria-hidden
    />
  );
}

export default SentenceConstructorBoard;

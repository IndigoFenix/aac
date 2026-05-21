// client-aac/src/components/SentenceConstructorBoard.tsx
//
// Layout skeleton for the sentence construction board. Renders the static
// shell — sidebar tabs, glyph display, tone toggles, help/play, modifier
// zone, AI strip, mode chips, main grid. State interactions (slot fill,
// modifier apply, AI refresh, guessing mode) wired in subsequent tasks.
//
// Eyegaze constraints baked in:
//   - No scrolling anywhere
//   - Stable target positions across tab changes
//   - Button-sized targets only (no chips smaller than a button)
//   - "More" lives in fixed positions

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import {
  type GlyphCategory,
  type VocabularyItem,
  getVocabularyItem,
  listByModeChip,
  modifiersFor,
  colorModifiersFor,
  MODE_CHIPS,
  defaultModeChip,
} from "@shared/glyph-registry";
import {
  EMPTY_GLYPH,
  MAX_SLOTS,
  pushSlot,
  replaceSlot,
  clearSlot,
  addModifier,
  removeModifier,
  resolveActiveSlot,
  serializeGlyph,
  setPayload,
  setToneTags,
  type ParsedGlyph,
  type ToneTag,
} from "@shared/glyph-compositor";
import { defaultImageResolver, resolveIconPath } from "@/lib/glyph-images";
import { apiUrl } from "@/lib/queryClient";
import { resolveEmoji } from "@shared/emoji-registry";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import type {
  ConstructionStateClient,
  ConstructionSuggestionsClient,
  ConstructionMemoryChipsClient,
} from "@/hooks/dual-agent-types";

/** Compute the slot we want the AI to suggest for. */
function computeTargetSlot(glyph: ParsedGlyph, activeSlot: number | null): number {
  if (activeSlot != null) return activeSlot;
  // No upper clamp — slots can grow up to MAX_SLOTS. We always target
  // the next empty position; if it's at the cap, the last slot is the
  // target for re-suggestion.
  return Math.min(glyph.slots.length, MAX_SLOTS - 1);
}

/**
 * Find a slot that is a composable host with no payload yet. Returns the
 * slot index, or null. When set, item presses route into the payload
 * rather than pushing a new slot.
 */
/**
 * What goes into a glyph slot when the student selects a vocabulary
 * item from the construction-board grid or AI strip. For items the AI
 * is explicitly taught about (`exposeToAi: true`) the slot keeps the
 * snake_case key — the AI's vocabulary list says `i_me`, `want`,
 * `play`, so the [GLYPH PRESS] should match. For everything else the
 * slot stores the item's CANONICAL EMOJI; the AI's vocabulary is just
 * "emoji" for those concepts, so it sees 🐈 (not "cat"), 🚶 (not
 * "walk"), 🍌 (not "banana"), and interprets intent visually. The
 * renderer reverse-maps emojis back to bundled artwork when one is
 * available (see getVocabularyItemByEmoji), so the visual fidelity is
 * the same whether the slot stores `key` or `emoji`.
 */
function slotKeyForSelection(item: VocabularyItem): string {
  if (item.exposeToAi) return item.key;
  if (item.emoji) return item.emoji;
  return item.key;
}

function findPendingPayloadSlot(glyph: ParsedGlyph): number | null {
  // Walk from most-recent to oldest — the freshly-placed host is usually last.
  for (let i = glyph.slots.length - 1; i >= 0; i--) {
    const slot = glyph.slots[i];
    const item = getVocabularyItem(slot.key);
    if (item?.composable && !slot.payload) return i;
  }
  return null;
}

const TABS: readonly GlyphCategory[] = ["who", "do", "what", "where", "when"] as const;

const TAB_ICON: Record<GlyphCategory, string> = {
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

export interface SentenceConstructorBoardProps {
  /** Called when the user presses Play with the current glyph string. */
  onPlay?: (glyphString: string) => void;
  /** Called when the user dismisses the board. */
  onClose?: () => void;
  /**
   * Push state to the AI. Pass when the board renders outside the
   * DualAgentProvider subtree; otherwise the optional context is used.
   */
  sendConstructionState?: (state: ConstructionStateClient) => void;
  /** Latest suggestion event from the AI. */
  constructionSuggestions?: ConstructionSuggestionsClient | null;
  /** AI-driven memory chips per category. */
  constructionMemoryChips?: Partial<Record<ConstructionStateClient["category"], ConstructionMemoryChipsClient>>;
}

export function SentenceConstructorBoard(props: SentenceConstructorBoardProps) {
  const { t, isRTL } = useLanguage();
  const { onClose, onPlay } = props;
  const ctx = useDualAgentContextOptional();
  // Props take precedence over context — the construction board may render
  // outside the DualAgentProvider subtree (as in the AAC home overlay).
  const sendConstructionState = props.sendConstructionState ?? ctx?.sendConstructionState;
  const constructionSuggestions = props.constructionSuggestions ?? ctx?.constructionSuggestions ?? null;
  const constructionMemoryChips = props.constructionMemoryChips ?? ctx?.constructionMemoryChips ?? {};

  const [activeTab, setActiveTab] = useState<GlyphCategory>("who");
  const [modeChip, setModeChip] = useState<string>(defaultModeChip("who"));
  const [glyph, setGlyph] = useState<ParsedGlyph>(EMPTY_GLYPH);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [tone, setTone] = useState<Record<ToneTag, boolean>>({
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
  const CHIPS_PER_PAGE = 7;

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
  const GRID_CELLS = 18;
  const GRID_ITEMS_WITH_MORE = GRID_CELLS - 1;

  // Merge tone toggle state into the glyph as tone tags. The compositor and
  // the play action both read from the displayed glyph.
  const displayedGlyph = useMemo(() => {
    const tags: ToneTag[] = [];
    if (tone.question) tags.push("question");
    if (tone.exclamation) tags.push("exclamation");
    return setToneTags(glyph, tags);
  }, [glyph, tone]);

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
  const gridNeedsMore = allGridItems.length > GRID_CELLS;
  const gridItemsPerPage = gridNeedsMore ? GRID_ITEMS_WITH_MORE : GRID_CELLS;
  const gridItems = useMemo(() => {
    if (!gridNeedsMore) return allGridItems.slice(0, GRID_CELLS);
    // Wrap-around slice so each page shows a full set; if the user keeps
    // tapping More we cycle through everything and eventually loop.
    const start = (gridPage * gridItemsPerPage) % allGridItems.length;
    const wrapped = [...allGridItems.slice(start), ...allGridItems.slice(0, start)];
    return wrapped.slice(0, gridItemsPerPage);
  }, [allGridItems, gridPage, gridNeedsMore, gridItemsPerPage]);

  // All applicable modifiers for the active slot (full list, before pagination).
  const allModifiers = useMemo(() => {
    if (effectiveActiveSlot == null) return [] as VocabularyItem[];
    const slot = displayedGlyph.slots[effectiveActiveSlot];
    const item = slot ? getVocabularyItem(slot.key) : undefined;
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
    const item = slot ? getVocabularyItem(slot.key) : undefined;
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

  const handleTabSelect = useCallback((tab: GlyphCategory) => {
    setActiveTab(tab);
    setModeChip(defaultModeChip(tab));
  }, []);

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
        return pushSlot(g, selectionKey);
      });
      setActiveSlot(null);
      // If we just placed a composable host with no payload, hop to the
      // first suggestCategory so the grid surfaces relevant fillers.
      if (item.composable && item.composable.suggestCategories.length > 0) {
        const nextTab = item.composable.suggestCategories[0];
        setActiveTab(nextTab);
        setModeChip(defaultModeChip(nextTab));
      }
    },
    [activeSlot]
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

  const handlePlay = useCallback(() => {
    if (displayedGlyph.slots.length === 0) return;
    onPlay?.(serializeGlyph(displayedGlyph));
  }, [displayedGlyph, onPlay]);

  // Help button state machine (per planning-docs/glyph-system.md):
  //   - Slot selected → re-suggest for that slot (excludes current AI strip).
  //   - No selection, glyph has empty slot(s) → guessing mode for first empty.
  //   - All filled, no selection → guessing mode for slot 3.
  // Guessing-mode entry sets `pendingHelpRequest`; the construction-state
  // effect picks it up and sends `requestGuessingMode: true` on the next
  // injection. The AI's existing <guessing_mode> behavior handles the rest.
  const handleHelpPress = useCallback(() => {
    if (activeSlot != null) {
      // Re-suggest path. Exclude what's currently in BOTH AI strips so the
      // next round genuinely surfaces new ideas (head and modifier alike).
      setExcludeKeys((prev) => {
        const seen = new Set(prev);
        for (const c of aiCandidates) seen.add(c.key);
        for (const c of aiModifierCandidates) seen.add(c.key);
        return Array.from(seen);
      });
      return;
    }
    setPendingHelpRequest(true);
  }, [activeSlot, aiCandidates, aiModifierCandidates]);

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
  // vocabulary list).
  useEffect(() => {
    setGridPage(0);
  }, [activeTab, modeChip]);

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

  const visibleChips = useMemo(() => {
    if (allChips.length <= CHIPS_PER_PAGE) return allChips;
    const start = (chipPage * CHIPS_PER_PAGE) % allChips.length;
    const wrapped = [...allChips.slice(start), ...allChips.slice(0, start)];
    return wrapped.slice(0, CHIPS_PER_PAGE);
  }, [allChips, chipPage]);

  const handleModifierPress = useCallback(
    (mod: VocabularyItem) => {
      if (effectiveActiveSlot == null) return;
      setGlyph((g) =>
        activeModifierKeys.has(mod.key)
          ? removeModifier(g, effectiveActiveSlot, mod.key)
          : addModifier(g, effectiveActiveSlot, mod.key)
      );
    },
    [effectiveActiveSlot, activeModifierKeys]
  );

  // AI-modifier press: same toggle add/remove flow as the static carousel.
  // For canonical registry modifiers, we route through handleModifierPress
  // so the existing color-mutex / dimension-mutex semantics still hold.
  // For AI-only / generated modifier symbols (rare), we fall back to the
  // raw key path since there's no VocabularyItem to consult — `addModifier`
  // operates by key, so the GLYPH stores the SUGGESTION verbatim and the
  // compositor's registered symbol path renders it.
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
      setGlyph((g) => {
        let next = g;
        const slot = next.slots[effectiveActiveSlot];
        if (!slot) return g;
        // Strip any existing color modifier first (mutual exclusion).
        for (const modKey of slot.modifiers) {
          if (modKey === colorItem.key) continue;
          const mod = getVocabularyItem(modKey);
          if (mod?.modifier?.transform === "color") {
            next = removeModifier(next, effectiveActiveSlot, modKey);
          }
        }
        // Toggle: tapping the active color again removes it; otherwise add.
        const refreshedSlot = next.slots[effectiveActiveSlot];
        if (refreshedSlot.modifiers.includes(colorItem.key)) {
          next = removeModifier(next, effectiveActiveSlot, colorItem.key);
        } else {
          next = addModifier(next, effectiveActiveSlot, colorItem.key);
        }
        return next;
      });
      setColorPickerOpen(false);
    },
    [effectiveActiveSlot]
  );

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
        return pushSlot(g, selectionKey);
      });
      setActiveSlot(null);
    },
    [activeSlot]
  );

  return (
    <div
      dir={isRTL ? "rtl" : "ltr"}
      className="flex h-full w-full overflow-hidden bg-gray-50 dark:bg-gray-900"
      data-testid="construction-board"
    >
      {/* Sidebar: vertical tabs */}
      <nav
        aria-label={t("construction.tabsLabel")}
        className="flex flex-col gap-2 p-2 border-e border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 w-28 shrink-0 overflow-hidden"
      >
        {TABS.map((tab) => {
          const active = tab === activeTab;
          return (
            <motion.button
              key={tab}
              data-dwell
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => handleTabSelect(tab)}
              onKeyDown={(e) => onTabKey(e, tab)}
              whileTap={{ scale: 0.96 }}
              className={[
                "flex flex-col items-center justify-center gap-1 rounded-xl py-3",
                "border-2 transition-colors",
                active
                  ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
                  : "border-transparent hover:bg-gray-100 dark:hover:bg-gray-700/40",
              ].join(" ")}
            >
              <span className="text-3xl" aria-hidden>
                {TAB_ICON[tab]}
              </span>
              <span className="text-xs font-medium">
                {t(`construction.tabs.${tab}`)}
              </span>
            </motion.button>
          );
        })}
      </nav>

      {/* Second sidebar: mode chips for active tab (static + memory) */}
      <nav
        aria-label={t("construction.tabsLabel")}
        className="flex flex-col gap-2 p-2 border-e border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 w-28 shrink-0 overflow-hidden"
      >
        {visibleChips.map((chip) => {
          const active = chip.key === modeChip;
          const baseStyle = active
            ? chip.memory
              ? "bg-purple-600 border-purple-700 text-white"
              : "bg-blue-600 border-blue-700 text-white"
            : chip.memory
              ? "bg-purple-50/60 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700 text-purple-900 dark:text-purple-100"
              : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600";
          const icon = chip.memory ? "✨" : CHIP_ICON[chip.key];
          return (
            <motion.button
              key={chip.key}
              data-dwell
              onClick={() => setModeChip(chip.key)}
              whileTap={{ scale: 0.95 }}
              className={[
                "rounded-xl border-2 text-xs font-medium py-2 px-2 flex flex-col items-center justify-center gap-1",
                baseStyle,
              ].join(" ")}
            >
              {icon && (
                <span className="text-2xl leading-none" aria-hidden>
                  {icon}
                </span>
              )}
              <span className="truncate w-full text-center">{chip.label}</span>
            </motion.button>
          );
        })}
        {allChips.length > CHIPS_PER_PAGE && (
          <motion.button
            data-dwell
            data-testid="chip-more"
            onClick={() => setChipPage((p) => p + 1)}
            whileTap={{ scale: 0.95 }}
            className="rounded-xl border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800 text-xs font-medium py-2 px-2 flex items-center justify-center"
          >
            …
          </motion.button>
        )}
      </nav>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top action row: glyph display + tone toggles + help + play */}
        <div className="flex items-stretch gap-2 p-3 border-b border-gray-200 dark:border-gray-700 shrink-0 h-36">
          {/* Glyph display — preview of the assembled glyph (or empty placeholder) */}
          <div className="flex-1 min-w-0 bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 p-2 overflow-hidden">
            <GlyphCompositor
              glyph={displayedGlyph}
              rtl={isRTL}
              resolveImage={defaultImageResolver}
              activeSlot={activeSlot}
              ariaLabel={t("construction.glyphPreviewLabel")}
              onSlotPress={handleSlotPress}
            />
          </div>

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

          {/* Help button */}
          <ActionButton
            label={t("construction.help")}
            icon="🔍"
            onPress={handleHelpPress}
            testId="construction-help"
          />

          {/* Clear-selected button — only when a slot is selected */}
          {activeSlot != null && (
            <ActionButton
              label={t("common.delete")}
              icon="✕"
              onPress={handleClearSelected}
              testId="construction-clear"
            />
          )}

          {/* Play button — disabled when no slots filled. Arrow points
              along the reading direction so it reads as "forward / go". */}
          <ActionButton
            label={t("construction.play")}
            icon={isRTL ? "◀" : "▶"}
            primary
            disabled={displayedGlyph.slots.length === 0}
            onPress={handlePlay}
            testId="construction-play"
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

        {/* AI-modifier strip — context-aware MODIFIER SUGGESTIONs delivered
            by suggest_construction_buttons.modifier_candidates. Only renders
            when the AI actually proposed something AND there's an active
            HEAD SYMBOL to attach modifiers to (otherwise the press is a
            no-op). Sits above the static modifier carousel so the AI row
            reads as "modifiers picked for this conversation" vs the
            registry-bundled row below. */}
        {aiModifierCandidates.length > 0 && effectiveActiveSlot != null && (
          <div
            className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0"
            data-testid="ai-modifier-strip"
          >
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
        )}

        {/* Modifier zone — registry-driven MODIFIER SYMBOLs applicable to
            the active HEAD SYMBOL. Only rendered when there are applicable
            modifiers OR colors. */}
        {(modifierItems.length > 0 || colorOptions.length > 0) && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
            {modifierItems.map((m) => (
              <ModifierButton
                key={m.key}
                item={m}
                active={activeModifierKeys.has(m.key)}
                onPress={() => handleModifierPress(m)}
              />
            ))}
            {allModifiers.length > MODIFIERS_PER_PAGE && (
              <MoreButton onPress={handleModifierMore} testId="modifier-more" />
            )}
            {colorOptions.length > 0 && (
              <ColorPickerButton
                active={colorPickerOpen}
                activeColorValue={
                  activeColorKey
                    ? getVocabularyItem(activeColorKey)?.modifier?.colorValue
                    : undefined
                }
                onPress={() => setColorPickerOpen((o) => !o)}
              />
            )}
          </div>
        )}

        {/* Color picker row — shown only when the picker button is toggled
            on. Renders the swatches inline so we don't have to manage
            popover positioning; tapping the picker button again or a
            swatch closes the row. */}
        {colorPickerOpen && colorOptions.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 bg-gray-50 dark:bg-gray-800/60"
            data-testid="color-picker"
          >
            {colorOptions.map((c) => (
              <ColorSwatchButton
                key={c.key}
                item={c}
                active={activeColorKey === c.key}
                onPress={() => handleColorPick(c)}
              />
            ))}
          </div>
        )}

        {/* AI strip — fixed height. Without this, an <img> with a large intrinsic
            size grows the button (and the strip) past its intended ~110px, squeezing
            the grid below. The percentage max-h on the img inside requires a
            definite parent height to resolve. */}
        <div className="flex items-stretch gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 h-[110px]">
          <span className="self-center text-xl select-none" aria-hidden>
            ✨
          </span>
          {[0, 1, 2, 3].map((i) => {
            const c = aiCandidates[i];
            if (c) {
              return (
                <AiCandidateButton
                  key={`${c.key}-${i}`}
                  candidate={c}
                  onPress={() => handleAiCandidatePress(c)}
                />
              );
            }
            return <AiPlaceholder key={`p-${i}`} pulsing={aiThinking} />;
          })}
          <MoreButton
            onPress={handleAiMore}
            testId="ai-strip-more"
            disabled={aiCandidates.length === 0 && !aiThinking}
          />
        </div>

        {/* Main grid — absorbs remaining vertical space */}
        <div className="flex-1 min-h-0 p-3 overflow-hidden">
          <div
            className="grid gap-2 w-full h-full"
            style={{
              gridTemplateColumns: "repeat(9, minmax(0, 1fr))",
              gridTemplateRows: "repeat(2, minmax(0, 1fr))",
            }}
          >
            {gridItems.map((item) => (
              <GridButton
                key={item.key}
                item={item}
                onPress={() => handleGridPress(item)}
              />
            ))}
            {/* Trailing More button — only rendered when the current
                mode-chip has more items than fit in one page. It occupies
                the last cell (cell 18 of the 6×3 grid); without the
                conditional it would always push the grid onto an implicit
                4th row and compress the visible buttons. */}
            {gridNeedsMore && (
              <MoreButton
                onPress={() => setGridPage((p) => p + 1)}
                testId="grid-more"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ToneToggle(props: {
  label: string;
  active: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <motion.button
      data-dwell
      onClick={props.onToggle}
      aria-pressed={props.active}
      aria-label={props.ariaLabel}
      whileTap={{ scale: 0.92 }}
      className={[
        "w-14 h-14 rounded-xl border-2 text-2xl font-bold flex items-center justify-center",
        props.active
          ? "bg-purple-100 border-purple-500 text-purple-700"
          : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600",
      ].join(" ")}
    >
      {props.label}
    </motion.button>
  );
}

function ActionButton(props: {
  label: string;
  icon: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <motion.button
      data-dwell
      data-testid={props.testId}
      onClick={props.onPress}
      disabled={props.disabled}
      whileTap={{ scale: 0.95 }}
      className={[
        "w-24 rounded-xl border-2 flex flex-col items-center justify-center gap-1 px-2 py-2",
        props.primary
          ? "bg-green-500 hover:bg-green-600 border-green-700 text-white"
          : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600",
        props.disabled ? "opacity-40 cursor-not-allowed" : "",
      ].join(" ")}
    >
      <span className="text-2xl" aria-hidden>
        {props.icon}
      </span>
      <span className="text-xs font-medium">{props.label}</span>
    </motion.button>
  );
}

/** Resolve a vocabulary item's display label via i18n, falling back to its raw key. */
function useItemLabel(item: VocabularyItem): string {
  const { t } = useLanguage();
  const translated = t(item.tKey);
  return translated === item.tKey ? item.key : translated;
}

function ModifierButton(props: {
  item: VocabularyItem;
  onPress: () => void;
  active?: boolean;
}) {
  const { item, active } = props;
  const url = item.imagePath ? resolveIconPath(item.imagePath) : null;
  const label = useItemLabel(item);
  return (
    <motion.button
      data-dwell
      onClick={props.onPress}
      aria-pressed={active ?? false}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-16 h-16 rounded-xl border-2 flex items-center justify-center",
        active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      aria-label={label}
    >
      {url ? (
        <img src={url} alt="" className="w-10 h-10 object-contain" />
      ) : (
        <span className="text-2xl" aria-hidden>
          {item.emoji ?? "•"}
        </span>
      )}
    </motion.button>
  );
}


function GridButton(props: { item: VocabularyItem; onPress: () => void }) {
  const { item } = props;
  const url = item.imagePath ? resolveIconPath(item.imagePath) : null;
  const label = useItemLabel(item);
  return (
    <motion.button
      data-dwell
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className="rounded-xl border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 flex flex-col items-center justify-center gap-1 p-2 min-h-0"
    >
      {url ? (
        <img src={url} alt="" className="max-h-[60%] max-w-[80%] object-contain" />
      ) : (
        <span className="text-4xl" aria-hidden>
          {item.emoji ?? "❓"}
        </span>
      )}
      <span className="text-xs font-medium truncate w-full text-center">
        {label}
      </span>
    </motion.button>
  );
}

/**
 * Entry button for the color picker — same footprint as ModifierButton so
 * it slots into the modifier zone without disrupting the row's geometry.
 * Shows a colored paint-drop emoji when no color is active; switches to
 * the currently-active color swatch when one is.
 */
function ColorPickerButton(props: {
  active: boolean;
  activeColorValue?: string;
  onPress: () => void;
}) {
  return (
    <motion.button
      data-dwell
      data-testid="color-picker-toggle"
      onClick={props.onPress}
      aria-pressed={props.active}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-16 h-16 rounded-xl border-2 flex items-center justify-center",
        props.active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      aria-label="Color"
      title="Color"
    >
      {props.activeColorValue ? (
        <span
          className="w-8 h-8 rounded-full border border-gray-300"
          style={{ backgroundColor: props.activeColorValue }}
          aria-hidden
        />
      ) : (
        <span className="text-2xl" aria-hidden>🎨</span>
      )}
    </motion.button>
  );
}

/**
 * Swatch in the color picker row. Filled disc in the color, with a tick
 * overlay when the swatch is currently applied to the active slot.
 */
function ColorSwatchButton(props: {
  item: VocabularyItem;
  active: boolean;
  onPress: () => void;
}) {
  const colorValue = props.item.modifier?.colorValue ?? "#9CA3AF";
  const label = useItemLabel(props.item);
  return (
    <motion.button
      data-dwell
      data-testid={`color-swatch-${props.item.key}`}
      onClick={props.onPress}
      aria-pressed={props.active}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-12 h-12 rounded-full border-2 flex items-center justify-center relative",
        props.active
          ? "border-blue-600"
          : "border-gray-300 dark:border-gray-600",
      ].join(" ")}
      style={{ backgroundColor: colorValue }}
      aria-label={label}
      title={label}
    >
      {props.active && (
        <span
          className="text-lg font-bold"
          // Tick contrasts with the swatch — light tick on dark colors,
          // dark tick on light colors. Cheap luminance proxy.
          style={{ color: isLightColor(colorValue) ? "#1F2937" : "#FFFFFF" }}
          aria-hidden
        >
          ✓
        </span>
      )}
    </motion.button>
  );
}

/** Quick luminance check — true for colors lighter than ~50% perceived brightness. */
function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // ITU-R BT.709 luminance approximation.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 160;
}

function MoreButton(props: { onPress: () => void; testId?: string; disabled?: boolean }) {
  const { t } = useLanguage();
  return (
    <motion.button
      data-dwell
      data-testid={props.testId}
      onClick={props.onPress}
      disabled={props.disabled}
      whileTap={{ scale: 0.95 }}
      className={[
        "rounded-xl border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800 flex flex-col items-center justify-center gap-1 p-2 min-h-0 min-w-[64px]",
        props.disabled ? "opacity-40 cursor-not-allowed" : "",
      ].join(" ")}
    >
      <span className="text-2xl" aria-hidden>
        …
      </span>
      <span className="text-xs font-medium">{t("common.more")}</span>
    </motion.button>
  );
}

/**
 * Resolve a candidate key (or fallback key) to a render plan. Mirrors the
 * glyph compositor's slot resolution chain so AI-strip suggestions and
 * board buttons render identically.
 *
 *   1. `symbol:ID`        → /api/custom-symbols/ID/image
 *   2. registry imagePath → bundled icon URL
 *   3. server-resolved symbolPath (only for the primary key — fallbacks
 *      never carry one)
 *   4. emoji (registry item.emoji → resolveEmoji)
 *   5. null → caller falls through to the next link in the chain
 *
 * `face:` keys are technically valid but the AI strip doesn't have a
 * face-cache resolver wired through this component, so they degrade to
 * the 👤 emoji via resolveEmoji ("face:" prefix shortcut in
 * shared/emoji-registry.ts).
 */
function resolveCandidateRender(
  key: string,
  serverSymbolPath: string | undefined,
): { url: string | null; emoji: string | null } {
  if (!key) return { url: null, emoji: null };
  if (key.startsWith("symbol:")) {
    const id = key.substring(7).trim();
    if (id) return { url: apiUrl(`/api/custom-symbols/${id}/image`), emoji: null };
  }
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
  onPress: () => void;
}) {
  const { t } = useLanguage();
  const { candidate } = props;
  const item = getVocabularyItem(candidate.key);

  // Try the primary key first; if nothing renders, fall back to the
  // server-validated fallback key. Image-load failure (404 / CORS /
  // pending generation) also routes to the fallback path so an
  // unresolved candidate doesn't sit with a broken-image glyph.
  const primary = resolveCandidateRender(candidate.key, candidate.symbolPath);
  const fb = candidate.fallback
    ? resolveCandidateRender(candidate.fallback, undefined)
    : { url: null, emoji: null };

  const [primaryFailed, setPrimaryFailed] = useState(false);
  useEffect(() => {
    // New URL — give the next load a fair chance to succeed.
    setPrimaryFailed(false);
  }, [primary.url]);

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

  // Label resolution: AI-provided label → registry translation → bare key.
  let label = candidate.label;
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
      className="flex-1 min-w-0 h-full rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-purple-50/60 dark:bg-purple-900/30 flex flex-col items-center justify-center gap-1 p-2"
    >
      {renderUrl ? (
        // min-h-0 lets the flex child shrink; max-h pixel cap pins the image
        // regardless of intrinsic size so the button can't grow vertically.
        // onError demotes the primary image — the resolver above then
        // tries the fallback key (which may itself be an emoji).
        <img
          src={renderUrl}
          alt=""
          className="min-h-0 max-h-[50px] max-w-[80%] object-contain"
          onError={() => {
            if (renderUrl === primary.url) setPrimaryFailed(true);
          }}
        />
      ) : (
        <span className="text-3xl leading-none" aria-hidden>
          {renderEmoji ?? "❓"}
        </span>
      )}
      <span className="text-xs font-medium truncate w-full text-center">
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

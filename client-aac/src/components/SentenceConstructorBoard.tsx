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
  MODE_CHIPS,
  defaultModeChip,
} from "@shared/glyph-registry";
import {
  EMPTY_GLYPH,
  pushSlot,
  replaceSlot,
  clearSlot,
  addModifier,
  removeModifier,
  resolveActiveSlot,
  serializeGlyph,
  setToneTags,
  type ParsedGlyph,
  type ToneTag,
} from "@shared/glyph-compositor";
import { defaultImageResolver, resolveIconPath } from "@/lib/glyph-images";
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
  if (glyph.slots.length < 3) return glyph.slots.length; // next empty
  return 2; // all filled → default to slot 3 (re-suggest)
}

const TABS: readonly GlyphCategory[] = ["who", "do", "what", "where", "when"] as const;

const TAB_ICON: Record<GlyphCategory, string> = {
  who: "👤",
  do: "🤲",
  what: "📦",
  where: "📍",
  when: "🕐",
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

  // AI strip state — populated by suggest_construction_buttons tool replies.
  const [aiCandidates, setAiCandidates] = useState<
    Array<{ key: string; label?: string }>
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

  const gridItems = useMemo(
    () => listByModeChip(activeTab, modeChip).slice(0, 18),
    [activeTab, modeChip]
  );

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
      setGlyph((g) => {
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, item.key);
        }
        return pushSlot(g, item.key);
      });
      setActiveSlot(null);
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
      // Re-suggest path.
      setExcludeKeys((prev) => {
        const seen = new Set(prev);
        for (const c of aiCandidates) seen.add(c.key);
        return Array.from(seen);
      });
      return;
    }
    setPendingHelpRequest(true);
  }, [activeSlot, aiCandidates]);

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
    sendConstructionState({
      category: activeTab,
      modeChip,
      glyph: serializeGlyph(glyph),
      activeSlot,
      targetSlot: computeTargetSlot(glyph, activeSlot),
      excludeKeys,
      requestGuessingMode: pendingHelpRequest || undefined,
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
  // last processed. Replace the AI strip wholesale.
  useEffect(() => {
    const incoming = constructionSuggestions;
    console.log("[construction] suggestions effect", {
      hasIncoming: !!incoming,
      receivedAt: incoming?.receivedAt,
      lastReceived: lastReceivedAtRef.current,
      candidateCount: incoming?.candidates.length,
    });
    if (!incoming || incoming.receivedAt <= lastReceivedAtRef.current) return;
    lastReceivedAtRef.current = incoming.receivedAt;
    setAiCandidates(incoming.candidates);
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

  const handleModifierMore = useCallback(() => {
    setModifierPage((p) => p + 1);
  }, []);

  // "More" press: hide the current candidates, exclude them next round.
  // After MORE_ESCALATION_THRESHOLD presses without a selection, escalate to
  // guessing mode by flagging the next state injection.
  const handleAiMore = useCallback(() => {
    setExcludeKeys((prev) => {
      const seen = new Set(prev);
      for (const c of aiCandidates) seen.add(c.key);
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
  }, [aiCandidates]);

  // AI-strip press: routes through handleGridPress so it behaves like a grid
  // tap — fills the next-empty slot or replaces the selected slot.
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
      // Reuse the grid handler's fill/replace logic. The function expects
      // a VocabularyItem-shaped object but only reads `.key` from it.
      setGlyph((g) => {
        if (activeSlot != null && activeSlot < g.slots.length) {
          return replaceSlot(g, activeSlot, synthesized.key);
        }
        return pushSlot(g, synthesized.key);
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
          return (
            <motion.button
              key={chip.key}
              data-dwell
              onClick={() => setModeChip(chip.key)}
              whileTap={{ scale: 0.95 }}
              className={[
                "rounded-xl border-2 text-xs font-medium py-2 px-2 flex items-center justify-center gap-1 truncate",
                baseStyle,
              ].join(" ")}
            >
              {chip.memory && <span aria-hidden>✨</span>}
              <span className="truncate">{chip.label}</span>
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

          {/* Play button — disabled when no slots filled */}
          <ActionButton
            label={t("construction.play")}
            icon="▶"
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

        {/* Modifier zone — only rendered when there are applicable modifiers */}
        {modifierItems.length > 0 && (
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
          </div>
        )}

        {/* AI strip */}
        <div className="flex items-stretch gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
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
              gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
              gridTemplateRows: "repeat(3, minmax(0, 1fr))",
            }}
          >
            {gridItems.map((item) => (
              <GridButton
                key={item.key}
                item={item}
                onPress={() => handleGridPress(item)}
              />
            ))}
            {/* Trailing "more" button in fixed grid position */}
            <MoreButton onPress={() => {/* task #5 */}} testId="grid-more" />
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

function AiCandidateButton(props: {
  candidate: { key: string; label?: string };
  onPress: () => void;
}) {
  const { t } = useLanguage();
  const { candidate } = props;
  const item = getVocabularyItem(candidate.key);
  const url = item?.imagePath ? resolveIconPath(item.imagePath) : null;
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
      className="flex-1 min-h-[90px] rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-purple-50/60 dark:bg-purple-900/30 flex flex-col items-center justify-center gap-1 p-2"
    >
      {url ? (
        <img src={url} alt="" className="max-h-[55%] max-w-[80%] object-contain" />
      ) : (
        <span className="text-3xl" aria-hidden>
          {item?.emoji ?? "✨"}
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
        "flex-1 min-h-[90px] rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-white/40 dark:bg-gray-800/40",
        props.pulsing ? "animate-pulse" : "",
      ].join(" ")}
      aria-hidden
    />
  );
}

export default SentenceConstructorBoard;

// client-shared/src/builder/BuilderSidebar.tsx
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// THE BUILDER'S TWO MEASURED COLUMNS: category tabs, then sub-category chips.
// Both are `flex-col` columns of a fixed-height board whose buttons FILL the
// height rather than sizing to their content — see sidebar-layout.ts for the
// arithmetic and why a constant was wrong at both ends.
//
// ONE component for both columns because they are one measurement: they are
// siblings in the same `flex h-full` row, so they always have the same height
// and one ResizeObserver answers for both.
//
// WHAT THIS OWNS: the two <nav> elements, the ref + ResizeObserver, the density
// step-down, and the button markup (which used to exist TWICE in the AAC — once
// for engine chrome and once for the legacy registry taxonomy — and had already
// drifted between the two).
//
// WHAT THE HOST OWNS: which entries are visible. The host pages the lists
// itself (`sidebarCapacity` + `sidebarPage` against the height this component
// reports through `onMeasure`) because the AAC also has to publish the visible
// set to a clinician's call mirror — a component that paged internally would
// leave the mirror guessing.
//
// PINNING: an entry that must sit outside the paged run carries
// `pinned: "lead"` (before the items — the "all" tab/chip) or `pinned: "trail"`
// (after the "…" pager — the People→Photos chip). Both count toward the
// column's budget, so the host passes them in `fixed` when it pages.

import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { motion } from "framer-motion";
import { GlyphTriad } from "../board/GlyphTriad";
import { useBuilderDeps } from "./deps";
import {
  SIDEBAR_BUTTON_FILL,
  SIDEBAR_PAD_PX,
  sidebarDensity,
  type SidebarDensity,
} from "./sidebar-layout";

/** One button in either column. */
export interface BuilderSidebarEntry {
  id: string;
  label: string;
  /** Emoji (or any short text) drawn above the label. */
  icon?: string;
  /** Chip only: the group's best examples, drawn as a GlyphTriad instead of an
   *  emoji. A category chip wears THREE of its members rather than one member
   *  standing in for the whole category. Wins over `icon` when non-empty. */
  glyphs?: readonly string[];
  /** Fallback glyph for the triad's faces (usually the group's own id). */
  glyphFallback?: string;
  active: boolean;
  testId?: string;
  /** Call-mirror address (`data-mirror-id`). Omitted → no attribute, which is
   *  what a host with no call mirror wants. */
  mirrorId?: string;
  /** Chip only: an AI-generated memory chip, which draws purple. */
  memory?: boolean;
  /** Placement relative to the "…" pager — see the header. */
  pinned?: "lead" | "trail";
  onPress: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}

export interface BuilderSidebarProps {
  /** aria-label for BOTH navs (they are one control to a screen reader). */
  ariaLabel: string;
  tabs: readonly BuilderSidebarEntry[];
  chips: readonly BuilderSidebarEntry[];
  tabsNeedMore?: boolean;
  chipsNeedMore?: boolean;
  onTabsMore?: () => void;
  onChipsMore?: () => void;
  tabsTestId?: string;
  chipsTestId?: string;
  tabsMoreTestId?: string;
  chipsMoreTestId?: string;
  /**
   * How the chip column's "…" pager draws. "plain" is the legacy registry
   * column's fixed `text-xs py-2`; "density" is the engine column's, which
   * steps down with the rest of the buttons. Kept as a knob rather than
   * unified because unifying them would change what the AAC renders today.
   */
  chipsPagerStyle?: "plain" | "density";
  /** Called with the measured column height (px) whenever it changes. The host
   *  feeds it back into `sidebarCapacity` to decide what to pass as entries. */
  onMeasure?: (heightPx: number) => void;
  /** The measured height the host is currently working from — the density
   *  step-down reads it, so it must be the SAME number the host paged with. */
  heightPx: number;
}

export function BuilderSidebar(props: BuilderSidebarProps) {
  const { ariaLabel, tabs, chips } = props;
  const sidebarRef = useRef<HTMLElement | null>(null);
  const onMeasure = props.onMeasure;

  // THE MEASURED COLUMN (2026-08-27). Both sidebars are siblings in the board's
  // `flex h-full` row, so they are always the same height — one observer
  // answers for both.
  useEffect(() => {
    const el = sidebarRef.current;
    if (!el || typeof ResizeObserver === "undefined" || !onMeasure) return;
    onMeasure(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) onMeasure(e.contentRect.height + SIDEBAR_PAD_PX * 2);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The element is stable for the component's life; re-running on every
    // render would tear the observer down mid-resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // How tight each column has to draw itself — the count includes the pinned
  // buttons and the pager, because they take the same room a category does.
  const tabDensity = sidebarDensity(tabs.length + (props.tabsNeedMore ? 1 : 0), props.heightPx);
  const chipDensity = sidebarDensity(chips.length + (props.chipsNeedMore ? 1 : 0), props.heightPx);

  const lead = (list: readonly BuilderSidebarEntry[]) => list.filter((e) => e.pinned === "lead");
  const run = (list: readonly BuilderSidebarEntry[]) => list.filter((e) => !e.pinned);
  const trail = (list: readonly BuilderSidebarEntry[]) => list.filter((e) => e.pinned === "trail");

  return (
    <>
      <nav
        ref={sidebarRef as Ref<HTMLElement>}
        aria-label={ariaLabel}
        className={NAV_CLASS}
        data-testid={props.tabsTestId}
      >
        {[...lead(tabs), ...run(tabs)].map((entry) => (
          <TabButton key={entry.id} entry={entry} density={tabDensity} />
        ))}
        {props.tabsNeedMore && (
          <PagerButton
            testId={props.tabsMoreTestId}
            onPress={props.onTabsMore}
            className={PLAIN_PAGER_CLASS}
          />
        )}
        {trail(tabs).map((entry) => (
          <TabButton key={entry.id} entry={entry} density={tabDensity} />
        ))}
      </nav>

      <nav aria-label={ariaLabel} className={NAV_CLASS} data-testid={props.chipsTestId}>
        {[...lead(chips), ...run(chips)].map((entry) => (
          <ChipButton key={entry.id} entry={entry} density={chipDensity} />
        ))}
        {props.chipsNeedMore && (
          <PagerButton
            testId={props.chipsMoreTestId}
            onPress={props.onChipsMore}
            className={
              props.chipsPagerStyle === "density"
                ? [
                    "rounded-xl border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800 px-2 flex items-center justify-center",
                    SIDEBAR_BUTTON_FILL,
                    chipDensity.pad,
                    chipDensity.label,
                    "font-medium",
                  ].join(" ")
                : PLAIN_PAGER_CLASS
            }
          />
        )}
        {trail(chips).map((entry) => (
          <ChipButton key={entry.id} entry={entry} density={chipDensity} />
        ))}
      </nav>
    </>
  );
}

const NAV_CLASS =
  "flex flex-col gap-2 p-2 border-e border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 w-28 shrink-0 overflow-hidden";

const PLAIN_PAGER_CLASS = `rounded-xl border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800 text-xs font-medium py-2 px-2 flex items-center justify-center ${SIDEBAR_BUTTON_FILL}`;

function TabButton(props: { entry: BuilderSidebarEntry; density: SidebarDensity }) {
  const { entry, density } = props;
  return (
    <motion.button
      data-dwell
      data-testid={entry.testId}
      data-mirror-id={entry.mirrorId}
      role="tab"
      aria-selected={entry.active}
      tabIndex={0}
      onClick={entry.onPress}
      onKeyDown={entry.onKeyDown}
      whileTap={{ scale: 0.96 }}
      className={[
        "flex flex-col items-center justify-center rounded-xl overflow-hidden",
        SIDEBAR_BUTTON_FILL,
        density.pad,
        "border-2 transition-colors",
        entry.active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-transparent hover:bg-gray-100 dark:hover:bg-gray-700/40",
      ].join(" ")}
    >
      <span className={`${density.icon} leading-none`} aria-hidden>
        {entry.icon}
      </span>
      <span className={`${density.label} font-medium truncate w-full text-center`}>
        {entry.label}
      </span>
    </motion.button>
  );
}

function ChipButton(props: { entry: BuilderSidebarEntry; density: SidebarDensity }) {
  const { GlyphComponent } = useBuilderDeps();
  const { entry, density } = props;
  const baseStyle = entry.active
    ? entry.memory
      ? "bg-purple-600 border-purple-700 text-white"
      : "bg-blue-600 border-blue-700 text-white"
    : entry.memory
      ? "bg-purple-50/60 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700 text-purple-900 dark:text-purple-100"
      : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600";
  // PRESENCE, not length: a group that advertises art but has no example to
  // show still draws the triad (which degrades to its own fallback glyph).
  // Only a group with no art at all falls back to the entry's emoji.
  const faces = entry.glyphs;
  return (
    <motion.button
      data-dwell
      data-mirror-id={entry.mirrorId}
      data-testid={entry.testId}
      onClick={entry.onPress}
      whileTap={{ scale: 0.95 }}
      className={[
        "rounded-xl border-2 px-2 flex flex-col items-center justify-center overflow-hidden",
        SIDEBAR_BUTTON_FILL,
        density.pad,
        density.label,
        baseStyle,
      ].join(" ")}
    >
      {faces ? (
        // The chip wears THREE of its members (best examples first,
        // engine-ranked) rather than one word standing in for the
        // whole category — see GlyphTriad.
        <span className={`${density.face} flex items-center justify-center`} aria-hidden>
          <GlyphTriad
            glyphs={faces}
            GlyphComponent={GlyphComponent}
            fallback={entry.glyphFallback ?? entry.id}
            ariaLabel={entry.label}
          />
        </span>
      ) : entry.icon ? (
        <span className={`${density.icon} leading-none`} aria-hidden>
          {entry.icon}
        </span>
      ) : null}
      <span className="truncate w-full text-center">{entry.label}</span>
    </motion.button>
  );
}

function PagerButton(props: { testId?: string; onPress?: () => void; className: string }) {
  return (
    <motion.button
      data-dwell
      data-testid={props.testId}
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className={props.className}
    >
      …
    </motion.button>
  );
}

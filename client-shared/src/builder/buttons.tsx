// client-shared/src/builder/buttons.tsx
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// Every LEAF the sentence builder draws: the action row's buttons, the modifier
// rail, the picker toggles and swatches, the word tiles, the paging controls.
// Extracted from SentenceConstructorBoard markup-preserving — the classNames,
// the `data-dwell` / `data-testid` / `data-mirror-id` attributes and the aria
// wiring are the AAC's, byte for byte, because the call mirror addresses these
// by attribute and a child's dwell targets are measured against them.
//
// Client-specific behavior comes from `useBuilderDeps()` (t / rtl / Glyph /
// resolveIconPath) — this file never imports a `@/` module.
//
// The `.icon-fill-area` / `.icon-fill-img` / `.icon-fill-emoji` classes are
// defined in BOTH clients' index.css; they are the contract that lets a tile's
// picture fill its cell without pushing the label out.

import { useEffect, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { getVocabularyItem, type VocabularyItem } from "@shared/glyph-registry";
import { resolveEmoji, rtlMirrorStyle } from "@shared/emoji-registry";
import { placeArt } from "@shared/glyph-place-art";
import type { BuilderWord } from "@shared/games-bridge";
import { useBuilderDeps } from "./deps";
import type { BuilderPerson } from "./types";
import { ArrowBack } from "./directional-icons";

// ─────────────────────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────────────────────

/** A vocabulary item's display label via i18n, falling back to its raw key.
 *  `t` returns the KEY when a key is missing, so the comparison — not a `||` —
 *  is what detects "untranslated". */
export function useItemLabel(item: VocabularyItem): string {
  const { t } = useBuilderDeps();
  const translated = t(item.tKey);
  return translated === item.tKey ? item.key : translated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action row
// ─────────────────────────────────────────────────────────────────────────────

export interface ToneToggleProps {
  label: string;
  active: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

export function ToneToggle(props: ToneToggleProps) {
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

export interface ActionButtonProps {
  label: string;
  icon: string;
  onPress: () => void;
  disabled?: boolean;
  /** Render a spinner in place of the icon and block presses (e.g. Play while
   *  the composed sentence is being interpreted). */
  busy?: boolean;
  primary?: boolean;
  /** Background color (overrides the default white). Border matches unless borderColor is set. */
  color?: string;
  borderColor?: string;
  /** When true, render the active highlight (thicker border + ring). Used
   *  by the Word Finder button to show that guessing mode is currently on. */
  active?: boolean;
  /** READY: the composition is already sayable. A quiet halo — an invitation,
   *  not a gate; the button is pressable with or without it. */
  ready?: boolean;
  /**
   * PRIMARY ONLY. Which path a press takes, as a colour: `true` = the device
   * renders the sentence itself (green); `false` = the AI will interpret it
   * (yellow-green, with a "?" in the corner); `null` = nothing to say yet.
   */
  parsable?: boolean | null;
  /** Flip the icon horizontally. For DIRECTIONAL chrome only — Backspace's ⌫
   *  erases toward the start of the line, which is the RIGHT in RTL, so the
   *  glyph has to turn around with the text. (⌦ U+2326 is the nominal
   *  right-erasing character, but it is missing from enough of the fonts the
   *  iPad shell falls back to that a mirrored ⌫ is the safer draw.) */
  mirrorIcon?: boolean;
  testId?: string;
  /** Encoded builder target, so a clinician on a call can POINT at this control
   *  from their mirror (`data-mirror-id`, resolved by CallIndicateBridge). */
  mirrorId?: string;
}

export function ActionButton(props: ActionButtonProps) {
  return (
    <motion.button
      data-dwell
      data-mirror-id={props.mirrorId}
      data-testid={props.testId}
      data-active={props.active ? "true" : undefined}
      data-ready={props.ready ? "true" : undefined}
      data-parsable={props.parsable == null ? undefined : String(props.parsable)}
      onClick={props.onPress}
      disabled={props.disabled || props.busy}
      whileTap={{ scale: 0.95 }}
      className={[
        "w-24 rounded-xl border-2 flex flex-col items-center justify-center gap-1 px-2 py-2",
        props.primary
          ? props.parsable === false
            ? "relative bg-lime-400 hover:bg-lime-500 border-lime-600 text-lime-950"
            : "relative bg-green-500 hover:bg-green-600 border-green-700 text-white"
          : props.color
          ? "text-gray-800"
          : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600",
        props.disabled ? "opacity-40 cursor-not-allowed" : "",
        props.active ? "ring-2 ring-violet-400 border-violet-600 dark:border-violet-300" : "",
        props.ready && !props.disabled && !props.busy
          ? "ring-4 ring-green-300 dark:ring-green-400/60"
          : "",
      ].join(" ")}
      style={props.color ? { backgroundColor: props.active && props.color === "#EDE9FE" ? "#C4B5FD" : props.color, borderColor: props.borderColor ?? props.color } : undefined}
    >
      <span
        className="text-2xl"
        aria-hidden
        style={props.mirrorIcon && !props.busy ? { transform: "scaleX(-1)" } : undefined}
      >
        {props.busy
          ? <span className="inline-block w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : props.icon}
      </span>
      <span className="text-xs font-medium">{props.label}</span>
      {props.primary && props.parsable === false && !props.busy && (
        <span
          aria-hidden
          data-testid="construction-play-unparsed"
          className="absolute top-1 end-1 w-5 h-5 rounded-full bg-white/90 text-lime-900 text-xs font-bold flex items-center justify-center"
        >
          ?
        </span>
      )}
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modifier rail
// ─────────────────────────────────────────────────────────────────────────────

export interface ModifierButtonProps {
  item: VocabularyItem;
  onPress: () => void;
  active?: boolean;
}

export function ModifierButton(props: ModifierButtonProps) {
  const { rtl, resolveIconPath } = useBuilderDeps();
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
        "w-16 h-16 rounded-xl border-2 flex flex-col items-center justify-center overflow-hidden",
        active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      style={{ padding: 6 }}
      aria-label={label}
    >
      <div className="icon-fill-area">
        {url ? (
          <img src={url} alt="" className="icon-fill-img" style={rtlMirrorStyle(rtl, { key: item.key, emoji: item.emoji ?? resolveEmoji(item.key), item })} />
        ) : (
          <span className="icon-fill-emoji" aria-hidden style={rtlMirrorStyle(rtl, { key: item.key, emoji: item.emoji ?? "•", item })}>
            {item.emoji ?? "•"}
          </span>
        )}
      </div>
    </motion.button>
  );
}

/**
 * Engine modifier-rail button — ModifierButton's 64px footprint, fed by a
 * BuilderWord instead of a registry item so the engine's glyph renders.
 */
export interface EngineModifierButtonProps {
  word: BuilderWord;
  active: boolean;
  onPress: () => void;
}

export function EngineModifierButton(props: EngineModifierButtonProps) {
  const { rtl, resolveIconPath, GlyphComponent } = useBuilderDeps();
  const { word, active } = props;
  const item = getVocabularyItem(word.key);
  const url = item?.imagePath ? resolveIconPath(item.imagePath) : null;
  const emoji = item?.emoji ?? resolveEmoji(word.key);
  const label = word.label || word.key;
  return (
    <motion.button
      data-dwell
      data-testid={`engine-modifier-${word.key}`}
      onClick={props.onPress}
      aria-pressed={active}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-16 h-16 rounded-xl border-2 flex flex-col items-center justify-center overflow-hidden",
        active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      style={{ padding: 6 }}
      aria-label={label}
      title={label}
    >
      <div className="icon-fill-area">
        {word.glyph || placeArt(word.key) ? (
          <GlyphComponent glyph={word.glyph ?? word.key} noBackground ariaLabel={label} />
        ) : url ? (
          <img src={url} alt="" className="icon-fill-img" style={rtlMirrorStyle(rtl, { key: word.key, emoji, item: item ?? undefined })} />
        ) : (
          <span className="icon-fill-emoji" aria-hidden style={rtlMirrorStyle(rtl, { key: word.key, emoji: emoji ?? "•", item: item ?? undefined })}>
            {emoji ?? "•"}
          </span>
        )}
      </div>
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Word tiles
// ─────────────────────────────────────────────────────────────────────────────

export interface GridButtonProps {
  item: VocabularyItem;
  onPress: () => void;
  mirrorId?: string;
}

export function GridButton(props: GridButtonProps) {
  const { rtl, resolveIconPath, GlyphComponent } = useBuilderDeps();
  const { item } = props;
  const url = item.imagePath ? resolveIconPath(item.imagePath) : null;
  const label = useItemLabel(item);
  return (
    <motion.button
      data-dwell
      data-mirror-id={props.mirrorId}
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className="rounded-xl border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 flex flex-col items-center justify-center min-h-0 overflow-hidden"
      style={{ padding: 5 }}
    >
      <div className="icon-fill-area">
        {item.expandsTo ? (
          // Alias (today/tomorrow/yesterday) — preview the composed glyph it
          // inserts (day + arrow) so the button matches the result.
          <GlyphComponent glyph={item.expandsTo} noBackground ariaLabel={label} />
        ) : placeArt(item.key) ? (
          // A ROOM or BUILDING is one symbol drawn from two PNGs (shell +
          // fixture) — it has to go through the compositor, or the palette
          // shows a bare 🛌 for the button that draws `room(bed)`.
          <GlyphComponent glyph={item.key} noBackground ariaLabel={label} />
        ) : url ? (
          <img src={url} alt="" className="icon-fill-img" style={rtlMirrorStyle(rtl, { key: item.key, emoji: item.emoji ?? resolveEmoji(item.key), item })} />
        ) : (
          <span className="icon-fill-emoji" aria-hidden style={rtlMirrorStyle(rtl, { key: item.key, emoji: item.emoji ?? "❓", item })}>
            {item.emoji ?? "❓"}
          </span>
        )}
      </div>
      <span className="text-xs font-medium truncate w-full text-center shrink-0" style={{ marginTop: 2 }}>
        {label}
      </span>
    </motion.button>
  );
}

/**
 * Main-grid tile for an engine-surfaced word (stage-3 builder merge).
 * Renders the engine's composed glyph when it carries one, else the
 * registry's art/emoji for the same key, else an emoji resolved from the
 * key. Present persons/creatures get the same green "here now" treatment
 * as the camera-seen contacts in the person list.
 */
export interface EngineWordButtonProps {
  word: BuilderWord;
  onPress: () => void;
  /** Encoded call-mirror address (`data-mirror-id`). The HOST supplies it —
   *  omitted, no attribute is rendered, which is what a host with no call
   *  mirror (the clinician dialog) wants. */
  mirrorId?: string;
}

export function EngineWordButton(props: EngineWordButtonProps) {
  const { t, rtl, resolveIconPath, GlyphComponent } = useBuilderDeps();
  const { word } = props;
  const item = getVocabularyItem(word.key);
  const url = item?.imagePath ? resolveIconPath(item.imagePath) : null;
  const emoji = item?.emoji ?? resolveEmoji(word.key);
  let label = word.label;
  if (!label && item) {
    const translated = t(item.tKey);
    label = translated === item.tKey ? word.key : translated;
  }
  if (!label) label = word.key;
  return (
    <motion.button
      data-dwell
      data-mirror-id={props.mirrorId}
      data-testid={`engine-word-${word.key}`}
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className={[
        "rounded-xl border-2 flex flex-col items-center justify-center min-h-0 overflow-hidden",
        word.present
          ? "border-green-500 bg-green-50 dark:bg-green-900/30"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      style={{ padding: 5 }}
      aria-label={label}
      title={label}
    >
      <div className="icon-fill-area">
        {word.glyph || placeArt(word.key) ? (
          // No engine glyph for a place word still draws its shell — the
          // compositor resolves the composition from the key itself.
          <GlyphComponent glyph={word.glyph ?? word.key} noBackground ariaLabel={label} />
        ) : url ? (
          <img src={url} alt="" className="icon-fill-img" style={rtlMirrorStyle(rtl, { key: word.key, emoji })} />
        ) : (
          <span className="icon-fill-emoji" aria-hidden style={rtlMirrorStyle(rtl, { key: word.key, emoji: emoji ?? "❓" })}>
            {emoji ?? "❓"}
          </span>
        )}
      </div>
      <span className="text-xs font-medium truncate w-full text-center shrink-0" style={{ marginTop: 2 }}>
        {label}
      </span>
    </motion.button>
  );
}

/**
 * Main-grid tile for content that is NOT registry vocabulary and carries no
 * engine glyph — a host-supplied picture URL (the clinician's uploaded custom
 * symbols) or a bare emoji (its recent-emoji strip). Same markup and footprint
 * as `GridButton`, deliberately: these tiles sit in the SAME 9×2 grid as the
 * word tiles, so a second hand-rolled copy of that markup in a host is exactly
 * how the two would drift.
 *
 * `src` wins over `emoji` when both are given.
 */
export interface ImageTileProps {
  /** Picture URL for the tile's face (already resolved by the host). */
  src?: string;
  /** Fallback face when there is no picture — drawn with the word mirror rule. */
  emoji?: string;
  label: string;
  onPress: () => void;
  testId?: string;
}

export function ImageTile(props: ImageTileProps) {
  const { rtl } = useBuilderDeps();
  const { src, emoji, label } = props;
  return (
    <motion.button
      data-dwell
      data-testid={props.testId}
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className="rounded-xl border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 flex flex-col items-center justify-center min-h-0 overflow-hidden"
      style={{ padding: 5 }}
      aria-label={label}
      title={label}
    >
      <div className="icon-fill-area">
        {src ? (
          <img src={src} alt="" className="icon-fill-img" loading="lazy" />
        ) : (
          <span
            className="icon-fill-emoji"
            aria-hidden
            style={rtlMirrorStyle(rtl, { key: emoji ?? "", emoji: emoji ?? "❓" })}
          >
            {emoji ?? "❓"}
          </span>
        )}
      </div>
      <span className="text-xs font-medium truncate w-full text-center shrink-0" style={{ marginTop: 2 }}>
        {label}
      </span>
    </motion.button>
  );
}

/**
 * Person tile for the "who → photos" person list. Shows the contact's face
 * (live camera capture or stored photo) or a 👤 silhouette when no image is
 * available, with their name below and a subtle ring when they've been seen
 * on camera this session. Pressing it inserts a `face:<id>` slot.
 */
export interface PersonButtonProps {
  person: BuilderPerson;
  faceUrl: string | null;
  present: boolean;
  onPress: () => void;
  /** See EngineWordButton.mirrorId. */
  mirrorId?: string;
}

export function PersonButton(props: PersonButtonProps) {
  const { person, faceUrl, present } = props;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [faceUrl]);
  const showImage = !!faceUrl && !failed;
  return (
    <motion.button
      data-dwell
      data-mirror-id={props.mirrorId}
      data-testid={`person-${person.id}`}
      onClick={props.onPress}
      whileTap={{ scale: 0.95 }}
      className={[
        "rounded-xl border-2 flex flex-col items-center justify-center gap-1 p-2 min-h-0",
        present
          ? "border-green-500 bg-green-50 dark:bg-green-900/30"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      aria-label={person.name}
      title={person.name}
    >
      <div className="icon-fill-area">
        {showImage ? (
          <img
            src={faceUrl!}
            alt=""
            className="icon-fill-img rounded-full"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="icon-fill-emoji" aria-hidden>👤</span>
        )}
      </div>
      <span className="text-xs font-medium truncate w-full text-center shrink-0" style={{ marginTop: 2 }}>
        {person.name}
      </span>
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Picker toggles + swatches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry button for the color picker — same footprint as ModifierButton so
 * it slots into the modifier zone without disrupting the row's geometry.
 * Shows a colored paint-drop emoji when no color is active; switches to
 * the currently-active color swatch when one is.
 */
export interface ColorPickerButtonProps {
  active: boolean;
  activeColorValue?: string;
  onPress: () => void;
}

export function ColorPickerButton(props: ColorPickerButtonProps) {
  const { t } = useBuilderDeps();
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
      aria-label={t("aac.glyph.color")}
      title={t("aac.glyph.color")}
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
export interface ColorSwatchButtonProps {
  item: VocabularyItem;
  active: boolean;
  onPress: () => void;
}

export function ColorSwatchButton(props: ColorSwatchButtonProps) {
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

/** Toggle button that opens the emotion picker — mirrors ColorPickerButton. */
export interface EmotionPickerButtonProps {
  active: boolean;
  activeEmoji?: string;
  onPress: () => void;
}

export function EmotionPickerButton(props: EmotionPickerButtonProps) {
  const { t } = useBuilderDeps();
  return (
    <motion.button
      data-dwell
      data-testid="emotion-picker-toggle"
      onClick={props.onPress}
      aria-pressed={props.active}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-16 h-16 rounded-xl border-2 flex items-center justify-center",
        props.active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      aria-label={t("builder.emotion")}
      title={t("builder.emotion")}
    >
      <span className="text-2xl" aria-hidden>{props.activeEmoji ?? "🙂"}</span>
    </motion.button>
  );
}

/** One emotion option in the emotion picker row — the feeling emoji, ringed when active. */
export interface EmotionSwatchButtonProps {
  item: VocabularyItem;
  active: boolean;
  onPress: () => void;
}

export function EmotionSwatchButton(props: EmotionSwatchButtonProps) {
  const label = useItemLabel(props.item);
  return (
    <motion.button
      data-dwell
      data-testid={`emotion-swatch-${props.item.key}`}
      onClick={props.onPress}
      aria-pressed={props.active}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-12 h-12 rounded-full border-2 flex items-center justify-center bg-white dark:bg-gray-800",
        props.active
          ? "border-blue-600 ring-2 ring-blue-300"
          : "border-gray-300 dark:border-gray-600",
      ].join(" ")}
      aria-label={label}
      title={label}
    >
      <span className="text-2xl" aria-hidden>{props.item.emoji ?? "🙂"}</span>
    </motion.button>
  );
}

/**
 * Generic picker-opener button (mirrors ColorPickerButton/EmotionPickerButton)
 * for the amount / quality / join pickers. Shows a representative emoji.
 */
export interface PickerToggleButtonProps {
  active: boolean;
  emoji: string;
  label: string;
  testId: string;
  onPress: () => void;
}

export function PickerToggleButton(props: PickerToggleButtonProps) {
  return (
    <motion.button
      data-dwell
      data-testid={props.testId}
      onClick={props.onPress}
      aria-pressed={props.active}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-16 h-16 rounded-xl border-2 flex items-center justify-center",
        props.active
          ? "border-blue-600 bg-blue-50 dark:bg-blue-900/40"
          : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      aria-label={props.label}
      title={props.label}
    >
      <span className="text-2xl" aria-hidden>{props.emoji}</span>
    </motion.button>
  );
}

/**
 * One opposite-pair toggle in the quality picker. Tapping cycles the active
 * slot none → positive → negative → none; the button shows the current pole's
 * emoji (green = positive, red = negative, dimmed = off).
 */
export interface QualityToggleButtonProps {
  pair: { pos: VocabularyItem; neg: VocabularyItem };
  activeKeys: ReadonlySet<string>;
  onPress: () => void;
}

export function QualityToggleButton(props: QualityToggleButtonProps) {
  const { pair, activeKeys } = props;
  const posLabel = useItemLabel(pair.pos);
  const negLabel = useItemLabel(pair.neg);
  const hasPos = activeKeys.has(pair.pos.key);
  const hasNeg = activeKeys.has(pair.neg.key);
  const state = hasPos ? "pos" : hasNeg ? "neg" : "off";
  const emoji = hasNeg ? (pair.neg.emoji ?? "👎") : (pair.pos.emoji ?? "👍");
  return (
    <motion.button
      data-dwell
      data-testid={`quality-toggle-${pair.pos.key}`}
      onClick={props.onPress}
      aria-pressed={hasPos || hasNeg}
      whileTap={{ scale: 0.94 }}
      className={[
        "w-16 h-16 rounded-xl border-2 flex items-center justify-center",
        state === "pos"
          ? "border-green-600 bg-green-50 dark:bg-green-900/40"
          : state === "neg"
            ? "border-red-600 bg-red-50 dark:bg-red-900/40"
            : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800",
      ].join(" ")}
      aria-label={`${posLabel} / ${negLabel}`}
      title={`${posLabel} / ${negLabel}`}
    >
      <span className="text-2xl" aria-hidden style={state === "off" ? { opacity: 0.5 } : undefined}>{emoji}</span>
    </motion.button>
  );
}

/** Quick luminance check — true for colors lighter than ~50% perceived brightness. */
export function isLightColor(hex: string): boolean {
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

// ─────────────────────────────────────────────────────────────────────────────
// Paging controls
// ─────────────────────────────────────────────────────────────────────────────

export interface PagingButtonProps {
  onPress: () => void;
  testId?: string;
  disabled?: boolean;
  /** See EngineWordButton.mirrorId. */
  mirrorId?: string;
}

/**
 * PAGE BACK — More's twin, and the reason the grid reserves two cells rather
 * than one.
 */
export function PageBackButton(props: PagingButtonProps) {
  const { t, rtl } = useBuilderDeps();
  return (
    <motion.button
      data-dwell
      data-mirror-id={props.mirrorId}
      data-testid={props.testId}
      onClick={props.onPress}
      disabled={props.disabled}
      whileTap={{ scale: 0.95 }}
      className={[
        "rounded-xl border-2 border-dashed border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800 flex flex-col items-center justify-center gap-1 p-2 min-h-0 min-w-[64px]",
        props.disabled ? "opacity-40 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {/* LOGICAL, never left/right: `ArrowBack` points at the start edge of the
          reading direction, so a Hebrew board's Back points the Hebrew way. */}
      <ArrowBack className="w-6 h-6" rtl={rtl} />
      <span className="text-xs font-medium">{t("common.back")}</span>
    </motion.button>
  );
}

export function MoreButton(props: PagingButtonProps) {
  const { t } = useBuilderDeps();
  return (
    <motion.button
      data-dwell
      data-mirror-id={props.mirrorId}
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

/** Keyboard activation for a sidebar tab (Enter / Space), exported so a host
 *  that builds its own tab entries can reuse the exact same handler. */
export function tabKeyActivate(e: KeyboardEvent, activate: () => void): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activate();
  }
}

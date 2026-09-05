// client-shared/src/builder/ModifierBand.tsx
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// THE MODIFIER BAND and the five picker rows beneath it.
//
// The band combines its sub-groups in a single horizontal row so they don't
// burn several vertical rows on small screens:
//   left:   the game ENGINE's own modifier rail for the active head (🎮)
//   middle: the host's optional AI-suggestion strip (`aiStrip`) — AAC-only
//   right:  the registry-driven modifiers + More, then the five picker toggles
// A divider only renders when the groups on both sides of it have content.
//
// The five picker ROWS (colour / emotion / amount / quality / join) are
// siblings of the band, not children, so this component returns a fragment:
// they sit in the host's own column flow exactly where they always did.
//
// The band renders NOTHING when every group is empty — a host does not have to
// repeat the emptiness test it would otherwise have to keep in sync.
//
// WHAT THE HOST OWNS: the option lists, which picker is open, which keys are
// active on the slot, and every handler. This component decides only layout and
// which pieces are visible.

import type { ReactNode } from "react";
import { getVocabularyItem, type VocabularyItem } from "@shared/glyph-registry";
import type { BuilderWord } from "@shared/games-bridge";
import { useBuilderDeps } from "./deps";
import {
  ColorPickerButton,
  ColorSwatchButton,
  EmotionPickerButton,
  EmotionSwatchButton,
  EngineModifierButton,
  ModifierButton,
  MoreButton,
  PickerToggleButton,
  QualityToggleButton,
} from "./buttons";

export interface QualityPair {
  pos: VocabularyItem;
  neg: VocabularyItem;
}

export interface ModifierBandProps {
  /** The ENGINE's modifier rail for the active head (already filtered/capped
   *  by the host — this only draws it). */
  engineModifiers: readonly BuilderWord[];
  onEngineModifierPress: (word: BuilderWord) => void;
  /** Modifier keys currently applied to the active slot (for the pressed state). */
  activeModifierKeys: ReadonlySet<string>;
  /**
   * A host-supplied strip drawn between the engine rail and the registry rail.
   * The AAC passes its ✨ AI-suggestion strip here; the clinician passes
   * nothing. Presence (not emptiness) drives the dividers around it.
   */
  aiStrip?: ReactNode;

  /** Registry modifiers for the active slot's part of speech, one page's worth. */
  modifiers: readonly VocabularyItem[];
  onModifierPress: (item: VocabularyItem) => void;
  /** True when there are more modifiers than one page — draws the More button. */
  modifiersHaveMore: boolean;
  onModifierMore: () => void;
  /** Encoded call-mirror address for the modifier rail's More button. The AAC
   *  passes the grid's page-more target (the mirror has no rail-specific one). */
  modifierMoreMirrorId?: string;

  colorOptions: readonly VocabularyItem[];
  colorPickerOpen: boolean;
  activeColorKey: string | null;
  onColorToggle: () => void;
  onColorPick: (item: VocabularyItem) => void;

  emotionOptions: readonly VocabularyItem[];
  emotionPickerOpen: boolean;
  activeEmotionKey: string | null;
  onEmotionToggle: () => void;
  onEmotionPick: (item: VocabularyItem) => void;

  amountOptions: readonly VocabularyItem[];
  amountPickerOpen: boolean;
  activeAmountKey: string | null;
  onAmountToggle: () => void;
  onAmountPick: (item: VocabularyItem) => void;

  qualityPairs: readonly QualityPair[];
  qualityPickerOpen: boolean;
  onQualityToggle: () => void;
  onQualityPress: (pair: QualityPair) => void;

  /** Armable forward-binding joins. The host passes an EMPTY list when a join
   *  cannot be armed (no slot yet, or the sentence is at MAX_SLOTS). */
  joinOptions: readonly VocabularyItem[];
  joinPickerOpen: boolean;
  pendingJoin: string | null;
  onJoinToggle: () => void;
  onJoinPick: (key: string) => void;
}

/** The picker rows all share one shell. */
const PICKER_ROW_CLASS =
  "flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 bg-gray-50 dark:bg-gray-800/60";

export function ModifierBand(props: ModifierBandProps) {
  const { t } = useBuilderDeps();
  const {
    engineModifiers,
    aiStrip,
    modifiers,
    colorOptions,
    emotionOptions,
    amountOptions,
    qualityPairs,
    joinOptions,
  } = props;

  const hasRegistryGroup =
    modifiers.length > 0 ||
    colorOptions.length > 0 ||
    emotionOptions.length > 0 ||
    amountOptions.length > 0 ||
    qualityPairs.length > 0 ||
    joinOptions.length > 0;
  const bandVisible = engineModifiers.length > 0 || !!aiStrip || hasRegistryGroup;

  return (
    <>
      {bandVisible && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          {/* Engine modifier rail — the game engine's own modifiers for the
              active head, composed with "." like every other modifier. */}
          {engineModifiers.length > 0 && (
            <div className="flex items-center gap-2 shrink-0" data-testid="engine-modifier-strip">
              <span className="self-center text-xl select-none" aria-hidden>
                🎮
              </span>
              {engineModifiers.map((m) => (
                <EngineModifierButton
                  key={m.key}
                  word={m}
                  active={props.activeModifierKeys.has(m.key)}
                  onPress={() => props.onEngineModifierPress(m)}
                />
              ))}
            </div>
          )}
          {engineModifiers.length > 0 && (!!aiStrip || hasRegistryGroup) && (
            <div className="self-stretch w-px bg-gray-300 dark:bg-gray-600 shrink-0" aria-hidden />
          )}
          {aiStrip}
          {!!aiStrip &&
            (modifiers.length > 0 || colorOptions.length > 0 || emotionOptions.length > 0) && (
              <div className="self-stretch w-px bg-gray-300 dark:bg-gray-600 shrink-0" aria-hidden />
            )}
          {hasRegistryGroup && (
            <div className="flex items-center gap-2 shrink-0">
              {modifiers.map((m) => (
                <ModifierButton
                  key={m.key}
                  item={m}
                  active={props.activeModifierKeys.has(m.key)}
                  onPress={() => props.onModifierPress(m)}
                />
              ))}
              {props.modifiersHaveMore && (
                <MoreButton
                  onPress={props.onModifierMore}
                  testId="modifier-more"
                  mirrorId={props.modifierMoreMirrorId}
                />
              )}
              {colorOptions.length > 0 && (
                <ColorPickerButton
                  active={props.colorPickerOpen}
                  activeColorValue={
                    props.activeColorKey
                      ? getVocabularyItem(props.activeColorKey)?.modifier?.colorValue
                      : undefined
                  }
                  onPress={props.onColorToggle}
                />
              )}
              {emotionOptions.length > 0 && (
                <EmotionPickerButton
                  active={props.emotionPickerOpen}
                  activeEmoji={
                    props.activeEmotionKey
                      ? getVocabularyItem(props.activeEmotionKey)?.emoji
                      : undefined
                  }
                  onPress={props.onEmotionToggle}
                />
              )}
              {amountOptions.length > 0 && (
                <PickerToggleButton
                  active={props.amountPickerOpen}
                  emoji={
                    props.activeAmountKey
                      ? getVocabularyItem(props.activeAmountKey)?.emoji ?? "🌗"
                      : "🌗"
                  }
                  label={t("builder.amount")}
                  testId="amount-picker-toggle"
                  onPress={props.onAmountToggle}
                />
              )}
              {qualityPairs.length > 0 && (
                <PickerToggleButton
                  active={props.qualityPickerOpen}
                  emoji="👍"
                  label={t("builder.quality")}
                  testId="quality-picker-toggle"
                  onPress={props.onQualityToggle}
                />
              )}
              {joinOptions.length > 0 && (
                <PickerToggleButton
                  active={props.joinPickerOpen}
                  emoji={
                    props.pendingJoin ? getVocabularyItem(props.pendingJoin)?.emoji ?? "🔗" : "🔗"
                  }
                  label={t("builder.join")}
                  testId="join-picker-toggle"
                  onPress={props.onJoinToggle}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Color picker row — shown only when the picker button is toggled
          on. Renders the swatches inline so we don't have to manage
          popover positioning; tapping the picker button again or a
          swatch closes the row. */}
      {props.colorPickerOpen && colorOptions.length > 0 && (
        <div className={PICKER_ROW_CLASS} data-testid="color-picker">
          {colorOptions.map((c) => (
            <ColorSwatchButton
              key={c.key}
              item={c}
              active={props.activeColorKey === c.key}
              onPress={() => props.onColorPick(c)}
            />
          ))}
        </div>
      )}

      {/* Emotion picker row — mirrors the color picker; shows face options to
          attach as a badge on the active slot. */}
      {props.emotionPickerOpen && emotionOptions.length > 0 && (
        <div className={PICKER_ROW_CLASS} data-testid="emotion-picker">
          {emotionOptions.map((e) => (
            <EmotionSwatchButton
              key={e.key}
              item={e}
              active={props.activeEmotionKey === e.key}
              onPress={() => props.onEmotionPick(e)}
            />
          ))}
        </div>
      )}

      {/* Amount (quantifier) picker — mutually-exclusive gauge scale. */}
      {props.amountPickerOpen && amountOptions.length > 0 && (
        <div className={PICKER_ROW_CLASS} data-testid="amount-picker">
          {amountOptions.map((a) => (
            <ModifierButton
              key={a.key}
              item={a}
              active={props.activeAmountKey === a.key}
              onPress={() => props.onAmountPick(a)}
            />
          ))}
        </div>
      )}

      {/* Quality pole-toggle picker — each pair is one button that cycles
          none → positive → negative → none on the active slot. */}
      {props.qualityPickerOpen && qualityPairs.length > 0 && (
        <div className={PICKER_ROW_CLASS} data-testid="quality-picker">
          {qualityPairs.map((pair) => (
            <QualityToggleButton
              key={pair.pos.key}
              pair={pair}
              activeKeys={props.activeModifierKeys}
              onPress={() => props.onQualityPress(pair)}
            />
          ))}
        </div>
      )}

      {/* Join picker — arm a forward-binding connector / spatial relation for
          the NEXT word. The compositor draws it in the seam once placed. */}
      {props.joinPickerOpen && joinOptions.length > 0 && (
        <div className={PICKER_ROW_CLASS} data-testid="join-picker">
          {joinOptions.map((j) => (
            <ModifierButton
              key={j.key}
              item={j}
              active={props.pendingJoin === j.key}
              onPress={() => props.onJoinPick(j.key)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// shared/glyph-compositor.tsx
//
// React SVG renderer for parsed glyphs. Imported by both clients
// (client-aac and clinician). Server code must NOT import this file —
// pure parsing/layout logic lives in glyph-compositor.ts.
//
// The compositor renders to a viewBox and scales to fill its container.
// Each slot is rendered in 100×100 unit space; modifiers stack as overlays
// per the transform rules defined in the registry.

import * as React from "react";
import {
  getVocabularyItem,
  type VocabularyItem,
  type ModifierTransform,
} from "./glyph-registry.js";
import {
  parseGlyph,
  computeLayout,
  dominantToneFamily,
  TONE_COLORS,
  SLOT_UNIT,
  type ParsedGlyph,
  type ParsedSlot,
  type SlotLayout,
  type ToneTag,
  type ImageResolver,
} from "./glyph-compositor.js";

// ImageResolver is re-exported from glyph-compositor.ts so server-safe
// callers (AI prompt builders, tests) can reference it without dragging in
// React. It's the function clients pass via the `resolveImage` prop.
export type { ImageResolver };

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export interface GlyphCompositorProps {
  /** Glyph string or pre-parsed structure. */
  glyph: string | ParsedGlyph;
  /** Optional explicit pixel width; otherwise fills container. */
  width?: number | string;
  height?: number | string;
  /** Right-to-left rendering (Hebrew/Arabic). Reverses slot order + flips images. */
  rtl?: boolean;
  /** Image URL resolver. Receives registry item + raw key. */
  resolveImage?: ImageResolver;
  /** Index of a slot currently selected (for construction-board outline). */
  activeSlot?: number | null;
  /** Suppress the colored tone background (for use inside an outer button shell). */
  noBackground?: boolean;
  /** Optional accessible label override; otherwise built from slot keys. */
  ariaLabel?: string;
  /** Click handler that fires with the slot index that was tapped (or null for outside-any-slot). */
  onSlotPress?: (slotIndex: number | null) => void;
}

export function GlyphCompositor(props: GlyphCompositorProps): React.ReactElement {
  const {
    glyph,
    width,
    height,
    rtl = false,
    resolveImage,
    activeSlot = null,
    noBackground = false,
    ariaLabel,
    onSlotPress,
  } = props;

  const parsed: ParsedGlyph = typeof glyph === "string" ? parseGlyph(glyph) : glyph;
  const layout = computeLayout(parsed, rtl);
  const tone = dominantToneFamily(parsed);
  const bg = TONE_COLORS[tone];

  const fallbackLabel =
    parsed.slots.map((s) => s.key).filter(Boolean).join(" ") || "empty glyph";

  // Wrap the SVG in a positioned container so it can't claim intrinsic
  // viewBox-derived dimensions and push the parent taller. With absolute
  // positioning + inset:0, the SVG conforms to its wrapper's box exactly —
  // the wrapper's size is determined entirely by its parent's layout.
  const wrapperStyle: React.CSSProperties = {
    position: "relative",
    width: width ?? "100%",
    height: height ?? "100%",
    minHeight: 0,
    minWidth: 0,
  };
  const svgStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    display: "block",
  };

  return (
    <div style={wrapperStyle}>
    <svg
      viewBox={`0 0 ${layout.viewBoxWidth} ${layout.viewBoxHeight}`}
      preserveAspectRatio="xMidYMid meet"
      style={svgStyle}
      role="img"
      aria-label={ariaLabel ?? fallbackLabel}
    >
      <defs>
        <filter id="glyph-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Background tint */}
      {!noBackground && (
        <rect
          x={0}
          y={0}
          width={layout.viewBoxWidth}
          height={layout.viewBoxHeight}
          fill={bg}
          rx={8}
          ry={8}
        />
      )}

      {/* Each slot */}
      {layout.slots.map((slotLayout) => {
        const slot = parsed.slots[slotLayout.index];
        return (
          <SlotGroup
            key={slotLayout.index}
            slot={slot}
            layout={slotLayout}
            rtl={rtl}
            resolveImage={resolveImage}
            isActive={activeSlot === slotLayout.index}
            onPress={onSlotPress ? () => onSlotPress(slotLayout.index) : undefined}
          />
        );
      })}

      {/* Tone corner badge */}
      {parsed.toneTags.length > 0 && (
        <ToneCornerBadge
          tags={parsed.toneTags}
          x={layout.cornerBadge.x}
          y={layout.cornerBadge.y}
          size={layout.cornerBadge.size}
        />
      )}
    </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot rendering
// ─────────────────────────────────────────────────────────────────────────────

interface SlotGroupProps {
  slot: ParsedSlot;
  layout: SlotLayout;
  rtl: boolean;
  resolveImage?: ImageResolver;
  isActive: boolean;
  onPress?: () => void;
}

function SlotGroup(props: SlotGroupProps): React.ReactElement {
  const { slot, layout, rtl, resolveImage, isActive, onPress } = props;
  const item = slot ? getVocabularyItem(slot.key) : undefined;

  // Collect modifier transforms applied to this slot
  const transforms = collectModifierTransforms(slot);

  const hasGlow = transforms.has("glow");
  const isShrunken = transforms.has("shrink");
  const mainScale = isShrunken ? 0.5 : 1.0;
  const mainSize = SLOT_UNIT * 0.7 * mainScale;
  const mainX = layout.x + (SLOT_UNIT - mainSize) / 2;
  const mainY = layout.y + (SLOT_UNIT - mainSize) / 2;

  const url = slot ? resolveImage?.({ item, key: slot.key }) ?? null : null;

  return (
    <g
      onClick={onPress}
      style={onPress ? { cursor: "pointer" } : undefined}
    >
      {/* Slot hit target (transparent rect for click). */}
      <rect
        x={layout.x}
        y={layout.y}
        width={layout.width}
        height={layout.height}
        fill="transparent"
      />

      {/* Halos render under everything */}
      {transforms.has("halo_warm") && (
        <circle
          cx={layout.x + SLOT_UNIT / 2}
          cy={layout.y + SLOT_UNIT / 2}
          r={SLOT_UNIT * 0.46}
          fill="none"
          stroke="#F97316"
          strokeWidth={4}
        />
      )}
      {transforms.has("halo_cool") && (
        <circle
          cx={layout.x + SLOT_UNIT / 2}
          cy={layout.y + SLOT_UNIT / 2}
          r={SLOT_UNIT * 0.46}
          fill="none"
          stroke="#3B82F6"
          strokeWidth={4}
        />
      )}

      {/* Main symbol — image, then emoji fallback, then placeholder */}
      {slot && url && (
        <image
          href={url}
          x={mainX}
          y={mainY}
          width={mainSize}
          height={mainSize}
          filter={hasGlow ? "url(#glyph-glow)" : undefined}
          transform={
            rtl && item && !isNonReversible(item)
              ? `translate(${mainX + mainSize}, ${mainY}) scale(-1, 1) translate(${-mainX}, ${-mainY})`
              : undefined
          }
        />
      )}
      {slot && !url && (item?.emoji || !item) && (
        <text
          x={layout.x + SLOT_UNIT / 2}
          y={layout.y + SLOT_UNIT / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={SLOT_UNIT * 0.6 * mainScale}
          filter={hasGlow ? "url(#glyph-glow)" : undefined}
        >
          {item?.emoji ?? "❓"}
        </text>
      )}

      {/* Active-slot outline (for construction board) */}
      {isActive && (
        <rect
          x={layout.x + 3}
          y={layout.y + 3}
          width={layout.width - 6}
          height={layout.height - 6}
          fill="none"
          stroke="#2563EB"
          strokeWidth={3}
          rx={6}
          ry={6}
        />
      )}

      {/* Badge-type modifiers (and `hands`, which is treated as a badge for v1) */}
      <BadgeStack slot={slot} layout={layout} resolveImage={resolveImage} />

      {/* Dot indicators at bottom for count modifiers */}
      {transforms.has("dots") && (
        <DotIndicator slot={slot} layout={layout} />
      )}

      {/* Red X overlay renders on top */}
      {transforms.has("red_x") && (
        <g stroke="#DC2626" strokeWidth={6} strokeLinecap="round">
          <line
            x1={layout.x + 15}
            y1={layout.y + 15}
            x2={layout.x + SLOT_UNIT - 15}
            y2={layout.y + SLOT_UNIT - 15}
          />
          <line
            x1={layout.x + SLOT_UNIT - 15}
            y1={layout.y + 15}
            x2={layout.x + 15}
            y2={layout.y + SLOT_UNIT - 15}
          />
        </g>
      )}
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modifier helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Collect the set of transforms applied to a slot from its modifier list. */
function collectModifierTransforms(slot: ParsedSlot | undefined): Set<ModifierTransform> {
  const out = new Set<ModifierTransform>();
  if (!slot) return out;
  for (const modKey of slot.modifiers) {
    const mod = getVocabularyItem(modKey);
    if (mod?.modifier) out.add(mod.modifier.transform);
  }
  return out;
}

interface BadgeStackProps {
  slot: ParsedSlot | undefined;
  layout: SlotLayout;
  resolveImage?: ImageResolver;
}

const BADGE_TRANSFORMS: ReadonlyArray<ModifierTransform> = ["badge", "hands"];

function BadgeStack(props: BadgeStackProps): React.ReactElement | null {
  const { slot, layout, resolveImage } = props;
  if (!slot) return null;
  const badges = slot.modifiers
    .map((k) => getVocabularyItem(k))
    .filter((v): v is VocabularyItem =>
      !!v?.modifier && BADGE_TRANSFORMS.includes(v.modifier.transform)
    );
  if (badges.length === 0) return null;

  const badgeSize = SLOT_UNIT * 0.28;
  return (
    <g>
      {badges.map((b, i) => {
        const bx = layout.x + 4 + i * (badgeSize + 2);
        const by = layout.y + 4;
        const url = resolveImage?.({ item: b, key: b.key }) ?? null;
        return url ? (
          <image
            key={b.key}
            href={url}
            x={bx}
            y={by}
            width={badgeSize}
            height={badgeSize}
          />
        ) : (
          <text
            key={b.key}
            x={bx + badgeSize / 2}
            y={by + badgeSize / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={badgeSize * 0.9}
          >
            {b.emoji ?? "•"}
          </text>
        );
      })}
    </g>
  );
}

interface DotIndicatorProps {
  slot: ParsedSlot | undefined;
  layout: SlotLayout;
}

function DotIndicator(props: DotIndicatorProps): React.ReactElement | null {
  const { slot, layout } = props;
  if (!slot) return null;
  // Determine dot count from the count-modifier present
  let dotCount = 0;
  for (const mk of slot.modifiers) {
    if (mk === "one") dotCount = 1;
    else if (mk === "two") dotCount = 2;
    else if (mk === "many") dotCount = 4;
  }
  if (dotCount === 0) return null;

  const dotR = 5;
  const spacing = 14;
  const totalWidth = (dotCount - 1) * spacing;
  const startX = layout.x + SLOT_UNIT / 2 - totalWidth / 2;
  const y = layout.y + SLOT_UNIT - 10;
  return (
    <g fill="#1E40AF">
      {Array.from({ length: dotCount }).map((_, i) => (
        <circle key={i} cx={startX + i * spacing} cy={y} r={dotR} />
      ))}
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tone corner badge
// ─────────────────────────────────────────────────────────────────────────────

interface ToneCornerBadgeProps {
  tags: ToneTag[];
  x: number;
  y: number;
  size: number;
}

function ToneCornerBadge(props: ToneCornerBadgeProps): React.ReactElement {
  const { tags, x, y, size } = props;
  const hasQuestion = tags.includes("question");
  const hasExclamation = tags.includes("exclamation");
  const label = hasQuestion && hasExclamation ? "?!" : hasQuestion ? "?" : "!";
  const fill = hasQuestion ? "#7C3AED" : "#DC2626";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={size}
        height={size}
        rx={4}
        ry={4}
        fill={fill}
      />
      <text
        x={x + size / 2}
        y={y + size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.7}
        fontWeight={700}
        fill="white"
      >
        {label}
      </text>
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RTL handling
// ─────────────────────────────────────────────────────────────────────────────

/** Future hook for items that shouldn't be horizontally mirrored in RTL. */
function isNonReversible(_item: VocabularyItem): boolean {
  // No items currently flagged as non-reversible. When added, this should
  // read a `nonReversible: true` field on the registry item.
  return false;
}

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
  getVocabularyItemByEmoji,
  type VocabularyItem,
  type ModifierTransform,
  type DimensionPattern,
  type AnimatedSpriteFacet,
} from "./glyph-registry.js";
import { resolveEmoji, isEmoji, isNonReversibleEmoji } from "./emoji-registry.js";
import {
  parseGlyph,
  computeLayout,
  dominantToneFamily,
  TONE_COLORS,
  SLOT_UNIT,
  SPATIAL_RELATIONS,
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
  /**
   * Called when an `<image>` element fails to load its `href`. The
   * compositor passes the failed URL; the host (Glyph.tsx) records it so
   * the resolver returns null on the next render and the slot drops
   * back to its emoji/text fallback instead of showing a broken-image
   * glyph. Optional — when omitted the failure is silent and the slot
   * stays empty.
   */
  onImageError?: (url: string) => void;
  /**
   * Optional renderer for SYMBOLs carrying an `animatedSprite` facet. The
   * compositor wraps whatever this returns in a `<foreignObject>` sized to
   * the slot so the host can plug in any animation driver (the AAC client
   * uses a hover-driven sprite component; other consumers can leave this
   * unset to get the static `imagePath`/emoji fallback).
   */
  renderAnimatedSymbol?: (facet: AnimatedSpriteFacet, key: string) => React.ReactNode;
  /**
   * Economize space: when the glyph is a single SYMBOL with no modifiers /
   * payload (the common "one image/emoji" button case), render that symbol
   * nearly edge-to-edge (≈0.94 of the slot) instead of the default ≈0.7 that
   * leaves room for badges/arrows. Opt-in so surfaces that need the rim space
   * (the clinician client) keep the conservative default; the AAC client
   * passes it so single-symbol buttons fill their cell. Multi-slot and
   * modified glyphs are unaffected — they still need the surrounding room.
   */
  fillSlot?: boolean;
  /**
   * Show the "empty payload" art for composable hosts (e.g. an open container
   * with a blank slot) when their payload is unfilled. This is the construction
   * affordance — it tells the user "drop something here" — so it's opt-in and
   * ONLY the sentence builder sets it. Everywhere else (boards, captions, the
   * AI strip) an unfilled host renders its normal full image, with no visible
   * blank spot. Default false.
   */
  showEmptyHostSlot?: boolean;
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
    onImageError,
    renderAnimatedSymbol,
    fillSlot = false,
    showEmptyHostSlot = false,
  } = props;

  const parsed: ParsedGlyph = typeof glyph === "string" ? parseGlyph(glyph) : glyph;
  const layout = computeLayout(parsed, rtl);

  // A single, unmodified SYMBOL can be rendered nearly full-bleed — there are
  // no badges/arrows/payload that need the slot's rim. This is the case that
  // otherwise leaves a single emoji/image floating in a too-small box.
  const firstSlot = parsed.slots[0];
  const fillBoost =
    fillSlot &&
    parsed.slots.length === 1 &&
    (firstSlot?.modifiers?.length ?? 0) === 0 &&
    !firstSlot?.payload;
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
            onImageError={onImageError}
            renderAnimatedSymbol={renderAnimatedSymbol}
            fillBoost={fillBoost}
            showEmptyHostSlot={showEmptyHostSlot}
          />
        );
      })}

      {/* Prosody corner badge (? / ! / both) — top-right in LTR. */}
      {parsed.toneTags.some((t) => t === "question" || t === "exclamation") && (
        <ToneCornerBadge
          tags={parsed.toneTags}
          x={layout.cornerBadge.x}
          y={layout.cornerBadge.y}
          size={layout.cornerBadge.size}
        />
      )}
      {/* Tense corner badge (past / future) — top-left in LTR. */}
      {parsed.toneTags.some((t) => t === "past" || t === "future") && (
        <TenseCornerBadge
          tags={parsed.toneTags}
          x={layout.tenseBadge.x}
          y={layout.tenseBadge.y}
          size={layout.tenseBadge.size}
          rtl={rtl}
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
  onImageError?: (url: string) => void;
  renderAnimatedSymbol?: (facet: AnimatedSpriteFacet, key: string) => React.ReactNode;
  /** Render this (single, unmodified) symbol nearly full-bleed — see fillSlot. */
  fillBoost?: boolean;
  /** Show empty-payload host art (construction affordance) — see GlyphCompositor. */
  showEmptyHostSlot?: boolean;
}

function SlotGroup(props: SlotGroupProps): React.ReactElement {
  const { slot, layout, rtl, resolveImage, isActive, onPress, onImageError, renderAnimatedSymbol, fillBoost, showEmptyHostSlot } = props;
  // Resolve the slot's vocabulary item. For a snake_case/canonical key
  // that's a direct registry lookup. For a raw-emoji key, fall back to
  // the reverse-emoji map so non-exposed items with bundled artwork
  // (walk → 🚶, run → 🏃) are recognized as full registry items here.
  // Without this, the imagePath swap below would still find the URL
  // (the resolver does its own reverse lookup) but the SlotGroup would
  // miss the item — meaning no RTL flip, no composable payload, no
  // emptyImagePath behavior. Pinning the item upfront makes every
  // downstream branch see the same canonical entry.
  let item = slot ? getVocabularyItem(slot.key) : undefined;
  if (!item && slot && isEmoji(slot.key)) {
    item = getVocabularyItemByEmoji(slot.key);
  }

  // Collect modifier transforms applied to this slot
  const transforms = collectModifierTransforms(slot);

  const hasGlow = transforms.has("glow");
  const isShrunken = transforms.has("shrink");
  const mainScale = isShrunken ? 0.5 : 1.0;
  // Fraction of the slot the main symbol occupies. Default 0.7 leaves rim room
  // for badges/arrows/dots; fillBoost (single unmodified symbol) goes nearly
  // edge-to-edge so the icon actually fills its button. Emoji text is sized a
  // touch smaller than the image frac since the glyph ink already nearly fills
  // its font box.
  const mainFrac = fillBoost ? 0.94 : 0.7;
  const emojiFrac = fillBoost ? 0.92 : 0.6;
  const mainSize = SLOT_UNIT * mainFrac * mainScale;
  const mainX = layout.x + (SLOT_UNIT - mainSize) / 2;
  const mainY = layout.y + (SLOT_UNIT - mainSize) / 2;

  // Dimension modifier (big/small/long/short/tall/wide/thin) — drives both
  // the arrow decorations drawn around the slot AND a scale applied to the
  // main symbol so the underlying image visually matches the adjective.
  const dimensionPattern = collectDimensionPattern(slot);
  const dimensionScale = dimensionPattern ? DIMENSION_SCALES[dimensionPattern] : null;

  // Relational modifiers (next/prev/this) — directional arrows drawn beneath
  // the symbol. Empty for an unmodified slot or one whose head IS the arrow.
  const relationalArrows = collectRelationalArrows(slot);

  // Color modifier — draws a colored frame around the slot rim. Doesn't
  // alter the underlying symbol (emoji or image) because reliable
  // emoji-recoloring across browsers is fragile; the frame is unambiguous
  // and keeps the symbol identifiable.
  const colorValue = collectColorValue(slot);

  // Composable host with an `emptyImagePath` swap: when the payload
  // slot is unfilled, point the resolver at the empty-state image
  // (e.g. play-empty) instead of the regular host art. This lets a
  // container item render visibly distinct full / empty states.
  // Only the sentence builder shows the empty-payload "drop here" art; every
  // other surface renders the host's normal image so there's no visible blank
  // spot on an unfilled host.
  const useEmptyImage =
    showEmptyHostSlot
    && !!item?.composable?.emptyImagePath
    && !!slot
    && !slot.payload;
  // The mirror swap — a CONTAINER FRAME (building/room) trades its standalone
  // icon for a carved-out backing plate once something is nested inside it.
  // Unlike the empty swap this applies on every surface, because it's what the
  // symbol genuinely looks like when full, not a construction affordance.
  const useFilledImage =
    !useEmptyImage
    && !!item?.composable?.filledImagePath
    && !!slot?.payload;
  // Gender-body modifier (he/she/they) swaps the host art to a `-male`/
  // `-female`/`-plural` body variant. Composes after the empty-image swap.
  const genderSuffix = collectGenderSuffix(slot);
  let resolverImagePath = useEmptyImage
    ? item!.composable!.emptyImagePath
    : useFilledImage
      ? item!.composable!.filledImagePath
      : item?.imagePath;
  if (genderSuffix && resolverImagePath) {
    resolverImagePath = `${resolverImagePath}-${genderSuffix}`;
  }
  const resolverItem = item ? { ...item, imagePath: resolverImagePath } : item;
  const url = slot ? resolveImage?.({ item: resolverItem, key: slot.key }) ?? null : null;
  // The emoji this slot would fall back to. Computed up here (not just in the
  // emoji branch below) because reversibility depends on it: a concept whose
  // representative emoji is text-like (💯, 🔤, a "?") must not mirror in RTL —
  // and that holds whether it renders as the emoji OR as a generated image of
  // the same concept, so gating both on it kills the "loads unflipped, then
  // flips" transition when a generated image arrives to replace the emoji.
  const baseEmojiChar = slot ? (item?.emoji ?? resolveEmoji(slot.key) ?? "❓") : "❓";
  // When the host carries a gender modifier but has no variant art (url null),
  // swap the emoji fallback to a gendered one so he/she/they still read.
  const emojiChar = genderSuffix ? applyGenderEmoji(baseEmojiChar, genderSuffix) : baseEmojiChar;
  const imageReversible = !!item && !isNonReversible(item) && !isNonReversibleEmoji(emojiChar);
  const mainCx = mainX + mainSize / 2;
  const mainCy = mainY + mainSize / 2;
  const imageTransforms: string[] = [];
  if (rtl && imageReversible) {
    imageTransforms.push(`translate(${mainCx} ${mainCy}) scale(-1 1) translate(${-mainCx} ${-mainCy})`);
  }
  if (dimensionScale) {
    const [sx, sy] = dimensionScale;
    imageTransforms.push(`translate(${mainCx} ${mainCy}) scale(${sx} ${sy}) translate(${-mainCx} ${-mainCy})`);
  }
  const mainImageTransform = imageTransforms.length ? imageTransforms.join(" ") : undefined;

  // Emoji raster path (canvas). SVG <text> can't recolor a color-emoji font
  // (the embedded-bitmap/COLR glyph ignores `fill`) and the emoji branch never
  // got the RTL flip that real images get. So when the emoji fallback would
  // render AND the slot carries a color modifier or needs an RTL flip, we
  // rasterize the emoji to a tinted/mirrored bitmap and feed it through the
  // same <image> path the real-image branch uses. The flip is baked into the
  // bitmap (not applied as an SVG transform) so it composes with the dimension
  // warp without double-flipping.
  // `imageReversible` already excludes text-like emoji (see above), so this
  // also keeps "💯"/"🔤"/"?" upright in RTL.
  const emojiFlip = rtl && imageReversible;
  const wantCanvasEmoji =
    !!slot &&
    !url &&
    (!item?.animatedSprite || !renderAnimatedSymbol) &&
    (!!colorValue || emojiFlip);
  const emojiDataUrl = wantCanvasEmoji
    ? emojiToDataUrl(emojiChar, { tint: colorValue, flip: emojiFlip })
    : null;
  // RTL flip is already baked into the bitmap, so the <image> only needs the
  // dimension warp — reusing mainImageTransform here would mirror it twice.
  const emojiImageTransform = dimensionScale
    ? `translate(${mainCx} ${mainCy}) scale(${dimensionScale[0]} ${dimensionScale[1]}) translate(${-mainCx} ${-mainCy})`
    : undefined;
  // Once the emoji itself is recolored, the rim frame is redundant; keep the
  // frame only for image symbols (which we don't canvas-tint, to avoid CORS
  // taint on cross-origin generated/S3 art) or when the raster is unavailable.
  const tintedViaCanvas = !!emojiDataUrl && !!colorValue;
  const showColorFrame = !!colorValue && !tintedViaCanvas;

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

      {/* Main symbol — animated sprite first (when the SYMBOL declares one
          and the host wired a renderer), then static image, then emoji
          fallback, then placeholder. The animated branch is wrapped in a
          <foreignObject> sized to the slot so any animation driver works.
          The dimension warp / RTL flip are encoded as SVG `transform` on
          the foreignObject so they still apply uniformly. */}
      {slot && item?.animatedSprite && renderAnimatedSymbol && (
        <foreignObject
          x={mainX}
          y={mainY}
          width={mainSize}
          height={mainSize}
          transform={mainImageTransform}
        >
          {renderAnimatedSymbol(item.animatedSprite, slot.key)}
        </foreignObject>
      )}
      {slot && (!item?.animatedSprite || !renderAnimatedSymbol) && url && (
        <image
          href={url}
          x={mainX}
          y={mainY}
          width={mainSize}
          height={mainSize}
          filter={hasGlow ? "url(#glyph-glow)" : undefined}
          transform={mainImageTransform}
          onError={onImageError ? () => onImageError(url) : undefined}
        />
      )}
      {slot && (!item?.animatedSprite || !renderAnimatedSymbol) && !url && emojiDataUrl && (
        <image
          href={emojiDataUrl}
          x={mainX}
          y={mainY}
          width={mainSize}
          height={mainSize}
          filter={hasGlow ? "url(#glyph-glow)" : undefined}
          transform={emojiImageTransform}
        />
      )}
      {slot && (!item?.animatedSprite || !renderAnimatedSymbol) && !url && !emojiDataUrl && (
        <text
          x={layout.x + SLOT_UNIT / 2}
          y={layout.y + SLOT_UNIT / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={SLOT_UNIT * emojiFrac * mainScale}
          filter={hasGlow ? "url(#glyph-glow)" : undefined}
          transform={dimensionScale ? `translate(${layout.x + SLOT_UNIT / 2} ${layout.y + SLOT_UNIT / 2}) scale(${dimensionScale[0]} ${dimensionScale[1]}) translate(${-(layout.x + SLOT_UNIT / 2)} ${-(layout.y + SLOT_UNIT / 2)})` : undefined}
        >
          {emojiChar}
        </text>
      )}

      {/* Dimension arrows — drawn after the main symbol so they overlay
          the slot rim. The pattern picks the decoration layout; the
          warp scale above keeps the symbol visually in step. */}
      {dimensionPattern && (
        <DimensionArrows pattern={dimensionPattern} layout={layout} />
      )}

      {/* Relational arrows (next/prev/this) — directional cue beneath the symbol. */}
      {relationalArrows.length > 0 && (
        <RelationalArrows arrows={relationalArrows} layout={layout} rtl={rtl} />
      )}

      {/* Composable payload overlay — payload symbol on top of host symbol. */}
      {slot && item?.composable && (
        <PayloadOverlay
          slot={slot}
          host={item}
          layout={layout}
          rtl={rtl}
          resolveImage={resolveImage}
          onImageError={onImageError}
          showEmptyHostSlot={showEmptyHostSlot}
        />
      )}

      {/* Color modifier — thick rounded outline in the modifier's color
          around the slot rim. Shown for image symbols (which aren't
          canvas-tinted) and as a fallback when the emoji raster is
          unavailable; suppressed once the emoji itself is recolored. The
          active-slot blue outline (below) renders on top of this. */}
      {showColorFrame && (
        <rect
          x={layout.x + 4}
          y={layout.y + 4}
          width={layout.width - 8}
          height={layout.height - 8}
          fill="none"
          stroke={colorValue}
          strokeWidth={6}
          rx={10}
          ry={10}
        />
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
      <BadgeStack slot={slot} layout={layout} rtl={rtl} resolveImage={resolveImage} onImageError={onImageError} />

      {/* Dot indicators at bottom for count modifiers */}
      {transforms.has("dots") && (
        <DotIndicator slot={slot} layout={layout} />
      )}
      {transforms.has("gauge") && (
        <GaugeIndicator level={collectGaugeLevel(slot) ?? 0} layout={layout} />
      )}
      {transforms.has("polarity") && (
        <PolarityMark pole={collectPolarity(slot) ?? "pos"} layout={layout} />
      )}
      {slot?.join && layout.index > 0 && (
        SPATIAL_RELATIONS.has(slot.join)
          ? <SpatialArrow relation={slot.join} layout={layout} rtl={rtl} />
          : <SeamConnector connector={slot.join} layout={layout} rtl={rtl} />
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
// Payload overlay (composable hosts)
// ─────────────────────────────────────────────────────────────────────────────

interface PayloadOverlayProps {
  slot: ParsedSlot;
  host: VocabularyItem;
  layout: SlotLayout;
  rtl: boolean;
  resolveImage?: ImageResolver;
  onImageError?: (url: string) => void;
  /** Show the empty-payload affordance (dashed ring) — construction only. */
  showEmptyHostSlot?: boolean;
}

function PayloadOverlay(props: PayloadOverlayProps): React.ReactElement | null {
  const { slot, host, layout, rtl, resolveImage, onImageError, showEmptyHostSlot } = props;
  const composable = host.composable;
  if (!composable) return null;

  // Payload is rendered at ~45% of slot size. Position depends on the
  // host's facet:
  //   - "upper"        → centered horizontally, in the upper third
  //   - "lower-right"  → bottom-right quadrant; mirrors to lower-left in RTL
  //   - "middle-right" → middle vertical, right-third horizontal;
  //                       mirrors to middle-left in RTL
  //   - "center"       → dead center (default)
  // Non-center positions all mirror their horizontal anchor under RTL
  // so the payload stays in step with the host image's own flip.
  const size = SLOT_UNIT * 0.45;
  let cx: number;
  let cy: number;
  if (composable.position === "upper") {
    cx = layout.x + SLOT_UNIT / 2;
    cy = layout.y + SLOT_UNIT * 0.32;
  } else if (composable.position === "lower-right") {
    cx = layout.x + SLOT_UNIT * (rtl ? 0.3 : 0.7);
    cy = layout.y + SLOT_UNIT * 0.7;
  } else if (composable.position === "middle-right") {
    cx = layout.x + SLOT_UNIT * (rtl ? 0.17 : 0.83);
    cy = layout.y + SLOT_UNIT * 0.5;
  } else {
    cx = layout.x + SLOT_UNIT / 2;
    cy = layout.y + SLOT_UNIT / 2;
  }
  const x = cx - size / 2;
  const y = cy - size / 2;

  // Empty payload behavior:
  //   - If the host has an `emptyImagePath`, the SlotGroup already
  //     swapped the host's main image to the empty pose — no further
  //     overlay needed. The empty state is conveyed by the host art
  //     itself.
  //   - Otherwise, render the dashed placeholder ring so the user
  //     sees the slot is fillable.
  // The empty-payload affordance (dashed ring) is a CONSTRUCTION cue — outside
  // the sentence builder an unfilled host just shows its plain art, no blank
  // spot. (The emptyImagePath swap is likewise gated in SlotGroup.)
  if (!slot.payload) {
    if (!showEmptyHostSlot) return null;
    if (composable.emptyImagePath) return null;
    return (
      <g aria-hidden>
        <circle
          cx={cx}
          cy={cy}
          r={size / 2}
          fill="rgba(255,255,255,0.55)"
          stroke="#9CA3AF"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      </g>
    );
  }

  const payloadItem = getVocabularyItem(slot.payload);
  const url = resolveImage?.({ item: payloadItem, key: slot.payload }) ?? null;
  const payloadEmoji = payloadItem?.emoji ?? resolveEmoji(slot.payload) ?? "❓";
  const payloadReversible =
    !!payloadItem && !isNonReversible(payloadItem) && !isNonReversibleEmoji(payloadEmoji);

  return (
    <g>
      {/* Subtle white pad so the payload reads cleanly over the host. */}
      <circle
        cx={cx}
        cy={cy}
        r={size / 2 + 2}
        fill="rgba(255,255,255,0.75)"
      />
      {url ? (
        <image
          href={url}
          x={x}
          y={y}
          width={size}
          height={size}
          transform={
            rtl && payloadReversible
              ? `translate(${x + size}, ${y}) scale(-1, 1) translate(${-x}, ${-y})`
              : undefined
          }
          onError={onImageError ? () => onImageError(url) : undefined}
        />
      ) : (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size * 0.85}
        >
          {payloadItem?.emoji ?? resolveEmoji(slot.payload) ?? "❓"}
        </text>
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

/**
 * Pick the first dimension pattern (big/small/long/short/tall/short_low/
 * wide/thin) attached to the slot. Only one active at a time — if the AI
 * stacks two contradictory ones the first wins, which keeps the visual
 * coherent. Returns undefined when no dimension modifier is present.
 */
function collectDimensionPattern(slot: ParsedSlot | undefined): DimensionPattern | undefined {
  if (!slot) return undefined;
  for (const modKey of slot.modifiers) {
    const mod = getVocabularyItem(modKey);
    if (mod?.modifier?.transform === "dimension" && mod.modifier.dimension) {
      return mod.modifier.dimension;
    }
  }
  return undefined;
}

/**
 * Collect the directional arrows for any relational modifiers on the slot, in
 * composition order. next/prev/this each contribute one arrow, so a stacked
 * `day.next.next` yields two forward arrows. Returns [] when none are present.
 */
function collectRelationalArrows(
  slot: ParsedSlot | undefined
): Array<"forward" | "backward" | "up"> {
  if (!slot) return [];
  const out: Array<"forward" | "backward" | "up"> = [];
  for (const modKey of slot.modifiers) {
    const rel = getVocabularyItem(modKey)?.modifier?.relation;
    if (rel) out.push(rel.arrow);
  }
  return out;
}

/**
 * Pick the first color modifier on the slot and return its CSS color.
 * Only one color shows at a time — the AI stacking two contradictory
 * ones (color_red+color_blue) is treated as the first winning so the
 * visual stays coherent.
 */
function collectColorValue(slot: ParsedSlot | undefined): string | undefined {
  if (!slot) return undefined;
  for (const modKey of slot.modifiers) {
    const mod = getVocabularyItem(modKey);
    if (mod?.modifier?.transform === "color" && mod.modifier.colorValue) {
      return mod.modifier.colorValue;
    }
  }
  return undefined;
}

/**
 * Pick the first gauge modifier's fill level (none/some/half/most/all).
 * Returns null when no gauge modifier is present. 0 is a valid level (none),
 * so the check is `gauge !== undefined`, not truthiness.
 */
function collectGaugeLevel(slot: ParsedSlot | undefined): number | null {
  if (!slot) return null;
  for (const modKey of slot.modifiers) {
    const g = getVocabularyItem(modKey)?.modifier;
    if (g?.transform === "gauge" && g.gauge !== undefined) return g.gauge;
  }
  return null;
}

/**
 * Pick the first polarity modifier's pole (`pos`/`neg`) — drives the ✓/✗
 * opposite-pair mark (right/wrong). Null when none is present.
 */
function collectPolarity(slot: ParsedSlot | undefined): "pos" | "neg" | null {
  if (!slot) return null;
  for (const modKey of slot.modifiers) {
    const p = getVocabularyItem(modKey)?.modifier;
    if (p?.transform === "polarity" && p.polarity) return p.polarity;
  }
  return null;
}

/**
 * Pick the first gender-body modifier on the slot (`male`/`female`/`plural`).
 * Returns the suffix used to (a) swap the host art to a `-male`/`-female`/
 * `-plural` variant and (b) swap the emoji fallback to a gendered emoji.
 * Only one applies at a time — first wins. Undefined when none is present.
 */
function collectGenderSuffix(
  slot: ParsedSlot | undefined
): "male" | "female" | "plural" | undefined {
  if (!slot) return undefined;
  for (const modKey of slot.modifiers) {
    if (getVocabularyItem(modKey)?.modifier?.transform === "gender_body") {
      return modKey as "male" | "female" | "plural";
    }
  }
  return undefined;
}

/**
 * Gendered emoji fallback for a `gender_body` modifier when the host has no
 * `-male`/`-female`/`-plural` variant art yet. Keyed by the host's base emoji.
 * Unmapped bases keep their base emoji (the modifier still applies to the art
 * path when variant art exists).
 */
const GENDERED_EMOJI: Record<string, { male: string; female: string; plural: string }> = {
  "🧑": { male: "👨", female: "👩", plural: "👥" },
  "🧒": { male: "👦", female: "👧", plural: "🧒" },
};
function applyGenderEmoji(base: string, gender: "male" | "female" | "plural"): string {
  return GENDERED_EMOJI[base]?.[gender] ?? base;
}

/**
 * Image-warp scale per dimension pattern — [xScale, yScale] applied to
 * the main symbol so it visually matches the adjective. Values are
 * intentionally subtle (~±25%) so the symbol stays recognizable; the
 * dimension's meaning is mainly carried by the arrow decoration.
 */
const DIMENSION_SCALES: Record<DimensionPattern, [number, number]> = {
  big:            [1.2, 1.2],
  small:          [0.75, 0.75],
  length_long:    [1.25, 1],
  length_short:   [0.7, 1],
  tall_high:      [1, 1.25],
  short_low:      [1, 0.7],
  wide:           [1.25, 1],
  thin:           [0.7, 1],
};

// ─────────────────────────────────────────────────────────────────────────────
// Dimension arrows
// ─────────────────────────────────────────────────────────────────────────────

const ARROW_STROKE = "#1E40AF";    // deep blue, reads against any tone bg
const ARROW_WIDTH = 3;
const ARROW_HEAD_LEN = 7;

/**
 * Draw a single arrow as line + two head strokes. Origin (x1,y1) to
 * tip (x2,y2). When `doubleHeaded` is true a mirror head is drawn at
 * the start too — used for long.
 */
function Arrow(props: {
  x1: number; y1: number; x2: number; y2: number;
  doubleHeaded?: boolean;
  /** Override stroke color (defaults to the dimension-arrow blue). */
  stroke?: string;
  /** Override stroke width. */
  width?: number;
}): React.ReactElement {
  const { x1, y1, x2, y2, doubleHeaded } = props;
  const stroke = props.stroke ?? ARROW_STROKE;
  const width = props.width ?? ARROW_WIDTH;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const halfSpread = Math.PI / 7;
  const ax = (cx: number, cy: number, dir: number, off: number) => ({
    x: cx + ARROW_HEAD_LEN * Math.cos(angle + dir * Math.PI + off),
    y: cy + ARROW_HEAD_LEN * Math.sin(angle + dir * Math.PI + off),
  });
  // End head (pointing along the arrow direction at x2,y2).
  const e1 = ax(x2, y2, 1, halfSpread);
  const e2 = ax(x2, y2, 1, -halfSpread);
  // Optional start head (pointing back along the arrow direction at x1,y1).
  const s1 = ax(x1, y1, 0, halfSpread);
  const s2 = ax(x1, y1, 0, -halfSpread);
  return (
    <g stroke={stroke} strokeWidth={width} strokeLinecap="round" fill="none">
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <line x1={x2} y1={y2} x2={e1.x} y2={e1.y} />
      <line x1={x2} y1={y2} x2={e2.x} y2={e2.y} />
      {doubleHeaded && (
        <>
          <line x1={x1} y1={y1} x2={s1.x} y2={s1.y} />
          <line x1={x1} y1={y1} x2={s2.x} y2={s2.y} />
        </>
      )}
    </g>
  );
}

/**
 * Render the arrow decoration for a dimension modifier. Each pattern
 * places arrows differently around the slot rim — see DimensionPattern.
 * The image-warp scale is applied separately to the main symbol.
 */
function DimensionArrows(props: {
  pattern: DimensionPattern;
  layout: SlotLayout;
}): React.ReactElement | null {
  const { pattern, layout } = props;
  const x = layout.x;
  const y = layout.y;
  const W = SLOT_UNIT;
  // Inset where the arrow tail sits, and edge offset where the tip lands.
  const INNER = 30;
  const EDGE = 6;
  const HALF = W / 2;

  switch (pattern) {
    case "big":
      // 4 corner arrows pointing outward.
      return (
        <g>
          <Arrow x1={x + INNER}     y1={y + INNER}     x2={x + EDGE}     y2={y + EDGE} />
          <Arrow x1={x + W - INNER} y1={y + INNER}     x2={x + W - EDGE} y2={y + EDGE} />
          <Arrow x1={x + INNER}     y1={y + W - INNER} x2={x + EDGE}     y2={y + W - EDGE} />
          <Arrow x1={x + W - INNER} y1={y + W - INNER} x2={x + W - EDGE} y2={y + W - EDGE} />
        </g>
      );
    case "small":
      // 4 corner arrows pointing inward.
      return (
        <g>
          <Arrow x1={x + EDGE}     y1={y + EDGE}     x2={x + INNER}     y2={y + INNER} />
          <Arrow x1={x + W - EDGE} y1={y + EDGE}     x2={x + W - INNER} y2={y + INNER} />
          <Arrow x1={x + EDGE}     y1={y + W - EDGE} x2={x + INNER}     y2={y + W - INNER} />
          <Arrow x1={x + W - EDGE} y1={y + W - EDGE} x2={x + W - INNER} y2={y + W - INNER} />
        </g>
      );
    case "length_long":
      // Single horizontal double-headed arrow below the image.
      return (
        <Arrow x1={x + 10} y1={y + W - 8} x2={x + W - 10} y2={y + W - 8} doubleHeaded />
      );
    case "length_short":
      // Two horizontal arrows below, pointing inward toward each other.
      return (
        <g>
          <Arrow x1={x + 10}      y1={y + W - 8} x2={x + HALF - 8}  y2={y + W - 8} />
          <Arrow x1={x + W - 10}  y1={y + W - 8} x2={x + HALF + 8}  y2={y + W - 8} />
        </g>
      );
    case "tall_high":
      // Single vertical arrow on the right side, pointing up (full height).
      return (
        <Arrow x1={x + W - 8} y1={y + W - 10} x2={x + W - 8} y2={y + 10} />
      );
    case "short_low":
      // Single short vertical arrow on the right side, pointing down,
      // spanning roughly the lower half of the slot.
      return (
        <Arrow x1={x + W - 8} y1={y + HALF - 10} x2={x + W - 8} y2={y + W - 10} />
      );
    case "wide":
      // Two horizontal arrows on the sides, pointing outward.
      return (
        <g>
          <Arrow x1={x + HALF - 10} y1={y + HALF} x2={x + 8}     y2={y + HALF} />
          <Arrow x1={x + HALF + 10} y1={y + HALF} x2={x + W - 8} y2={y + HALF} />
        </g>
      );
    case "thin":
      // Two horizontal arrows on the sides, pointing inward.
      return (
        <g>
          <Arrow x1={x + 8}     y1={y + HALF} x2={x + HALF - 10} y2={y + HALF} />
          <Arrow x1={x + W - 8} y1={y + HALF} x2={x + HALF + 10} y2={y + HALF} />
        </g>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relational arrows (next / prev / this)
// ─────────────────────────────────────────────────────────────────────────────

const REL_ARROW_STROKE = "#0F766E"; // teal — distinct from the dimension blue
const REL_ARROW_WIDTH = 4;

/**
 * Draw the directional arrow(s) for relational modifiers, in a centered row
 * just inside the bottom rim. "forward" points along the reading direction,
 * "backward" against it, "up" points up; RTL mirrors forward/backward so
 * "forward" always reads as "ahead of the reader". Multiple arrows (stacked
 * next/prev) lay out left-to-right.
 */
function RelationalArrows(props: {
  arrows: Array<"forward" | "backward" | "up">;
  layout: SlotLayout;
  rtl: boolean;
}): React.ReactElement | null {
  const { arrows, layout, rtl } = props;
  if (!arrows.length) return null;
  const W = SLOT_UNIT;
  const cellW = 22;            // horizontal footprint per arrow
  const gap = 2;
  const span = arrows.length * cellW + (arrows.length - 1) * gap;
  const startX = layout.x + W / 2 - span / 2;
  const yMid = layout.y + W - 11; // sit just inside the bottom rim
  const half = cellW / 2 - 2;
  return (
    <g>
      {arrows.map((arrow, i) => {
        const cx = startX + i * (cellW + gap) + cellW / 2;
        if (arrow === "up") {
          return (
            <Arrow key={i} x1={cx} y1={yMid + 8} x2={cx} y2={yMid - 8}
              stroke={REL_ARROW_STROKE} width={REL_ARROW_WIDTH} />
          );
        }
        const pointsRight = (arrow === "forward") !== rtl;
        const x1 = pointsRight ? cx - half : cx + half;
        const x2 = pointsRight ? cx + half : cx - half;
        return (
          <Arrow key={i} x1={x1} y1={yMid} x2={x2} y2={yMid}
            stroke={REL_ARROW_STROKE} width={REL_ARROW_WIDTH} />
        );
      })}
    </g>
  );
}

interface BadgeStackProps {
  slot: ParsedSlot | undefined;
  layout: SlotLayout;
  rtl: boolean;
  resolveImage?: ImageResolver;
  onImageError?: (url: string) => void;
}

const BADGE_TRANSFORMS: ReadonlyArray<ModifierTransform> = ["badge", "hands", "emotion"];

type CornerKey = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Mirror the horizontal side of a corner in RTL ("top-left" ↔ "top-right"). */
function mirrorCorner(corner: CornerKey): CornerKey {
  switch (corner) {
    case "top-left": return "top-right";
    case "top-right": return "top-left";
    case "bottom-left": return "bottom-right";
    case "bottom-right": return "bottom-left";
  }
}

/**
 * Internal shape carried through BadgeStack — either a fully-resolved
 * registry modifier (`item` present) OR a non-canonical modifier whose key
 * we want to render as a generated/emoji badge in the same slot. The
 * non-canonical path is what makes `water.spicy` show a "spicy" badge even
 * though `spicy` isn't in the registry: the AI is allowed to reach for
 * arbitrary words as modifiers and we route them through the imageKey
 * resolver instead of silently dropping them.
 */
type BadgeEntry =
  | { kind: "canonical"; key: string; item: VocabularyItem; corner: CornerKey }
  | { kind: "unknown"; key: string; corner: CornerKey };

function BadgeStack(props: BadgeStackProps): React.ReactElement | null {
  const { slot, layout, rtl, resolveImage, onImageError } = props;
  if (!slot) return null;
  const entries: BadgeEntry[] = [];
  for (const modKey of slot.modifiers) {
    const item = getVocabularyItem(modKey);
    if (item?.modifier && BADGE_TRANSFORMS.includes(item.modifier.transform)) {
      entries.push({
        kind: "canonical",
        key: modKey,
        item,
        corner: item.modifier.corner ?? "top-left",
      });
    } else if (!item) {
      // Non-canonical modifier — render its imageKey/emoji visual as a badge
      // in the default top-left corner. Registry transforms (dimension,
      // color, glow, red_x, halo, dots, shrink, hands) are handled
      // elsewhere; only fall here if the key isn't in the registry at all.
      entries.push({ kind: "unknown", key: modKey, corner: "top-left" });
    }
  }
  if (entries.length === 0) return null;

  const badgeSize = SLOT_UNIT * 0.28;
  const pad = 4;
  const gap = 2;

  // Group badges by visual corner (after RTL mirroring) so multiple badges
  // at the same anchor stack predictably.
  const groups = new Map<CornerKey, BadgeEntry[]>();
  for (const e of entries) {
    const visualCorner = rtl ? mirrorCorner(e.corner) : e.corner;
    const arr = groups.get(visualCorner) ?? [];
    arr.push(e);
    groups.set(visualCorner, arr);
  }

  /** Where the i-th badge sits within a stack anchored at a given corner. */
  const computeBadgeXY = (corner: CornerKey, i: number) => {
    const onTop = corner === "top-left" || corner === "top-right";
    const onLeft = corner === "top-left" || corner === "bottom-left";
    const stackOffset = i * (badgeSize + gap);
    const x = onLeft
      ? layout.x + pad + stackOffset
      : layout.x + SLOT_UNIT - pad - badgeSize - stackOffset;
    const y = onTop
      ? layout.y + pad
      : layout.y + SLOT_UNIT - pad - badgeSize;
    return { x, y };
  };

  return (
    <g>
      {Array.from(groups.entries()).flatMap(([corner, items]) =>
        items.map((entry, i) => {
          const { x, y } = computeBadgeXY(corner, i);
          const item = entry.kind === "canonical" ? entry.item : undefined;
          const url = resolveImage?.({ item, key: entry.key }) ?? null;
          // Flip image content horizontally in RTL so a directional hand still
          // points the same way relative to the speaker/addressee axis.
          const imageTransform = url && rtl && item && !isNonReversible(item)
            ? `translate(${x + badgeSize}, ${y}) scale(-1, 1) translate(${-x}, ${-y})`
            : undefined;
          const fallbackGlyph = item?.emoji ?? resolveEmoji(entry.key) ?? "•";
          return url ? (
            <image
              key={entry.key}
              href={url}
              x={x}
              y={y}
              width={badgeSize}
              height={badgeSize}
              transform={imageTransform}
              onError={onImageError ? () => onImageError(url) : undefined}
            />
          ) : (
            <text
              key={entry.key}
              x={x + badgeSize / 2}
              y={y + badgeSize / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={badgeSize * 0.9}
            >
              {fallbackGlyph}
            </text>
          );
        })
      )}
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
// Gauge indicator (amount scale: none/some/half/most/all)
// ─────────────────────────────────────────────────────────────────────────────

interface GaugeIndicatorProps {
  /** Fill fraction 0..1. */
  level: number;
  layout: SlotLayout;
}

/**
 * A small fill meter beneath the symbol — an outlined pill with an inner bar
 * filled to `level`. Renders the amount-scale quantifiers (none=empty …
 * all=full) on a host noun. Sits in the same beneath-the-symbol band as the
 * dot indicator, so the two never both apply to one slot in practice.
 */
function GaugeIndicator(props: GaugeIndicatorProps): React.ReactElement {
  const { level, layout } = props;
  const clamped = Math.max(0, Math.min(1, level));
  const barW = SLOT_UNIT * 0.5;
  const barH = 9;
  const x = layout.x + (SLOT_UNIT - barW) / 2;
  const y = layout.y + SLOT_UNIT - 13;
  const pad = 2;
  const innerW = (barW - pad * 2) * clamped;
  return (
    <g>
      <rect x={x} y={y} width={barW} height={barH} rx={barH / 2} ry={barH / 2}
        fill="#FFFFFF" stroke="#9CA3AF" strokeWidth={1.5} />
      {innerW > 0 && (
        <rect x={x + pad} y={y + pad} width={innerW} height={barH - pad * 2}
          rx={(barH - pad * 2) / 2} ry={(barH - pad * 2) / 2} fill="#1E40AF" />
      )}
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seam connector (forward-binding join: and / or / but / if / because)
// ─────────────────────────────────────────────────────────────────────────────

/** Compact symbol per connector, drawn in the seam between two glyphs. */
const CONNECTOR_SYMBOL: Record<string, string> = {
  and: "&", or: "/", but: "≠", if: "?", because: "∵",
};

interface SeamConnectorProps {
  connector: string;
  layout: SlotLayout;
  rtl: boolean;
}

/**
 * A small badge straddling the boundary BEFORE a slot, showing the connector
 * that joins it to the previous slot. The boundary is the slot's leading edge
 * (left in LTR, right in RTL). This is the minimal seam render; the spatial
 * slice extends the same seam with trajectory arrows.
 */
function SeamConnector(props: SeamConnectorProps): React.ReactElement {
  const { connector, layout, rtl } = props;
  const sym = CONNECTOR_SYMBOL[connector] ?? "+";
  const r = SLOT_UNIT * 0.16;
  const cx = rtl ? layout.x + layout.width : layout.x;
  const cy = layout.y + layout.height / 2;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#FFFFFF" stroke="#6B7280" strokeWidth={1.5} />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={r * 1.1}
        fill="#374151"
        fontWeight="bold"
      >
        {sym}
      </text>
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spatial arrow (trajectory join: to/from/in/out/on/under/over/through)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-relation geometry: `dir` is the arrow heading (+1 forward A→B, -1 back
 * B→A) and `yFrac` is the vertical position in the slot (0=top, 1=bottom),
 * which encodes elevation (over=high, under=low, on=top, in/out=slightly low).
 */
const SPATIAL_GEOMETRY: Record<string, { dir: 1 | -1; yFrac: number }> = {
  to:      { dir: 1,  yFrac: 0.5 },
  from:    { dir: -1, yFrac: 0.5 },
  in:      { dir: 1,  yFrac: 0.58 },
  out:     { dir: -1, yFrac: 0.58 },
  on:      { dir: 1,  yFrac: 0.3 },
  under:   { dir: 1,  yFrac: 0.78 },
  over:    { dir: 1,  yFrac: 0.22 },
  through: { dir: 1,  yFrac: 0.5 },
};

interface SpatialArrowProps {
  relation: string;
  layout: SlotLayout;
  rtl: boolean;
}

/**
 * A trajectory arrow drawn in the seam before a slot, reaching toward (or back
 * from) the glyph. `dir` flips horizontally under RTL; `yFrac` gives elevation
 * (over/under/on). The minimal straight-arrow render; curved over/under spans
 * are a later enhancement.
 */
function SpatialArrow(props: SpatialArrowProps): React.ReactElement {
  const { relation, layout, rtl } = props;
  const g = SPATIAL_GEOMETRY[relation] ?? { dir: 1 as const, yFrac: 0.5 };
  const y = layout.y + layout.height * g.yFrac;
  const span = SLOT_UNIT * 0.5;
  const cx = rtl ? layout.x + layout.width : layout.x; // boundary toward previous slot
  const x1 = cx - span / 2;
  const x2 = cx + span / 2;
  const pointsRight = (rtl ? -g.dir : g.dir) > 0;
  const tipX = pointsRight ? x2 : x1;
  const tailX = pointsRight ? x1 : x2;
  const head = 8;
  const hx = pointsRight ? -head : head;
  return (
    <g stroke={REL_ARROW_STROKE} strokeWidth={3.5} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <line x1={tailX} y1={y} x2={tipX} y2={y} />
      <line x1={tipX} y1={y} x2={tipX + hx} y2={y - head} />
      <line x1={tipX} y1={y} x2={tipX + hx} y2={y + head} />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Polarity mark (opposite-pair: right ✓ / wrong ✗)
// ─────────────────────────────────────────────────────────────────────────────

interface PolarityMarkProps {
  pole: "pos" | "neg";
  layout: SlotLayout;
}

/**
 * A small green ✓ (positive pole) or red ✗ (negative pole) badge in the
 * bottom-right corner of the slot — the `mark` axis of the opposite-pair
 * design (right/wrong). Bottom-right avoids the emotion badge's top-right.
 */
function PolarityMark(props: PolarityMarkProps): React.ReactElement {
  const { pole, layout } = props;
  const size = SLOT_UNIT * 0.32;
  const x = layout.x + SLOT_UNIT - size - 2;
  const y = layout.y + SLOT_UNIT - size - 2;
  const pos = pole === "pos";
  return (
    <g>
      <rect x={x} y={y} width={size} height={size} rx={4} ry={4} fill={pos ? "#16A34A" : "#DC2626"} />
      <text
        x={x + size / 2}
        y={y + size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.7}
        fill="#FFFFFF"
        fontWeight="bold"
      >
        {pos ? "✓" : "✗"}
      </text>
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

/**
 * Tense corner badge — renders past (amber arrow) and/or future (blue
 * arrow). If both stack (rare but legal), shows "↔" to indicate temporal
 * range. Sits opposite the prosody badge so a sentence can mark tense AND
 * intonation without the two glyphs overlapping. In RTL the arrow
 * direction swaps so "past" still points "behind the reader" — i.e.
 * rightward when the reading flow runs right-to-left.
 */
function TenseCornerBadge(props: ToneCornerBadgeProps & { rtl?: boolean }): React.ReactElement {
  const { tags, x, y, size, rtl = false } = props;
  const hasPast = tags.includes("past");
  const hasFuture = tags.includes("future");
  const pastArrow = rtl ? "→" : "←";
  const futureArrow = rtl ? "←" : "→";
  const label = hasPast && hasFuture ? "↔" : hasPast ? pastArrow : futureArrow;
  // Amber for past (memory / earlier), blue for future (ahead / later);
  // both → muted gray, the symbol itself carries the meaning.
  const fill = hasPast && hasFuture ? "#6B7280" : hasPast ? "#D97706" : "#2563EB";
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

// ─────────────────────────────────────────────────────────────────────────────
// Emoji rasterization (tint + mirror)
// ─────────────────────────────────────────────────────────────────────────────

// Cache keyed by emoji|tint|flip → data URL. The emoji set on any given board
// is small and bounded, so this stays tiny and avoids re-rasterizing the same
// glyph every render. Module-scoped because the canvas output is deterministic
// for a given (emoji, tint, flip) regardless of which slot requested it.
const emojiRasterCache = new Map<string, string>();

/**
 * Rasterize an emoji to a data URL, optionally recolored and/or horizontally
 * mirrored, so it can be rendered through the SVG <image> path.
 *
 * Recoloring uses the `color` composite operation: it takes the hue+saturation
 * of `tint` while preserving the emoji's own luminosity, so the glyph's shading
 * and detail survive (a tinted 😀 still reads as a face, not a flat blob). The
 * tint is then re-clipped to the emoji's alpha via `destination-in` because the
 * blend would otherwise flood the transparent background with the color.
 *
 * Returns null when there's no DOM / 2D context (SSR, jsdom in tests), so
 * callers fall back to plain <text>.
 */
function emojiToDataUrl(
  emoji: string,
  opts: { tint?: string; flip?: boolean } = {},
): string | null {
  if (typeof document === "undefined") return null;
  const tint = opts.tint ?? "";
  const flip = !!opts.flip;
  const cacheKey = `${emoji}|${tint}|${flip ? "f" : ""}`;
  const cached = emojiRasterCache.get(cacheKey);
  if (cached) return cached;

  const S = 128;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const canvas = document.createElement("canvas");
  canvas.width = S * dpr;
  canvas.height = S * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null; // jsdom / headless — let the caller use <text>

  ctx.scale(dpr, dpr);
  if (flip) {
    ctx.translate(S, 0);
    ctx.scale(-1, 1);
  }
  ctx.font = `${S * 0.78}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, S / 2, S / 2);

  if (tint) {
    // Recolor while preserving the emoji's luminance detail.
    ctx.globalCompositeOperation = "color";
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, S, S);
    // Re-clip the flooded color back to the emoji's own alpha.
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillText(emoji, S / 2, S / 2);
    ctx.globalCompositeOperation = "source-over";
  }

  let url: string;
  try {
    url = canvas.toDataURL();
  } catch {
    return null; // tainted/unsupported — fall back to <text>
  }
  emojiRasterCache.set(cacheKey, url);
  return url;
}

// client/src/features/call/MirroredBoardView.tsx
//
// A READ-ONLY render of the AAC student's screen, mirrored over the call's
// reliable data channel (see shared/call/call-data-messages.ts). It lets a
// clinician SEE what the student is looking at without a screen-capture
// permission prompt, faithfully: the context sidebar, the main board grid, and
// the bottom quick-action row, in the STUDENT's reading direction.
//
// IT SHOWS WHICH SURFACE IT IS SHOWING. The AAC has more than one grid: the
// communication board, the sentence builder (a full-screen overlay OVER the
// board), and a game's mini-board beside the game window. This view used to
// assume the first — so while a student built a sentence, a clinician watched
// the board underneath, with nothing on screen to say the child had left it.
// `surface` names it, `strip` carries the sentence being built, `chips` the
// builder's mode rail, and `hud` a game's ambient state.
//
// With `interactive` on (the "Interact" toggle in CallView), pressing a button
// emits back to the AAC, which routes it through the student's own press
// pipeline — facilitated communication, not remote pointer control. Which
// message that is depends on the button: an ordinary board button is a whole
// utterance (`facilitator-press`), while a builder cell is one move in
// composing one (`facilitator-builder`), and the two ids tell them apart
// (parseBuilderTarget).
//
// Cursor sharing: `dwellId` is where the STUDENT is looking/hovering (amber
// ring); `onHover` reports where the CLINICIAN is hovering back to the AAC so
// the student sees the clinician's cursor as a highlight on their own board.
//
// It does NOT import the AAC's DynamicBoard (cross-package + heavy gaze/glyph
// wiring). Each button renders via the clinician-side <Glyph> (shared
// GlyphCompositor), falling back to symbolPath image → emoji → label.

import { useCallback, useMemo, useRef, useState } from "react";
import type { BoardButton, ParsedBoardData } from "@shared/schema";
import type {
  MirrorHudSections,
  MirrorQuickButton,
  MirrorStripItem,
  MirrorSurface,
} from "@shared/call/call-data-messages";
import { parseBuilderTarget, type BuilderTarget } from "@shared/call/builder-mirror";
import { pageGrid } from "@shared/board-grid";
import { resolveButtonBackground, resolveBorderClass } from "@shared/button-color";
import { Glyph } from "@/components/Glyph";
import { cn } from "@/lib/utils";
import { MirroredHudStrip } from "./MirroredHudStrip";

interface Props {
  board: ParsedBoardData;
  pageId?: string;
  /** Student device reading direction. */
  rtl?: boolean;
  /** Context-sidebar buttons the student sees beside the board. */
  contextButtons?: BoardButton[];
  /** Bottom quick-action row the student sees. */
  quickButtons?: MirrorQuickButton[];
  /** Which AAC surface this is — drives the badge and the game reflow. */
  surface?: MirrorSurface;
  /** The app's or game's own localized title. */
  title?: string;
  /** The sentence builder's composed sentence + its controls. */
  strip?: MirrorStripItem[];
  /** The builder's mode-chip rail. */
  chips?: MirrorQuickButton[];
  /** An embedded world-engine game's ambient HUD. */
  hud?: MirrorHudSections;
  /** Button id the STUDENT is dwelling on (their gaze/cursor) — amber ring. */
  dwellId?: string | null;
  /** Most recent momentary press — emerald flash. */
  selection?: { buttonId: string; at: number } | null;
  /** When true, clicking a button facilitates a press on the student. */
  interactive?: boolean;
  onPress?: (button: BoardButton, spokenText: string) => void;
  /** A press on a mirrored SENTENCE BUILDER cell (word, tab, chip, slot, control). */
  onBuilderPress?: (target: BuilderTarget) => void;
  /** Press-and-hold POINTED at a button (or released — null). Offered even when
   *  Interact is off: pointing is not pressing. */
  onIndicate?: (buttonId: string | null) => void;
  /** The button this clinician is currently pointing at. */
  indicatedId?: string | null;
  /** Report the clinician's own hovered button id (or null) — sent to the AAC. */
  onHover?: (buttonId: string | null) => void;
  /** Localized surface badge — the caller owns the strings. */
  surfaceLabel?: string;
  className?: string;
}

/** Resolve the text the AAC would voice (spokenText → sentence → label). */
function spokenTextFor(b: BoardButton): string {
  return (b.spokenText || b.sentence || b.label || "").trim();
}

/**
 * PRESS AND HOLD TO POINT. The AAC gives a caretaker in the room this gesture
 * already (HoldHighlightOverlay): a tap selects, a HOLD marks the button
 * instead. A clinician on a call needs the same distinction — "look at this
 * one" must not put words in the child's mouth — so the mirror reproduces it,
 * and the mark lives exactly as long as the press does, as it does there.
 */
const INDICATE_HOLD_MS = 500;

/**
 * The hold gesture, shared by everything a clinician can point at: a board
 * button, a builder word, a category tab, a mode chip, the Play control.
 *
 * Returns the pointer handlers, a `fired()` the click handler must consult (a
 * completed hold has to swallow the click that follows its release, or pointing
 * would also press), and `arming` for the progress bar. `id` is what travels —
 * a board button id, or a `bx:` builder target — and the AAC resolves it
 * through the same `data-mirror-id` its cursor reporter already reads.
 */
function useIndicateHold(id: string, onIndicate?: (buttonId: string | null) => void) {
  const [arming, setArming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setArming(false);
    if (heldRef.current) onIndicate?.(null);
  }, [onIndicate]);

  const start = useCallback(() => {
    if (!onIndicate) return;
    heldRef.current = false;
    setArming(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      heldRef.current = true;
      setArming(false);
      onIndicate(id);
    }, INDICATE_HOLD_MS);
  }, [onIndicate, id]);

  /** True once, when the click being handled is the tail of a completed hold. */
  const fired = useCallback(() => {
    if (!heldRef.current) return false;
    heldRef.current = false;
    return true;
  }, []);

  return { arming, start, cancel, fired, enabled: !!onIndicate };
}

/** The filling bar under a button being held. A CSS width transition, so the
 *  gesture is visible without spending an animation frame on it. */
function HoldBar({ arming }: { arming: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-yellow-400 transition-[width] ease-linear"
      style={{ width: arming ? "100%" : "0%", transitionDuration: arming ? `${INDICATE_HOLD_MS}ms` : "0ms" }}
    />
  );
}

/**
 * One board button, drawn the way the STUDENT's board draws it.
 *
 * 🚨 The fill comes from `resolveButtonBackground` and the label is dark, both
 * copied from `BoardButtonVisual`. The AAC palette is pastel and MOST buttons
 * are plain white (shared/button-color.ts) — an earlier version of this file
 * painted white label text straight over `button.color`, which rendered the
 * whole board as blank tiles. The mirror has to obey the board's colour rules,
 * not invent its own.
 */
function MirrorButton({ button, rtl, dwell, selected, indicated, interactive, onPress, onHover, onIndicate }: {
  button: BoardButton; rtl?: boolean; dwell?: boolean; selected?: boolean; indicated?: boolean;
  interactive?: boolean; onPress?: (b: BoardButton, t: string) => void; onHover?: (id: string | null) => void;
  onIndicate?: (buttonId: string | null) => void;
}) {
  const hold = useIndicateHold(button.id, onIndicate);

  // Pointing is not pressing, so the element has to be clickable whenever
  // EITHER is on offer — not only when Interact is armed.
  const Tag: any = interactive || onIndicate ? "button" : "div";
  const symbolIsUrl = button.symbolPath && /^(https?:|\/)/.test(button.symbolPath);
  const emoji = button.iconRef && !button.iconRef.includes(" ") && !button.iconRef.startsWith("fa") ? button.iconRef : null;
  const background = resolveButtonBackground(button.color, button.glyph, button.buttonType, button.role);
  return (
    <Tag
      {...(Tag === "button" ? { type: "button" } : {})}
      onClick={() => {
        // A completed hold swallows its own click — it was a point, not a press.
        if (hold.fired()) return;
        if (interactive) onPress?.(button, spokenTextFor(button));
      }}
      onPointerDown={hold.start}
      onPointerUp={hold.cancel}
      onPointerCancel={hold.cancel}
      onPointerEnter={() => onHover?.(button.id)}
      onPointerLeave={() => { hold.cancel(); onHover?.(null); }}
      className={cn(
        "relative flex h-full w-full min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border-2 p-1 text-center",
        // The student's own border vocabulary (guess / suggestion / more / link).
        resolveBorderClass({ buttonType: button.buttonType }),
        "text-gray-800",
        (interactive || onIndicate) && "cursor-pointer hover:brightness-95",
        dwell && "ring-4 ring-amber-400",
        selected && "ring-4 ring-emerald-400",
        indicated && "ring-4 ring-yellow-400",
      )}
      style={{ backgroundColor: background }}
      aria-label={button.label}
    >
      <div className="min-h-0 w-full flex-1">
        {button.glyph || button.glyphFallback ? (
          // Definite-size wrapper (matches the AAC board): GlyphCompositor fills
          // 100%×100%. Centering the SVG in a flex parent collapses it to 0.
          <div style={{ width: "100%", height: "100%" }}>
            <Glyph glyph={button.glyph} fallback={button.glyphFallback} noBackground rtl={rtl} ariaLabel={button.label} />
          </div>
        ) : symbolIsUrl ? (
          <img src={button.symbolPath} alt={button.label} className="h-full w-full object-contain" />
        ) : emoji ? (
          <div className="flex h-full w-full items-center justify-center"><span className="text-3xl leading-none">{emoji}</span></div>
        ) : null}
      </div>
      {button.label && <div className="w-full shrink-0 truncate text-xs font-medium">{button.label}</div>}
      {hold.enabled && <HoldBar arming={hold.arming} />}
    </Tag>
  );
}

/**
 * The sentence the student is building, above the grid. This is the half of the
 * builder a bare grid cannot show: the grid says what they COULD say next, this
 * says what they have said so far — which is the thing a clinician is watching
 * for.
 */
function SentenceStrip({ items, interactive, onPress, onIndicate, indicatedId }: {
  items: MirrorStripItem[]; interactive?: boolean; onPress?: (t: BuilderTarget) => void;
  onIndicate?: (buttonId: string | null) => void; indicatedId?: string | null;
}) {
  return (
    <div className="mb-2 flex shrink-0 items-stretch gap-2 rounded-lg bg-black/30 p-2" style={{ height: "5.5rem" }}>
      {items.map((item) => (
        <StripItem
          key={item.id}
          item={item}
          interactive={interactive}
          onPress={onPress}
          // A SLOT is a word the child already placed; there is nothing to
          // point them at. A CONTROL ("now press Say it") is exactly the kind
          // of thing a clinician points at, so only those take the gesture.
          onIndicate={item.kind === "control" ? onIndicate : undefined}
          indicated={indicatedId === item.id}
        />
      ))}
    </div>
  );
}

function StripItem({ item, interactive, onPress, onIndicate, indicated }: {
  item: MirrorStripItem; interactive?: boolean; onPress?: (t: BuilderTarget) => void;
  onIndicate?: (buttonId: string | null) => void; indicated?: boolean;
}) {
  const hold = useIndicateHold(item.id, onIndicate);
  const isControl = item.kind === "control";
  const Tag: any = interactive || hold.enabled ? "button" : "div";
  return (
          <Tag
            {...(Tag === "button" ? { type: "button" } : {})}
            onClick={() => {
              if (hold.fired()) return;
              if (!interactive) return;
              const target = parseBuilderTarget(item.id);
              if (target) onPress?.(target);
            }}
            onPointerDown={hold.start}
            onPointerUp={hold.cancel}
            onPointerCancel={hold.cancel}
            onPointerLeave={hold.cancel}
            aria-label={item.label ?? item.glyph}
            className={cn(
              // Light tiles with dark text, like the builder's own sentence
              // strip — glyph line-art is drawn to sit on white, not on a dark
              // panel, and the control labels have to stay legible.
              "relative flex min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border-2 border-gray-200 bg-white p-1 text-gray-800",
              isControl ? "w-16 shrink-0" : "aspect-square h-full",
              (interactive || hold.enabled) && "cursor-pointer hover:brightness-95",
              item.active && "ring-4 ring-amber-400",
              indicated && "ring-4 ring-yellow-400",
            )}
          >
            {item.kind === "slot" ? (
              <div style={{ width: "100%", height: "100%" }}>
                <Glyph glyph={item.glyph} fallback={item.emoji} noBackground ariaLabel={item.label ?? item.glyph} />
              </div>
            ) : (
              <span className="text-2xl leading-none">{item.emoji}</span>
            )}
            {isControl && item.label && <span className="w-full truncate text-[10px]">{item.label}</span>}
            {hold.enabled && <HoldBar arming={hold.arming} />}
          </Tag>
  );
}

/** A rail of small chips — the builder's mode chips, or the AAC's own bottom
 *  quick-action row. Quick actions are never pressable (they are the student's
 *  own chrome, not vocabulary); builder chips are, when Interact is armed. */
function ChipRail({ items, height, interactive, onPress, onIndicate, indicatedId }: {
  items: MirrorQuickButton[]; height: string; interactive?: boolean; onPress?: (t: BuilderTarget) => void;
  onIndicate?: (buttonId: string | null) => void; indicatedId?: string | null;
}) {
  return (
    <div className="mt-2 grid shrink-0 gap-2" style={{ height, gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((q) => (
        <ChipRailItem
          key={q.id}
          chip={q}
          interactive={interactive}
          onPress={onPress}
          onIndicate={onIndicate}
          indicated={indicatedId === q.id}
        />
      ))}
    </div>
  );
}

function ChipRailItem({ chip, interactive, onPress, onIndicate, indicated }: {
  chip: MirrorQuickButton; interactive?: boolean; onPress?: (t: BuilderTarget) => void;
  onIndicate?: (buttonId: string | null) => void; indicated?: boolean;
}) {
  const hold = useIndicateHold(chip.id, onIndicate);
  const target = interactive ? parseBuilderTarget(chip.id) : null;
  const Tag: any = target || hold.enabled ? "button" : "div";
  return (
    <Tag
      {...(Tag === "button" ? { type: "button" } : {})}
      onClick={() => {
        if (hold.fired()) return;
        if (target) onPress?.(target);
      }}
      onPointerDown={hold.start}
      onPointerUp={hold.cancel}
      onPointerCancel={hold.cancel}
      onPointerLeave={hold.cancel}
      className={cn(
        "relative flex flex-col items-center justify-center overflow-hidden rounded-lg border p-1 text-center text-gray-900",
        (target || hold.enabled) && "cursor-pointer hover:brightness-110",
        chip.active && "ring-2 ring-violet-400",
        indicated && "ring-2 ring-yellow-400",
      )}
      style={{ backgroundColor: chip.color || "#E5E7EB" }}
    >
      {chip.emoji && <span className="text-xl leading-none">{chip.emoji}</span>}
      <span className="w-full truncate text-[11px] font-semibold">{chip.label}</span>
      {hold.enabled && <HoldBar arming={hold.arming} />}
    </Tag>
  );
}

export function MirroredBoardView({
  board, pageId, rtl, contextButtons, quickButtons,
  surface, title, strip, chips, hud, surfaceLabel,
  dwellId, selection, interactive, onPress, onBuilderPress, onHover, onIndicate, indicatedId, className,
}: Props) {
  const page = useMemo(() => {
    const id = pageId ?? board.currentPageId;
    return board.pages.find((p) => p.id === id) ?? board.pages[0] ?? null;
  }, [board, pageId]);

  // Same resolution the student's own renderer uses — the mirror must show the
  // board they are looking at, not a differently-shaped guess at it.
  const { rows, cols } = pageGrid(board, page, { rows: 1, cols: 1 });

  // One press entry point. A builder cell carries its target in its id, so the
  // two facilitator messages never have to be chosen by the caller.
  const press = (button: BoardButton, spokenText: string) => {
    const target = parseBuilderTarget(button.id);
    if (target) onBuilderPress?.(target);
    else onPress?.(button, spokenText);
  };

  // In a game the student's own screen is [sidebar board][game window]. The
  // mini-board is two columns wide, so stretching it across the pane would show
  // a layout the child never had — it keeps its sidebar width and the HUD takes
  // the room the game itself occupies on their screen.
  const gameReflow = !!hud?.length;

  const grid = page ? (
    <div
      className="grid h-full w-full gap-2"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {page.buttons.map((b) => (
        <div
          key={b.id}
          className="min-h-0 min-w-0"
          style={{ gridColumn: `${b.col + 1} / span ${b.colSpan ?? 1}`, gridRow: `${b.row + 1} / span ${b.rowSpan ?? 1}` }}
        >
          <MirrorButton
            button={b}
            rtl={rtl}
            dwell={dwellId === b.id}
            selected={selection?.buttonId === b.id}
            indicated={indicatedId === b.id}
            interactive={interactive}
            onPress={press}
            onHover={onHover}
            onIndicate={onIndicate}
          />
        </div>
      ))}
    </div>
  ) : (
    <div className="flex h-full w-full items-center justify-center text-white/40">—</div>
  );

  return (
    <div className={cn("flex h-full w-full flex-col bg-black/40 p-2", className)} dir={rtl ? "rtl" : "ltr"}>
      {/* Which of the student's screens this is. Without it the builder and the
          board are two grids a clinician cannot tell apart. */}
      {(surfaceLabel || title) && (
        <div className="mb-2 flex shrink-0 items-center gap-2 text-xs">
          {surfaceLabel && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide text-white",
                surface === "builder" ? "bg-violet-600/90" : surface === "game" ? "bg-emerald-600/90" : surface === "app" ? "bg-sky-600/90" : "bg-white/20",
              )}
            >
              {surfaceLabel}
            </span>
          )}
          {title && <span className="truncate text-white/70">{title}</span>}
        </div>
      )}

      {strip && strip.length > 0 && (
        <SentenceStrip items={strip} interactive={interactive} onPress={onBuilderPress} onIndicate={onIndicate} indicatedId={indicatedId} />
      )}

      {/* Context sidebar (leading) + main board grid. */}
      <div className="flex min-h-0 flex-1 gap-2">
        {contextButtons && contextButtons.length > 0 && (
          <div className="flex w-20 shrink-0 flex-col gap-2">
            {contextButtons.map((b) => (
              <div key={b.id} className="min-h-0 flex-1">
                <MirrorButton
                  button={b}
                  rtl={rtl}
                  dwell={dwellId === b.id}
                  selected={selection?.buttonId === b.id}
                  indicated={indicatedId === b.id}
                  interactive={interactive}
                  onPress={press}
                  onHover={onHover}
                  onIndicate={onIndicate}
                />
              </div>
            ))}
          </div>
        )}
        {gameReflow ? (
          <>
            <div className="min-h-0 w-28 shrink-0">{grid}</div>
            <MirroredHudStrip sections={hud!} className="min-h-0 flex-1" />
          </>
        ) : (
          <div className="min-h-0 min-w-0 flex-1">{grid}</div>
        )}
      </div>

      {/* The builder's mode-chip rail — pressable, unlike the quick actions. */}
      {chips && chips.length > 0 && (
        <ChipRail items={chips} height="3.25rem" interactive={interactive} onPress={onBuilderPress} onIndicate={onIndicate} indicatedId={indicatedId} />
      )}

      {/* Bottom quick-action row (read-only). */}
      {quickButtons && quickButtons.length > 0 && (
        <ChipRail items={quickButtons} height="4.5rem" />
      )}
    </div>
  );
}

export default MirroredBoardView;

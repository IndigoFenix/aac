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

import { useMemo } from "react";
import type { BoardButton, ParsedBoardData } from "@shared/schema";
import type {
  MirrorHudSections,
  MirrorQuickButton,
  MirrorStripItem,
  MirrorSurface,
} from "@shared/call/call-data-messages";
import { parseBuilderTarget, type BuilderTarget } from "@shared/call/builder-mirror";
import { pageGrid } from "@shared/board-grid";
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

/** One read-only board button: glyph → symbol image → emoji → label only. */
function MirrorButton({ button, rtl, dwell, selected, interactive, onPress, onHover }: {
  button: BoardButton; rtl?: boolean; dwell?: boolean; selected?: boolean;
  interactive?: boolean; onPress?: (b: BoardButton, t: string) => void; onHover?: (id: string | null) => void;
}) {
  const Tag: any = interactive ? "button" : "div";
  const symbolIsUrl = button.symbolPath && /^(https?:|\/)/.test(button.symbolPath);
  const emoji = button.iconRef && !button.iconRef.includes(" ") && !button.iconRef.startsWith("fa") ? button.iconRef : null;
  return (
    <Tag
      {...(interactive ? { type: "button", onClick: () => onPress?.(button, spokenTextFor(button)) } : {})}
      onPointerEnter={() => onHover?.(button.id)}
      onPointerLeave={() => onHover?.(null)}
      className={cn(
        "relative flex h-full w-full min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border-2 p-1 text-center",
        "border-white/15 bg-white/10 text-white",
        interactive && "cursor-pointer hover:bg-white/20",
        dwell && "ring-4 ring-amber-400",
        selected && "ring-4 ring-emerald-400",
      )}
      style={{ backgroundColor: button.color || undefined }}
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
    </Tag>
  );
}

/**
 * The sentence the student is building, above the grid. This is the half of the
 * builder a bare grid cannot show: the grid says what they COULD say next, this
 * says what they have said so far — which is the thing a clinician is watching
 * for.
 */
function SentenceStrip({ items, interactive, onPress }: {
  items: MirrorStripItem[]; interactive?: boolean; onPress?: (t: BuilderTarget) => void;
}) {
  const fire = (item: MirrorStripItem) => {
    const target = parseBuilderTarget(item.id);
    if (target) onPress?.(target);
  };
  return (
    <div className="mb-2 flex shrink-0 items-stretch gap-2 rounded-lg bg-black/30 p-2" style={{ height: "5.5rem" }}>
      {items.map((item) => {
        const Tag: any = interactive ? "button" : "div";
        const isControl = item.kind === "control";
        return (
          <Tag
            key={item.id}
            {...(interactive ? { type: "button", onClick: () => fire(item) } : {})}
            aria-label={item.label ?? item.glyph}
            className={cn(
              "flex min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border-2 p-1 text-white",
              isControl ? "w-16 shrink-0 border-white/20 bg-white/10" : "aspect-square h-full border-white/15 bg-white/5",
              interactive && "cursor-pointer hover:bg-white/20",
              item.active && "ring-4 ring-amber-400",
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
          </Tag>
        );
      })}
    </div>
  );
}

/** A rail of small chips — the builder's mode chips, or the AAC's own bottom
 *  quick-action row. Quick actions are never pressable (they are the student's
 *  own chrome, not vocabulary); builder chips are, when Interact is armed. */
function ChipRail({ items, height, interactive, onPress }: {
  items: MirrorQuickButton[]; height: string; interactive?: boolean; onPress?: (t: BuilderTarget) => void;
}) {
  return (
    <div className="mt-2 grid shrink-0 gap-2" style={{ height, gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((q) => {
        const target = interactive ? parseBuilderTarget(q.id) : null;
        const Tag: any = target ? "button" : "div";
        return (
          <Tag
            key={q.id}
            {...(target ? { type: "button", onClick: () => onPress?.(target) } : {})}
            className={cn(
              "flex flex-col items-center justify-center overflow-hidden rounded-lg border p-1 text-center text-gray-900",
              target && "cursor-pointer hover:brightness-110",
              q.active && "ring-2 ring-violet-400",
            )}
            style={{ backgroundColor: q.color || "#E5E7EB" }}
          >
            {q.emoji && <span className="text-xl leading-none">{q.emoji}</span>}
            <span className="w-full truncate text-[11px] font-semibold">{q.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}

export function MirroredBoardView({
  board, pageId, rtl, contextButtons, quickButtons,
  surface, title, strip, chips, hud, surfaceLabel,
  dwellId, selection, interactive, onPress, onBuilderPress, onHover, className,
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
            interactive={interactive}
            onPress={press}
            onHover={onHover}
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
        <SentenceStrip items={strip} interactive={interactive} onPress={onBuilderPress} />
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
                  interactive={interactive}
                  onPress={press}
                  onHover={onHover}
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
        <ChipRail items={chips} height="3.25rem" interactive={interactive} onPress={onBuilderPress} />
      )}

      {/* Bottom quick-action row (read-only). */}
      {quickButtons && quickButtons.length > 0 && (
        <ChipRail items={quickButtons} height="4.5rem" />
      )}
    </div>
  );
}

export default MirroredBoardView;

// client/src/features/call/MirroredBoardView.tsx
//
// A READ-ONLY render of the AAC student's screen, mirrored over the call's
// reliable data channel (see shared/call/call-data-messages.ts). It lets a
// clinician SEE what the student is looking at without a screen-capture
// permission prompt, faithfully: the context sidebar, the main board grid, and
// the bottom quick-action row, in the STUDENT's reading direction.
//
// With `interactive` on (the "Interact" toggle in CallView), pressing a board
// button emits a `facilitator-press` back to the AAC, which routes it through
// the student's own press pipeline (student-voice TTS + sentence builder) —
// facilitated communication, not remote pointer control.
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
import type { MirrorQuickButton } from "@shared/call/call-data-messages";
import { Glyph } from "@/components/Glyph";
import { cn } from "@/lib/utils";

interface Props {
  board: ParsedBoardData;
  pageId?: string;
  /** Student device reading direction. */
  rtl?: boolean;
  /** Context-sidebar buttons the student sees beside the board. */
  contextButtons?: BoardButton[];
  /** Bottom quick-action row the student sees. */
  quickButtons?: MirrorQuickButton[];
  /** Button id the STUDENT is dwelling on (their gaze/cursor) — amber ring. */
  dwellId?: string | null;
  /** Most recent momentary press — emerald flash. */
  selection?: { buttonId: string; at: number } | null;
  /** When true, clicking a board button facilitates a press on the student. */
  interactive?: boolean;
  onPress?: (button: BoardButton, spokenText: string) => void;
  /** Report the clinician's own hovered button id (or null) — sent to the AAC. */
  onHover?: (buttonId: string | null) => void;
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

export function MirroredBoardView({ board, pageId, rtl, contextButtons, quickButtons, dwellId, selection, interactive, onPress, onHover, className }: Props) {
  const page = useMemo(() => {
    const id = pageId ?? board.currentPageId;
    return board.pages.find((p) => p.id === id) ?? board.pages[0] ?? null;
  }, [board, pageId]);

  const grid = page?.layout ?? board.grid;
  const rows = Math.max(1, grid?.rows ?? 1);
  const cols = Math.max(1, grid?.cols ?? 1);

  return (
    <div className={cn("flex h-full w-full flex-col bg-black/40 p-2", className)} dir={rtl ? "rtl" : "ltr"}>
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
                  onPress={onPress}
                  onHover={onHover}
                />
              </div>
            ))}
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {page ? (
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
                    onPress={onPress}
                    onHover={onHover}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/40">—</div>
          )}
        </div>
      </div>

      {/* Bottom quick-action row (read-only). */}
      {quickButtons && quickButtons.length > 0 && (
        <div className="mt-2 grid shrink-0 gap-2" style={{ height: "4.5rem", gridTemplateColumns: `repeat(${quickButtons.length}, minmax(0, 1fr))` }}>
          {quickButtons.map((q) => (
            <div
              key={q.id}
              className={cn(
                "flex flex-col items-center justify-center overflow-hidden rounded-lg border p-1 text-center text-gray-900",
                q.active && "ring-2 ring-violet-400",
              )}
              style={{ backgroundColor: q.color || "#E5E7EB" }}
            >
              {q.emoji && <span className="text-xl leading-none">{q.emoji}</span>}
              <span className="w-full truncate text-[11px] font-semibold">{q.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default MirroredBoardView;

// client/src/features/call/MirroredBoardView.tsx
//
// A READ-ONLY render of the AAC student's communication board, mirrored over the
// call's reliable data channel (see shared/call/call-data-messages.ts). It lets
// a clinician SEE what the student is looking at without a screen-capture
// permission prompt. With `interactive` on (the "Interact" toggle in CallView),
// pressing a button emits a `facilitator-press` back to the AAC, which routes it
// through the student's own press pipeline (student-voice TTS + sentence
// builder) — facilitated communication, not remote pointer control.
//
// It deliberately does NOT import the AAC's DynamicBoard (cross-package, and it
// carries heavy gaze/glyph wiring). It lays the buttons out on the board grid
// and renders each via the clinician-side <Glyph> (shared GlyphCompositor),
// falling back to symbolPath image → emoji → label.

import { useMemo } from "react";
import type { BoardButton, ParsedBoardData } from "@shared/schema";
import { Glyph } from "@/components/Glyph";
import { cn } from "@/lib/utils";

interface Props {
  board: ParsedBoardData;
  pageId?: string;
  /** Button id the student is dwelling on (gaze hover) — amber ring. */
  dwellId?: string | null;
  /** Most recent momentary press — emerald flash. */
  selection?: { buttonId: string; at: number } | null;
  /** When true, clicking a button facilitates a press on the student. */
  interactive?: boolean;
  onPress?: (button: BoardButton, spokenText: string) => void;
  className?: string;
}

/** Resolve the text the AAC would voice for this button. Mirrors the AAC's
 *  press handling (spokenText → sentence → label). */
function spokenTextFor(b: BoardButton): string {
  return (b.spokenText || b.sentence || b.label || "").trim();
}

export function MirroredBoardView({ board, pageId, dwellId, selection, interactive, onPress, className }: Props) {
  const page = useMemo(() => {
    const id = pageId ?? board.currentPageId;
    return board.pages.find((p) => p.id === id) ?? board.pages[0] ?? null;
  }, [board, pageId]);

  const grid = page?.layout ?? board.grid;
  const rows = Math.max(1, grid?.rows ?? 1);
  const cols = Math.max(1, grid?.cols ?? 1);

  if (!page) {
    return <div className={cn("flex h-full w-full items-center justify-center text-white/40", className)}>—</div>;
  }

  return (
    <div className={cn("h-full w-full bg-black/40 p-2", className)}>
      <div
        className="grid h-full w-full gap-2"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {page.buttons.map((b) => {
          const isDwell = dwellId === b.id;
          const isSelected = selection?.buttonId === b.id;
          const Tag: any = interactive ? "button" : "div";
          return (
            <Tag
              key={b.id}
              {...(interactive ? { type: "button", onClick: () => onPress?.(b, spokenTextFor(b)) } : {})}
              className={cn(
                "relative flex min-h-0 flex-col items-center justify-center overflow-hidden rounded-lg border-2 p-1 text-center",
                "border-white/15 bg-white/10 text-white",
                interactive && "cursor-pointer hover:bg-white/20",
                isDwell && "ring-4 ring-amber-400",
                isSelected && "ring-4 ring-emerald-400",
              )}
              style={{
                gridColumn: `${b.col + 1} / span ${b.colSpan ?? 1}`,
                gridRow: `${b.row + 1} / span ${b.rowSpan ?? 1}`,
                backgroundColor: b.color || undefined,
              }}
              aria-label={b.label}
            >
              <div className="flex min-h-0 flex-1 items-center justify-center">
                {b.glyph ? (
                  <Glyph glyph={b.glyph} fallback={b.glyphFallback} height="100%" ariaLabel={b.label} />
                ) : b.symbolPath && /^(https?:|\/)/.test(b.symbolPath) ? (
                  <img src={b.symbolPath} alt={b.label} className="max-h-full max-w-full object-contain" />
                ) : b.iconRef && !b.iconRef.includes(" ") && !b.iconRef.startsWith("fa") ? (
                  <span className="text-3xl leading-none">{b.iconRef}</span>
                ) : null}
              </div>
              {b.label && <div className="w-full truncate text-xs font-medium">{b.label}</div>}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

export default MirroredBoardView;

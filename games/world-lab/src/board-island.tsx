// games/world-lab/src/board-island.tsx
//
// The lab's response board — the SAME renderer the AAC uses. It mounts a
// small React root that draws the shared `<BoardButtonVisual>` (client-shared)
// in a 2×4 grid, exactly as `AppMiniBoard` does during a game, fed by the
// quest host's board view through the same `lockedBoardFrom` shape. The glyph
// composition is the shared `GlyphCompositor` with the lab's bundled-icon
// resolver, so a button reads pixel-identical to the student's real board.
//
// The lab is otherwise vanilla TS; this is the only React island, wrapped in
// an imperative handle (mount / set / dispose) the vanilla host drives.

import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import type { BoardButtonInput, BoardRenderDeps, GlyphRenderProps, IconVisual } from "@client-shared/board/types";
// The component lives in the .tsx (the bare `@shared/glyph-compositor`
// resolves to the types-only .ts) — import it explicitly, as the AAC does.
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { QuestBoardView } from "@shared/symbol-game/quest-host";
import { labImageResolver } from "./glyph-resolver";

// Icon/text sizing mirrors AppMiniBoard's 4-row column, so the buttons read the
// same on the lab bench as in the student's board.
const ICON_FONT = "clamp(1rem, calc((100dvh - 10.5rem) / 4 * 0.45), 6rem)";
const TEXT_FONT = "clamp(0.5rem, calc((100dvh - 10.5rem) / 4 * 0.10), 1.25rem)";

/** The lab's Glyph wrapper: the shared compositor with the bundled-icon
 *  resolver (the AAC injects its own; the lab injects this). */
function LabGlyph(p: GlyphRenderProps) {
  return (
    <GlyphCompositor
      glyph={p.glyph ?? p.fallback ?? ""}
      resolveImage={labImageResolver}
      noBackground={p.noBackground}
      ariaLabel={p.ariaLabel}
      fillSlot
    />
  );
}

/** Glyph-first icon resolution (game buttons always carry a composed glyph;
 *  fall back to the emoji iconRef). */
const resolveIcon = (button: BoardButtonInput): IconVisual => {
  if (button.glyph || button.glyphFallback) {
    return { kind: "glyph", glyph: button.glyph, fallback: button.glyphFallback };
  }
  if (button.iconRef) return { kind: "emoji", text: button.iconRef };
  return { kind: "placeholder" };
};

const deps: BoardRenderDeps = { resolveIcon, GlyphComponent: LabGlyph };

function BoardStrip({ view, onSelect }: { view: QuestBoardView | null; onSelect: (id: string) => void }) {
  const options = view?.options.slice(0, 8) ?? [];
  return (
    <div className="quest-boardpanel-inner">
      <div className="quest-boardpanel-prompt">{view?.promptText ?? ""}</div>
      <div
        className="quest-boardpanel-grid"
        style={{
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gridTemplateRows: "repeat(4, minmax(0, 1fr))",
        }}
      >
        {options.map((o, i) => {
          const button: BoardButtonInput = {
            label: o.label,
            glyph: o.glyph,
            iconRef: o.iconRef,
            sentence: o.spokenText,
          };
          return (
            <BoardButtonVisual
              key={o.id + i}
              button={button}
              deps={deps}
              variant="board"
              onClick={() => onSelect(o.id)}
              iconFontSize={ICON_FONT}
              textFontSize={TEXT_FONT}
              borderClassName="board-btn-border"
            />
          );
        })}
      </div>
    </div>
  );
}

export interface BoardIsland {
  set(view: QuestBoardView | null): void;
  dispose(): void;
}

/** Mount the board island into `container`; `onSelect` fires a button id — the
 *  host owns the voice, so the board itself never speaks (no double TTS). */
export function mountBoardIsland(container: HTMLElement, onSelect: (id: string) => void): BoardIsland {
  const root: Root = createRoot(container);
  const render = (view: QuestBoardView | null) =>
    root.render(
      <StrictMode>
        <BoardStrip view={view} onSelect={onSelect} />
      </StrictMode>,
    );
  render(null);
  return {
    set: render,
    dispose: () => root.unmount(),
  };
}

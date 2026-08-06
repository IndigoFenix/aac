// server/services/dual-agent/board-launch.ts
//
// LAUNCH BUTTONS — a board button whose press OPENS something (an app, a
// permitted website, or a pre-built board) instead of voicing its speech.
//
// The Coordinator owns the GATING (which targets this session permits, which
// board a key resolves to) because that needs session state. What lives here
// are the two decisions that don't: how a gated target becomes the client-facing
// action, and which board cover art the device can actually draw.

import type { BoardButtonAction } from "@shared/schema";
import type { BoardButtonOpen } from "./agent-events";

/** A board's cover art as carried on `availableBoards` — the two fields the
 *  AAC's button renderer understands. */
export interface BoardCover {
  iconRef?: string;
  symbolPath?: string;
}

/**
 * The client-facing action for a board button, from its (already gated) launch
 * target. Precedence matches `extractButtonOpen`: website → app → board. A
 * button with no launch target speaks.
 */
export function buttonActionFromOpen(
  open: BoardButtonOpen | undefined,
  speakText: string,
): BoardButtonAction {
  if (open?.website) return { type: "open_website", url: open.website };
  if (open?.app) return { type: "open_app", appId: open.app };
  if (open?.board) return { type: "open_board", boardKey: open.board };
  return { type: "speak", text: speakText };
}

/**
 * A board's cover reduced to what the device can actually DRAW, or undefined.
 *
 * The AAC renders `symbolPath` straight into an `<img src>`, so only a real URL
 * works there: the builder's default `"syntaacx_logo"` placeholder and legacy
 * Widgit/SymbolStix paths (`"[widgit]…​.emf"`) would render as a broken image —
 * worse than no icon at all. An emoji `iconRef` always works; a FontAwesome
 * class (`fa…`) is the empty-speech-bubble sentinel, not a picture.
 */
export function renderableBoardCover(cover: BoardCover | undefined): BoardCover | undefined {
  if (!cover) return undefined;
  if (cover.iconRef && !cover.iconRef.startsWith("fa")) return { iconRef: cover.iconRef };
  const path = cover.symbolPath ?? "";
  if (path.startsWith("/api/") || path.startsWith("http")) return { symbolPath: path };
  return undefined;
}

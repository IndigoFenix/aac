// server/services/dual-agent/board-launch.ts
//
// LAUNCH BUTTONS — a board button whose press OPENS something (an app, a
// permitted website, or a pre-built board) or FIRES a smart-home action,
// instead of voicing its speech.
//
// The Coordinator owns the GATING (which targets this session permits, which
// board a key resolves to) because that needs session state. What lives here
// are the decisions that don't: how a gated target becomes the client-facing
// action, and which of the target's own artwork the device can actually draw.

import type { BoardButtonAction, HomeAction } from "@shared/schema";
import { findHomeAction } from "@shared/home-actions";
import type { BoardButtonOpen } from "./agent-events";

/** A board's cover art as carried on `availableBoards` — the two fields the
 *  AAC's button renderer understands. */
export interface BoardCover {
  iconRef?: string;
  symbolPath?: string;
}

/**
 * The client-facing action for a board button, from its (already gated) launch
 * target. Precedence matches `extractButtonOpen`: website → app → board → home.
 * A button with no launch target speaks.
 *
 * `homeActions` is the student's normalized slot list; a `home` target is
 * resolved against its ENABLED entries (findHomeAction) so the action carries
 * the phrase and name the client needs. An unknown or disabled id degrades to
 * a plain speak button rather than a dead press.
 *
 * What the button carries depends on WHERE the slot actuates:
 *  - `spoken` → `command`, the phrase the client utters itself.
 *  - `alexa`/`google` → `announce`, what the device says while the SERVER
 *    actuates. Resolved to the label here, so the client never has to know the
 *    defaulting rule.
 * Never both. `requiresConfirmation` rides along either way so the client can
 * render its confirm step before sending the press.
 */
export function buttonActionFromOpen(
  open: BoardButtonOpen | undefined,
  speakText: string,
  homeActions: HomeAction[] = [],
): BoardButtonAction {
  if (open?.website) return { type: "open_website", url: open.website };
  if (open?.app) return { type: "open_app", appId: open.app };
  if (open?.board) return { type: "open_board", boardKey: open.board };
  if (open?.home) {
    const action = findHomeAction(homeActions, open.home);
    // `speakText` is deliberately DROPPED here: the client utters `command`
    // verbatim, because the wake-word phrase only works said exactly.
    // A spoken slot with no phrase would be a silent dead press — normalization
    // already drops those, so this only guards hand-built lists.
    if (action && (action.type !== "spoken" || action.command)) {
      const button: BoardButtonAction = {
        type: "run_home_action",
        actionId: action.id,
        label: action.label,
      };
      if (action.type === "spoken") button.command = action.command;
      else button.announce = action.announce || action.label;
      if (action.requiresConfirmation) button.requiresConfirmation = true;
      return button;
    }
  }
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

/**
 * An emoji-only target icon reduced to what a launch button can DRAW, or
 * undefined. The counterpart to `renderableBoardCover` for the targets whose
 * artwork is a bare emoji rather than an image: `open.home` smart-home slots
 * (a slot's `icon`) and `open.app` built-in apps (the app registry's `icon`).
 *
 * There is no image path to validate here, so the only rule that carries over
 * is the FontAwesome one: `fa…` is the empty-speech-bubble sentinel, not a
 * picture.
 */
export function renderableEmojiIcon(icon: string | undefined): BoardCover | undefined {
  const trimmed = (icon ?? "").trim();
  if (!trimmed || trimmed.startsWith("fa")) return undefined;
  return { iconRef: trimmed };
}

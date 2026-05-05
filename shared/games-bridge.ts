// Message contract between the platform (clinician/AAC clients) and games
// embedded in an iframe. Both sides import this file via `@shared/games-bridge`.
//
// Games run standalone when no parent is present — `sendToParent` is a no-op
// in that case, and `onPlatformMessage` simply never fires.

export interface BridgeMessageBase {
  /** Stamped by `sendToParent` / `sendToGame` so receivers can ignore stray window messages. */
  __aivotaGameBridge: true;
}

// ── Platform → Game ─────────────────────────────────────────────────────────

export type PlatformMessage = BridgeMessageBase & (
  /**
   * First message the platform sends after the iframe loads. `licenseToken` is
   * a short-lived signed token the platform mints when it has verified the
   * user's license; games that require licensing must refuse to start without
   * a valid token. Standalone access is gated separately at the server layer.
   */
  | { type: "init"; locale?: string; studentDisplayName?: string; licenseToken?: string }
  | { type: "expression"; emotion: string; confidence: number }
  | { type: "people_present"; names: string[] }
  | { type: "ai_comment"; text: string }
  /**
   * Gaze position in **iframe-local pixel coordinates** (already converted by
   * the platform). `mode === "off"` means no gaze data is being produced.
   */
  | { type: "gaze"; x: number; y: number; mode: "off" | "eyegaze" | "mouse" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "request_close" }
);

// ── Game → Platform ─────────────────────────────────────────────────────────

export type GameMessage = BridgeMessageBase & (
  | { type: "ready"; gameId: string; version?: string }
  | { type: "player_action"; action: string; meta?: Record<string, unknown> }
  | { type: "score"; value: number; delta?: number }
  | { type: "level_changed"; level: number }
  | { type: "session_end"; reason: "won" | "quit" | "error"; summary?: string }
  | { type: "request_close" }
);

// ── Helpers ─────────────────────────────────────────────────────────────────

const TAG = "__aivotaGameBridge" as const;

function isBridgeMessage(value: unknown): value is BridgeMessageBase & { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[TAG] === true &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

/** Send a message from a game up to its embedding platform. No-op when running standalone. */
export function sendToParent(msg: Omit<GameMessage, "__aivotaGameBridge">): void {
  if (typeof window === "undefined" || window.parent === window) return;
  const tagged = { ...msg, [TAG]: true } as GameMessage;
  // Origin "*" is fine here — the receiver validates its own origin allowlist.
  window.parent.postMessage(tagged, "*");
}

/** Send a message from the platform down to an embedded game iframe. */
export function sendToGame(
  iframe: HTMLIFrameElement,
  msg: Omit<PlatformMessage, "__aivotaGameBridge">,
  targetOrigin = "*",
): void {
  const win = iframe.contentWindow;
  if (!win) return;
  const tagged = { ...msg, [TAG]: true } as PlatformMessage;
  win.postMessage(tagged, targetOrigin);
}

/** Subscribe (in a game) to messages from the platform. Returns an unsubscribe fn. */
export function onPlatformMessage(
  cb: (msg: PlatformMessage) => void,
  allowedOrigins?: string[],
): () => void {
  const handler = (event: MessageEvent) => {
    if (allowedOrigins && !allowedOrigins.includes(event.origin)) return;
    if (!isBridgeMessage(event.data)) return;
    cb(event.data as PlatformMessage);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Subscribe (in the platform) to messages from a specific iframe. */
export function onGameMessage(
  iframe: HTMLIFrameElement,
  cb: (msg: GameMessage) => void,
  allowedOrigins?: string[],
): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (allowedOrigins && !allowedOrigins.includes(event.origin)) return;
    if (!isBridgeMessage(event.data)) return;
    cb(event.data as GameMessage);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

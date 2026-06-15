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
  | { type: "init"; locale?: string; studentDisplayName?: string; licenseToken?: string; dwellMs?: number; params?: Record<string, unknown> }
  | { type: "expression"; emotion: string; confidence: number }
  | { type: "people_present"; names: string[] }
  | { type: "ai_comment"; text: string }
  /**
   * Gaze position in **iframe-local pixel coordinates** (already converted by
   * the platform). `mode === "off"` means no gaze data is being produced.
   */
  | { type: "gaze"; x: number; y: number; mode: "off" | "eyegaze" | "mouse" }
  /**
   * Hands the game its content payload (e.g. a goal-tree game definition).
   * Games that accept payloads must validate them and keep running their
   * built-in content when the payload is rejected.
   */
  | { type: "load_game"; game: unknown }
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
  /**
   * Free-form observation the embedding platform forwards to the live AI
   * session as a `[GAME OBSERVATION]` context update. `surface` is any
   * JSON-serializable shape — game and AI co-evolve without a schema.
   */
  | { type: "ai_observation"; surface: unknown }
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

/**
 * Omit that distributes over unions. Plain `Omit` collapses a union to its
 * common keys, which made every variant-specific field ("action", "gameId",
 * …) a type error at sendToParent/sendToGame call sites.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A platform→game message as passed to `sendToGame` (the `__aivotaGameBridge`
 *  tag is stamped by the helper). Distributes over the union so variant-specific
 *  fields survive — plain `Omit` would collapse it to the common keys. */
export type PlatformMessageInput = DistributiveOmit<PlatformMessage, "__aivotaGameBridge">;
/** A game→platform message as passed to `sendToParent`. */
export type GameMessageInput = DistributiveOmit<GameMessage, "__aivotaGameBridge">;

/** The embedding parent's origin, from the referrer the browser set when it
 *  loaded this iframe. Used as the postMessage targetOrigin so game→platform
 *  messages aren't broadcast to whatever document occupies the frame. Falls
 *  back to "*" only when the referrer is unavailable (e.g. no-referrer policy). */
function parentTargetOrigin(): string {
  try {
    if (typeof document !== "undefined" && document.referrer) {
      return new URL(document.referrer).origin;
    }
  } catch { /* ignore */ }
  return "*";
}

/** The iframe's own origin, used as the default targetOrigin / inbound origin
 *  allowlist so platform↔game messages (incl. the license token) aren't sent to
 *  or accepted from any other origin. Falls back to "*" if it can't be resolved. */
function iframeTargetOrigin(iframe: HTMLIFrameElement): string {
  try {
    if (iframe.src) return new URL(iframe.src, typeof window !== "undefined" ? window.location.href : undefined).origin;
  } catch { /* ignore */ }
  return "*";
}

/** Origin allowlist (the iframe's own origin) for inbound game→platform
 *  messages, or undefined when it can't be resolved (then the source check
 *  alone applies — preserving prior behavior). */
function originAllowlist(iframe: HTMLIFrameElement): string[] | undefined {
  const origin = iframeTargetOrigin(iframe);
  return origin === "*" ? undefined : [origin];
}

/** Send a message from a game up to its embedding platform. No-op when running standalone. */
export function sendToParent(msg: GameMessageInput): void {
  if (typeof window === "undefined" || window.parent === window) return;
  const tagged = { ...msg, [TAG]: true } as GameMessage;
  window.parent.postMessage(tagged, parentTargetOrigin());
}

/** Send a message from the platform down to an embedded game iframe. Defaults to
 *  the iframe's own origin (never "*") so payloads like the license token aren't
 *  leaked to a different document if the frame ever navigates cross-origin. */
export function sendToGame(
  iframe: HTMLIFrameElement,
  msg: PlatformMessageInput,
  targetOrigin?: string,
): void {
  const win = iframe.contentWindow;
  if (!win) return;
  const tagged = { ...msg, [TAG]: true } as PlatformMessage;
  win.postMessage(tagged, targetOrigin ?? iframeTargetOrigin(iframe));
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
    // Default the origin allowlist to the iframe's own origin when the caller
    // doesn't supply one, instead of accepting any origin.
    const origins = allowedOrigins ?? originAllowlist(iframe);
    if (origins && !origins.includes(event.origin)) return;
    if (!isBridgeMessage(event.data)) return;
    cb(event.data as GameMessage);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

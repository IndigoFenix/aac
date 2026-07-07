// Message contract between the platform (clinician/AAC clients) and games
// embedded in an iframe. Both sides import this file via `@shared/games-bridge`.
//
// Games run standalone when no parent is present — `sendToParent` is a no-op
// in that case, and `onPlatformMessage` simply never fires.

export interface BridgeMessageBase {
  /** Stamped by `sendToParent` / `sendToGame` so receivers can ignore stray window messages. */
  __aivotaGameBridge: true;
}

/**
 * One locked option a game pins onto the AAC's response board (a SENTENCE
 * BUTTON). The student presses it like any board button; the platform reports the
 * `id` back via `board_option_selected`. `glyph` is an optional composed AAC
 * glyph string so the button renders as the real symbol the student is learning.
 */
export interface BoardOption {
  id: string;
  label: string;
  glyph?: string;
  /** Proper per-locale text the board SPEAKS on press (the student's own
   *  statement, translated). `label`/`glyph` stay language-invariant. */
  spokenText?: string;
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
   * The AAC AI's live activity, pushed whenever it changes so a cooperative app
   * can react (e.g. pause its own audio while the AI speaks, show a "thinking"
   * cue). `speaking` = the AI voice is currently playing; `thinking` = an agent
   * (Speaker / Board Manager / interpret) is working. Coarse by design — apps
   * shouldn't couple to the AAC's internal agent structure.
   */
  | { type: "ai_state"; speaking: boolean; thinking: boolean }
  /**
   * The AAC avatar's current emote, so an app can mirror the AI's mood on its
   * own characters. One of the avatar's three coarse states.
   */
  | { type: "ai_emote"; emote: "happy" | "sad" | "neutral" }
  /**
   * Correlated reply to a game→platform `ai_select` (and, in future, other
   * structured `ai_request`s that opt into a machine-readable answer). Matched
   * by `requestId`. For `ai_select`, `ok:true` carries `data:{ selectedId,
   * reason? }`; `ok:false` carries `error`. A free-text `ai_request` is still
   * answered as spoken `ai_comment`, NOT this message — so apps should handle a
   * missing `ai_response` gracefully.
   */
  | { type: "ai_response"; requestId: string; ok: boolean; text?: string; data?: unknown; error?: string }
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
  /**
   * The student pressed one of the options the game pinned via `set_board_options`.
   * `id` is the option's id. Sent only while options are locked; clearing them
   * stops further reports.
   */
  | { type: "board_option_selected"; id: string }
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
  /**
   * ACTIVELY ask the AAC AI to respond to the student about something now — a
   * directed nudge, stronger than the passive `ai_observation`. `prompt` frames
   * what to react to (e.g. "the student just matched all the animals — celebrate
   * with them"). The AI's answer arrives as a spoken `ai_comment` (there is no
   * synchronous return today). `requestId` is optional and reserved for a future
   * correlated `ai_response`; it is safe to omit.
   *
   * Fire sparingly — every request drives the live session (latency + cost).
   */
  | { type: "ai_request"; prompt: string; requestId?: string }
  /**
   * Ask the AAC AI to CHOOSE ONE of a set of options the app provides, and reply
   * with the chosen id — a bounded, structured selection (e.g. "here are 12
   * books; pick the best one for this student"). The platform answers with a
   * correlated `ai_response` carrying `data:{ selectedId, reason? }`. `selectedId`
   * is guaranteed to be one of the provided `options[].id`.
   *
   * `instruction` steers the choice (e.g. "the student loves dinosaurs and
   * adventure"). The app supplies its own relevance signal here — no student PHI
   * leaves the platform. Requires NO license. Rate-limited + metered server-side,
   * so fire only on real decisions.
   */
  | {
      type: "ai_select";
      requestId: string;
      options: Array<{ id: string; label: string; description?: string }>;
      instruction?: string;
    }
  /**
   * Lock the AAC response board (the side SENTENCE BUTTONs) to these options so
   * the student answers a puzzle on the REAL communication board — teaching its
   * use. `prompt` is the question being asked (for context / narration). The
   * platform reports a press back as `board_option_selected`. Re-sending replaces
   * the set; `clear_board_options` releases it back to the AI.
   */
  | { type: "set_board_options"; options: BoardOption[]; prompt?: string }
  | { type: "clear_board_options" }
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

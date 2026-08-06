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
  /** THE TEXT ON THE BUTTON — display, and therefore in the student's language
   *  wherever the game can name the thing (the world engine renders it through
   *  its own lexicons). The platform shows this verbatim: a game that leaves an
   *  English glyph key here puts an English word on a Hebrew board. `id` is the
   *  invariant handle — it is what comes back on press — and `glyph` is the
   *  picture; neither is ever read as text. */
  label: string;
  glyph?: string;
  /** Proper per-locale text the board SPEAKS on press (the student's own
   *  statement, translated). `glyph` stays language-invariant. */
  spokenText?: string;
}

/**
 * One word the game engine's surfacer offers the AAC sentence builder. `key`
 * is the canonical engine-lexicon word — composing sentences out of keys keeps
 * them parseable by the game's own engine. `glyph` is a renderable composed
 * glyph string (same grammar the board buttons use).
 */
export interface BuilderWord {
  key: string;
  label: string;
  glyph?: string;
  /** Engine category bucket, e.g. "who" | "do" | "what" | "where". */
  category?: string;
  /** Noun kind when the word is a noun ("person" | "creature" | "item" | "place"). */
  kind?: string;
  /** For persons/creatures: present in the current scene (prioritize + badge). */
  present?: boolean;
}

/** A sub-category chip within the active category (e.g. the engine lexicon's
 *  word groups). `id` is echoed back as `builder_state.group`. */
export interface BuilderGroup {
  id: string;
  /** Localized display label (the engine's lang layer renders it). */
  label: string;
  /** Optional glyph/emoji face for the chip — the best example of the group. */
  glyph?: string;
  /** The chip's full face: up to 3 member glyphs, best example first, drawn as
   *  a cluster so a category shows what it CONTAINS rather than one stand-in
   *  word. Clients that draw a single face use `glyph` (= `glyphs[0]`). */
  glyphs?: string[];
}

/** The engine's answer to a `builder_state`: what the sentence builder should
 *  offer for the current partial sentence. */
export interface BuilderSurface {
  /** Ranked main-grid words. */
  buttons: BuilderWord[];
  /** Modifier rail for the active head (compose onto it with "."). */
  modifiers?: BuilderWord[];
  /** Category chips the game can serve (send builder_state.category to filter).
   *  These ARE the builder's tab set while an engine drives it — the client
   *  must not substitute its own category scheme. */
  categories?: string[];
  /** Sub-category chips for the ACTIVE category (send builder_state.group to
   *  filter within it). Mirrors the engine's own vocabulary-menu hierarchy. */
  groups?: BuilderGroup[];
  /** True when the current sentence already parses as complete/sayable. */
  complete?: boolean;
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
   * the platform). `mode === "off"` means no usable position for the game (the
   * coordinates are then -1,-1) — treat it as "not pointing at anything".
   *
   * `away` splits the two reasons a position is missing, for games that want to
   * react differently (optional — ignoring it keeps "off" behavior):
   *   away: true  — gaze IS tracked, the person is just looking somewhere else
   *                 on the screen (the AAC's sidebar, a video tile). A KNOWN
   *                 look-away: drop any aim at once.
   *   away absent — no data at all (blink, dropped frames, tracker lost). Not
   *                 a look-away, so a game may hold its last aim briefly.
   */
  | { type: "gaze"; x: number; y: number; mode: "off" | "eyegaze" | "mouse"; away?: boolean }
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
   * stops further reports. `voiced` is true when the platform already voiced the
   * press (student-voice TTS or local speech) — the game must then NOT voice it
   * itself, only execute it. Absent/false means the game owns the voicing.
   */
  | { type: "board_option_selected"; id: string; voiced?: boolean }
  /**
   * A composed glyph SENTENCE the student produced OUTSIDE the game — an
   * LLM-authored board button or the sentence builder — forwarded so it can take
   * effect in-world. The game parses it with its OWN (vendored) engine — parse
   * authority lives game-side so the platform's lexicon version can never
   * disagree with the game's. An unparsable sentence simply has no in-game
   * effect (the student still said it). The game answers with `glyph_result`.
   * `voiced` as on `board_option_selected`.
   */
  | { type: "glyph_input"; glyph: string; requestId?: string; voiced?: boolean }
  /**
   * The AAC sentence builder asking the game's engine what to offer for the
   * current partial sentence. `glyph` is the partial composed sentence (may be
   * empty), `category` an optional tab filter (one of the game's advertised
   * `BuilderSurface.categories`). The game answers with a correlated
   * `builder_surface`. Fired per builder change — games should answer from the
   * pure surfacer, no world mutation.
   */
  | { type: "builder_state"; requestId: string; glyph: string; category?: string; group?: string }
  /**
   * Multiplayer session identity for a world-engine game running inside a call.
   * `selfId` is this participant's stable network id (personId); `role` is
   * "owner" when this iframe must run the authoritative sim (and stream world
   * state), "follower" when it must freeze its sim and replicate. Re-sent on
   * every roster/ownership change — a role FLIP means the game should reboot
   * its world (deterministic from its bundled spec, so a reboot is cheap).
   * Never sent for solo play: no `world_session` = single-player, sim your own.
   */
  | { type: "world_session"; selfId: string; role: "owner" | "follower"; peers?: Array<{ id: string; name?: string }> }
  /**
   * Inbound world-state packets from peer `fromId`, ferried verbatim from the
   * call mesh's UNRELIABLE "world" channel. `msgs` is an engine-versioned
   * payload (WorldNetMessage[]) the platform never inspects — the game's own
   * (vendored) engine applies it and must tolerate unknown message kinds.
   */
  | { type: "world_data"; fromId: string; msgs: unknown[] }
  /**
   * Inbound RELIABLE game command from peer `fromId` (a follower's board press
   * or built sentence, a claim notice, …), ferried from the call's reliable
   * data channel. Opaque to the platform; the game drops commands not meant
   * for its role.
   */
  | { type: "world_cmd"; fromId: string; cmd: unknown }
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
  /**
   * THE GAME IS MAKING SPEECH SOUND right now (its own in-app voice — an NPC
   * line, a narrator). Send `speaking:true` as the utterance starts and
   * `speaking:false` when it ends or is cancelled.
   *
   * The platform GATES ITS MICROPHONE while this is true: game audio leaves the
   * same speaker the AAC listens through, so an ungated NPC line is transcribed
   * as the student speaking and the assistant answers a sentence nobody said.
   * `ms` (estimated utterance length) bounds the hold, so a lost `false` edge —
   * the iframe closing mid-line — reopens the mic on its own.
   *
   * This is about AUDIO ONLY. It says nothing about what was said; the AI is
   * not told the line, and no turn is driven either way.
   */
  | { type: "game_speech"; speaking: boolean; ms?: number }
  /**
   * Parse verdict for a `glyph_input`, correlated by `requestId` when one was
   * given. `parsed:false` = the game's engine couldn't make a sentence of it
   * (no in-game effect happened). The platform uses this to decide whether an
   * LLM interpretation pass is still needed (builder flow) — so games should
   * answer promptly and unconditionally. `spokenText` is the engine's own
   * natural-language rendering of the sentence (its lang layer), for the
   * platform to voice when it skips the LLM.
   */
  | { type: "glyph_result"; glyph: string; parsed: boolean; requestId?: string; spokenText?: string }
  /** Correlated answer to `builder_state`. */
  | { type: "builder_surface"; requestId: string; surface: BuilderSurface }
  /**
   * The game's ambient HUD state (family members present, pocket contents,
   * status line, …) for the PLATFORM to render beside its own board — the
   * in-iframe side panel is hidden when embedded, freeing that screen edge
   * for video-chat tiles. Deliberately generic sections so games can evolve
   * what they surface without a bridge change (the client is a display
   * engine). Re-sent whole on every change; empty `sections` clears it.
   */
  | {
      type: "world_hud";
      sections: Array<{
        id: string;
        /** Localized section title (optional — compact strips may omit it). */
        title?: string;
        /**
         * How the section wants to READ (the game knows what its data means;
         * the platform just draws it):
         *   "chips" — one dense inline row of small icon+number chips (a
         *             city/status ribbon; the top strip).
         *   "cards" — a box per entry, icon over name (creatures/people).
         *   "items" — a compact icon grid with count badges (inventory).
         * Absent = "cards".
         */
        layout?: "chips" | "cards" | "items";
        items: Array<{
          id: string;
          label: string;
          /** Engine glyph key (renders via the glyph system when resolvable). */
          glyph?: string;
          /** Emoji/char face fallback. */
          emoji?: string;
          /** Small secondary line (activity, mood, …). */
          note?: string;
          /** Stack count for pocket-style items. */
          count?: number;
          /** Highlighted (e.g. the currently addressed family member). */
          active?: boolean;
          /** Present but not HERE (away working/shopping) — drawn faded. */
          dim?: boolean;
        }>;
      }>;
    }
  /**
   * Outbound world-state packets for the call mesh's UNRELIABLE "world"
   * channel (owner: avatar/creature bodies + speech; any peer: its own spark).
   * The platform fans them out verbatim — engine-versioned, never inspected.
   */
  | { type: "world_data"; msgs: unknown[] }
  /**
   * Outbound RELIABLE game command for the call's reliable data channel. When
   * `toId` is set only that peer should act on it (receivers drop others');
   * absent = every peer. Used for follower→owner command relay and rare
   * events (spark→body claims), never for per-frame state.
   */
  | { type: "world_cmd"; cmd: unknown; toId?: string }
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

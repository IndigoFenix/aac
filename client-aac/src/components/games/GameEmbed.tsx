// Iframe wrapper for games that live under /games/<id>/. Bridges postMessage
// in both directions using shared/games-bridge.
//
// AI integration: when an embedded game posts `{type: "ai_observation", surface: ...}`,
// the embed forwards `surface` to the live dual-agent session via
// `dualAgent.sendContextOnly(...)` — the AI sees it as a `[SYSTEM CONTEXT UPDATE]`
// and is free to weave it into its conversation with the student. Optionally,
// the AI's spoken text is forwarded back down to the game as `ai_comment` so
// the game can react visually if it wants.
//
// Works standalone too: if the component is rendered outside a
// `DualAgentProvider`, `ai_observation` messages are silently dropped (or
// surfaced via `onMessage`) instead of throwing.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  onGameMessage,
  sendToGame,
  type BoardOption,
  type GameMessage,
  type PlatformMessageInput,
} from "@shared/games-bridge";
import { API_BASE_URL } from "@/lib/api-base";
import { apiPost } from "@/lib/queryClient";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { useLanguage } from "@/contexts/LanguageContext";

export interface GameEmbedHandle {
  /** Push a structured message down to the embedded game. */
  send: (msg: PlatformMessageInput) => void;
}

export interface GameEmbedProps {
  /** Stable game id; matches the folder name under /games/. Used for logging only. */
  gameId: string;
  /** URL to load in the iframe — typically `/games/<id>/`. */
  src: string;
  /** Optional className for the wrapping element. */
  className?: string;
  /** Fired for every message from the game. AI-observation messages are still surfaced here AFTER being forwarded to the AI. */
  onMessage?: (msg: GameMessage) => void;
  /** Fired when the game requests close (`request_close`) or sends `session_end`. */
  onClose?: (reason?: "won" | "quit" | "error" | "request_close") => void;
  /**
   * If set, the AI's spoken text is forwarded down to the game as `ai_comment`
   * messages. Default: true. Set to false for games that don't want narration.
   */
  forwardAiTextToGame?: boolean;
  /**
   * Origin allowlist for messages from the iframe. When omitted, same-origin
   * is assumed. Pass an array of origins (e.g. `["https://aivota.app"]`) to
   * support cross-origin embeds.
   */
  allowedOrigins?: string[];
  /**
   * If set and a gaze provider is mounted, forward gaze events to the game as
   * `gaze` messages. Throttled to ~30 Hz. Default: false (most games don't
   * need gaze; bubbles is the exception).
   */
  forwardGaze?: boolean;
  /**
   * Content payload sent to the game as a `load_game` message right after
   * `init` (e.g. a goal-tree game definition). The game validates it and
   * answers with `player_action: game_loaded` or `load_game_rejected`.
   */
  gamePayload?: unknown;
  /**
   * Startup parameters (resolved server-side from the conversation/student)
   * carried on the `init` message (e.g. space_trader's `{ startLevel }`). The
   * game reads what it understands and ignores the rest.
   */
  initParams?: Record<string, unknown>;
  /**
   * Fired when the game locks the AAC response board to a set of options
   * (`set_board_options`) or releases it (`clear_board_options` → null). The host
   * shows them as the side SENTENCE BUTTONs and, on a press, sends
   * `board_option_selected` back down via this embed's imperative `send`.
   */
  onBoardOptions?: (options: BoardOption[] | null, prompt?: string) => void;
}

const GameEmbed = forwardRef<GameEmbedHandle, GameEmbedProps>(function GameEmbed(
  { gameId, src, className, onMessage, onClose, forwardAiTextToGame = true, allowedOrigins, forwardGaze = false, gamePayload, initParams, onBoardOptions },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dualAgent = useDualAgentContextOptional();
  // The default context value has gazePosition: null, so this is safe even
  // when no provider is mounted (e.g. path-bypass routes).
  const dwell = useEyeTrackingDwell();
  // THE STUDENT'S language, not the device's. LanguageContext is the AAC UI
  // locale, and home.tsx drives it from the student profile's primaryLanguage —
  // so a Hebrew student on an English-locale tablet gets a Hebrew world. (This
  // used to send navigator.language, which is the DEVICE's setting and had
  // nothing to do with the child.) The clinician embed does the same thing:
  // client/src/features/call/CallGameEmbed.tsx.
  const { language } = useLanguage();
  const [iframeReady, setIframeReady] = useState(false);

  // Expose a single imperative `send` method to parent components.
  useImperativeHandle(
    ref,
    () => ({
      send: (msg) => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        sendToGame(iframe, msg);
      },
    }),
    [],
  );

  // Format a structured surface into a single text block the AI can read. JSON
  // is the broadest contract — games can send any shape and the AI sees it
  // verbatim, so they can co-evolve without a schema dance.
  const formatSurface = useCallback((surface: unknown): string => {
    let body: string;
    try {
      body = typeof surface === "string" ? surface : JSON.stringify(surface, null, 2);
    } catch {
      body = String(surface);
    }
    return `[GAME OBSERVATION] (game: ${gameId})\n${body}`;
  }, [gameId]);

  // Listen for messages from the iframe. We re-bind whenever the iframe
  // remounts so `event.source === iframe.contentWindow` matches.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const off = onGameMessage(
      iframe,
      (msg) => {
        if (msg.type === "ready") {
          setIframeReady(true);
        }

        if (msg.type === "request_close") {
          onClose?.("request_close");
        } else if (msg.type === "session_end") {
          onClose?.(msg.reason);
        }

        // AI surface — forward to live session if available.
        if (msg.type === "ai_observation" && dualAgent?.sendContextOnly) {
          dualAgent.sendContextOnly(formatSurface(msg.surface));
        }

        // Active AI request — a directed nudge asking the AI to respond to the
        // student now. Routed as a context injection framed as a request; the
        // AI's reply comes back through the normal `ai_comment` stream.
        if (msg.type === "ai_request" && dualAgent?.sendContextOnly) {
          const prompt = typeof msg.prompt === "string" ? msg.prompt.trim() : "";
          if (prompt) dualAgent.sendContextOnly(`[GAME REQUEST] (game: ${gameId})\n${prompt}`);
        }

        // Structured AI selection — the app asks the AI to pick one of its
        // options; we call the gated endpoint (as the trusted, authenticated
        // host) and reply with a correlated `ai_response`. Fire-and-forget:
        // onGameMessage is sync, so run the round-trip in a detached async task.
        if (msg.type === "ai_select") {
          const target = iframeRef.current;
          const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
          const options = Array.isArray(msg.options) ? msg.options : [];
          if (target && requestId && options.length >= 2) {
            void (async () => {
              try {
                const resp = await apiPost<{ ok: boolean; selectedId: string; reason?: string; error?: string }>(
                  "/api/aac/app-ai/select",
                  { options, instruction: msg.instruction, sessionId: dualAgent?.sessionId ?? undefined },
                );
                sendToGame(target, {
                  type: "ai_response",
                  requestId,
                  ok: true,
                  data: { selectedId: resp.selectedId, reason: resp.reason },
                });
              } catch (e: any) {
                sendToGame(target, { type: "ai_response", requestId, ok: false, error: e?.message || "selection failed" });
              }
            })();
          } else if (target && requestId) {
            sendToGame(target, { type: "ai_response", requestId, ok: false, error: "invalid ai_select (need requestId + at least 2 options)" });
          }
        }

        // Board lock: the game pins (or releases) the AAC response board options.
        if (msg.type === "set_board_options") onBoardOptions?.(msg.options, msg.prompt);
        else if (msg.type === "clear_board_options") onBoardOptions?.(null);

        onMessage?.(msg);
      },
      allowedOrigins,
    );
    return () => off();
  }, [allowedOrigins, dualAgent, formatSurface, onClose, onMessage, onBoardOptions]);

  // Once the game says it's ready, send an `init` message. Carries locale and
  // (eventually) a license token. The token plumbing is wired but no minting
  // endpoint exists yet — left as a forward-compat hook.
  //
  // `language` is in the deps on purpose: a world-engine game chooses its lang
  // layer when the world BUILDS (dollhouse waits for `init` before loadSpec), so
  // the locale has to be the one in hand at handshake time. Re-sending on a
  // later change is harmless — the standing world keeps its language, but
  // anything the game still translates through `initLocale` follows along.
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    // Inferred (not annotated as Omit<PlatformMessage, …> — plain Omit over a
    // union collapses to the common keys and drops locale/dwellMs/params).
    const init = {
      type: "init" as const,
      locale: language,
      // Games with their own dwell logic honour the platform's configured dwell time.
      dwellMs: dwell?.dwellTimeMs,
      ...(initParams ? { params: initParams } : {}),
    };
    sendToGame(iframe, init);
    if (gamePayload !== undefined) {
      sendToGame(iframe, { type: "load_game", game: gamePayload });
    }
  }, [iframeReady, language, dwell?.dwellTimeMs, gamePayload, initParams]);

  // Forward EYEGAZE position into the iframe's local coordinate space at
  // ~30 Hz. Coordinates produced by the dwell context are page-space; we
  // subtract the iframe's bounding rect so games see iframe-local pixels.
  //
  // Read the dwell context through a ref so the loop binds ONCE and always
  // sees the LIVE sample — capturing it in the effect closure re-sent a
  // FROZEN position between React renders, and under render stalls (the
  // AAC's camera-ML load) that stale point periodically yanked the game's
  // aim to wherever the eyes had been. Mouse mode is deliberately NOT
  // forwarded: a pointer over the iframe already fires native events inside
  // it, and a forwarded (possibly stale) copy only fights them.
  const dwellGazeRef = useRef(dwell);
  dwellGazeRef.current = dwell;
  useEffect(() => {
    if (!forwardGaze) return;
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let rafId = 0;
    let lastSent = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastSent < 33) return;
      lastSent = now;
      const d = dwellGazeRef.current;
      const pos = d?.mode === "eyegaze" ? d.gazePosition : null;
      if (!pos) {
        // No position at all — a blink or a dropped tracker frame. The game may
        // hold its last aim through it; we're not asserting a look-away.
        sendToGame(iframe, { type: "gaze", x: -1, y: -1, mode: "off" });
        return;
      }
      const rect = iframe.getBoundingClientRect();
      const x = pos.x - rect.left;
      const y = pos.y - rect.top;
      // Gaze tracked but OUTSIDE the iframe (sidebar, quick buttons) — still
      // "off" for the game (never an aim point at its edge), flagged `away` so
      // a game that cares can drop its aim at once instead of holding it.
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        sendToGame(iframe, { type: "gaze", x: -1, y: -1, mode: "off", away: true });
        return;
      }
      sendToGame(iframe, { type: "gaze", x, y, mode: "eyegaze" });
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [forwardGaze, iframeReady]);

  // Forward AI text back to the game as it streams. We track the last forwarded
  // value so we don't replay the same message; the live session accumulates
  // text within a turn and clears it between turns.
  // Only `assistant` captions qualify: the same slot also carries the student's
  // own words, and echoing those back as an "ai_comment" would have the game
  // react to the student as if the AI had spoken.
  const aiCaption = dualAgent?.currentMessage?.role === "assistant"
    ? dualAgent.currentMessage.content
    : "";
  const lastAiTextRef = useRef<string>("");
  useEffect(() => {
    if (!forwardAiTextToGame) return;
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (!aiCaption || aiCaption === lastAiTextRef.current) return;
    lastAiTextRef.current = aiCaption;
    sendToGame(iframe, { type: "ai_comment", text: aiCaption });
  }, [aiCaption, forwardAiTextToGame, iframeReady]);

  // Push the AI's live activity (speaking / thinking) down to the game whenever
  // it changes — so a cooperative app can duck its audio or show a cue. Coarse
  // by design; gated behind the same flag as ai_comment.
  const speaking = !!dualAgent?.isPlaying;
  const proc = dualAgent?.processing;
  const thinking = !!(proc && (proc.speaker || proc.board || proc.interpret));
  const lastAiStateRef = useRef<string>("");
  useEffect(() => {
    if (!forwardAiTextToGame || !iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const key = `${speaking}|${thinking}`;
    if (key === lastAiStateRef.current) return;
    lastAiStateRef.current = key;
    sendToGame(iframe, { type: "ai_state", speaking, thinking });
  }, [speaking, thinking, forwardAiTextToGame, iframeReady]);

  // Mirror the AAC avatar's emote so a game can reflect the AI's mood.
  const emote = dualAgent?.emote ?? "neutral";
  const lastEmoteRef = useRef<string>("");
  useEffect(() => {
    if (!forwardAiTextToGame || !iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (emote === lastEmoteRef.current) return;
    lastEmoteRef.current = emote;
    sendToGame(iframe, { type: "ai_emote", emote });
  }, [emote, forwardAiTextToGame, iframeReady]);

  // Resolve `src` against VITE_API_URL when it's a same-origin path. In dev
  // the AAC client runs on port 5174 while the games are served by express on
  // port 5000 — without this, the iframe would resolve `/games/...` against
  // 5174 and hit the AAC's SPA fallback (rendering the AAC inside itself).
  const resolvedSrc = useMemo(() => {
    if (!src.startsWith("/")) return src;
    return API_BASE_URL + src;
  }, [src]);

  // Memoize the iframe element so it isn't torn down on unrelated re-renders.
  const iframeEl = useMemo(
    () => (
      <iframe
        ref={iframeRef}
        src={resolvedSrc}
        title={`Aivota game: ${gameId}`}
        // Sandbox keeps games to themselves but allows scripts and same-origin
        // (so cookies/session reach the gated /games/ static handler), forms (so
        // the games auth/login form can submit) plus pointer-lock for
        // fullscreen-style games. No top-navigation.
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
        allow="autoplay; fullscreen"
        className="h-full w-full border-0 block bg-black"
      />
    ),
    [gameId, resolvedSrc],
  );

  return <div className={className ?? "h-full w-full bg-black"}>{iframeEl}</div>;
});

export default GameEmbed;

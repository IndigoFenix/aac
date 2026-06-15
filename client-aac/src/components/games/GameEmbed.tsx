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
  type GameMessage,
  type PlatformMessageInput,
} from "@shared/games-bridge";
import { API_BASE_URL } from "@/lib/api-base";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";

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
}

const GameEmbed = forwardRef<GameEmbedHandle, GameEmbedProps>(function GameEmbed(
  { gameId, src, className, onMessage, onClose, forwardAiTextToGame = true, allowedOrigins, forwardGaze = false, gamePayload, initParams },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dualAgent = useDualAgentContextOptional();
  // The default context value has gazePosition: null, so this is safe even
  // when no provider is mounted (e.g. path-bypass routes).
  const dwell = useEyeTrackingDwell();
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

        onMessage?.(msg);
      },
      allowedOrigins,
    );
    return () => off();
  }, [allowedOrigins, dualAgent, formatSurface, onClose, onMessage]);

  // Once the game says it's ready, send an `init` message. Carries locale and
  // (eventually) a license token. The token plumbing is wired but no minting
  // endpoint exists yet — left as a forward-compat hook.
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    // Inferred (not annotated as Omit<PlatformMessage, …> — plain Omit over a
    // union collapses to the common keys and drops locale/dwellMs/params).
    const init = {
      type: "init" as const,
      locale: typeof navigator !== "undefined" ? navigator.language : undefined,
      // Games with their own dwell logic honour the platform's configured dwell time.
      dwellMs: dwell?.dwellTimeMs,
      ...(initParams ? { params: initParams } : {}),
    };
    sendToGame(iframe, init);
    if (gamePayload !== undefined) {
      sendToGame(iframe, { type: "load_game", game: gamePayload });
    }
  }, [iframeReady, dwell?.dwellTimeMs, gamePayload, initParams]);

  // Forward gaze position into the iframe's local coordinate space at ~30 Hz.
  // Coordinates produced by the dwell context are page-space; we subtract the
  // iframe's bounding rect so games see iframe-local pixels.
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
      const mode = dwell?.mode ?? "off";
      const pos = dwell?.gazePosition;
      if (!pos) {
        sendToGame(iframe, { type: "gaze", x: -1, y: -1, mode: "off" });
        return;
      }
      const rect = iframe.getBoundingClientRect();
      sendToGame(iframe, {
        type: "gaze",
        x: pos.x - rect.left,
        y: pos.y - rect.top,
        mode: mode === "off" ? "off" : mode,
      });
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [forwardGaze, iframeReady, dwell?.gazePosition, dwell?.mode]);

  // Forward AI text back to the game as it streams. We track the last forwarded
  // value so we don't replay the same message; the live session accumulates
  // text within a turn and clears it between turns.
  const lastAiTextRef = useRef<string>("");
  useEffect(() => {
    if (!forwardAiTextToGame) return;
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const text = dualAgent?.currentMessage?.content ?? "";
    if (!text || text === lastAiTextRef.current) return;
    lastAiTextRef.current = text;
    sendToGame(iframe, { type: "ai_comment", text });
  }, [dualAgent?.currentMessage?.content, forwardAiTextToGame, iframeReady]);

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
        // (so cookies/session reach the gated /games/ static handler) plus
        // pointer-lock for fullscreen-style games. No top-navigation.
        sandbox="allow-scripts allow-same-origin allow-pointer-lock"
        allow="autoplay; fullscreen"
        className="h-full w-full border-0 block bg-black"
      />
    ),
    [gameId, resolvedSrc],
  );

  return <div className={className ?? "h-full w-full bg-black"}>{iframeEl}</div>;
});

export default GameEmbed;

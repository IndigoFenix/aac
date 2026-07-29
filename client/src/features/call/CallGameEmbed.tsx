// client/src/features/call/CallGameEmbed.tsx
//
// Clinician-side iframe wrapper for packaged games under /games/<id>/ — the
// portable core of the AAC's GameEmbed (see
// client-aac/src/components/games/GameEmbed.tsx) without any of the student
// machinery: no dual-agent forwarding, no gaze/dwell (the clinician's mouse
// reaches the iframe natively), no ai_select round-trip. Game messages of the
// `ai_*` family are ignored here — a clinician window has no live AI session
// to feed them to.
//
// Bridges postMessage in both directions via shared/games-bridge:
//   ready → init handshake (locale + optional params), then the host pushes
//   whatever it wants through the imperative `send` handle (world_session,
//   world_data, builder_state, …) and receives everything via `onMessage`.

import {
  forwardRef,
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
import { apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";

export interface CallGameEmbedHandle {
  /** Push a structured message down to the embedded game. */
  send: (msg: PlatformMessageInput) => void;
}

export interface CallGameEmbedProps {
  /** Stable game id; matches the folder name under /games/. Used for logging only. */
  gameId: string;
  /** URL to load in the iframe — typically `/games/<id>/`. */
  src: string;
  /** Optional className for the wrapping element. */
  className?: string;
  /** Fired for every message from the game. */
  onMessage?: (msg: GameMessage) => void;
  /** Fired when the game locks the response-board dock to a set of options
   *  (`set_board_options`) or releases it (`clear_board_options` → null). */
  onBoardOptions?: (options: BoardOption[] | null, prompt?: string) => void;
  /** Fired when the game requests close (`request_close`) or sends `session_end`. */
  onClose?: (reason?: "won" | "quit" | "error" | "request_close") => void;
  /** Fired right after the ready→init handshake completes — the host can now
   *  push session state (e.g. `world_session`) into the game. */
  onReady?: () => void;
  /** Startup parameters carried on the `init` message. */
  initParams?: Record<string, unknown>;
}

const CallGameEmbed = forwardRef<CallGameEmbedHandle, CallGameEmbedProps>(function CallGameEmbed(
  { gameId, src, className, onMessage, onBoardOptions, onClose, onReady, initParams },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeReady, setIframeReady] = useState(false);
  // The game's locale is the clinician UI language (the call's working
  // language) — games prefix-match it ("he", "en-US", … all work).
  const { language } = useLanguage();

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

  // Keep callbacks in refs so the message listener never re-binds (re-binding
  // is only needed when the iframe element itself remounts).
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onBoardOptionsRef = useRef(onBoardOptions);
  onBoardOptionsRef.current = onBoardOptions;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Listen for messages from the iframe.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const off = onGameMessage(iframe, (msg) => {
      if (msg.type === "ready") {
        setIframeReady(true);
      }

      if (msg.type === "request_close") {
        onCloseRef.current?.("request_close");
      } else if (msg.type === "session_end") {
        onCloseRef.current?.(msg.reason);
      }

      // ai_* messages need a live AI session; the clinician has none. Ignore
      // them (still surfaced via onMessage below, for logging).

      // Board lock: the game pins (or releases) the dock's board options.
      if (msg.type === "set_board_options") onBoardOptionsRef.current?.(msg.options, msg.prompt);
      else if (msg.type === "clear_board_options") onBoardOptionsRef.current?.(null);

      onMessageRef.current?.(msg);
    });
    return () => off();
  }, []);

  // Once the game says it's ready, send `init`, then let the host follow up.
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    sendToGame(iframe, {
      type: "init" as const,
      locale: language,
      ...(initParams ? { params: initParams } : {}),
    });
    onReadyRef.current?.();
  }, [iframeReady, language, initParams]);

  // Resolve `src` against VITE_API_URL when it's a same-origin path — in dev
  // the clinician client runs on its own Vite port while the games are served
  // by express, so a bare `/games/...` would hit the clinician SPA fallback.
  const resolvedSrc = useMemo(() => {
    if (!src.startsWith("/")) return src;
    return apiUrl(src);
  }, [src]);

  // Memoize the iframe element so it isn't torn down on unrelated re-renders.
  const iframeEl = useMemo(
    () => (
      <iframe
        ref={iframeRef}
        src={resolvedSrc}
        title={`Aivota game: ${gameId}`}
        // Sandbox keeps games to themselves but allows scripts and same-origin
        // (so cookies/session reach the gated /games/ static handler), forms
        // plus pointer-lock for fullscreen-style games. No top-navigation.
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
        allow="autoplay; fullscreen"
        className="h-full w-full border-0 block bg-black"
      />
    ),
    [gameId, resolvedSrc],
  );

  return <div className={className ?? "h-full w-full bg-black"}>{iframeEl}</div>;
});

export default CallGameEmbed;

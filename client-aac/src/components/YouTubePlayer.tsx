// client-aac/src/components/YouTubePlayer.tsx
//
// The video surface shared by YouTubeApp and YouTubeVideoPlayer. It hides ONE
// hard difference between our runtimes:
//
//   • Web build — the page is a real https origin, so we embed the YouTube
//     IFrame player directly (unchanged, known-good behavior).
//
//   • Packaged shells (Electron `app://aac`, Capacitor iPad
//     `capacitor://localhost`) — those origins are not http(s), and YouTube's
//     player rejects them (error 152/153) because it reads
//     `window.location.origin` / `document.referrer` from inside its own iframe
//     and both are invalid. So instead we frame the player one level deep via
//     the https backend relay page (`/api/aac/youtube/embed`) and drive it over
//     a tiny postMessage protocol. See server/services/youtube/
//     youtube-embed-page.ts.
//
// Both modes expose the SAME imperative surface (toggle / seekRelative /
// restart) via ref, and the same onReady / onPlayingChange / onError callbacks,
// so callers render their own big-button chrome and don't care which mode ran.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { API_BASE_URL, IS_PACKAGED_APP } from "@/lib/api-base";

/**
 * Keep the latest callbacks in a ref so the player-init effects can depend on
 * `videoId` alone. Without this, a caller passing inline callbacks would
 * re-run the effect every render — tearing down and rebuilding the player.
 */
function useLatestCallbacks(cbs: {
  onReady?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  onError?: (code?: number) => void;
}) {
  const ref = useRef(cbs);
  ref.current = cbs;
  return ref;
}

export interface YouTubePlayerHandle {
  /** Play if paused, pause if playing. */
  toggle(): void;
  /** Seek by a signed number of seconds relative to the current position. */
  seekRelative(seconds: number): void;
  /** Jump to the start and play. */
  restart(): void;
}

interface YouTubePlayerProps {
  videoId: string;
  onReady?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  onError?: (code?: number) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// YouTube IFrame API loader (shared, used by the direct/web mode only).
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

let ytApiLoaded = false;
let ytApiLoading = false;
const ytApiCallbacks: Array<() => void> = [];

function loadYTApi(): Promise<void> {
  if (ytApiLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    ytApiCallbacks.push(resolve);
    if (ytApiLoading) return;
    ytApiLoading = true;

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      ytApiLoaded = true;
      ytApiLoading = false;
      for (const cb of ytApiCallbacks) cb();
      ytApiCallbacks.length = 0;
    };
  });
}

const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function YouTubePlayer({ videoId, onReady, onPlayingChange, onError, className }, ref) {
    return IS_PACKAGED_APP ? (
      <RelayPlayer
        ref={ref}
        videoId={videoId}
        onReady={onReady}
        onPlayingChange={onPlayingChange}
        onError={onError}
        className={className}
      />
    ) : (
      <DirectPlayer
        ref={ref}
        videoId={videoId}
        onReady={onReady}
        onPlayingChange={onPlayingChange}
        onError={onError}
        className={className}
      />
    );
  },
);

export default YouTubePlayer;

// ---------------------------------------------------------------------------
// Relay mode — iframe pointed at the https backend relay page.
// ---------------------------------------------------------------------------

const RelayPlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function RelayPlayer({ videoId, onReady, onPlayingChange, onError, className }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const cbs = useLatestCallbacks({ onReady, onPlayingChange, onError });

    // The relay page lives at the backend origin; target postMessage precisely
    // there (falls back to the current origin for the same-origin web dev case).
    const targetOrigin = API_BASE_URL || window.location.origin;
    const src = `${API_BASE_URL}/api/aac/youtube/embed?v=${encodeURIComponent(videoId)}`;

    const post = useCallback(
      (msg: Record<string, unknown>) => {
        iframeRef.current?.contentWindow?.postMessage({ type: "yt-cmd", ...msg }, targetOrigin);
      },
      [targetOrigin],
    );

    useImperativeHandle(
      ref,
      () => ({
        toggle: () => post({ cmd: "toggle" }),
        seekRelative: (seconds: number) => post({ cmd: "seekRelative", seconds }),
        restart: () => post({ cmd: "restart" }),
      }),
      [post],
    );

    useEffect(() => {
      const onMessage = (ev: MessageEvent) => {
        // Only trust messages from our own relay iframe.
        if (ev.source !== iframeRef.current?.contentWindow) return;
        const d = ev.data;
        if (!d || typeof d !== "object") return;
        if (d.type === "yt-ready") cbs.current.onReady?.();
        else if (d.type === "yt-state") cbs.current.onPlayingChange?.(Boolean(d.playing));
        else if (d.type === "yt-error") {
          console.error(`[YouTubePlayer] relay playback error ${d.code} for video ${videoId}`);
          cbs.current.onError?.(d.code);
        }
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [videoId, cbs]);

    return (
      <iframe
        ref={iframeRef}
        src={src}
        className={className}
        // No border, fill the parent; caller positions the surface.
        style={{ border: 0, width: "100%", height: "100%" }}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        title="YouTube video"
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Direct mode — YouTube IFrame API embedded in-page (web build, https origin).
// ---------------------------------------------------------------------------

const DirectPlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function DirectPlayer({ videoId, onReady, onPlayingChange, onError, className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<any>(null);
    const cbs = useLatestCallbacks({ onReady, onPlayingChange, onError });

    useImperativeHandle(
      ref,
      () => ({
        toggle: () => {
          const p = playerRef.current;
          if (!p) return;
          try {
            if (p.getPlayerState() === 1) p.pauseVideo();
            else p.playVideo();
          } catch { /* ignore */ }
        },
        seekRelative: (seconds: number) => {
          const p = playerRef.current;
          if (!p) return;
          try {
            const current = p.getCurrentTime() || 0;
            p.seekTo(Math.max(0, current + seconds), true);
          } catch { /* ignore */ }
        },
        restart: () => {
          const p = playerRef.current;
          if (!p) return;
          try {
            p.seekTo(0, true);
            p.playVideo();
          } catch { /* ignore */ }
        },
      }),
      [],
    );

    useEffect(() => {
      let destroyed = false;

      (async () => {
        await loadYTApi();
        if (destroyed) return;

        const playerId = `yt-player-${Date.now()}`;
        const div = document.createElement("div");
        div.id = playerId;
        containerRef.current?.appendChild(div);

        playerRef.current = new window.YT.Player(playerId, {
          videoId,
          width: "100%",
          height: "100%",
          host: "https://www.youtube-nocookie.com",
          playerVars: {
            autoplay: 1,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            fs: 0,
          },
          events: {
            onReady: () => {
              if (!destroyed) cbs.current.onReady?.();
            },
            onStateChange: (event: any) => {
              if (destroyed) return;
              // PLAYING=1, PAUSED=2, ENDED=0
              if (event.data === 1) cbs.current.onPlayingChange?.(true);
              else if (event.data === 2 || event.data === 0) cbs.current.onPlayingChange?.(false);
            },
            onError: (event: any) => {
              console.error(`[YouTubePlayer] playback error ${event?.data} for video ${videoId}`);
              if (!destroyed) cbs.current.onError?.(event?.data);
            },
          },
        });
      })();

      return () => {
        destroyed = true;
        try {
          playerRef.current?.destroy();
        } catch { /* ignore */ }
        playerRef.current = null;
      };
    }, [videoId, cbs]);

    return <div ref={containerRef} className={className} style={{ width: "100%", height: "100%" }} />;
  },
);

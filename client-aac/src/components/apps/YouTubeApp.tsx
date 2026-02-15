// client-aac/src/components/apps/YouTubeApp.tsx
// Full-screen YouTube player overlay with large accessible controls
// Moved from YouTubeVideoPlayer.tsx for the add-on apps system

import { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Play, Pause, RotateCcw, Rewind, FastForward } from "lucide-react";

interface YouTubeAppProps {
  videoId: string;
  title: string;
  onClose: () => void;
}

// YouTube IFrame API types
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

export default function YouTubeApp({ videoId, title, onClose }: YouTubeAppProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let destroyed = false;

    (async () => {
      await loadYTApi();
      if (destroyed) return;

      const playerId = `yt-player-${Date.now()}`;
      const div = document.createElement("div");
      div.id = playerId;
      containerRef.current?.querySelector(".yt-container")?.appendChild(div);

      playerRef.current = new window.YT.Player(playerId, {
        videoId,
        width: "100%",
        height: "100%",
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
            if (!destroyed) setIsReady(true);
          },
          onStateChange: (event: any) => {
            if (destroyed) return;
            if (event.data === 1) setIsPlaying(true);
            else if (event.data === 2) setIsPlaying(false);
            else if (event.data === 0) setIsPlaying(false);
          },
          onError: () => {
            if (!destroyed) setHasError(true);
          },
        },
      });
    })();

    return () => {
      destroyed = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
  }, [videoId]);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      const state = p.getPlayerState();
      if (state === 1) p.pauseVideo();
      else p.playVideo();
    } catch { /* ignore */ }
  }, []);

  const seekRelative = useCallback((delta: number) => {
    const p = playerRef.current;
    if (!p) return;
    try {
      const current = p.getCurrentTime() || 0;
      p.seekTo(Math.max(0, current + delta), true);
    } catch { /* ignore */ }
  }, []);

  const restart = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.seekTo(0, true);
      p.playVideo();
    } catch { /* ignore */ }
  }, []);

  const btnBase = "flex items-center justify-center rounded-2xl text-white font-bold shadow-lg active:scale-95 transition-transform select-none";

  return (
    <motion.div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black flex flex-col"
      data-dwell-trap
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent">
        <span className="text-white text-lg font-semibold truncate flex-1">{title}</span>
      </div>

      <div className="flex-1 relative">
        <div className="yt-container absolute inset-0" />
        {!isReady && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xl">
            Loading video...
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <p className="text-white text-xl">Video unavailable</p>
            <button data-dwell onClick={onClose} className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`}>
              <X size={36} />
            </button>
          </div>
        )}
      </div>

      {!hasError && (
        <div className="relative z-10 flex items-center justify-center gap-4 px-4 py-5 bg-gradient-to-t from-black/80 to-transparent">
          <button data-dwell onClick={onClose} className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`} aria-label="Exit">
            <X size={36} />
          </button>
          <button data-dwell onClick={() => seekRelative(-10)} className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`} aria-label="Back 10 seconds">
            <Rewind size={32} />
          </button>
          <button data-dwell onClick={togglePlay} className={`${btnBase} w-24 h-24 bg-green-600 hover:bg-green-700`} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={42} /> : <Play size={42} />}
          </button>
          <button data-dwell onClick={() => seekRelative(10)} className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`} aria-label="Forward 10 seconds">
            <FastForward size={32} />
          </button>
          <button data-dwell onClick={restart} className={`${btnBase} w-20 h-20 bg-purple-600 hover:bg-purple-700`} aria-label="Restart">
            <RotateCcw size={32} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

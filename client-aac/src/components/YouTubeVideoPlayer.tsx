// client-aac/src/components/YouTubeVideoPlayer.tsx
// Full-screen YouTube player overlay with large accessible controls.
// The video surface itself (and the app:// / capacitor:// origin workaround) is
// handled by the shared <YouTubePlayer>; this file is just the chrome.

import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X, Play, Pause, RotateCcw, Rewind, FastForward } from "lucide-react";
import YouTubePlayer, { type YouTubePlayerHandle } from "./YouTubePlayer";

interface YouTubeVideoPlayerProps {
  videoId: string;
  title: string;
  onClose: () => void;
}

export default function YouTubeVideoPlayer({ videoId, title, onClose }: YouTubeVideoPlayerProps) {
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  const togglePlay = useCallback(() => playerRef.current?.toggle(), []);
  const seekRelative = useCallback((delta: number) => playerRef.current?.seekRelative(delta), []);
  const restart = useCallback(() => playerRef.current?.restart(), []);

  const btnBase = "flex items-center justify-center rounded-2xl text-white font-bold shadow-lg active:scale-95 transition-transform select-none";

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-black flex flex-col"
      data-dwell-trap
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      {/* Title bar */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent">
        <span className="text-white text-lg font-semibold truncate flex-1">{title}</span>
      </div>

      {/* Video area */}
      <div className="flex-1 relative">
        <YouTubePlayer
          ref={playerRef}
          videoId={videoId}
          onReady={() => setIsReady(true)}
          onPlayingChange={setIsPlaying}
          onError={() => setHasError(true)}
          className="absolute inset-0"
        />
        {!isReady && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xl pointer-events-none">
            Loading video...
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black">
            <p className="text-white text-xl">Video unavailable</p>
            <button type="button"
              onClick={onClose}
              className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`}
              aria-label="Close"
            >
              <X size={36} />
            </button>
          </div>
        )}
      </div>

      {/* Controls bar */}
      {!hasError && (
        <div className="relative z-10 flex items-center justify-center gap-4 px-4 py-5 bg-gradient-to-t from-black/80 to-transparent">
          {/* Exit */}
          <button type="button"
            onClick={onClose}
            className={`${btnBase} w-20 h-20 bg-red-600 hover:bg-red-700`}
            aria-label="Exit"
          >
            <X size={36} />
          </button>

          {/* Back 10s */}
          <button type="button"
            onClick={() => seekRelative(-10)}
            className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`}
            aria-label="Back 10 seconds"
          >
            <Rewind size={32} />
          </button>

          {/* Play/Pause — largest */}
          <button type="button"
            onClick={togglePlay}
            className={`${btnBase} w-24 h-24 bg-green-600 hover:bg-green-700`}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={42} /> : <Play size={42} />}
          </button>

          {/* Forward 10s */}
          <button type="button"
            onClick={() => seekRelative(10)}
            className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700`}
            aria-label="Forward 10 seconds"
          >
            <FastForward size={32} />
          </button>

          {/* Restart */}
          <button type="button"
            onClick={restart}
            className={`${btnBase} w-20 h-20 bg-purple-600 hover:bg-purple-700`}
            aria-label="Restart"
          >
            <RotateCcw size={32} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

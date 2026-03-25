// client-aac/src/components/apps/SpotifyApp.tsx
// Full-screen Spotify player overlay.
// Uses Web Playback SDK when the student has a connected Spotify account,
// falls back to iframe embed (30-second previews) otherwise.

import { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

// Spotify Web Playback SDK types
declare global {
  interface Window {
    Spotify: any;
    onSpotifyWebPlaybackSDKReady: (() => void) | undefined;
  }
}

let sdkLoaded = false;
let sdkLoading = false;
const sdkCallbacks: Array<() => void> = [];

function loadSpotifySDK(): Promise<void> {
  if (sdkLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    sdkCallbacks.push(resolve);
    if (sdkLoading) return;
    sdkLoading = true;

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    document.head.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      sdkLoaded = true;
      sdkLoading = false;
      for (const cb of sdkCallbacks) cb();
      sdkCallbacks.length = 0;
    };
  });
}

interface SpotifyAppProps {
  trackId: string;
  title: string;
  artist: string;
  studentId: string;
  onClose: () => void;
}

export default function SpotifyApp({ trackId, title, artist, studentId, onClose }: SpotifyAppProps) {
  const [mode, setMode] = useState<"loading" | "sdk" | "embed">("loading");
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<any>(null);
  const tokenRef = useRef<string>("");
  const deviceIdRef = useRef<string>("");

  // Try to get an access token; if available, use SDK mode
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await apiRequest("GET", `/api/aac/spotify/token?studentId=${studentId}`);
        const data = await res.json();
        if (cancelled || !data.accessToken) {
          setMode("embed");
          return;
        }
        tokenRef.current = data.accessToken;

        // Load SDK and create player
        await loadSpotifySDK();
        if (cancelled) return;

        const player = new window.Spotify.Player({
          name: "CliniAACian",
          getOAuthToken: (cb: (token: string) => void) => cb(tokenRef.current),
          volume: 0.8,
        });

        player.addListener("ready", ({ device_id }: { device_id: string }) => {
          if (cancelled) return;
          deviceIdRef.current = device_id;
          setMode("sdk");
          // Start playback
          fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device_id}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tokenRef.current}`,
            },
            body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
          }).catch(() => {});
        });

        player.addListener("player_state_changed", (state: any) => {
          if (!state || cancelled) return;
          setIsPlaying(!state.paused);
          setPosition(state.position);
          setDuration(state.duration);
        });

        player.addListener("initialization_error", () => !cancelled && setMode("embed"));
        player.addListener("authentication_error", () => !cancelled && setMode("embed"));
        player.addListener("account_error", () => !cancelled && setMode("embed"));

        await player.connect();
        playerRef.current = player;
      } catch {
        if (!cancelled) setMode("embed");
      }
    })();

    return () => {
      cancelled = true;
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, [studentId, trackId]);

  // Update position periodically in SDK mode
  useEffect(() => {
    if (mode !== "sdk" || !isPlaying) return;
    const interval = setInterval(() => {
      playerRef.current?.getCurrentState().then((state: any) => {
        if (state) setPosition(state.position);
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [mode, isPlaying]);

  const togglePlay = useCallback(() => {
    playerRef.current?.togglePlay();
  }, []);

  const seekRelative = useCallback((deltaMs: number) => {
    playerRef.current?.getCurrentState().then((state: any) => {
      if (state) {
        playerRef.current?.seek(Math.max(0, state.position + deltaMs));
      }
    });
  }, []);

  const btnBase = "flex items-center justify-center rounded-2xl font-bold shadow-lg active:scale-95 transition-transform select-none";
  const embedUrl = `https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0`;

  const progressPct = duration > 0 ? (position / duration) * 100 : 0;
  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-gradient-to-b from-gray-900 to-black flex flex-col"
      data-dwell-trap
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-3">
        <span className="text-4xl">🎧</span>
        <div className="flex-1 min-w-0">
          <p className="text-white text-lg font-semibold truncate">{title}</p>
          {artist && <p className="text-gray-400 text-sm truncate">{artist}</p>}
        </div>
      </div>

      {/* Content — SDK player or iframe embed */}
      <div className="flex-1 flex items-center justify-center px-4">
        {mode === "loading" && (
          <div className="text-white text-xl animate-pulse">Loading...</div>
        )}

        {mode === "embed" && (
          <iframe
            src={embedUrl}
            width="100%"
            height="352"
            frameBorder="0"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            style={{ borderRadius: "12px", maxWidth: "600px" }}
            title={`Spotify: ${title}`}
          />
        )}

        {mode === "sdk" && (
          <div className="flex flex-col items-center gap-6 w-full max-w-lg">
            {/* Progress bar */}
            <div className="w-full">
              <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-1000"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex justify-between mt-1 text-xs text-gray-400">
                <span>{formatTime(position)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Playback controls — large and accessible */}
            <div className="flex items-center justify-center gap-4">
              <button
                data-dwell
                onClick={() => seekRelative(-15000)}
                className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700 text-white`}
                aria-label="Back 15 seconds"
              >
                <SkipBack size={32} />
              </button>
              <button
                data-dwell
                onClick={togglePlay}
                className={`${btnBase} w-24 h-24 bg-green-600 hover:bg-green-700 text-white`}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause size={42} /> : <Play size={42} />}
              </button>
              <button
                data-dwell
                onClick={() => seekRelative(15000)}
                className={`${btnBase} w-20 h-20 bg-blue-600 hover:bg-blue-700 text-white`}
                aria-label="Forward 15 seconds"
              >
                <SkipForward size={32} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Close button at bottom — large and visible */}
      <div className="px-3 pb-4">
        <button
          data-dwell
          onClick={onClose}
          className={`${btnBase} w-full h-14 bg-red-500 text-white text-lg gap-2`}
          aria-label="Close Spotify"
        >
          <X size={24} />
          Close
        </button>
      </div>
    </motion.div>
  );
}

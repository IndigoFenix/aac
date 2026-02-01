// client-aac/src/hooks/useStreamingAudioPlayer.ts
// Hook for playing streaming audio chunks from SSE responses

import { useState, useRef, useCallback, useEffect } from "react";

export interface AudioChunk {
  chunk: string; // Base64 encoded audio data
  format: "mp3" | "wav" | "ogg" | "webm";
}

export interface UseStreamingAudioPlayerReturn {
  isPlaying: boolean;
  isBuffering: boolean;
  error: string | null;
  queueChunk: (chunk: AudioChunk) => void;
  play: () => void;
  stop: () => void;
  clear: () => void;
}

export interface UseStreamingAudioPlayerOptions {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: string) => void;
  autoPlay?: boolean;
}

/**
 * Hook for playing streaming audio chunks
 *
 * Uses a single Audio element and blob URLs for reliable sequential playback.
 * Chunks are queued and played one at a time.
 */
export function useStreamingAudioPlayer(
  options: UseStreamingAudioPlayerOptions = {}
): UseStreamingAudioPlayerReturn {
  const {
    onPlaybackStart,
    onPlaybackEnd,
    onError,
    autoPlay = true,
  } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single audio element for all playback
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Queue of blob URLs to play
  const queueRef = useRef<string[]>([]);
  // Track if we're currently playing (to prevent concurrent plays)
  const playingRef = useRef(false);
  // Track if playback has started (for onPlaybackStart callback)
  const playbackStartedRef = useRef(false);
  // Track if we've been stopped (to prevent playing after stop)
  const stoppedRef = useRef(false);

  // Initialize audio element
  useEffect(() => {
    audioRef.current = new Audio();
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      // Clean up any remaining blob URLs
      queueRef.current.forEach((url) => URL.revokeObjectURL(url));
      queueRef.current = [];
    };
  }, []);

  // Get MIME type from format
  const getMimeType = useCallback((format: string): string => {
    const mimeMap: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      webm: "audio/webm",
    };
    return mimeMap[format] || "audio/mpeg";
  }, []);

  // Convert base64 to Blob URL
  const base64ToBlobUrl = useCallback(
    (base64: string, format: string): string => {
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const mimeType = getMimeType(format);
      const blob = new Blob([bytes], { type: mimeType });
      return URL.createObjectURL(blob);
    },
    [getMimeType]
  );

  // Play the next chunk in the queue
  const playNext = useCallback(async () => {
    // Don't play if stopped or already playing
    if (stoppedRef.current || playingRef.current) {
      return;
    }

    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    // Check if there's anything to play
    if (queueRef.current.length === 0) {
      // Queue is empty, playback complete
      if (playbackStartedRef.current) {
        playbackStartedRef.current = false;
        playingRef.current = false;
        setIsPlaying(false);
        setIsBuffering(false);
        onPlaybackEnd?.();
      }
      return;
    }

    // Mark as playing
    playingRef.current = true;

    // Get next URL from queue
    const url = queueRef.current.shift()!;

    // Set up event handlers
    const handleEnded = () => {
      URL.revokeObjectURL(url);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      playingRef.current = false;
      // Play next chunk
      playNext();
    };

    const handleError = (e: Event) => {
      console.error("[StreamingAudioPlayer] Playback error:", e);
      URL.revokeObjectURL(url);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      playingRef.current = false;

      const errorMessage = "Audio playback failed";
      setError(errorMessage);
      onError?.(errorMessage);

      // Try to continue with next chunk
      playNext();
    };

    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    // Set source and play
    audio.src = url;

    try {
      await audio.play();

      // First successful play - notify
      if (!playbackStartedRef.current) {
        playbackStartedRef.current = true;
        setIsPlaying(true);
        setIsBuffering(false);
        onPlaybackStart?.();
      }
    } catch (err: any) {
      console.error("[StreamingAudioPlayer] Play failed:", err);
      URL.revokeObjectURL(url);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      playingRef.current = false;

      // NotAllowedError means autoplay was blocked - need user interaction
      if (err.name === "NotAllowedError") {
        // Put the URL back at the front of the queue
        queueRef.current.unshift(url);
        setIsBuffering(true);
        setError("Click to play audio");
      } else if (err.name === "AbortError") {
        // AbortError means we were stopped - this is expected, don't treat as error
        console.log("[StreamingAudioPlayer] Playback aborted (stopped)");
      } else {
        const errorMessage = err.message || "Playback failed";
        setError(errorMessage);
        onError?.(errorMessage);
        // Try next chunk
        playNext();
      }
    }
  }, [onPlaybackEnd, onPlaybackStart, onError]);

  // Queue a new audio chunk
  const queueChunk = useCallback(
    (chunk: AudioChunk) => {
      try {
        setError(null);
        stoppedRef.current = false; // Allow playback again

        const url = base64ToBlobUrl(chunk.chunk, chunk.format);
        queueRef.current.push(url);

        console.log(
          `[StreamingAudioPlayer] Queued chunk, queue size: ${queueRef.current.length}`
        );

        // Auto-play if not already playing
        if (autoPlay && !playingRef.current) {
          setIsBuffering(true);
          playNext();
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to queue audio";
        console.error("[StreamingAudioPlayer] Queue error:", errorMessage);
        setError(errorMessage);
        onError?.(errorMessage);
      }
    },
    [autoPlay, base64ToBlobUrl, playNext, onError]
  );

  // Manual play (useful when autoplay is blocked)
  const play = useCallback(() => {
    setError(null);
    stoppedRef.current = false;

    if (!playingRef.current && queueRef.current.length > 0) {
      playNext();
    }
  }, [playNext]);

  // Stop playback
  const stop = useCallback(() => {
    stoppedRef.current = true;
    playingRef.current = false;
    playbackStartedRef.current = false;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }

    setIsPlaying(false);
    setIsBuffering(false);
  }, []);

  // Clear queue and stop
  const clear = useCallback(() => {
    stop();
    // Clean up blob URLs
    queueRef.current.forEach((url) => URL.revokeObjectURL(url));
    queueRef.current = [];
    console.log("[StreamingAudioPlayer] Queue cleared");
  }, [stop]);

  return {
    isPlaying,
    isBuffering,
    error,
    queueChunk,
    play,
    stop,
    clear,
  };
}

/**
 * Helper function to handle SSE audio events
 * Use this to connect an EventSource to the streaming player
 */
export function createSSEAudioHandler(
  player: UseStreamingAudioPlayerReturn,
  options: {
    onTranscription?: (text: string, language: string) => void;
    onTextChunk?: (chunk: string) => void;
    onBoard?: (board: any) => void;
    onComplete?: (data: { sessionId?: string; fullText?: string }) => void;
    onError?: (error: string) => void;
  } = {}
) {
  return (event: MessageEvent, eventType: string) => {
    try {
      const data = JSON.parse(event.data);

      switch (eventType) {
        case "transcription":
          options.onTranscription?.(data.text, data.language);
          break;

        case "text":
          options.onTextChunk?.(data.chunk);
          break;

        case "audio":
          player.queueChunk({
            chunk: data.chunk,
            format: data.format || "mp3",
          });
          break;

        case "board":
          options.onBoard?.(data.board || data);
          break;

        case "complete":
          options.onComplete?.(data);
          break;

        case "error":
          const errorMsg = data.error || "Unknown error";
          player.stop();
          options.onError?.(errorMsg);
          break;
      }
    } catch (err) {
      console.error("[SSEAudioHandler] Failed to parse event:", err);
    }
  };
}

export default useStreamingAudioPlayer;

// client-aac/src/hooks/useStreamingAudioPlayer.ts
// Hook for playing streaming audio chunks from SSE responses

import { useState, useRef, useCallback, useEffect } from "react";
import { processVoice } from "@/lib/pitchShifter";

export interface AudioChunk {
  chunk: string; // Base64 encoded audio data
  format: "mp3" | "wav" | "ogg" | "webm";
  /** Optional tag identifying the audio source (e.g. "avatar", "utterance") */
  tag?: string;
}

export interface UseStreamingAudioPlayerReturn {
  isPlaying: boolean;
  isBuffering: boolean;
  error: string | null;
  /** Current speaking volume 0-1, updated via AudioContext analyser while playing */
  speakingVolume: number;
  /**
   * Synchronous ref: true from the moment the first chunk is queued
   * until POST_PLAY_TAIL_MS after the last chunk finishes.
   * Use this for gating mic input — it covers pre-play startup delay
   * and post-play room echo tail, unlike the `isPlaying` state which
   * has React propagation latency and no echo buffer.
   */
  isBusyRef: { readonly current: boolean };
  /** Tag of the currently playing chunk (e.g. "avatar", "utterance"), or null if idle */
  currentTag: string | null;
  queueChunk: (chunk: AudioChunk) => void;
  play: () => void;
  stop: () => void;
  clear: () => void;
  /** Clear queued chunks matching a tag, leaving other tags intact. */
  clearByTag: (tag: string) => void;
  /** Mute/unmute LOCAL speaker output only (the call tap is unaffected, so a
   *  locally-muted AAC still transmits its voice). */
  setLocalMuted: (muted: boolean) => void;
  /** A MediaStream carrying everything this player sounds (all TTS paths), for
   *  sending the AAC's synthesized voice over a call. Null until the graph is up. */
  getCallStream: () => MediaStream | null;
}

export interface UseStreamingAudioPlayerOptions {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: string) => void;
  autoPlay?: boolean;
  /**
   * Per-tag pitch shift in semitones.  Keys are audio tags (e.g. "avatar", "utterance").
   * Untagged chunks or tags not in the map are played without pitch shift.
   * Example: { avatar: 3, utterance: -2 }
   */
  pitchByTag?: Record<string, number>;
  /**
   * Per-tag formant (vocal-tract) shift in semitones, relative to the original
   * voice. Moving formants up (positive) simulates a shorter tract → younger.
   * A tag absent from this map keeps the legacy coupled-formant behaviour.
   * Example: { avatar: 5 }
   */
  formantByTag?: Record<string, number>;
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
    pitchByTag,
    formantByTag,
  } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakingVolume, setSpeakingVolume] = useState(0);

  // Single audio element for non-pitch-shifted playback
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Queue of items to play
  const queueRef = useRef<{ url?: string; buffer?: ArrayBuffer; format: string; tag?: string }[]>([]);
  // Tag of the chunk currently playing
  const [currentTag, setCurrentTag] = useState<string | null>(null);
  // Track if we're currently playing (to prevent concurrent plays)
  const playingRef = useRef(false);
  // Track if playback has started (for onPlaybackStart callback)
  const playbackStartedRef = useRef(false);
  // Track if we've been stopped (to prevent playing after stop)
  const stoppedRef = useRef(false);

  // Synchronous "busy" ref for mic gating — true from first queued chunk
  // until POST_PLAY_TAIL_MS after the last chunk finishes playing.
  // Unlike isPlaying state, this has no React propagation delay and covers
  // the post-playback echo tail where the mic might pick up residual audio.
  const POST_PLAY_TAIL_MS = 500;
  const busyRef = useRef(false);
  const busyTailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AudioContext analyser for volume tracking
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  // Currently-playing AudioBufferSourceNode (pitch-shifted path)
  const bufferSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Local-output gain (mute = 0) and a parallel tap that exposes everything this
  // player sounds as a MediaStream, so the AAC's synthesized voice can be sent over
  // a call exactly like a microphone would be.
  const masterGainRef = useRef<GainNode | null>(null);
  const callDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const volumeRafRef = useRef<number>(0);
  // Keep latest pitch map in a ref so playNext doesn't need to re-render
  const pitchByTagRef = useRef(pitchByTag);
  pitchByTagRef.current = pitchByTag;
  const formantByTagRef = useRef(formantByTag);
  formantByTagRef.current = formantByTag;

  // Initialize audio element + AudioContext analyser
  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;

    // Set up AudioContext for volume analysis
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      // Local speakers: analyser → masterGain → destination (mute = gain 0).
      const masterGain = ctx.createGain();
      analyser.connect(masterGain);
      masterGain.connect(ctx.destination);
      // Call tap: analyser → MediaStreamDestination, in PARALLEL (not through
      // masterGain), so muting the local speakers never silences what we transmit.
      // Both the <audio>-element path AND the pitch-shifted bufferSource path feed
      // the analyser, so this captures regular server TTS and the ElevenLabs
      // (client_tts) path alike.
      const callDest = ctx.createMediaStreamDestination();
      analyser.connect(callDest);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      sourceRef.current = source;
      masterGainRef.current = masterGain;
      callDestRef.current = callDest;
    } catch (err) {
      console.warn("[StreamingAudioPlayer] AudioContext setup failed:", err);
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      bufferSourceRef.current?.stop();
      bufferSourceRef.current = null;
      if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current);
      if (busyTailTimerRef.current) clearTimeout(busyTailTimerRef.current);
      try { audioContextRef.current?.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
      analyserRef.current = null;
      sourceRef.current = null;
      masterGainRef.current = null;
      callDestRef.current = null;
      busyRef.current = false;
      // Clean up any remaining blob URLs
      queueRef.current.forEach((e) => { if (e.url) URL.revokeObjectURL(e.url); });
      queueRef.current = [];
    };
  }, []);

  // Volume polling loop — runs while playing
  useEffect(() => {
    if (!isPlaying || !analyserRef.current) {
      setSpeakingVolume(0);
      return;
    }
    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const poll = () => {
      analyser.getByteFrequencyData(dataArray);
      // RMS-ish: average of frequency bins, normalized to 0-1
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length / 255;
      setSpeakingVolume(avg);
      volumeRafRef.current = requestAnimationFrame(poll);
    };
    volumeRafRef.current = requestAnimationFrame(poll);
    return () => {
      if (volumeRafRef.current) cancelAnimationFrame(volumeRafRef.current);
      setSpeakingVolume(0);
    };
  }, [isPlaying]);

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

  // Play a pitch-shifted chunk via AudioBufferSourceNode
  const playPitchShifted = useCallback(async (
    entry: { buffer: ArrayBuffer; format: string; tag?: string },
    semitones: number,
    formantSemitones: number | undefined,
    onDone: () => void,
    onFail: (err: any) => void,
  ) => {
    const ctx = audioContextRef.current;
    const analyser = analyserRef.current;
    if (!ctx || !analyser) { onFail(new Error("No AudioContext")); return; }

    try {
      // Resume AudioContext if suspended (autoplay policy)
      if (ctx.state === "suspended") await ctx.resume();

      // Decode compressed audio → AudioBuffer
      const audioBuffer = await ctx.decodeAudioData(entry.buffer.slice(0)); // slice to avoid detach

      // Apply pitch (+ optional formant) shift to every channel.
      const shifted = ctx.createBuffer(
        audioBuffer.numberOfChannels,
        audioBuffer.length,
        audioBuffer.sampleRate,
      );
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const raw = audioBuffer.getChannelData(ch);
        const processed = processVoice(raw, audioBuffer.sampleRate, semitones, formantSemitones);
        shifted.getChannelData(ch).set(processed);
      }

      // Create one-shot source → analyser → destination
      const src = ctx.createBufferSource();
      src.buffer = shifted;
      src.connect(analyser); // analyser is already connected to destination
      bufferSourceRef.current = src;

      src.onended = () => {
        src.disconnect();
        bufferSourceRef.current = null;
        onDone();
      };
      src.start();
    } catch (err) {
      onFail(err);
    }
  }, []);

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
        setCurrentTag(null);
        onPlaybackEnd?.();

        // Keep busyRef true for POST_PLAY_TAIL_MS to cover room echo
        if (busyTailTimerRef.current) clearTimeout(busyTailTimerRef.current);
        busyTailTimerRef.current = setTimeout(() => {
          busyRef.current = false;
          busyTailTimerRef.current = null;
        }, POST_PLAY_TAIL_MS);
      }
      return;
    }

    // Mark as playing
    playingRef.current = true;

    // Get next entry from queue
    const entry = queueRef.current.shift()!;
    setCurrentTag(entry.tag ?? null);

    // ── Pitch-shifted path: decode → WSOLA → AudioBufferSourceNode ──
    if (entry.buffer) {
      const markPlaying = () => {
        if (!playbackStartedRef.current) {
          playbackStartedRef.current = true;
          setIsPlaying(true);
          setIsBuffering(false);
          onPlaybackStart?.();
        }
      };

      markPlaying();
      const tagPitch = (entry.tag && pitchByTagRef.current?.[entry.tag]) || 0;
      const tagFormant = entry.tag ? formantByTagRef.current?.[entry.tag] : undefined;
      playPitchShifted(
        entry as { buffer: ArrayBuffer; format: string; tag?: string },
        tagPitch,
        tagFormant,
        () => { playingRef.current = false; playNext(); },       // onDone
        (err) => {                                                // onFail
          playingRef.current = false;
          if (stoppedRef.current) return; // Expected when clear() was called during playback
          console.error("[StreamingAudioPlayer] Pitch-shifted playback error:", err);
          setError("Pitch-shifted playback failed");
          onError?.("Pitch-shifted playback failed");
          playNext();
        },
      );
      return;
    }

    // ── Standard path: blob URL → <audio> element ──
    const url = entry.url!;

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
      URL.revokeObjectURL(url);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      playingRef.current = false;

      // If we were stopped/cleared, the error is expected (URL was revoked) — don't report
      if (stoppedRef.current) return;

      console.error("[StreamingAudioPlayer] Playback error:", e);
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
      URL.revokeObjectURL(url);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      playingRef.current = false;

      // AbortError when stopped/cleared during play() — expected, ignore silently
      if (stoppedRef.current || err.name === "AbortError") {
        return;
      }

      console.error("[StreamingAudioPlayer] Play failed:", err);

      // NotAllowedError means autoplay was blocked - need user interaction
      if (err.name === "NotAllowedError") {
        // Put the entry back at the front of the queue
        queueRef.current.unshift(entry);
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
  }, [onPlaybackEnd, onPlaybackStart, onError, playPitchShifted]);

  // Convert base64 string to ArrayBuffer (for pitch-shifted path)
  const base64ToArrayBuffer = useCallback((base64: string): ArrayBuffer => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }, []);

  // Queue a new audio chunk
  const queueChunk = useCallback(
    (chunk: AudioChunk) => {
      try {
        setError(null);
        stoppedRef.current = false; // Allow playback again

        // Mark busy immediately (synchronous) — gates mic BEFORE async play
        busyRef.current = true;
        if (busyTailTimerRef.current) {
          clearTimeout(busyTailTimerRef.current);
          busyTailTimerRef.current = null;
        }

        const tagPitch = chunk.tag && pitchByTagRef.current?.[chunk.tag];
        const tagFormant = chunk.tag && formantByTagRef.current?.[chunk.tag];
        if ((tagPitch && tagPitch !== 0) || (tagFormant && tagFormant !== 0)) {
          // Pitch/formant-shifted path: store raw ArrayBuffer for decodeAudioData later
          const buffer = base64ToArrayBuffer(chunk.chunk);
          queueRef.current.push({ buffer, format: chunk.format, tag: chunk.tag });
        } else {
          // Standard path: create blob URL
          const url = base64ToBlobUrl(chunk.chunk, chunk.format);
          queueRef.current.push({ url, format: chunk.format, tag: chunk.tag });
        }

        console.log(
          `[StreamingAudioPlayer] Queued chunk (${chunk.tag || "untagged"}), queue size: ${queueRef.current.length}`
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
    [autoPlay, base64ToBlobUrl, base64ToArrayBuffer, playNext, onError]
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
    // Stop pitch-shifted source if playing
    try { bufferSourceRef.current?.stop(); } catch { /* may already be stopped */ }
    bufferSourceRef.current = null;

    // Start tail timer for busyRef (cover echo even when manually stopped)
    if (busyTailTimerRef.current) clearTimeout(busyTailTimerRef.current);
    busyTailTimerRef.current = setTimeout(() => {
      busyRef.current = false;
      busyTailTimerRef.current = null;
    }, POST_PLAY_TAIL_MS);

    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTag(null);
  }, []);

  // Clear queue and stop
  const clear = useCallback(() => {
    stop();
    // Clean up blob URLs
    queueRef.current.forEach((e) => { if (e.url) URL.revokeObjectURL(e.url); });
    queueRef.current = [];
    console.log("[StreamingAudioPlayer] Queue cleared");
  }, [stop]);

  // Clear only chunks with a matching tag, leaving other-tag chunks queued.
  // If the currently-playing chunk matches, it is also stopped.
  const clearByTag = useCallback((tag: string) => {
    // Drop matching chunks from the queue (revoke their blob URLs first).
    const remaining: typeof queueRef.current = [];
    let dropped = 0;
    for (const entry of queueRef.current) {
      if (entry.tag === tag) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        dropped++;
      } else {
        remaining.push(entry);
      }
    }
    queueRef.current = remaining;

    // If the currently-playing chunk is the same tag, stop it so the next
    // queued (other-tag) chunk can take over.
    if (currentTag === tag && playingRef.current) {
      stop();
      // Auto-resume with whatever non-matching chunks remain.
      if (queueRef.current.length > 0) {
        setIsBuffering(true);
        playNext();
      }
    }
    if (dropped > 0) {
      console.log(`[StreamingAudioPlayer] Cleared ${dropped} chunk(s) with tag "${tag}"`);
    }
  }, [currentTag, stop, playNext]);

  // Mute LOCAL speakers without affecting the call tap (analyser → callDest sits
  // before masterGain in parallel).
  const setLocalMuted = useCallback((muted: boolean) => {
    if (masterGainRef.current) masterGainRef.current.gain.value = muted ? 0 : 1;
  }, []);

  const getCallStream = useCallback((): MediaStream | null => callDestRef.current?.stream ?? null, []);

  return {
    isPlaying,
    isBuffering,
    error,
    speakingVolume,
    isBusyRef: busyRef,
    currentTag,
    queueChunk,
    play,
    stop,
    clear,
    clearByTag,
    setLocalMuted,
    getCallStream,
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

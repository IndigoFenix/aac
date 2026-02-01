// client-aac/src/hooks/useAudioRecorder.ts
// Hook for recording audio using MediaRecorder API

import { useState, useRef, useCallback, useEffect } from "react";

export interface UseAudioRecorderReturn {
  isRecording: boolean;
  isPaused: boolean;
  audioLevel: number;
  duration: number;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  cancelRecording: () => void;
}

export interface UseAudioRecorderOptions {
  onAudioLevel?: (level: number) => void;
  mimeType?: string;
  audioBitsPerSecond?: number;
}

/**
 * Hook for recording audio with push-to-talk functionality
 *
 * Features:
 * - WebM/Opus format (good compression, browser support)
 * - Real-time audio level monitoring
 * - Duration tracking
 * - Pause/resume support
 * - Clean error handling
 */
export function useAudioRecorder(
  options: UseAudioRecorderOptions = {}
): UseAudioRecorderReturn {
  const { onAudioLevel, audioBitsPerSecond = 128000 } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs for cleanup
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const resolverRef = useRef<((blob: Blob | null) => void) | null>(null);

  // Determine the best supported MIME type
  const getMimeType = useCallback((): string => {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return "audio/webm"; // Fallback
  }, []);

  // Monitor audio levels
  const monitorAudioLevel = useCallback(() => {
    if (analyserRef.current && isRecording && !isPaused) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);

      // Calculate average level
      const average =
        dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;

      // Normalize to 0-1 range
      const normalizedLevel = average / 255;
      setAudioLevel(normalizedLevel);
      onAudioLevel?.(normalizedLevel);

      animationFrameRef.current = requestAnimationFrame(monitorAudioLevel);
    }
  }, [isRecording, isPaused, onAudioLevel]);

  // Cleanup function
  const cleanup = useCallback(() => {
    // Stop animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Clear duration interval
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    // Stop MediaRecorder
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch (e) {
        // Ignore errors during cleanup
      }
      mediaRecorderRef.current = null;
    }

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      try {
        if (audioContextRef.current.state !== "closed") {
          audioContextRef.current.close();
        }
      } catch (e) {
        // Ignore errors during cleanup
      }
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    chunksRef.current = [];
    setAudioLevel(0);
    setDuration(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Start recording
  const startRecording = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      cleanup(); // Ensure clean state

      // Check for browser support
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Audio recording is not supported in this browser");
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100,
        },
      });

      streamRef.current = stream;

      // Set up audio level monitoring
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      // Create MediaRecorder
      const mimeType = getMimeType();
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond,
      });

      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const mimeBase = mimeType.split(";")[0]; // Remove codec info
        const blob = new Blob(chunksRef.current, { type: mimeBase });

        if (resolverRef.current) {
          resolverRef.current(blob);
          resolverRef.current = null;
        }

        setIsRecording(false);
        setIsPaused(false);
      };

      mediaRecorder.onerror = (event: Event) => {
        const error = (event as any).error;
        console.error("[useAudioRecorder] MediaRecorder error:", error);
        setError(error?.message || "Recording error occurred");
        cleanup();
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
      setIsPaused(false);
      startTimeRef.current = Date.now();

      // Start duration tracking
      durationIntervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);

      // Start audio level monitoring
      monitorAudioLevel();

      console.log("[useAudioRecorder] Recording started with mimeType:", mimeType);
    } catch (err) {
      console.error("[useAudioRecorder] Failed to start recording:", err);

      let userFriendlyError = "Failed to access microphone";
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("Permission denied")
        ) {
          userFriendlyError =
            "Microphone permission denied. Please allow microphone access.";
        } else if (
          err.name === "NotFoundError" ||
          err.message.includes("NotFoundError")
        ) {
          userFriendlyError =
            "No microphone found. Please connect a microphone.";
        } else if (err.name === "NotReadableError") {
          userFriendlyError =
            "Microphone is being used by another application.";
        } else {
          userFriendlyError = err.message;
        }
      }

      setError(userFriendlyError);
      cleanup();
      throw new Error(userFriendlyError);
    }
  }, [cleanup, getMimeType, audioBitsPerSecond, monitorAudioLevel]);

  // Stop recording and return the audio blob
  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
        cleanup();
        resolve(null);
        return;
      }

      resolverRef.current = resolve;

      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error("[useAudioRecorder] Error stopping recorder:", err);
        cleanup();
        resolve(null);
      }
    });
  }, [cleanup]);

  // Pause recording
  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      setIsPaused(true);

      // Stop audio level monitoring while paused
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setAudioLevel(0);

      console.log("[useAudioRecorder] Recording paused");
    }
  }, []);

  // Resume recording
  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
      setIsPaused(false);

      // Resume audio level monitoring
      monitorAudioLevel();

      console.log("[useAudioRecorder] Recording resumed");
    }
  }, [monitorAudioLevel]);

  // Cancel recording without returning data
  const cancelRecording = useCallback(() => {
    if (resolverRef.current) {
      resolverRef.current(null);
      resolverRef.current = null;
    }
    cleanup();
    setIsRecording(false);
    setIsPaused(false);
    console.log("[useAudioRecorder] Recording cancelled");
  }, [cleanup]);

  return {
    isRecording,
    isPaused,
    audioLevel,
    duration,
    error,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    cancelRecording,
  };
}

export default useAudioRecorder;

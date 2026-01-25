/**
 * CameraAttentivenessContext.tsx
 *
 * Context for intelligent camera monitoring with sleep/wake states,
 * motion detection, and AI-controllable parameters.
 *
 * Features:
 * - Automatic sleep when no motion detected
 * - Wake on motion detection
 * - Configurable capture frequency and resolution
 * - AI-controllable parameters via context form system
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from 'react';
import {
  CameraAttentivenessState,
  AttentivenessMode,
  CaptureFrequency,
  CaptureResolution,
  CapturedFrame,
  FrameCapturedCallback,
  MotionStateCallback,
  DEFAULT_ATTENTIVENESS_STATE,
  FREQUENCY_INTERVALS,
  RESOLUTION_SETTINGS,
  MOTION_THRESHOLDS,
} from '@/lib/cameraAttentivenessTypes';

interface CameraAttentivenessContextType {
  /** Current state of the attentiveness system */
  state: CameraAttentivenessState;

  /** Start monitoring the camera */
  start: () => void;

  /** Stop monitoring the camera */
  stop: () => void;

  /** Manually wake the camera */
  wake: () => void;

  /** Manually put the camera to sleep */
  sleep: () => void;

  /** Set capture frequency */
  setFrequency: (frequency: CaptureFrequency) => void;

  /** Set capture resolution */
  setResolution: (resolution: CaptureResolution) => void;

  /** Set both frequency and resolution */
  setMode: (mode: Partial<AttentivenessMode>) => void;

  /** Register callback for when frames are captured */
  onFrameCaptured: (callback: FrameCapturedCallback | null) => void;

  /** Register callback for motion state changes */
  onMotionStateChange: (callback: MotionStateCallback | null) => void;

  /** Get the last captured frame */
  getLastFrame: () => CapturedFrame | null;

  /** Capture a frame immediately at specified resolution */
  captureNow: (resolution?: CaptureResolution) => Promise<CapturedFrame | null>;
}

const CameraAttentivenessContext = createContext<CameraAttentivenessContextType | undefined>(
  undefined
);

interface CameraAttentivenessProviderProps {
  children: ReactNode;
  /** Video stream to monitor - typically from useMultiCamera's user camera */
  videoStream: MediaStream | null;
  /** Whether to auto-start monitoring when stream is available */
  autoStart?: boolean;
}

export function CameraAttentivenessProvider({
  children,
  videoStream,
  autoStart = true,
}: CameraAttentivenessProviderProps) {
  const [state, setState] = useState<CameraAttentivenessState>(DEFAULT_ATTENTIVENESS_STATE);

  // Refs for capturing and comparison
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previousFrameDataRef = useRef<ImageData | null>(null);
  const lastFrameRef = useRef<CapturedFrame | null>(null);
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sleepTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Callback refs
  const frameCapturedCallbackRef = useRef<FrameCapturedCallback | null>(null);
  const motionStateCallbackRef = useRef<MotionStateCallback | null>(null);

  // Create hidden video and canvas elements
  useEffect(() => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.display = 'none';
    document.body.appendChild(video);
    videoRef.current = video;

    const canvas = document.createElement('canvas');
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    canvasRef.current = canvas;

    return () => {
      video.pause();
      video.srcObject = null;
      video.remove();
      canvas.remove();
    };
  }, []);

  // Connect video stream to hidden video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (videoStream) {
      video.srcObject = videoStream;
      video.play().catch((err) => {
        console.warn('[CameraAttentiveness] Failed to play video:', err);
      });
    } else {
      video.pause();
      video.srcObject = null;
    }
  }, [videoStream]);

  /**
   * Compare two frames to detect motion
   * Returns a value from 0 to 1 indicating the amount of motion
   */
  const detectMotion = useCallback((currentData: ImageData, previousData: ImageData): number => {
    if (currentData.width !== previousData.width || currentData.height !== previousData.height) {
      return 0;
    }

    const current = currentData.data;
    const previous = previousData.data;
    const pixelCount = current.length / 4;
    let changedPixels = 0;

    for (let i = 0; i < current.length; i += 4) {
      // Compare RGB values (skip alpha)
      const rDiff = Math.abs(current[i] - previous[i]);
      const gDiff = Math.abs(current[i + 1] - previous[i + 1]);
      const bDiff = Math.abs(current[i + 2] - previous[i + 2]);
      const avgDiff = (rDiff + gDiff + bDiff) / 3;

      if (avgDiff > MOTION_THRESHOLDS.pixelSensitivity) {
        changedPixels++;
      }
    }

    return changedPixels / pixelCount;
  }, []);

  /**
   * Capture a frame at the specified resolution
   */
  const captureFrame = useCallback(
    async (resolution: CaptureResolution): Promise<CapturedFrame | null> => {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas || !videoStream || video.readyState < 2) {
        return null;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const { width, height } = RESOLUTION_SETTINGS[resolution];
      canvas.width = width;
      canvas.height = height;

      try {
        ctx.drawImage(video, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', resolution === 'high' ? 0.9 : 0.7);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => {
              if (b) resolve(b);
              else reject(new Error('Failed to create blob'));
            },
            'image/jpeg',
            resolution === 'high' ? 0.9 : 0.7
          );
        });

        const frame: CapturedFrame = {
          blob,
          dataUrl,
          resolution,
          timestamp: Date.now(),
          motionLevel: state.motionLevel,
        };

        lastFrameRef.current = frame;
        return frame;
      } catch (err) {
        console.error('[CameraAttentiveness] Failed to capture frame:', err);
        return null;
      }
    },
    [videoStream, state.motionLevel]
  );

  /**
   * Get image data for motion detection (always low resolution)
   */
  const getMotionDetectionData = useCallback((): ImageData | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || !videoStream || video.readyState < 2) {
      return null;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const { width, height } = RESOLUTION_SETTINGS.low;
    canvas.width = width;
    canvas.height = height;

    try {
      ctx.drawImage(video, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    } catch (err) {
      console.error('[CameraAttentiveness] Failed to get motion data:', err);
      return null;
    }
  }, [videoStream]);

  /**
   * Main monitoring tick - called at the configured frequency
   */
  const monitoringTick = useCallback(async () => {
    if (!state.isRunning || !videoStream) return;

    setState((prev) => ({ ...prev, isCapturing: true }));

    try {
      // Get current frame data for motion detection
      const currentFrameData = getMotionDetectionData();

      if (currentFrameData) {
        let motionLevel = 0;

        // Compare with previous frame if available
        if (previousFrameDataRef.current) {
          motionLevel = detectMotion(currentFrameData, previousFrameDataRef.current);
        }

        previousFrameDataRef.current = currentFrameData;

        const now = Date.now();
        const wasAwake = state.isAwake;

        setState((prev) => {
          let newIsAwake = prev.isAwake;
          let newLastMotionDetected = prev.lastMotionDetected;

          // Handle motion detection and sleep/wake transitions
          if (motionLevel >= MOTION_THRESHOLDS.motionThreshold) {
            newLastMotionDetected = now;

            // Wake up if sleeping and motion exceeds wake threshold
            if (!prev.isAwake && motionLevel >= MOTION_THRESHOLDS.wakeThreshold) {
              newIsAwake = true;
              console.log('[CameraAttentiveness] Motion detected, waking up');
            }
          }

          return {
            ...prev,
            motionLevel,
            lastMotionDetected: newLastMotionDetected,
            isAwake: newIsAwake,
            frameCount: prev.frameCount + 1,
          };
        });

        // Notify motion state change
        if (wasAwake !== state.isAwake || motionLevel !== state.motionLevel) {
          motionStateCallbackRef.current?.(state.isAwake, motionLevel);
        }

        // Capture full frame if awake and callback is registered
        if (state.isAwake && frameCapturedCallbackRef.current) {
          const frame = await captureFrame(state.mode.resolution);
          if (frame) {
            setState((prev) => ({ ...prev, lastFrameUrl: frame.dataUrl }));
            frameCapturedCallbackRef.current(frame);
          }
        }
      }
    } catch (err) {
      console.error('[CameraAttentiveness] Monitoring tick error:', err);
    } finally {
      setState((prev) => ({ ...prev, isCapturing: false }));
    }
  }, [
    state.isRunning,
    state.isAwake,
    state.mode.resolution,
    state.motionLevel,
    videoStream,
    getMotionDetectionData,
    detectMotion,
    captureFrame,
  ]);

  /**
   * Check for sleep timeout
   */
  useEffect(() => {
    if (!state.isRunning || !state.isAwake) return;

    // Clear existing timeout
    if (sleepTimeoutRef.current) {
      clearTimeout(sleepTimeoutRef.current);
    }

    // Set new timeout to check if we should sleep
    sleepTimeoutRef.current = setTimeout(() => {
      setState((prev) => {
        if (!prev.lastMotionDetected) return prev;

        const timeSinceMotion = Date.now() - prev.lastMotionDetected;
        if (timeSinceMotion >= MOTION_THRESHOLDS.sleepTimeout) {
          console.log('[CameraAttentiveness] No motion detected, going to sleep');
          motionStateCallbackRef.current?.(false, 0);
          return { ...prev, isAwake: false };
        }
        return prev;
      });
    }, MOTION_THRESHOLDS.sleepTimeout);

    return () => {
      if (sleepTimeoutRef.current) {
        clearTimeout(sleepTimeoutRef.current);
      }
    };
  }, [state.isRunning, state.isAwake, state.lastMotionDetected]);

  /**
   * Set up the capture interval based on current frequency
   */
  useEffect(() => {
    // Clear existing interval
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }

    if (!state.isRunning || !videoStream) return;

    // Use sleep frequency if asleep, otherwise use configured frequency
    const frequency = state.isAwake ? state.mode.frequency : 'sleep';
    const interval = FREQUENCY_INTERVALS[frequency];

    console.log(`[CameraAttentiveness] Setting capture interval: ${interval}ms (${frequency})`);

    captureIntervalRef.current = setInterval(monitoringTick, interval);

    // Run immediately
    monitoringTick();

    return () => {
      if (captureIntervalRef.current) {
        clearInterval(captureIntervalRef.current);
      }
    };
  }, [state.isRunning, state.isAwake, state.mode.frequency, videoStream, monitoringTick]);

  // Control methods
  const start = useCallback(() => {
    console.log('[CameraAttentiveness] Starting monitoring');
    previousFrameDataRef.current = null;
    setState((prev) => ({
      ...prev,
      isRunning: true,
      isAwake: true,
      error: null,
      frameCount: 0,
    }));
  }, []);

  const stop = useCallback(() => {
    console.log('[CameraAttentiveness] Stopping monitoring');
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    if (sleepTimeoutRef.current) {
      clearTimeout(sleepTimeoutRef.current);
      sleepTimeoutRef.current = null;
    }
    setState((prev) => ({
      ...prev,
      isRunning: false,
      isCapturing: false,
    }));
  }, []);

  const wake = useCallback(() => {
    console.log('[CameraAttentiveness] Manual wake');
    setState((prev) => ({
      ...prev,
      isAwake: true,
      lastMotionDetected: Date.now(),
    }));
    motionStateCallbackRef.current?.(true, state.motionLevel);
  }, [state.motionLevel]);

  const sleep = useCallback(() => {
    console.log('[CameraAttentiveness] Manual sleep');
    setState((prev) => ({ ...prev, isAwake: false }));
    motionStateCallbackRef.current?.(false, 0);
  }, []);

  const setFrequency = useCallback((frequency: CaptureFrequency) => {
    console.log(`[CameraAttentiveness] Setting frequency: ${frequency}`);
    setState((prev) => ({
      ...prev,
      mode: { ...prev.mode, frequency },
    }));
  }, []);

  const setResolution = useCallback((resolution: CaptureResolution) => {
    console.log(`[CameraAttentiveness] Setting resolution: ${resolution}`);
    setState((prev) => ({
      ...prev,
      mode: { ...prev.mode, resolution },
    }));
  }, []);

  const setMode = useCallback((mode: Partial<AttentivenessMode>) => {
    console.log('[CameraAttentiveness] Setting mode:', mode);
    setState((prev) => ({
      ...prev,
      mode: { ...prev.mode, ...mode },
    }));
  }, []);

  const onFrameCaptured = useCallback((callback: FrameCapturedCallback | null) => {
    frameCapturedCallbackRef.current = callback;
  }, []);

  const onMotionStateChange = useCallback((callback: MotionStateCallback | null) => {
    motionStateCallbackRef.current = callback;
  }, []);

  const getLastFrame = useCallback(() => {
    return lastFrameRef.current;
  }, []);

  const captureNow = useCallback(
    async (resolution?: CaptureResolution): Promise<CapturedFrame | null> => {
      return captureFrame(resolution ?? state.mode.resolution);
    },
    [captureFrame, state.mode.resolution]
  );

  // Auto-start when stream becomes available
  useEffect(() => {
    if (autoStart && videoStream && !state.isRunning) {
      // Small delay to ensure video is ready
      const timeout = setTimeout(() => {
        start();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [autoStart, videoStream, state.isRunning, start]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const value: CameraAttentivenessContextType = {
    state,
    start,
    stop,
    wake,
    sleep,
    setFrequency,
    setResolution,
    setMode,
    onFrameCaptured,
    onMotionStateChange,
    getLastFrame,
    captureNow,
  };

  return (
    <CameraAttentivenessContext.Provider value={value}>
      {children}
    </CameraAttentivenessContext.Provider>
  );
}

/**
 * Hook to access the camera attentiveness context
 */
export function useCameraAttentiveness(): CameraAttentivenessContextType {
  const context = useContext(CameraAttentivenessContext);
  if (context === undefined) {
    throw new Error(
      'useCameraAttentiveness must be used within a CameraAttentivenessProvider'
    );
  }
  return context;
}

/**
 * Optional hook that returns undefined if not in provider
 */
export function useCameraAttentivenessOptional(): CameraAttentivenessContextType | undefined {
  return useContext(CameraAttentivenessContext);
}

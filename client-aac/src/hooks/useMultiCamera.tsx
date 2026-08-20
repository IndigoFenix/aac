import {
  useState,
  useRef,
  useCallback,
  useEffect,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { useCamera } from '@/hooks/useCamera';
import { isSingleCameraCaptureOS } from '@/lib/platform';

// One camera only on iOS/iPadOS WebKit — starting a second capture kills the
// first one's track (which used to ping-pong forever via the track-ended
// recovery below). Evaluated once; the OS doesn't change under us.
const SINGLE_CAMERA_ONLY = isSingleCameraCaptureOS(
  typeof navigator !== 'undefined' ? navigator.userAgent : '',
  typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0,
);

interface CameraStream {
  id: string;
  deviceId: string;
  label: string;
  stream: MediaStream | null;
  isActive: boolean;
  error: string | null;
  facing: 'user' | 'environment' | 'unknown';
}

function useMultiCameraImpl(options?: { autoStart?: boolean }) {
  const autoStart = options?.autoStart ?? true;
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<Map<string, CameraStream>>(new Map());
  const [isEnumerating, setIsEnumerating] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Determine camera facing direction from label with priority for integrated cameras
  const getFacingMode = useCallback((label: string): 'user' | 'environment' | 'unknown' => {
    const lowerLabel = label.toLowerCase();
    
    // Priority: Integrated cameras are user-facing by default
    if (lowerLabel.includes('integrated') || lowerLabel.includes('builtin') || lowerLabel.includes('built-in')) {
      return 'user';
    }
    
    // External cameras are environment-facing by default  
    if (lowerLabel.includes('hd webcam') || lowerLabel.includes('usb') || lowerLabel.includes('external')) {
      return 'environment';
    }
    
    // Fallback based on common naming patterns
    if (lowerLabel.includes('front') || lowerLabel.includes('user') || lowerLabel.includes('selfie')) {
      return 'user';
    }
    if (lowerLabel.includes('back') || lowerLabel.includes('rear') || lowerLabel.includes('environment')) {
      return 'environment';
    }
    
    return 'unknown';
  }, []);

  // Start a specific camera
  const startCamera = useCallback(async (deviceId: string, facing: 'user' | 'environment' | 'unknown' = 'unknown') => {
    try {
      console.log(`Starting camera: ${deviceId} (${facing})`);
      
      const device = availableDevices.find(d => d.deviceId === deviceId);
      if (!device) {
        throw new Error('Camera device not found');
      }

      // Request camera stream
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });

      const cameraStream: CameraStream = {
        id: deviceId,
        deviceId,
        label: device.label || `Camera ${deviceId.slice(0, 8)}`,
        stream,
        isActive: true,
        error: null,
        facing: facing === 'unknown' ? getFacingMode(device.label) : facing
      };

      setCameras(prev => new Map(prev.set(deviceId, cameraStream)));
      console.log(`Camera started successfully: ${cameraStream.label} (${cameraStream.facing})`);
      
      return cameraStream;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to start camera ${deviceId}:`, error);
      
      setCameras(prev => {
        const updated = new Map(prev);
        updated.set(deviceId, {
          id: deviceId,
          deviceId,
          label: availableDevices.find(d => d.deviceId === deviceId)?.label || `Camera ${deviceId.slice(0, 8)}`,
          stream: null,
          isActive: false,
          error: errorMessage,
          facing: 'unknown'
        });
        return updated;
      });
      
      throw error;
    }
  }, [availableDevices, getFacingMode]);

  // Stop a specific camera
  const stopCamera = useCallback((deviceId: string) => {
    const camera = cameras.get(deviceId);
    if (camera?.stream) {
      camera.stream.getTracks().forEach(track => track.stop());
    }
    
    setCameras(prev => {
      const updated = new Map(prev);
      updated.delete(deviceId);
      return updated;
    });
    
    console.log(`Camera stopped: ${deviceId}`);
  }, [cameras]);

  // Auto-assign cameras by default: integrated as user, external as environment
  const autoAssignCameras = useCallback(async () => {
    const devices = availableDevices;
    if (devices.length === 0) return;

    try {
      console.log('Available cameras for assignment:', devices.map(d => ({
        deviceId: d.deviceId.slice(0, 8),
        label: d.label,
        facing: getFacingMode(d.label)
      })));

      // Strategy: If we have multiple cameras, try the second one first for user detection
      // since the current assignment seems to have the user on the second camera
      let userCamera, environmentCamera;
      
      if (devices.length >= 2) {
        // PRIORITY: Integrated camera should be the primary source for main user validation
        const integratedWebcam = devices.find(device => device.label.includes('Integrated Webcam'));
        const hdWebcam = devices.find(device => device.label.includes('HD Webcam C525'));
        
        if (integratedWebcam && hdWebcam) {
          userCamera = integratedWebcam;  // Integrated camera for main user detection
          environmentCamera = hdWebcam;   // HD Webcam for environment analysis
          console.log('Multi-camera strategy: Integrated Webcam as user camera (primary for main user validation)');
        } else {
          // Fallback: prioritize integrated cameras for user detection
          const integratedCamera = devices.find(d => getFacingMode(d.label) === 'user');
          const environmentCameraDevice = devices.find(d => getFacingMode(d.label) === 'environment');
          
          if (integratedCamera) {
            userCamera = integratedCamera;
            environmentCamera = environmentCameraDevice || devices.find(d => d !== integratedCamera);
            console.log('Multi-camera strategy: Using integrated/user-facing camera for main user detection');
          } else {
            // Last resort fallback
            userCamera = devices[0];
            environmentCamera = devices[1];
            console.log('Multi-camera strategy: Using fallback camera assignment');
          }
        }
      } else if (devices.length === 1) {
        // Single camera setup
        userCamera = devices[0];
        environmentCamera = null;
        console.log('Single camera strategy: Using only available camera as user camera');
      } else {
        console.log('No cameras available for assignment');
        return;
      }

      if (SINGLE_CAMERA_ONLY && environmentCamera) {
        console.log('Single-capture OS (iOS/iPadOS): environment camera disabled, user camera only');
        environmentCamera = null;
      }

      console.log('Auto-assigned cameras:', {
        userCamera: userCamera ? { id: userCamera.deviceId, label: userCamera.label } : null,
        environmentCamera: environmentCamera ? { id: environmentCamera.deviceId, label: environmentCamera.label } : null
      });

      // Start both cameras if available
      if (userCamera) {
        await startCamera(userCamera.deviceId, 'user');
      }
      if (environmentCamera) {
        await startCamera(environmentCamera.deviceId, 'environment');
      }
    } catch (error) {
      console.error('Failed to auto-assign cameras:', error);
      setGlobalError('Failed to start multi-camera mode');
    }
  }, [availableDevices, startCamera]);

  // Enumerate available camera devices
  const enumerateDevices = useCallback(async () => {
    try {
      setIsEnumerating(true);
      setGlobalError(null);
      
      // Check if MediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        console.warn('MediaDevices API not available - running in camera-less mode');
        setAvailableDevices([]);
        return;
      }
      
      // First, try to enumerate without permissions (basic device info)
      let devices = await navigator.mediaDevices.enumerateDevices();
      let videoDevices = devices.filter(device => device.kind === 'videoinput');
      
      // If no cameras found or no labels, request permission and re-enumerate.
      // Some browsers hide devices entirely until getUserMedia permission is granted.
      if (videoDevices.length === 0 || videoDevices.some(d => !d.label)) {
        try {
          console.log('Requesting camera permissions...');
          const tempStream = await Promise.race([
            navigator.mediaDevices.getUserMedia({ video: true }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Permission request timeout after 5 seconds')), 5000)
            )
          ]);

          // Stop the temporary stream immediately
          tempStream.getTracks().forEach(track => track.stop());

          // Re-enumerate with permissions granted
          await new Promise(resolve => setTimeout(resolve, 200));
          devices = await navigator.mediaDevices.enumerateDevices();
          videoDevices = devices.filter(device => device.kind === 'videoinput');

          console.log('Camera permissions granted, re-enumerated devices');
        } catch (permError) {
          console.warn('Camera permission request failed, continuing in camera-less mode:', permError);
          setAvailableDevices([]);
          return;
        }
      }

      if (videoDevices.length === 0) {
        console.log('No cameras found - continuing in camera-less mode');
        setAvailableDevices([]);
        return;
      }
      
      setAvailableDevices(videoDevices);
      
      console.log('Available cameras:', videoDevices.map(d => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
        facing: getFacingMode(d.label || `Camera ${d.deviceId.slice(0, 8)}`)
      })));
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn('Camera enumeration failed, continuing in camera-less mode:', error);
      
      // Don't set as global error - app can still work with audio features
      setAvailableDevices([]);
    } finally {
      setIsEnumerating(false);
    }
  }, [getFacingMode]);

  // Auto-assign cameras when devices are available (only when autoStart is true)
  useEffect(() => {
    if (!autoStart) return;
    if (availableDevices.length > 0) {
      autoAssignCameras();
    } else {
      console.log('No cameras available - app will work in camera-less mode with audio features only');
    }
  }, [autoStart, availableDevices, autoAssignCameras]);

  // Initialize devices on mount
  useEffect(() => {
    enumerateDevices();
  }, [enumerateDevices]);

  // Get user-facing camera stream
  const getUserCamera = useCallback(() => {
    const cameraArray = Array.from(cameras.values());
    return cameraArray.find(camera => 
      camera.facing === 'user' && camera.isActive && camera.stream
    ) || null;
  }, [cameras]);

  // Get environment-facing camera stream
  const getEnvironmentCamera = useCallback(() => {
    const cameraArray = Array.from(cameras.values());
    return cameraArray.find(camera => 
      camera.facing === 'environment' && camera.isActive && camera.stream
    ) || null;
  }, [cameras]);

  // Stop all cameras
  const stopAllCameras = useCallback(() => {
    Array.from(cameras.values()).forEach(camera => {
      if (camera.stream) {
        camera.stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      }
    });
    setCameras(new Map());
    console.log('All cameras stopped');
  }, [cameras]);

  // Capture frame from specific camera
  const captureFrameFromCamera = useCallback(async (deviceId: string): Promise<Blob | null> => {
    const camera = cameras.get(deviceId);
    if (!camera || !camera.stream || !camera.isActive) {
      console.log(`Camera ${deviceId} not available for capture`);
      return null;
    }

    try {
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) return null;

      video.srcObject = camera.stream;
      video.muted = true;
      video.playsInline = true;

      return new Promise((resolve) => {
        const cleanup = () => {
          video.pause();
          video.srcObject = null;
          video.remove();
          canvas.remove();
        };

        video.addEventListener('loadedmetadata', () => {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          
          video.addEventListener('canplay', () => {
            try {
              ctx.drawImage(video, 0, 0);
              canvas.toBlob((blob) => {
                cleanup();
                resolve(blob);
              }, 'image/jpeg', 0.8);
            } catch (drawError) {
              console.error("Error drawing video frame:", drawError);
              cleanup();
              resolve(null);
            }
          }, { once: true });
        }, { once: true });

        video.addEventListener('error', (err) => {
          console.error("Video element error:", err);
          cleanup();
          resolve(null);
        });

        video.play().catch(err => {
          console.error("Video play error:", err);
          cleanup();
          resolve(null);
        });
      });
    } catch (err) {
      console.error("Frame capture error:", err);
      return null;
    }
  }, [cameras]);

  return {
    availableDevices,
    cameras: Array.from(cameras.values()),
    isEnumerating,
    globalError,
    enumerateDevices,
    startCamera,
    stopCamera,
    stopAllCameras,
    getUserCamera,
    getEnvironmentCamera,
    captureFrameFromCamera,
    autoAssignCameras,
    isMultiCameraActive: cameras.size > 1,
    userCameraActive: getUserCamera() !== null,
    environmentCameraActive: getEnvironmentCamera() !== null
  };
}

// =============================================================================
// SINGLETON CONTEXT + SHARED USER-CAMERA VIDEO ELEMENT
//
// Why this exists: `useMultiCameraImpl` was previously called directly from
// multiple components (home, the attentiveness wrapper, two debug panels).
// Each call site ran its own getUserMedia, so a single physical camera was
// acquired several times concurrently. Desktop browsers tolerate that; iOS /
// iPadOS does not — the second acquisition stalls the first, freezing the feed
// ("works briefly, then faceMirror stops moving and Motion/Frame go to 0").
//
// The provider runs ONE impl instance and owns ONE hidden <video> bound to the
// user stream. All consumers (face tracking, hand tracking, attentiveness
// motion + capture) read from `userVideoEl` instead of attaching the stream to
// their own elements. The element is positioned offscreen but kept RENDERED
// (opacity:0 + 1px, never display:none) because iOS pauses display:none videos.
// =============================================================================

export interface CameraDiagEvent {
  t: number;
  kind: string;
  detail?: string;
}

export interface CaptureUserFrameOptions {
  width?: number;
  height?: number;
  quality?: number;
}

type MultiCameraImplValue = ReturnType<typeof useMultiCameraImpl>;

export interface MultiCameraValue extends MultiCameraImplValue {
  /** The single shared hidden <video> playing the user camera, or null until created. */
  userVideoEl: HTMLVideoElement | null;
  /**
   * The ONE user-camera MediaStream, whichever path produced it (multi-camera
   * assignment or the legacy shared-camera fallback). Exposed so a consumer
   * that genuinely needs the stream — the session recorder hands it to a
   * MediaRecorder — reads the existing one instead of calling getUserMedia
   * again, which is the whole point of this provider. Adding a track consumer
   * is fine; attaching it to a second <video> is what freezes iOS, so don't.
   */
  userStream: MediaStream | null;
  /** True once the shared user video has decodable frames (readyState >= 2). */
  userVideoReady: boolean;
  /** Capture a JPEG frame from the shared user video element (no transient <video>). */
  captureUserFrame: (opts?: CaptureUserFrameOptions) => Promise<Blob | null>;
  /** Rolling log of camera lifecycle events (track mute/unmute/ended, replays) for on-device debugging. */
  cameraDiag: CameraDiagEvent[];
}

const MultiCameraContext = createContext<MultiCameraValue | null>(null);

const MAX_DIAG_EVENTS = 50;

export function MultiCameraProvider({ children }: { children: ReactNode }) {
  const base = useMultiCameraImpl({ autoStart: true });
  const { getUserCamera } = base;

  // Fallback stream for the no-multi-camera path (see home.tsx startSharedCamera).
  const { stream: sharedCameraStream } = useCamera();

  const userVideoRef = useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [userVideoReady, setUserVideoReady] = useState(false);
  const [elReady, setElReady] = useState(false); // flips once the element is created
  const [cameraDiag, setCameraDiag] = useState<CameraDiagEvent[]>([]);

  // Track-ended recovery throttle. Re-acquisition itself can end tracks (on
  // iOS a new capture kills the previous one), so an unthrottled recovery
  // becomes a permanent acquire/kill loop that churns the whole app.
  const lastRecoveryRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const RECOVERY_MIN_INTERVAL_MS = 5000;

  const logDiag = useCallback((kind: string, detail?: string) => {
    const ev: CameraDiagEvent = { t: Date.now(), kind, detail };
    console.log(`[SharedCamera] ${kind}${detail ? `: ${detail}` : ''}`);
    setCameraDiag((prev) => {
      const next = [...prev, ev];
      return next.length > MAX_DIAG_EVENTS ? next.slice(-MAX_DIAG_EVENTS) : next;
    });
  }, []);

  // Resolve the active user stream. Multi-camera assignment is the normal path;
  // sharedCameraStream is the legacy fallback when no multi-cam device enrolled.
  const userCam = getUserCamera();
  const userStream = userCam?.stream ?? sharedCameraStream ?? null;

  // Create the single shared hidden video element exactly once.
  useEffect(() => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    // Offscreen but RENDERED — iOS pauses display:none / visibility:hidden videos.
    v.style.position = 'fixed';
    v.style.left = '0';
    v.style.top = '0';
    v.style.width = '1px';
    v.style.height = '1px';
    v.style.opacity = '0';
    v.style.pointerEvents = 'none';
    v.style.zIndex = '-1';
    document.body.appendChild(v);
    userVideoRef.current = v;

    const onLoaded = () => setUserVideoReady(v.readyState >= 2);
    const onPause = () => {
      // iOS resilience: if the element pauses while a stream is attached,
      // immediately resume. Backgrounding / focus changes trigger spurious pauses.
      if (v.srcObject) {
        logDiag('video-pause-resume');
        v.play().catch(() => {});
      }
    };
    v.addEventListener('loadeddata', onLoaded);
    v.addEventListener('playing', onLoaded);
    v.addEventListener('pause', onPause);

    setElReady(true);

    return () => {
      v.removeEventListener('loadeddata', onLoaded);
      v.removeEventListener('playing', onLoaded);
      v.removeEventListener('pause', onPause);
      v.pause();
      v.srcObject = null;
      v.remove();
      userVideoRef.current = null;
      if (recoveryTimerRef.current !== null) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bind the user stream to the shared element and wire iOS track recovery.
  useEffect(() => {
    const v = userVideoRef.current;
    if (!v) return;

    if (!userStream) {
      v.pause();
      v.srcObject = null;
      setUserVideoReady(false);
      return;
    }

    if (v.srcObject !== userStream) {
      v.srcObject = userStream;
      logDiag('stream-attached', `tracks=${userStream.getVideoTracks().length}`);
    }
    v.play()
      .then(() => setUserVideoReady(v.readyState >= 2))
      .catch((err) => logDiag('play-error', String(err)));

    const track = userStream.getVideoTracks()[0];
    if (!track) return;

    const onMute = () => logDiag('track-mute', track.label);
    const onUnmute = () => {
      logDiag('track-unmute', track.label);
      v.play().catch(() => {});
    };
    const onEnded = () => {
      // iOS dropped the capture entirely — re-acquire from scratch, but at
      // most once per RECOVERY_MIN_INTERVAL_MS (see throttle refs above).
      logDiag('track-ended', track.label);
      if (recoveryTimerRef.current !== null) return; // recovery already queued
      const wait = Math.max(
        0,
        RECOVERY_MIN_INTERVAL_MS - (Date.now() - lastRecoveryRef.current),
      );
      recoveryTimerRef.current = setTimeout(() => {
        recoveryTimerRef.current = null;
        lastRecoveryRef.current = Date.now();
        logDiag('capture-recovery');
        base.autoAssignCameras().catch(() => {});
      }, wait);
    };
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    track.addEventListener('ended', onEnded);

    return () => {
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
      track.removeEventListener('ended', onEnded);
    };
    // base.autoAssignCameras is stable enough; userStream identity drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userStream, logDiag]);

  // When the page returns to foreground, ensure the shared element resumes.
  useEffect(() => {
    const onVisibility = () => {
      const v = userVideoRef.current;
      if (!document.hidden && v?.srcObject) {
        logDiag('visibility-resume');
        v.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [logDiag]);

  const captureUserFrame = useCallback(
    async (opts?: CaptureUserFrameOptions): Promise<Blob | null> => {
      const v = userVideoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
      let canvas = captureCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement('canvas');
        captureCanvasRef.current = canvas;
      }
      const w = opts?.width ?? v.videoWidth;
      const h = opts?.height ?? v.videoHeight;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      try {
        ctx.drawImage(v, 0, 0, w, h);
      } catch {
        return null;
      }
      return await new Promise<Blob | null>((resolve) => {
        canvas!.toBlob((b) => resolve(b), 'image/jpeg', opts?.quality ?? 0.8);
      });
    },
    [],
  );

  const value: MultiCameraValue = {
    ...base,
    userVideoEl: elReady ? userVideoRef.current : null,
    userStream,
    userVideoReady,
    captureUserFrame,
    cameraDiag,
  };

  return (
    <MultiCameraContext.Provider value={value}>{children}</MultiCameraContext.Provider>
  );
}

/**
 * Access the shared multi-camera system. Must be rendered inside
 * <MultiCameraProvider>. The legacy `options` argument is accepted for
 * call-site compatibility but ignored — the provider controls acquisition.
 */
export function useMultiCamera(_options?: { autoStart?: boolean }): MultiCameraValue {
  const ctx = useContext(MultiCameraContext);
  if (!ctx) {
    throw new Error('useMultiCamera must be used within a MultiCameraProvider');
  }
  return ctx;
}
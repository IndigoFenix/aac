import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UserX, Eye, EyeOff, Play } from "lucide-react";
import DynamicBoard from "@/components/DynamicBoard";
import PrebuiltBoardSection from "@/components/PrebuiltBoardSection";
import QuickActions from "@/components/QuickActions";
import type { ParsedBoardData, BoardButton } from "@shared/schema";

import ChatLog from "@/components/ChatLog";
import ProfileSetup from "@/components/ProfileSetup";
import UserSettings from "@/components/UserSettings";
import { AccessibilityProvider } from "@/contexts/AccessibilityContext";
import { ConversationBox } from "@/components/ConversationBox";
import { DualAgentConversationBox } from "@/components/DualAgentConversationBox";
import { DualAgentProvider, useDualAgentContext } from "@/contexts/DualAgentContext";
import { Button } from "@/components/ui/button";
import { useGestures } from "@/hooks/useGestures";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useCamera } from "@/hooks/useCamera";
import { usePersonIdentification } from "@/hooks/usePersonIdentification";
import { useFaceImageCache } from "@/hooks/useFaceImageCache";
import UnifiedDebugPanel from "@/components/UnifiedDebugPanel";
import YesNoOverlay from "@/components/YesNoOverlay";
import TwoHandedObjectDetection from "@/components/TwoHandedObjectDetection";
import { DetectedObject } from "@/hooks/useTwoHandedObjectDetection";
import { ObjectDetectionDebug } from "@/components/ObjectDetectionDebug";
import InitializationLoadingScreen from "@/components/InitializationLoadingScreen";
import YouTubeApp from "@/components/apps/YouTubeApp";
import DrawingApp from "@/components/apps/DrawingApp";
import MusicApp from "@/components/apps/MusicApp";
import SpotifyApp from "@/components/apps/SpotifyApp";
import GameEmbed from "@/components/games/GameEmbed";
import BrowserApp from "@/components/apps/BrowserApp";
import type { PermittedWebsite } from "@shared/schema";
import { CustomAppPlayer } from "@/components/CustomAppPlayer";
import AppMiniBoard from "@/components/AppMiniBoard";
import { CameraAttentivenessWrapper } from "@/components/CameraAttentivenessWrapper";
import { FaceEngagementSignalFeed, MouseEyegazeSignalFeed } from "@/components/SleepSignalFeeds";
import { CameraFrameCollector } from "@/lib/cameraFrameCollector";
import { useFaceTracking } from "@/hooks/useFaceTracking";
import { useFaceEvents } from "@/hooks/useFaceEvents";
import { useHandGestureTracking } from "@/hooks/useHandGestureTracking";
import { useHandGestureEvents } from "@/hooks/useHandGestureEvents";
import { useSignLanguageClassifier } from "@/hooks/useSignLanguageClassifier";
import { useSignLanguagePhrase } from "@/hooks/useSignLanguagePhrase";
import { isValidSignLanguageCode } from "@/i18n";
import { serializeGestureContext } from "@/lib/gestureContextSerializer";
import { EyeTrackingDwellProvider } from "@/contexts/EyeTrackingDwellContext";
import DwellOverlay from "@/components/DwellOverlay";
import GazeCalibrationOverlay from "@/components/GazeCalibrationOverlay";
import { useEyeGaze } from "@/hooks/useEyeGaze";
import type { EyeGazeProviderType } from "@/lib/eyegaze/types";

import { useLanguage } from "@/contexts/LanguageContext";
import { useAppInitialization } from "@/contexts/AppInitializationContext";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, fetchWithAuth } from "@/lib/queryClient";

interface HomeProps {
  studentId: string;
  onLogout: () => void;
  onExitStudent: () => void;
}

/**
 * Inner component that bridges DualAgentContext to parent Home for interpret/mode features.
 * Must be rendered inside DualAgentProvider.
 */
function DualAgentBridge({ onModeChange, onInterpretReady, onDetectionChange, onBoardPatchChange, onSymbolUpdateChange, onAiButtonPressChange, onSendMessageReady, onSendContextOnlyReady, onBoardExitReady, onGuessingModeChange, onContextButtonsChange, onInitializedChange, onYesNoChange, onRestartSessionReady, onPausedChange, onActiveAppChange }: {
  onModeChange: (mode: 'interact' | 'silent') => void;
  onInterpretReady: (fn: ((buttons: string[], sentences?: Record<string, string>) => Promise<void>) | null) => void;
  onDetectionChange?: (enabled: boolean) => void;
  onBoardPatchChange?: (patch: import("@/hooks/dual-agent-types").BoardPatch | null) => void;
  onSymbolUpdateChange?: (data: { buttonLabel: string; symbolPath: string } | null) => void;
  onAiButtonPressChange?: (data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null) => void;
  onSendMessageReady?: (fn: ((msg: string) => Promise<void>) | null) => void;
  onSendContextOnlyReady?: (fn: ((text: string) => void) | null) => void;
  onInitializedChange?: (initialized: boolean) => void;
  onYesNoChange?: (active: boolean, dismiss: () => void) => void;
  onRestartSessionReady?: (fn: (() => void) | null) => void;
  onPausedChange?: (paused: boolean, setPaused: (p: boolean) => void) => void;
  onActiveAppChange?: (app: import("@/hooks/dual-agent-types").ActiveAppData | null, dismissApp: () => void, registerCapture: (fn: (() => Promise<Blob | null>) | null) => void) => void;
  onBoardExitReady?: (fn: ((label: string, instruction: string) => void) | null) => void;
  onGuessingModeChange?: (active: boolean) => void;
  onContextButtonsChange?: (buttons: Array<{ label: string; iconRef: string; symbolPath?: string; sentence?: string }>) => void;
}) {
  const { interactionMode, interpretButtons, videoCaptureEnabled, voiceEnabled, boardPatch, symbolUpdate, aiButtonPress, sendMessage, sendContextOnly, sendBoardExit, isInitialized, yesNoActive, dismissYesNo, clearSession, initialize, paused, setPaused, activeApp, dismissApp, registerAppCanvasCapture, studentId, guessingMode, contextButtons: contextButtonsFromCtx } = useDualAgentContext();

  useEffect(() => {
    onModeChange(interactionMode);
  }, [interactionMode, onModeChange]);

  useEffect(() => {
    onInterpretReady((buttons: string[], sentences?: Record<string, string>) => interpretButtons(buttons, sentences));
    return () => onInterpretReady(null);
  }, [interpretButtons, onInterpretReady]);

  useEffect(() => {
    onDetectionChange?.(videoCaptureEnabled || voiceEnabled);
  }, [videoCaptureEnabled, voiceEnabled, onDetectionChange]);

  useEffect(() => {
    onBoardPatchChange?.(boardPatch);
  }, [boardPatch, onBoardPatchChange]);

  useEffect(() => {
    onSymbolUpdateChange?.(symbolUpdate);
  }, [symbolUpdate, onSymbolUpdateChange]);

  useEffect(() => {
    onAiButtonPressChange?.(aiButtonPress);
  }, [aiButtonPress, onAiButtonPressChange]);

  useEffect(() => {
    onSendMessageReady?.((msg: string) => sendMessage(msg));
    return () => onSendMessageReady?.(null);
  }, [sendMessage, onSendMessageReady]);

  useEffect(() => {
    onSendContextOnlyReady?.((text: string) => sendContextOnly(text));
    return () => onSendContextOnlyReady?.(null);
  }, [sendContextOnly, onSendContextOnlyReady]);

  useEffect(() => {
    onBoardExitReady?.(sendBoardExit);
    return () => onBoardExitReady?.(null);
  }, [sendBoardExit, onBoardExitReady]);

  useEffect(() => {
    onGuessingModeChange?.(guessingMode);
  }, [guessingMode, onGuessingModeChange]);

  useEffect(() => {
    onContextButtonsChange?.(contextButtonsFromCtx);
  }, [contextButtonsFromCtx, onContextButtonsChange]);

  useEffect(() => {
    onInitializedChange?.(isInitialized);
  }, [isInitialized, onInitializedChange]);

  useEffect(() => {
    onYesNoChange?.(yesNoActive, dismissYesNo);
  }, [yesNoActive, dismissYesNo, onYesNoChange]);

  useEffect(() => {
    onRestartSessionReady?.(() => {
      clearSession();
      // Small delay to let cleanup complete before reinitializing
      setTimeout(() => initialize(), 500);
    });
    return () => onRestartSessionReady?.(null);
  }, [clearSession, initialize, onRestartSessionReady]);

  useEffect(() => {
    onPausedChange?.(paused, setPaused);
  }, [paused, setPaused, onPausedChange]);

  useEffect(() => {
    onActiveAppChange?.(activeApp, dismissApp, registerAppCanvasCapture);
  }, [activeApp, dismissApp, registerAppCanvasCapture, onActiveAppChange]);

  return null;
}

/** Returns the app component for the given activeApp, or null */
function renderAppContent(
  activeApp: import("@/hooks/dual-agent-types").ActiveAppData | null,
  dismissApp: () => void,
  registerCapture: (fn: (() => Promise<Blob | null>) | null) => void,
  studentId: string,
  sendMessageToAi?: (msg: string) => void,
  permittedWebsites?: PermittedWebsite[],
  sendContextOnlyToAi?: (text: string) => void,
): React.ReactNode {
  if (!activeApp) return null;
  if (activeApp.appId === "youtube") {
    return (
      <YouTubeApp
        videoId={activeApp.appData?.videoId}
        title={activeApp.appData?.title || "Video"}
        channels={activeApp.appData?.channels}
        onClose={dismissApp}
        sendContextOnly={sendContextOnlyToAi}
      />
    );
  }
  if (activeApp.appId === "drawing") {
    return <DrawingApp onClose={dismissApp} onRegisterCapture={registerCapture} />;
  }
  if (activeApp.appId === "music") {
    return <MusicApp onClose={dismissApp} />;
  }
  if (activeApp.appId === "spotify") {
    return <SpotifyApp trackId={activeApp.appData?.trackId || ""} title={activeApp.appData?.title || activeApp.appData?.query || "Music"} artist={activeApp.appData?.artist || ""} studentId={studentId} onClose={dismissApp} />;
  }
  if (activeApp.appId === "sandbox_game") {
    return (
      <GameEmbed
        gameId="sandbox-game"
        src="/games/sandbox-game/"
        onClose={dismissApp}
      />
    );
  }
  if (activeApp.appId === "bubbles_game") {
    return (
      <GameEmbed
        gameId="bubbles-game"
        src="/games/bubbles-game/"
        forwardGaze
        onClose={dismissApp}
      />
    );
  }
  if (activeApp.appId === "browser" && activeApp.appData?.url) {
    return (
      <BrowserApp
        url={activeApp.appData.url}
        label={activeApp.appData.label}
        permittedWebsites={permittedWebsites || []}
        onClose={dismissApp}
        sendContextOnly={sendContextOnlyToAi}
      />
    );
  }
  if (activeApp.appId === "custom_app" && activeApp.appData?.definition) {
    return (
      <CustomAppPlayer
        definition={activeApp.appData.definition}
        onClose={dismissApp}
        sendMessageToAi={sendMessageToAi}
      />
    );
  }
  return null;
}

export default function Home({ studentId, onLogout, onExitStudent }: HomeProps) {
  // Disable periodic camera detection calls (detect-person, analyze-image) to focus on chat
  const DISABLE_PERIODIC_DETECTION = true;

  const [showChatLog, setShowChatLog] = useState(false);
  const [showProfileSetup, setShowProfileSetup] = useState(false);
  const [showConversation, setShowConversation] = useState(false);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [currentSpeech, setCurrentSpeech] = useState<string>("");
  const [showGestureHints, setShowGestureHints] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [currentVisualContext, setCurrentVisualContext] = useState<string>("");
  const [isMainUserPresent, setIsMainUserPresent] = useState<boolean>(true);
  const [anyPersonPresent, setAnyPersonPresent] = useState<boolean>(true);
  const [isCameraBlocked, setIsCameraBlocked] = useState<boolean>(false);
  const [isStandbyMode, setIsStandbyMode] = useState<boolean>(false);
  // Language is now managed by LanguageContext
  const { language: currentLanguage, setLanguage: setCurrentLanguage, t, isRTL, direction, signLanguage } = useLanguage();
  const [useDualAgent, setUseDualAgent] = useState<boolean>(true); // Toggle for dual-agent system

  // Use the initialization context for loading state
  const { isComplete: isInitComplete } = useAppInitialization();
  // Object detection is now controlled via user settings
  const [detectedObjects, setDetectedObjects] = useState<{left: DetectedObject | null, right: DetectedObject | null}>({left: null, right: null});
  const [showObjectDetectionDebug, setShowObjectDetectionDebug] = useState<boolean>(false);
  const [showObjectDetectionWindow, setShowObjectDetectionWindow] = useState<boolean>(false);
  const [lastObjectDetectionTime, setLastObjectDetectionTime] = useState<number>();
  const [debugMode, setDebugMode] = useState<boolean>(true); // Enable debug mode by default for development
  const [showDebugPanel, setShowDebugPanel] = useState<boolean>(false);
  const [faceTrackingEnabled, setFaceTrackingEnabled] = useState<boolean>(true);
  const [handGestureEnabled, setHandGestureEnabled] = useState<boolean>(true);

  // Eyegaze dwell settings — stored in DB via student profile
  const [eyegazeSettings, setEyegazeSettings] = useState<{ enabled: boolean; provider: EyeGazeProviderType | "auto"; timeout: number }>({
    enabled: false, provider: "mouse", timeout: 2000
  });
  // Sync eyegaze settings from userProfile when it loads
  useEffect(() => {
    if (userProfile) {
      const aac = userProfile.aacSettings;
      setEyegazeSettings({
        enabled: aac?.eyegazeEnabled ?? false,
        provider: aac?.eyegazeProvider ?? "mouse",
        timeout: aac?.eyegazeTimeout ?? 2000,
      });
    }
  }, [userProfile]);

  // Environment camera frame collector (for dual-camera detection)
  const envCollectorRef = useRef<CameraFrameCollector | null>(null);

  // AAC Board state - populated from chat responses
  const [boardData, setBoardData] = useState<ParsedBoardData | null>(null);

  // Prebuilt board state — set when AI loads a custom board via set_board
  // When set, the main area shows the prebuilt board and AI board updates go to a side panel
  const [prebuiltBoardData, setPrebuiltBoardData] = useState<ParsedBoardData | null>(null);

  // 3-tier navigation: Home Page ↔ Context Board Home ↔ Latest Page
  // - contextBoard: the last non-home board loaded via set_board (null if none)
  // - latestPage: snapshot of the last dynamic board before navigating away (null if none)
  // - currentTier: which tier the user is currently on
  type NavTier = "home" | "context" | "latest";
  const [contextBoard, setContextBoard] = useState<{ board: ParsedBoardData; name: string; boardId: string } | null>(null);
  const [latestPage, setLatestPage] = useState<ParsedBoardData | null>(null);
  const [currentTier, setCurrentTier] = useState<NavTier>("home");

  // Board patch state — from detection (incremental add/remove)
  const [boardPatchData, setBoardPatchData] = useState<import("@/hooks/dual-agent-types").BoardPatch | null>(null);

  // Symbol update — auto-generated symbol ready
  const [symbolUpdateData, setSymbolUpdateData] = useState<{ buttonLabel: string; symbolPath: string } | null>(null);

  // AI button press — AI navigated within a loaded board
  const [aiButtonPressData, setAiButtonPressData] = useState<{ label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null>(null);

  // Recent button presses for Interpret feature (silent mode)
  const [recentButtonPresses, setRecentButtonPresses] = useState<string[]>([]);


  // Context sidebar buttons (from AI's add_context_button tool)
  const [contextButtons, setContextButtons] = useState<Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string }>>([]);

  // Apply symbol updates to context buttons (async image generation)
  useEffect(() => {
    if (!symbolUpdateData) return;
    setContextButtons(prev => prev.map(b =>
      b.label === symbolUpdateData.buttonLabel
        ? { ...b, symbolPath: symbolUpdateData.symbolPath }
        : b
    ));
  }, [symbolUpdateData]);

  // Board mode: 'ai' shows DynamicBoard, 'db' shows PrebuiltBoardSection
  const [boardMode, setBoardMode] = useState<'ai' | 'db'>('ai');

  // Dual-agent mode bridged from context
  const [dualAgentMode, setDualAgentMode] = useState<'interact' | 'silent'>('interact');
  const [aiSessionActive, setAiSessionActive] = useState(false);
  const [isGuessingMode, setIsGuessingMode] = useState(false);

  // Active app state (bridged from DualAgentContext)
  const [activeApp, setActiveApp] = useState<import("@/hooks/dual-agent-types").ActiveAppData | null>(null);
  const dismissAppRef = useRef<() => void>(() => {});
  const registerAppCanvasCaptureRef = useRef<(fn: (() => Promise<Blob | null>) | null) => void>(() => {});

  // Yes/No overlay state (bridged from DualAgentContext)
  const [yesNoActive, setYesNoActive] = useState(false);
  const dismissYesNoRef = useRef<(() => void) | null>(null);
  const interpretFnRef = useRef<((buttons: string[], sentences?: Record<string, string>) => Promise<void>) | null>(null);
  const sendBoardExitRef = useRef<((label: string, instruction: string) => void) | null>(null);
  const sendMessageFnRef = useRef<((msg: string) => Promise<void>) | null>(null);
  const sendContextOnlyFnRef = useRef<((text: string) => void) | null>(null);
  const restartSessionFnRef = useRef<(() => void) | null>(null);

  // Pause state (bridged from DualAgentContext)
  const [isPaused, setIsPaused] = useState(false);
  const setPausedFnRef = useRef<((p: boolean) => void) | null>(null);

  // Get authenticated user
  const { data: authUser, isLoading: isAuthLoading } = useQuery({
    queryKey: ["/auth/user"],
    retry: false
  });

  const { speak, isSpeaking } = useTextToSpeech();
  const {
    cameras,
    getUserCamera,
    getEnvironmentCamera,
    captureFrameFromCamera,
    autoAssignCameras,
    globalError
  } = useMultiCamera({ autoStart: true });

  // Get shared camera stream from CameraProvider context
  const { stream: sharedCameraStream, startCamera: startSharedCamera } = useCamera();

  // Wire environment camera stream to CameraFrameCollector
  useEffect(() => {
    const envCamera = getEnvironmentCamera();
    const envStream = envCamera?.stream ?? null;

    if (envStream) {
      if (!envCollectorRef.current) {
        envCollectorRef.current = new CameraFrameCollector();
      }
      envCollectorRef.current.setStream(envStream);
      envCollectorRef.current.start(250); // 4fps
    } else {
      envCollectorRef.current?.setStream(null);
      envCollectorRef.current?.stop();
    }

    return () => {
      envCollectorRef.current?.stop();
    };
  }, [getEnvironmentCamera]);

  // Destroy env collector on unmount
  useEffect(() => {
    return () => {
      envCollectorRef.current?.destroy();
      envCollectorRef.current = null;
    };
  }, []);

  // Auto-start the shared camera when face tracking or hand gesture tracking is enabled but no stream exists
  useEffect(() => {
    if ((faceTrackingEnabled || handGestureEnabled) && !sharedCameraStream && !getUserCamera()?.stream) {
      console.log("[Tracking] No camera stream available, starting shared camera");
      startSharedCamera();
    }
  }, [faceTrackingEnabled, handGestureEnabled, sharedCameraStream, getUserCamera, startSharedCamera]);

  // Face expression tracking via MediaPipe FaceLandmarker
  const faceTrackingStream = sharedCameraStream ?? getUserCamera()?.stream ?? null;
  const {
    isReady: faceTrackingReady,
    error: faceTrackingError,
    faces: rawFaces,
    fps: faceTrackingFps,
  } = useFaceTracking({
    videoStream: faceTrackingEnabled ? faceTrackingStream : null,
    enabled: faceTrackingEnabled,
  });

  // Unified eye gaze service — skip entirely for cursor control mode (mouse provider)
  const isCursorControlMode = eyegazeSettings.provider === "mouse";
  const eyeGaze = useEyeGaze({
    enabled: eyegazeSettings.enabled && !isCursorControlMode,
    rawFaces,
    preferredProvider: eyegazeSettings.provider,
  });

  // Eyegaze provider detection notification
  const [eyegazeNotification, setEyegazeNotification] = useState<{ name: string; type: "connected" | "failed" } | null>(null);
  const prevProviderRef = useRef<string | null>(null);
  const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    tobii: "Tobii Eye Tracker",
    eyetech: "EyeTech",
    lctech: "LC Technologies",
    gazepoint: "Gazepoint Eye Tracker",
    webhid: "WebHID Device",
    camera: "Camera Eye Tracking",
    mouse: "Cursor Control (External Device)",
  };
  useEffect(() => {
    if (eyeGaze.activeProvider && !prevProviderRef.current) {
      const name = PROVIDER_DISPLAY_NAMES[eyeGaze.activeProvider] || eyeGaze.activeProvider;
      setEyegazeNotification({ name, type: "connected" });
      const timer = setTimeout(() => setEyegazeNotification(null), 4000);
      return () => clearTimeout(timer);
    }
    prevProviderRef.current = eyeGaze.activeProvider;
  }, [eyeGaze.activeProvider]);

  // Show failure notification when selected provider wasn't detected
  useEffect(() => {
    if (eyeGaze.failedProvider) {
      const name = PROVIDER_DISPLAY_NAMES[eyeGaze.failedProvider] || eyeGaze.failedProvider;
      setEyegazeNotification({ name, type: "failed" });
      const timer = setTimeout(() => setEyegazeNotification(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [eyeGaze.failedProvider]);

  // Face image cache (in-memory, session-scoped — no server storage)
  const faceImageCache = useFaceImageCache();

  // Person identification for AAC system (face recognition)
  const {
    isReady: isPersonIdReady,
    currentIdentification,
    identifyFromVideo,
    identifyFromImage,
    knownPeopleCount,
    getUnmatchedDescriptors,
    lastCapturedFaceImage,
  } = usePersonIdentification({
    studentId,
    enabled: useDualAgent, // Only enable when dual-agent is active
    cacheFaceImage: faceImageCache.cacheFaceImage,
  });

  // Face event accumulation (derives semantic events from blendshapes)
  const { trackedFaces } = useFaceEvents({
    faces: rawFaces,
    currentIdentification,
    enabled: faceTrackingEnabled,
  });

  // Hand gesture tracking via MediaPipe GestureRecognizer
  const {
    isReady: handGestureReady,
    error: handGestureError,
    hands: rawHands,
    fps: handGestureFps,
  } = useHandGestureTracking({
    videoStream: handGestureEnabled ? faceTrackingStream : null,
    enabled: handGestureEnabled,
  });

  // Sign-language source of truth: AAC settings (clinician-controlled),
  // falling back to the LanguageContext value (AAC-side override).
  const settingsSignLanguage = (() => {
    const v = userProfile?.aacSettings?.signLanguage;
    return typeof v === "string" && isValidSignLanguageCode(v) ? v : null;
  })();
  const activeSignLanguage = settingsSignLanguage ?? signLanguage;

  // Sign language classifier: augments raw hands with sign language classifications
  const augmentedHands = useSignLanguageClassifier({
    hands: rawHands,
    signLanguage: activeSignLanguage,
  });

  // Hand gesture event accumulation (derives semantic events from gestures + landmarks)
  const { trackedHands } = useHandGestureEvents({
    hands: augmentedHands,
    enabled: handGestureEnabled,
    config: activeSignLanguage ? { signLanguageLocale: activeSignLanguage } : undefined,
  });

  // Buffer recognized signs into a phrase and submit on pause as a user
  // statement. Only active while the AI session is live and a sign language
  // is selected — otherwise we'd dispatch with no live agent listening.
  useSignLanguagePhrase({
    trackedHands,
    enabled: !!activeSignLanguage && aiSessionActive,
    onPhraseComplete: (phrase) => {
      console.log(`[SignLanguage] Phrase complete: "${phrase}"`);
      sendMessageFnRef.current?.(phrase);
    },
  });

  // Get current identified person (non-blocking getter for dual-agent)
  const getIdentifiedPerson = useCallback(() => {
    return currentIdentification?.person || null;
  }, [currentIdentification]);

  // Get serialized gesture/expression context for dual-agent AI
  const getGestureContext = useCallback(() => {
    return serializeGestureContext(trackedFaces, trackedHands);
  }, [trackedFaces, trackedHands]);

  // A detached <video> element bound to sharedCameraStream so face-api can
  // read pixels from it. Only used when no multi-camera entries are enrolled.
  const sharedVideoElRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!sharedCameraStream) {
      if (sharedVideoElRef.current) {
        sharedVideoElRef.current.pause();
        sharedVideoElRef.current.srcObject = null;
        sharedVideoElRef.current = null;
      }
      return;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = sharedCameraStream;
    video.play().catch(err => console.warn("[Tracking] shared video play failed:", err));
    sharedVideoElRef.current = video;
    return () => {
      video.pause();
      video.srcObject = null;
      if (sharedVideoElRef.current === video) sharedVideoElRef.current = null;
    };
  }, [sharedCameraStream]);

  // Periodic face identification — runs across EVERY active camera (user + environment),
  // not just a single primary. Drops descriptors after each tick whichever the camera
  // count is. The user-facing camera additionally drives `currentIdentification` (which
  // feeds gesture/expression event tracking via useFaceEvents).
  useEffect(() => {
    if (!isPersonIdReady || !useDualAgent) return;

    const runIdentification = async () => {
      const tasks: Array<Promise<void>> = [];

      for (const camera of cameras) {
        if (!camera.isActive || !camera.stream || !captureFrameFromCamera) continue;
        const sourceKey = `multicam:${camera.deviceId}`;
        const cameraRole = camera.facing;
        const cameraLabel = camera.label;
        const updateCurrent = camera.facing === "user";
        tasks.push((async () => {
          try {
            const frame = await captureFrameFromCamera(camera.deviceId);
            if (!frame || frame.size === 0) return;
            const img = new Image();
            const url = URL.createObjectURL(frame);
            img.src = url;
            await new Promise<void>(resolve => {
              img.onload = async () => {
                await identifyFromImage(img, { sourceKey, cameraRole, cameraLabel, updateCurrent });
                URL.revokeObjectURL(url);
                resolve();
              };
              img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
            });
          } catch {
            /* identification is non-critical — silent fail */
          }
        })());
      }

      // Fall back to sharedCameraStream when no multi-cam entries are enrolled
      if (cameras.length === 0 && sharedVideoElRef.current) {
        const video = sharedVideoElRef.current;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          tasks.push(
            (async () => {
              await identifyFromVideo(video, {
                sourceKey: "shared",
                cameraRole: "user",
                cameraLabel: "shared camera",
                updateCurrent: true,
              });
            })(),
          );
        }
      }

      if (tasks.length === 0) return;
      await Promise.all(tasks);
    };

    const interval = setInterval(runIdentification, 2000);
    runIdentification();
    return () => clearInterval(interval);
  }, [isPersonIdReady, useDualAgent, cameras, captureFrameFromCamera, identifyFromImage, identifyFromVideo]);

  // Initialize gesture handling
  useGestures({
    onSwipeLeft: () => setShowUserSettings(true),
    onCornerTap: () => setShowChatLog(true),
    onSwipeRight: () => setShowConversation(!showConversation),
  });

  // System startup - initialization is now managed by AppInitializationContext
  useEffect(() => {
    console.log('Aivota System - Initializing...');
    // Language is now managed by LanguageContext (loaded from localStorage automatically)
    // Camera, Boards, and Conversation initialization is handled by their respective contexts
  }, []);


  // Update user language preference when changed (now handled by LanguageContext)
  // The context handles localStorage, we just need to sync with server
  // Only sync after initialization is complete to avoid race conditions
  useEffect(() => {
    if (!isInitComplete) return; // Don't sync during initialization

    const syncLanguageToServer = async () => {
      if (studentId && currentLanguage) {
        try {
          await apiRequest('PATCH', `/api/students/${studentId}`, { primaryLanguage: currentLanguage });
        } catch (error) {
          console.log("Could not save language preference to server");
        }
      }
    };
    syncLanguageToServer();
  }, [currentLanguage, studentId, isInitComplete]);

  // Standby mode logic - monitor camera status and user presence
  useEffect(() => {
    // Check if we have an active override
    const overrideActive = localStorage.getItem('synapse_override_detection');
    const overrideTimestamp = localStorage.getItem('synapse_override_timestamp');
    
    if (overrideActive && overrideTimestamp) {
      const overrideTime = parseInt(overrideTimestamp);
      const now = Date.now();
      const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
      
      if (now - overrideTime < fiveMinutes) {
        // Override is still active, don't enter standby mode
        console.log('Person detection override active, remaining time:', Math.round((fiveMinutes - (now - overrideTime)) / 1000), 'seconds');
        setIsStandbyMode(false);
        return;
      } else {
        // Override expired, clear it
        localStorage.removeItem('synapse_override_detection');
        localStorage.removeItem('synapse_override_timestamp');
        console.log('Person detection override expired');
      }
    }
    
    const shouldEnterStandby = isCameraBlocked || !isMainUserPresent || !anyPersonPresent;
    setIsStandbyMode(shouldEnterStandby);
  }, [isCameraBlocked, isMainUserPresent, anyPersonPresent]);

  // Monitor camera status and person detection
  useEffect(() => {
    const checkStatus = async () => {
      if (isStandbyMode) return; // Don't check if in standby mode

      try {
        // Camera blocked when there's a global error or no usable stream at all
        const hasAnyCamera = cameras.some(c => c.isActive && c.stream) || !!sharedCameraStream;
        setIsCameraBlocked(!hasAnyCamera || !!globalError);

        if (!hasAnyCamera) {
          setAnyPersonPresent(false);
          setIsMainUserPresent(false);
          return;
        }

        // Run person detection on every active camera. anyPersonPresent is OR'd
        // across all cameras (someone in the environment view counts); only the
        // user-facing camera drives isMainUserPresent (standby gate).
        const detectFromBlob = async (
          frame: Blob,
          cameraType: "user" | "environment" | "unknown",
        ): Promise<{ personPresent: boolean; isMainUser: boolean } | null> => {
          if (frame.size <= 5000) return null;
          const formData = new FormData();
          formData.append("image", frame, "frame.jpg");
          formData.append("expectedAge", userProfile?.age?.toString() || "46");
          formData.append("expectedGender", userProfile?.gender || "male");
          formData.append("cameraType", cameraType);
          const resp = await fetchWithAuth("/api/aac/detect-person", { method: "POST", body: formData });
          if (!resp.ok) {
            console.log("Person detection API error:", resp.status, await resp.text());
            return null;
          }
          return resp.json();
        };

        const results = await Promise.all(
          cameras
            .filter(c => c.isActive && c.stream && captureFrameFromCamera)
            .map(async camera => {
              try {
                const frame = await captureFrameFromCamera(camera.deviceId);
                if (!frame) return null;
                const detection = await detectFromBlob(frame, camera.facing);
                return detection ? { camera, detection } : null;
              } catch (err) {
                console.log(`Person detection failed for ${camera.label}:`, err);
                return null;
              }
            }),
        );

        const successful = results.filter((r): r is NonNullable<typeof r> => r !== null);
        if (successful.length === 0) {
          // No multi-cam detections succeeded. If we only have sharedCameraStream
          // (no enrolled multi-cam entries), assume the user is present rather
          // than dropping into standby — the face mirror is working off it.
          if (cameras.length === 0 && sharedCameraStream) {
            setAnyPersonPresent(true);
            setIsMainUserPresent(true);
          } else {
            setAnyPersonPresent(false);
            setIsMainUserPresent(false);
          }
        } else {
          const anyPresent = successful.some(r => r.detection.personPresent);
          const userResult = successful.find(r => r.camera.facing === "user");
          setAnyPersonPresent(anyPresent);
          setIsMainUserPresent(userResult?.detection.isMainUser ?? false);
        }
      } catch (error) {
        console.error('Status check failed:', error);
        setIsCameraBlocked(true);
        setAnyPersonPresent(false);
        setIsMainUserPresent(false);
      }
    };

    if (DISABLE_PERIODIC_DETECTION) {
      // Assume user is present when detection is disabled
      setIsMainUserPresent(true);
      setAnyPersonPresent(true);
      return;
    }

    const interval = setInterval(checkStatus, 8000); // Check every 8 seconds
    checkStatus(); // Initial check

    return () => clearInterval(interval);
  }, [isStandbyMode, cameras, sharedCameraStream, globalError, captureFrameFromCamera, userProfile, DISABLE_PERIODIC_DETECTION]);

  // Show gesture hints briefly (touch devices only)
  useEffect(() => {
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return;
    const timer = setTimeout(() => {
      setShowGestureHints(true);
      setTimeout(() => setShowGestureHints(false), 3000);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  const handleSymbolSelect = async (symbol: { label: string; emoji: string }) => {
    const newSymbols = [...selectedSymbols, symbol.label];
    setSelectedSymbols(newSymbols);

    // Create interpretation and speak it using student voice
    const interpretation = newSymbols.join(" ");
    setCurrentSpeech(interpretation);
    const studentVoice = userProfile?.aacSettings?.studentVoiceType || 'boy';
    await speak(interpretation, currentLanguage, studentVoice);

    // Clear symbols after speech
    setTimeout(() => {
      setSelectedSymbols([]);
      setCurrentSpeech("");
    }, 2000);
  };


  // Handle AAC board button click — send immediately to server
  const handleBoardButtonClick = useCallback((button: BoardButton, spokenText: string) => {
    // Exit/exitBoard buttons: send directly as board_exit (no speech, no interpretation)
    if (button.action?.type === "exit" || (button as any).exitBoard) {
      const instruction = button.action?.text || "";
      // Save current page as latestPage when entering guessing mode from non-home tier
      if (instruction.includes("[GUESSING MODE]") && currentTier !== "home") {
        if (boardData) setLatestPage(boardData);
      }
      // Save current page when leaving non-home tier for any exit button
      if (currentTier !== "home" && !isGuessingMode) {
        if (boardData) setLatestPage(boardData);
      }
      sendBoardExitRef.current?.(button.label, instruction);
      return;
    }

    // Track for interpret feature (keep last 10)
    setRecentButtonPresses(prev => [...prev.slice(-9), spokenText]);

    setCurrentSpeech(spokenText);
    setTimeout(() => setCurrentSpeech(""), 2000);

    const sentences = button.sentence ? { [spokenText]: button.sentence } : undefined;

    if (interpretFnRef.current) {
      interpretFnRef.current([spokenText], sentences);
      setRecentButtonPresses([]);
    } else {
      speak(spokenText, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
    }
  }, [speak, currentLanguage, userProfile?.aacSettings?.studentVoiceType]);

  // Handle interpret: synthesize recent button presses into speech
  const handleInterpret = useCallback(() => {
    if (recentButtonPresses.length > 0 && interpretFnRef.current) {
      interpretFnRef.current(recentButtonPresses);
      setRecentButtonPresses([]);
    }
  }, [recentButtonPresses]);

  // Board history for back navigation
  const boardHistoryRef = useRef<ParsedBoardData[]>([]);

  // Handle board data updates from conversation
  const handleBoardUpdate = useCallback((board: ParsedBoardData) => {
    console.log('[Home] Board data received:', board.name, board.pages?.length, 'pages');
    setBoardData((prev) => {
      if (prev) {
        boardHistoryRef.current.push(prev);
      }
      return board;
    });
  }, []);

  // Handle set_board — AI loaded a prebuilt board (separate from regular board updates)
  const handleSetBoard = useCallback((data: { board: ParsedBoardData; name: string; boardId: string }) => {
    console.log('[Home] Prebuilt board loaded:', data.name);
    setPrebuiltBoardData(data.board);

    // Track tier: home board is special, everything else is a context board
    if (data.boardId === "__home__") {
      setCurrentTier("home");
    } else {
      setContextBoard(data);
      setCurrentTier("context");
    }

    // Clear AI side-panel board so it starts fresh
    setBoardData(null);
    boardHistoryRef.current = [];
  }, []);

  // Handle unload_board — AI returned to the fully dynamic board
  const handleUnloadBoard = useCallback(() => {
    console.log('[Home] Prebuilt board unloaded, returning to dynamic board');
    setPrebuiltBoardData(null);
    setCurrentTier("latest");
  }, []);

  const handleBoardBack = useCallback(() => {
    const prev = boardHistoryRef.current.pop();
    if (prev) {
      setBoardData(prev);
    }
  }, []);

  // Handle multi-page board navigation — inform AI of page change
  const handleBoardNavigate = useCallback((pageId: string, pageName: string, buttons: BoardButton[]) => {
    const buttonLabels = buttons.map(b => b.label).join(", ");
    const msg = `User navigated to page "${pageName}". Current buttons: ${buttonLabels}`;
    sendMessageFnRef.current?.(msg);
  }, []);

  // Handle detected objects from two-handed detection
  const handleObjectsDetected = useCallback((leftObject: DetectedObject | null, rightObject: DetectedObject | null) => {
    setDetectedObjects({ left: leftObject, right: rightObject });
    setLastObjectDetectionTime(Date.now());
  }, []);

  const handleProfileComplete = (_studentId: string, profile?: any) => {
    setUserProfile(profile);
    setShowProfileSetup(false);
    localStorage.setItem('synapse_student_id', studentId);
    if (profile) {
      localStorage.setItem('synapse_user_profile', JSON.stringify(profile));
    }
    // Conversation will start automatically when person is detected
  };

  // Load user profile from API (always fetch student data for AAC settings)
  useEffect(() => {
    const loadUserProfile = async () => {
      try {
        if (!studentId) return;
        // Always fetch student profile from API — authUser is the logged-in user,
        // not necessarily the student, and may lack AAC-specific fields
        const response = await fetchWithAuth(`/api/students/${studentId}`);
        if (response.ok) {
          const result = await response.json();
          // API returns { success, student } — extract the student object
          const profile = result.student || result;
          setUserProfile(profile);
          localStorage.setItem('synapse_user_profile', JSON.stringify(profile));

          // Load debug mode from user profile
          if (profile.debugMode === true) {
            console.log('Enabling debug mode from user profile');
            setDebugMode(true);
          }
        }
      } catch (error) {
        console.error('Failed to load user profile:', error);
      }
    };

    loadUserProfile();
  }, [studentId]);

  // Camera-dependent conversation starter with person verification
  useEffect(() => {
    const checkCameraAndStartConversation = async () => {
      if (!studentId) return;
      
      try {
        // Test if camera can actually capture valid frames from integrated camera
        const userCamera = getUserCamera();
        const testFrame = userCamera ? await captureFrameFromCamera(userCamera.deviceId) : null;
        
        // Check if we got a real camera frame (not just a placeholder icon)
        const cameraWorking = testFrame && testFrame.size > 10000; // Real frame should be larger than 10KB
        
        // Update camera blocked state
        setIsCameraBlocked(!cameraWorking);
        
        if (cameraWorking) {
          // If camera is working, verify person presence and identity
          try {
            const formData = new FormData();
            formData.append('image', testFrame, 'frame.jpg');
            formData.append('expectedAge', userProfile?.age?.toString() || '');
            formData.append('expectedGender', userProfile?.gender || '');
            // Add camera type information for proper user detection
            formData.append('cameraType', 'user'); // Main camera should be user-facing

            const response = await fetchWithAuth('/api/aac/detect-person', {
              method: 'POST',
              body: formData,
            });

            if (response.ok) {
              const detection = await response.json();
              console.log('Person detection result:', detection);
              
              setAnyPersonPresent(detection.personPresent);
              setIsMainUserPresent(detection.isMainUser);
              
              // Start conversation only if main user is present
              if (detection.personPresent && detection.isMainUser && !showConversation) {
                console.log('Starting conversation - main user verified, frame size:', testFrame.size);
                setShowConversation(true);
              } else if ((!detection.personPresent || !detection.isMainUser) && showConversation) {
                console.log('Pausing conversation - main user not present');
                setShowConversation(false);
              }
            }
          } catch (personError) {
            console.log('Person detection failed:', personError);
            // Fallback: assume person is present if camera works
            setAnyPersonPresent(true);
            setIsMainUserPresent(true);
            if (!showConversation) {
              setShowConversation(true);
            }
          }
        } else if (!cameraWorking && showConversation) {
          console.log('Pausing conversation - camera not working, frame size:', testFrame?.size || 0);
          setShowConversation(false);
        }
      } catch (error) {
        console.log('Camera test failed:', error);
        setIsCameraBlocked(true);
        setAnyPersonPresent(false);
        setIsMainUserPresent(false);
        if (showConversation) {
          setShowConversation(false);
        }
      }
    };

    if (studentId) {
      // Skip periodic detection if disabled - just enable conversation
      if (DISABLE_PERIODIC_DETECTION) {
        console.log('Periodic detection disabled - enabling conversation mode');
        setIsMainUserPresent(true);
        setAnyPersonPresent(true);
        setIsCameraBlocked(false);
        setIsStandbyMode(false);
        if (!showConversation) {
          setShowConversation(true);
        }
        return;
      }

      // If we have any usable camera, use it for presence detection
      const hasAnyCamera = cameras.some(c => c.isActive && c.stream) || !!sharedCameraStream;
      if (hasAnyCamera) {
        // Initial check after delay
        const timer = setTimeout(checkCameraAndStartConversation, 3000);

        // Also check periodically
        const interval = setInterval(checkCameraAndStartConversation, 15000);

        return () => {
          clearTimeout(timer);
          clearInterval(interval);
        };
      } else {
        // No camera available - enable conversation mode by default
        console.log('No camera available - enabling conversation mode for audio-only experience');
        setIsMainUserPresent(true);
        setAnyPersonPresent(true);
        setIsCameraBlocked(false);
        setIsStandbyMode(false);
        if (!showConversation) {
          setShowConversation(true);
        }
      }
    }
  }, [studentId, captureFrameFromCamera, cameras, sharedCameraStream, userProfile, DISABLE_PERIODIC_DETECTION]);

  // Real presence detection is handled in checkStatus above

  // Capture visual context periodically when conversation is active
  useEffect(() => {
    if (!showConversation || DISABLE_PERIODIC_DETECTION) return;

    const captureVisualContext = async () => {
      try {
        const userCamera = getUserCamera();
        const frame = userCamera ? await captureFrameFromCamera(userCamera.deviceId) : null;
        if (frame) {
          const formData = new FormData();
          formData.append('image', frame);

          const response = await fetchWithAuth('/api/aac/analyze-image', {
            method: 'POST',
            body: formData,
          });

          if (response.ok) {
            const { analysis } = await response.json();
            setCurrentVisualContext(analysis);
          }
        }
      } catch (error) {
        console.log('Visual context capture failed:', error);
      }
    };

    // Update visual context every 30 seconds during conversation
    const interval = setInterval(captureVisualContext, 30000);

    return () => clearInterval(interval);
  }, [showConversation, captureFrameFromCamera, getUserCamera, DISABLE_PERIODIC_DETECTION]);

  const handleResumeFromStandby = async () => {
    console.log('Resuming system - forcing exit from standby mode');
    
    // Force exit standby mode immediately and disable further detection temporarily
    setIsStandbyMode(false);
    setIsCameraBlocked(false);
    setAnyPersonPresent(true);
    setIsMainUserPresent(true);
    setShowConversation(true);
    
    // Store override in localStorage to prevent immediate re-entry to standby
    localStorage.setItem('synapse_override_detection', 'true');
    localStorage.setItem('synapse_override_timestamp', Date.now().toString());
    
    console.log('System resumed with person detection override for 5 minutes');
  };

  const handleFullScreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.log('Full screen toggle failed:', error);
    }
  };

  // System Startup Loading - now uses real task tracking
  if (!isInitComplete) {
    return <InitializationLoadingScreen />;
  }

  // Standby Screen Component
  if (isStandbyMode) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center">
        <div className="text-center space-y-8 max-w-md mx-auto p-8">
          <div className="text-6xl mb-4">😴</div>
          <h1 className="text-3xl font-bold text-gray-700 dark:text-gray-300">System Standby</h1>
          
          <div className="space-y-4 text-gray-600 dark:text-gray-400">
            {isCameraBlocked && (
              <div className="flex items-center justify-center gap-2 text-red-600 dark:text-red-400">
                <UserX className="w-5 h-5" />
                <span>Camera is blocked</span>
              </div>
            )}
            {!anyPersonPresent && !isCameraBlocked && (
              <div className="flex items-center justify-center gap-2 text-orange-600 dark:text-orange-400">
                <UserX className="w-5 h-5" />
                <span>No one is present</span>
              </div>
            )}
            {!isMainUserPresent && anyPersonPresent && !isCameraBlocked && (
              <div className="flex items-center justify-center gap-2 text-yellow-600 dark:text-yellow-400">
                <UserX className="w-5 h-5" />
                <span>Main user not detected</span>
              </div>
            )}
          </div>

          <Button
            onClick={handleResumeFromStandby}
            size="lg"
            className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 text-xl rounded-xl shadow-lg"
          >
            Resume System
          </Button>
          
          <p className="text-sm text-gray-500 dark:text-gray-500">
            System paused to save resources. Click Resume to continue.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AccessibilityProvider settings={userProfile?.aacSettings?.accessibility}>
    <CameraAttentivenessWrapper autoStart={true} cameraType="user">
    <FaceEngagementSignalFeed rawFaces={rawFaces} />
    <MouseEyegazeSignalFeed />
    <EyeTrackingDwellProvider
      mode={!eyegazeSettings.enabled ? "off" : rawFaces.length === 0 ? "off" : isCursorControlMode ? "mouse" : "eyegaze"}
      dwellTimeMs={eyegazeSettings.timeout}
      gazePoint={eyeGaze.gazePoint}
      isCalibrated={eyeGaze.isCalibrated}
      supportsCalibration={eyeGaze.supportsCalibration}
      getRawGaze={eyeGaze.getRawGaze}
      applyCalibration={eyeGaze.applyCalibration}
      clearCalibrationData={eyeGaze.clearCalibration}
    >
    <div className="h-dvh flex flex-col relative overflow-hidden bg-bg-soft pb-safe">
      {/* Eyegaze Provider Detection Notification */}
      <AnimatePresence>
        {eyegazeNotification && (
          <motion.div
            initial={{ y: -60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -60, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className={`fixed top-2 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-medium ${
              eyegazeNotification.type === "connected"
                ? "bg-blue-600 text-white"
                : "bg-amber-500 text-white"
            }`}
          >
            {eyegazeNotification.type === "connected" ? (
              <Eye className="w-4 h-4" />
            ) : (
              <EyeOff className="w-4 h-4" />
            )}
            {eyegazeNotification.name} {eyegazeNotification.type === "connected" ? "connected" : "not detected"}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main 3-Section Board Layout */}
      <main className={`flex-1 flex flex-col relative ${
        showConversation ? 'pt-24' : 'pt-4'
      }`}>
        {/* Audio Feedback Indicator */}
        <AnimatePresence>
          {isSpeaking && (
            <motion.div
              className="absolute top-4 right-4 z-20"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              <div className="w-3 h-3 bg-accent rounded-full animate-pulse" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Camera Status Indicator */}
        <motion.div
          className="absolute top-4 left-4 opacity-60 z-20"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.6 }}
          transition={{ delay: 1 }}
        >
          <i className="fas fa-camera text-accent text-lg" />
        </motion.div>

        {/* Board Area — fills all remaining space */}
        <div className={`flex-1 min-h-0 overflow-hidden relative flex ${isRTL ? 'flex-row-reverse' : 'flex-row'}`}
          data-dwell-trap={activeApp ? true : undefined}
        >
          <YesNoOverlay
            active={yesNoActive}
            onSelect={(choice) => {
              dismissYesNoRef.current?.();
              setYesNoActive(false);
              const translatedChoice = t(choice === "Yes" ? "quickActions.yes" : "quickActions.no");
              if (interpretFnRef.current) {
                // AI session active — server handles TTS via pre-generated student voice
                interpretFnRef.current([translatedChoice], { [translatedChoice]: translatedChoice });
              } else {
                // No AI session — use client-side speech
                speak(translatedChoice, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
              }
            }}
            onDismiss={() => {
              dismissYesNoRef.current?.();
              setYesNoActive(false);
            }}
          />
          {/* Context sidebar — always shows context buttons from add_context_button() */}
          {(() => {
            const sidebarBoard: ParsedBoardData | null = contextButtons.length > 0
              ? {
                  name: "Context",
                  grid: { rows: 4, cols: 1 },
                  pages: [{
                    id: "ctx",
                    name: "Context",
                    buttons: contextButtons.map((b, i) => ({
                      id: `ctx-${i}`,
                      row: i,
                      col: 0,
                      label: b.label,
                      iconRef: b.iconRef,
                      symbolPath: b.symbolPath,
                      sentence: b.sentence,
                      action: { type: "speak" as const, text: b.label },
                    })),
                  }],
                }
              : null;
            return (
              <AppMiniBoard
                board={sidebarBoard}
                onButtonClick={handleBoardButtonClick}
                language={currentLanguage}
                voiceType={userProfile?.aacSettings?.studentVoiceType || 'boy'}
                suppressLocalSpeech={aiSessionActive}
                getFaceImage={faceImageCache.getFaceImage}
              />
            );
          })()}
          {/* App content — replaces board when an app is active */}
          {activeApp ? (
            <div className="flex-1 min-w-0 h-full">
              {renderAppContent(
                activeApp,
                dismissAppRef.current,
                registerAppCanvasCaptureRef.current,
                studentId,
                (msg) => sendMessageFnRef.current?.(msg),
                (userProfile?.aacSettings?.permittedWebsites as PermittedWebsite[] | undefined) || [],
                (text) => sendContextOnlyFnRef.current?.(text),
              )}
            </div>
          ) : boardMode === 'ai' ? (
            <div className="flex-1 min-w-0 h-full">
              <DynamicBoard
                board={prebuiltBoardData || boardData}
                boardPatch={prebuiltBoardData ? null : boardPatchData}
                symbolUpdate={prebuiltBoardData ? null : symbolUpdateData}
                aiButtonPress={aiButtonPressData}
                onButtonClick={handleBoardButtonClick}
                onBack={boardHistoryRef.current.length > 0 ? handleBoardBack : undefined}
                onNavigate={handleBoardNavigate}
                language={currentLanguage}
                voiceType={userProfile?.aacSettings?.studentVoiceType || 'boy'}
                iconTextRatio={userProfile?.aacSettings?.iconTextRatio ?? 3}
                getFaceImage={faceImageCache.getFaceImage}
                suppressLocalSpeech={aiSessionActive}
              />
            </div>
          ) : (
            <PrebuiltBoardSection
              studentId={studentId}
              onSpeakAction={(text) => {
                if (interpretFnRef.current) {
                  // Route through AI — voice the text and send as button press
                  interpretFnRef.current([text], { [text]: text });
                } else {
                  setSelectedSymbols([text]);
                }
              }}
              language={currentLanguage}
              voiceType={userProfile?.aacSettings?.studentVoiceType || 'boy'}
              suppressLocalSpeech={aiSessionActive}
              onBack={() => {
                // Handle back at root level - could show board selector
              }}
            />
          )}
        </div>

        {/* Bottom Row: Quick Actions */}
        <QuickActions
          onAction={(action, text) => {
            if (action === "more") {
              // "More" = user can't find the right button. Ask AI to add
              // more options but NOT respond with speech.
              if (interpretFnRef.current) {
                interpretFnRef.current(["[MORE]"]);
              }
            } else if (action === "home") {
              // 3-tier Home button navigation
              if (isGuessingMode) {
                // Guessing mode: always return to latest page
                if (latestPage) {
                  setPrebuiltBoardData(null);
                  setBoardData(latestPage);
                  setCurrentTier("latest");
                  // Tell the AI the user exited guessing mode
                  sendBoardExitRef.current?.("Back", "The user exited guessing mode and returned to their conversation. Continue naturally.");
                }
              } else if (currentTier === "latest") {
                // On latest page → go to context board home if exists, otherwise home
                if (boardData) setLatestPage(boardData);
                if (contextBoard) {
                  handleSetBoard(contextBoard);
                } else {
                  // Load home board — tell server to load it
                  sendBoardExitRef.current?.("Home", "The user pressed Home. Call set_board(\"home\") to load the home board.");
                }
              } else if (currentTier === "context") {
                // On context board → go to home page
                sendBoardExitRef.current?.("Home", "The user pressed Home. Call set_board(\"home\") to load the home board.");
              } else {
                // On home page → go to latest page (don't save home as latest)
                if (latestPage) {
                  setPrebuiltBoardData(null);
                  setBoardData(latestPage);
                  setCurrentTier("latest");
                }
              }
            } else if (action === "exit") {
              // "Exit" = close the active app
              dismissAppRef.current();
            } else {
              // Yes/No — send as button press (server handles TTS if AI session active)
              if (interpretFnRef.current) {
                interpretFnRef.current([text], { [text]: text });
              } else {
                speak(text, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
              }
            }
          }}
          onBack={() => {
            // Call the prebuilt board's back function
            const goBack = (window as any).__prebuiltBoardGoBack;
            if (goBack) {
              goBack();
            }
          }}
          boardMode={boardMode}
          hasActiveApp={!!activeApp}
          hasPrebuiltBoard={!!prebuiltBoardData}
          currentTier={currentTier}
          isGuessingMode={isGuessingMode}
        />

        {/* Pause Overlay — covers board and quick actions when paused */}
        <AnimatePresence>
          {isPaused && (
            <motion.div
              key="pause-overlay"
              data-dwell-trap
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            >
              <button type="button"
                data-dwell
                onClick={() => setPausedFnRef.current?.(false)}
                className="flex flex-col items-center gap-4 p-8 rounded-3xl bg-white/90 dark:bg-gray-800/90 shadow-2xl hover:scale-105 active:scale-95 transition-transform"
              >
                <Play className="w-16 h-16 text-primary" />
                <span className="text-2xl font-bold text-gray-800 dark:text-gray-100">
                  {t('pause.resume')}
                </span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>

      </main>

      {/* Text-to-Speech Output Display */}
      <AnimatePresence>
        {currentSpeech && (
          <motion.div
            className="absolute bottom-0 left-0 right-0 bg-primary text-white p-4 text-center"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
          >
            <div className="flex items-center justify-center space-x-3">
              <i className="fas fa-volume-up text-xl" />
              <span className="text-lg font-medium">{currentSpeech}</span>
              {isSpeaking && (
                <div className="animate-spin">
                  <i className="fas fa-circle-notch" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat Log */}
      <ChatLog 
        isOpen={showChatLog}
        onClose={() => setShowChatLog(false)}
        studentId={studentId}
      />

      {/* Profile Setup */}
      <ProfileSetup 
        isOpen={showProfileSetup}
        onComplete={handleProfileComplete}
        onSkip={() => setShowProfileSetup(false)}
      />

      {/* User Settings */}
      <UserSettings
        isOpen={showUserSettings}
        onClose={() => setShowUserSettings(false)}
        studentId={studentId}
        userProfile={userProfile}
        onProfileUpdate={setUserProfile}
        debugMode={debugMode}
        onDebugModeChange={setDebugMode}
        onEyegazeChange={setEyegazeSettings}
        onRestartSession={() => restartSessionFnRef.current?.()}
      />

      {/* Conversation Box - Toggle between single-agent and dual-agent */}
      {studentId && !useDualAgent && (
        <ConversationBox
          studentId={studentId}
          userProfile={userProfile}
          isVisible={showConversation}
          onToggle={() => setShowConversation(!showConversation)}
          selectedSymbols={selectedSymbols}
          onClearSymbols={() => setSelectedSymbols([])}
          visualContext={currentVisualContext}
          language={currentLanguage}
          captureFrame={async () => {
            // Capture frame from user camera if available
            const userCamera = getUserCamera();
            if (userCamera && captureFrameFromCamera) {
              try {
                const frame = await captureFrameFromCamera(userCamera.deviceId);
                return frame;
              } catch (err) {
                console.log('[Home] Frame capture failed:', err);
                return null;
              }
            }
            return null;
          }}
          onBoardUpdate={handleBoardUpdate}
          currentBoard={boardData}
        />
      )}

      {/* Dual-Agent Conversation Box */}
      {studentId && useDualAgent && (
        <DualAgentProvider
          studentId={studentId}
          language={currentLanguage}
          pitchByTag={{
            ...(userProfile?.aacSettings?.aiVoicePitch ? { avatar: userProfile.aacSettings.aiVoicePitch } : {}),
            ...(userProfile?.aacSettings?.studentVoicePitch ? { interpret: userProfile.aacSettings.studentVoicePitch } : {}),
          }}
          captureFrame={async () => {
            // Try multiCamera first
            const userCamera = getUserCamera();
            if (userCamera && captureFrameFromCamera) {
              try {
                const frame = await captureFrameFromCamera(userCamera.deviceId);
                if (frame && frame.size > 0) {
                  return frame;
                }
              } catch (err) {
                console.log('[Home] multiCamera frame capture failed:', err);
              }
            }
            // Fall back to shared camera stream (from face tracking)
            const stream = sharedCameraStream ?? getUserCamera()?.stream;
            if (stream) {
              try {
                const video = document.createElement('video');
                video.srcObject = stream;
                video.muted = true;
                video.playsInline = true;
                await new Promise<void>((resolve, reject) => {
                  video.onloadedmetadata = () => { video.play().then(() => resolve()).catch(reject); };
                  video.onerror = () => reject(new Error('Video load failed'));
                  setTimeout(() => reject(new Error('Video load timeout')), 2000);
                });
                const canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 480;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(video, 0, 0, 640, 480);
                  const blob = await new Promise<Blob | null>((resolve) => {
                    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.7);
                  });
                  video.pause();
                  video.srcObject = null;
                  if (blob && blob.size > 0) {
                    console.log('[Home] Captured from shared stream:', blob.size, 'bytes');
                    return blob;
                  }
                }
              } catch (err) {
                console.log('[Home] Shared stream capture failed:', err);
              }
            }
            return null;
          }}
          captureEnvFrame={async () => {
            const collector = envCollectorRef.current;
            if (!collector || !collector.getIsAwake()) return null;
            const frame = await collector.captureNow('medium');
            if (!frame) return null;
            return { blob: frame.blob, timestamp: frame.timestamp, motionLevel: collector.getMotionLevel() };
          }}
          getIdentifiedPerson={getIdentifiedPerson}
          getGestureContext={getGestureContext}
          getUnmatchedFaceDescriptors={getUnmatchedDescriptors}
          debugMode={debugMode}
          getFaceImage={faceImageCache.getFaceImage}
        >
          <DualAgentBridge
            onModeChange={setDualAgentMode}
            onInterpretReady={(fn) => { interpretFnRef.current = fn; }}
            onBoardPatchChange={setBoardPatchData}
            onSymbolUpdateChange={setSymbolUpdateData}
            onAiButtonPressChange={setAiButtonPressData}
            onSendMessageReady={(fn) => { sendMessageFnRef.current = fn; }}
            onSendContextOnlyReady={(fn) => { sendContextOnlyFnRef.current = fn; }}
            onBoardExitReady={(fn) => { sendBoardExitRef.current = fn; }}
            onGuessingModeChange={setIsGuessingMode}
            onContextButtonsChange={setContextButtons}
            onInitializedChange={setAiSessionActive}
            onYesNoChange={(active, dismiss) => { setYesNoActive(active); dismissYesNoRef.current = dismiss; }}
            onRestartSessionReady={(fn) => { restartSessionFnRef.current = fn; }}
            onPausedChange={(paused, setPausedFn) => { setIsPaused(paused); setPausedFnRef.current = setPausedFn; }}
            onActiveAppChange={(app, dismiss, registerCapture) => { setActiveApp(app); dismissAppRef.current = dismiss; registerAppCanvasCaptureRef.current = registerCapture; }}
          />
          <DualAgentConversationBox
            isVisible={showConversation}
            onToggle={() => setShowConversation(!showConversation)}
            selectedSymbols={selectedSymbols}
            onClearSymbols={() => setSelectedSymbols([])}
            onBoardUpdate={handleBoardUpdate}
            onSetBoard={handleSetBoard}
            onUnloadBoard={handleUnloadBoard}
            currentBoard={boardData}
            boardMode={boardMode}
            onBoardModeChange={setBoardMode}
            recentButtonPresses={recentButtonPresses}
            onInterpret={handleInterpret}
            onSettings={() => setShowUserSettings(true)}
            onExitStudent={onExitStudent}
            onLogout={() => onLogout()}
            onFullScreen={handleFullScreen}
            debugMode={debugMode}
            showDebugPanel={showDebugPanel}
            onDebugPanelToggle={() => setShowDebugPanel(!showDebugPanel)}
            rawFaces={rawFaces}
            rawHands={rawHands}
          />
          {debugMode && (
            <UnifiedDebugPanel
              isOpen={showDebugPanel}
              onClose={() => setShowDebugPanel(false)}
              faceTrackingEnabled={faceTrackingEnabled}
              onFaceTrackingToggle={setFaceTrackingEnabled}
              trackedFaces={trackedFaces}
              faceTrackingFps={faceTrackingFps}
              faceTrackingReady={faceTrackingReady}
              faceTrackingError={faceTrackingError}
              handGestureEnabled={handGestureEnabled}
              onHandGestureToggle={setHandGestureEnabled}
              trackedHands={trackedHands}
              handGestureFps={handGestureFps}
              handGestureReady={handGestureReady}
              handGestureError={handGestureError}
              lastCapturedFaceImage={lastCapturedFaceImage}
            />
          )}
        </DualAgentProvider>
      )}

      {/* Gesture Hints */}
      <AnimatePresence>
        {showGestureHints && (
          <>
            <motion.div
              className="absolute bottom-4 left-4 text-text-secondary text-xs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <p>💡 Swipe left for settings</p>
            </motion.div>

            <motion.div
              className="absolute bottom-16 left-4 text-text-secondary text-xs"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <p>🗣️ Swipe right for conversation</p>
            </motion.div>
            
            <motion.div
              className="absolute bottom-4 right-4 text-text-secondary text-xs cursor-pointer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowChatLog(true)}
            >
              <p>💬 Tap here for chat history</p>
            </motion.div>
          </>
        )}
      </AnimatePresence>


      {/* Two-Handed Object Detection - only render when explicitly enabled in user settings */}
      {(userProfile?.objectDetectionEnabled || userProfile?.object_detection_enabled) && (
        <TwoHandedObjectDetection
          isEnabled={true}
          showWindow={showObjectDetectionWindow}
          onObjectsDetected={handleObjectsDetected}
          onToggle={setShowObjectDetectionWindow}
        />
      )}

      {/* Object Detection Debug Window */}
      <ObjectDetectionDebug
        isVisible={showObjectDetectionDebug}
        onToggle={(visible) => setShowObjectDetectionDebug(visible)}
        detectedObjects={detectedObjects}
        isDetectionActive={userProfile?.objectDetectionEnabled || userProfile?.object_detection_enabled || false}
        lastDetectionTime={lastObjectDetectionTime}
      />

    </div>
    <DwellOverlay />
    <GazeCalibrationOverlay />
    </EyeTrackingDwellProvider>
    </CameraAttentivenessWrapper>
    </AccessibilityProvider>
  );
}

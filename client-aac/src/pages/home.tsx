import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, UserX, Hand, Mic, Maximize, LogOut, ArrowLeft, Brain } from "lucide-react";
import DynamicBoard from "@/components/DynamicBoard";
import PrebuiltBoardSection from "@/components/PrebuiltBoardSection";
import QuickActions from "@/components/QuickActions";
import type { ParsedBoardData, BoardButton } from "@shared/schema";

import ChatLog from "@/components/ChatLog";
import ProfileSetup from "@/components/ProfileSetup";
import UserSettings from "@/components/UserSettings";
import { ConversationBox } from "@/components/ConversationBox";
import { DualAgentConversationBox } from "@/components/DualAgentConversationBox";
import { DualAgentProvider, useDualAgentContext } from "@/contexts/DualAgentContext";
import { LanguageSelector } from "@/components/LanguageSelector";
import { Button } from "@/components/ui/button";
import { useGestures } from "@/hooks/useGestures";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useCamera } from "@/hooks/useCamera";
import { usePersonIdentification } from "@/hooks/usePersonIdentification";
import { DebugToggle } from "@/components/DebugWindow";
import MultiCameraDebugWindow from "@/components/MultiCameraDebugWindow";
import { CameraDebugToggle } from "@/components/CameraDebugToggle";
import AudioCapture from "@/components/AudioCapture";
// AudioToggle now merged into PassiveCoListener
import TwoHandedObjectDetection from "@/components/TwoHandedObjectDetection";
import { DetectedObject } from "@/hooks/useTwoHandedObjectDetection";
import { ObjectDetectionDebug } from "@/components/ObjectDetectionDebug";
import PassiveCoListener from "@/components/PassiveCoListener";
import InitializationLoadingScreen from "@/components/InitializationLoadingScreen";
import { CameraAttentivenessWrapper } from "@/components/CameraAttentivenessWrapper";
import { CameraAttentivenessDebug } from "@/components/CameraAttentivenessDebug";
import { useFaceTracking } from "@/hooks/useFaceTracking";
import { useFaceEvents } from "@/hooks/useFaceEvents";
import { useHandGestureTracking } from "@/hooks/useHandGestureTracking";
import { useHandGestureEvents } from "@/hooks/useHandGestureEvents";
import { serializeGestureContext } from "@/lib/gestureContextSerializer";

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
function DualAgentBridge({ onModeChange, onInterpretReady, onDetectionChange, onBoardPatchChange }: {
  onModeChange: (mode: 'interact' | 'silent') => void;
  onInterpretReady: (fn: ((buttons: string[]) => Promise<void>) | null) => void;
  onDetectionChange?: (enabled: boolean) => void;
  onBoardPatchChange?: (patch: import("@/hooks/useDualAgent").BoardPatch | null) => void;
}) {
  const { interactionMode, interpretButtons, detectionEnabled, boardPatch } = useDualAgentContext();

  useEffect(() => {
    onModeChange(interactionMode);
  }, [interactionMode, onModeChange]);

  useEffect(() => {
    onInterpretReady((buttons: string[]) => interpretButtons(buttons));
    return () => onInterpretReady(null);
  }, [interpretButtons, onInterpretReady]);

  useEffect(() => {
    onDetectionChange?.(detectionEnabled);
  }, [detectionEnabled, onDetectionChange]);

  useEffect(() => {
    onBoardPatchChange?.(boardPatch);
  }, [boardPatch, onBoardPatchChange]);

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
  const { language: currentLanguage, setLanguage: setCurrentLanguage, t, isRTL, direction } = useLanguage();
  const [showCameraDebug, setShowCameraDebug] = useState<boolean>(false);
  const [showAudioCapture, setShowAudioCapture] = useState<boolean>(false);
  const [useDualAgent, setUseDualAgent] = useState<boolean>(true); // Toggle for dual-agent system

  // Use the initialization context for loading state
  const { isComplete: isInitComplete } = useAppInitialization();
  // Object detection is now controlled via user settings
  const [detectedObjects, setDetectedObjects] = useState<{left: DetectedObject | null, right: DetectedObject | null}>({left: null, right: null});
  const [showObjectDetectionDebug, setShowObjectDetectionDebug] = useState<boolean>(false);
  const [showObjectDetectionWindow, setShowObjectDetectionWindow] = useState<boolean>(false);
  const [lastObjectDetectionTime, setLastObjectDetectionTime] = useState<number>();
  const [debugMode, setDebugMode] = useState<boolean>(false);
  const [showAttentivenessDebug, setShowAttentivenessDebug] = useState<boolean>(false);
  const [faceTrackingEnabled, setFaceTrackingEnabled] = useState<boolean>(true);
  const [handGestureEnabled, setHandGestureEnabled] = useState<boolean>(true);

  // Passive Co-Listener state
  const [passiveChoiceOptions, setPassiveChoiceOptions] = useState<Array<{ label: string; emoji: string; confidence: number }>>([]);

  // AAC Board state - populated from chat responses
  const [boardData, setBoardData] = useState<ParsedBoardData | null>(null);

  // Board patch state — from detection (incremental add/remove)
  const [boardPatchData, setBoardPatchData] = useState<import("@/hooks/useDualAgent").BoardPatch | null>(null);

  // Recent button presses for Interpret feature (silent mode)
  const [recentButtonPresses, setRecentButtonPresses] = useState<string[]>([]);

  // Board mode: 'ai' shows DynamicBoard, 'db' shows PrebuiltBoardSection
  const [boardMode, setBoardMode] = useState<'ai' | 'db'>('ai');

  // Dual-agent mode bridged from context
  const [dualAgentMode, setDualAgentMode] = useState<'interact' | 'silent'>('interact');
  const interpretFnRef = useRef<((buttons: string[]) => Promise<void>) | null>(null);

  // Get authenticated user
  const { data: authUser, isLoading: isAuthLoading } = useQuery({
    queryKey: ["/auth/user"],
    retry: false
  });

  const { speak, isSpeaking } = useTextToSpeech();
  const {
    cameras,
    isMultiCameraActive,
    getUserCamera,
    getEnvironmentCamera,
    captureFrameFromCamera,
    autoAssignCameras,
    globalError
  } = useMultiCamera({ autoStart: false });

  // Get shared camera stream from CameraProvider context
  const { stream: sharedCameraStream, startCamera: startSharedCamera } = useCamera();

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

  // Person identification for AAC system (face recognition)
  const {
    isReady: isPersonIdReady,
    currentIdentification,
    identifyFromVideo,
    knownPeopleCount,
  } = usePersonIdentification({
    studentId,
    enabled: useDualAgent, // Only enable when dual-agent is active
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

  // Hand gesture event accumulation (derives semantic events from gestures + landmarks)
  const { trackedHands } = useHandGestureEvents({
    hands: rawHands,
    enabled: handGestureEnabled,
  });

  // Get current identified person (non-blocking getter for dual-agent)
  const getIdentifiedPerson = useCallback(() => {
    return currentIdentification?.person || null;
  }, [currentIdentification]);

  // Get serialized gesture/expression context for dual-agent AI
  const getGestureContext = useCallback(() => {
    return serializeGestureContext(trackedFaces, trackedHands);
  }, [trackedFaces, trackedHands]);

  // Periodic face identification from camera (runs every 2 seconds when ready)
  useEffect(() => {
    if (!isPersonIdReady || !useDualAgent || !isMultiCameraActive) return;

    const runIdentification = async () => {
      const userCamera = getUserCamera();
      if (!userCamera || !captureFrameFromCamera) return;

      try {
        const frame = await captureFrameFromCamera(userCamera.deviceId);
        if (frame && frame.size > 0) {
          // Create an image element from the blob
          const img = new Image();
          const url = URL.createObjectURL(frame);
          img.src = url;

          await new Promise<void>((resolve) => {
            img.onload = async () => {
              await identifyFromVideo(img as any); // Works with images too
              URL.revokeObjectURL(url);
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(url);
              resolve();
            };
          });
        }
      } catch (err) {
        // Silent fail - identification is non-critical
      }
    };

    // Run identification every 2 seconds (fast enough for context, slow enough for performance)
    const interval = setInterval(runIdentification, 2000);

    // Run once immediately
    runIdentification();

    return () => clearInterval(interval);
  }, [isPersonIdReady, useDualAgent, isMultiCameraActive, getUserCamera, captureFrameFromCamera, identifyFromVideo]);

  // Initialize gesture handling
  useGestures({
    onSwipeLeft: () => setShowUserSettings(true),
    onCornerTap: () => setShowChatLog(true),
    onSwipeRight: () => setShowConversation(!showConversation),
  });

  // System startup - initialization is now managed by AppInitializationContext
  useEffect(() => {
    console.log('Xahaph System - Initializing...');
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
        // Check camera status first - multi-camera system
        setIsCameraBlocked(!isMultiCameraActive || !!globalError || !getUserCamera());
        
        // Only do person detection if multi-camera is working and we have a user camera
        const userCamera = getUserCamera();
        if (isMultiCameraActive && userCamera && captureFrameFromCamera) {
          try {
            console.log('Attempting camera capture for person detection...');
            const frame = await captureFrameFromCamera(userCamera.deviceId);
            console.log('Camera capture result:', frame ? `${frame.size} bytes` : 'null');
            
            if (frame && frame.size > 5000) { // Valid frame check
              const formData = new FormData();
              formData.append('image', frame, 'frame.jpg');
              formData.append('expectedAge', userProfile?.age?.toString() || '46');
              formData.append('expectedGender', userProfile?.gender || 'male');
              formData.append('cameraType', 'user'); // Integrated camera for main user detection

              console.log('Sending person detection request...');
              const personResponse = await fetchWithAuth(`/api/aac/detect-person`, {
                method: 'POST',
                body: formData,
              });
              
              if (personResponse.ok) {
                const personData = await personResponse.json();
                console.log('Person detection result:', personData);
                setAnyPersonPresent(personData.personPresent || false);
                setIsMainUserPresent(personData.isMainUser || false);
              } else {
                console.log('Person detection API error:', personResponse.status, await personResponse.text());
              }
            } else {
              console.log('Invalid frame captured, size:', frame?.size || 0);
              // If frame capture fails, assume no person present to trigger standby
              setAnyPersonPresent(false);
              setIsMainUserPresent(false);
            }
          } catch (detectionError) {
            console.log('Person detection in status check failed:', detectionError);
            // If detection fails completely, assume no person present
            setAnyPersonPresent(false);
            setIsMainUserPresent(false);
          }
        } else {
          console.log('Multi-camera not active or user camera not available');
          setIsCameraBlocked(true);
          setAnyPersonPresent(false);
          setIsMainUserPresent(false);
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
  }, [isStandbyMode, isMultiCameraActive, globalError, captureFrameFromCamera, getUserCamera, userProfile, DISABLE_PERIODIC_DETECTION]);

  // Show gesture hints briefly
  useEffect(() => {
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
    const studentVoice = userProfile?.aacStudentVoiceType || 'boy';
    await speak(interpretation, currentLanguage, studentVoice);

    // Clear symbols after speech
    setTimeout(() => {
      setSelectedSymbols([]);
      setCurrentSpeech("");
    }, 2000);
  };

  // Handle AAC board button click - sends to conversation
  const handleBoardButtonClick = useCallback((button: BoardButton, spokenText: string) => {
    // Add to selected symbols to trigger conversation send
    setSelectedSymbols([spokenText]);
    setCurrentSpeech(spokenText);

    // Track for interpret feature (keep last 10)
    setRecentButtonPresses(prev => [...prev.slice(-9), spokenText]);

    // Clear after a moment
    setTimeout(() => {
      setCurrentSpeech("");
    }, 2000);
  }, []);

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

  const handleBoardBack = useCallback(() => {
    const prev = boardHistoryRef.current.pop();
    if (prev) {
      setBoardData(prev);
    }
  }, []);

  // Handle detected objects from two-handed detection
  const handleObjectsDetected = useCallback((leftObject: DetectedObject | null, rightObject: DetectedObject | null) => {
    setDetectedObjects({ left: leftObject, right: rightObject });
    setLastObjectDetectionTime(Date.now());
  }, []);

  // Handle choice detection from passive co-listener
  const handleChoiceDetected = useCallback((options: Array<{ label: string; emoji: string; confidence: number }>) => {
    console.log('🎯 Choice detected, showing options:', options);
    setPassiveChoiceOptions(options);
    
    // Auto-clear after 30 seconds
    setTimeout(() => {
      setPassiveChoiceOptions([]);
    }, 30000);
  }, []);

  // Handle selection of a passive choice option
  const handlePassiveChoiceSelect = useCallback(async (option: { label: string; emoji: string }) => {
    console.log('✨ Selected passive choice option:', option);
    
    // Add to selected symbols and speak
    await handleSymbolSelect({ 
      label: option.label, 
      emoji: option.emoji 
    });
    
    // Clear choice options
    setPassiveChoiceOptions([]);
  }, [handleSymbolSelect]);

  const handleProfileComplete = (_studentId: string, profile?: any) => {
    setUserProfile(profile);
    setShowProfileSetup(false);
    localStorage.setItem('synapse_student_id', studentId);
    if (profile) {
      localStorage.setItem('synapse_user_profile', JSON.stringify(profile));
    }
    // Conversation will start automatically when person is detected
  };

  // Load user profile from authenticated user or API
  useEffect(() => {
    const loadUserProfile = async () => {
      try {
        if (authUser && (authUser as any).id) {
          console.log('Using authenticated user data as profile:', authUser);
          setUserProfile(authUser);
          localStorage.setItem('synapse_user_profile', JSON.stringify(authUser));
          
          // Auto-enable audio capture if user has audioMonitoring enabled
          if ((authUser as any).audioMonitoring === true) {
            console.log('Auto-enabling audio capture from authenticated user profile');
            setShowAudioCapture(true);
          }
          
          // Load debug mode from user profile
          if ((authUser as any).debugMode === true) {
            console.log('Enabling debug mode from authenticated user profile');
            setDebugMode(true);
          }
        } else if (studentId) {
          // Fallback to API call if authUser is not available but studentId is set
          const response = await fetchWithAuth(`/api/students/${studentId}`);
          if (response.ok) {
            const profile = await response.json();
            setUserProfile(profile);
            localStorage.setItem('synapse_user_profile', JSON.stringify(profile));
            
            // Auto-enable audio capture if user has audioMonitoring enabled
            if (profile.audioMonitoring === true) {
              console.log('Auto-enabling audio capture from API user profile');
              setShowAudioCapture(true);
            }
            
            // Load debug mode from user profile
            if (profile.debugMode === true) {
              console.log('Enabling debug mode from API user profile');
              setDebugMode(true);
            }
          }
        }
      } catch (error) {
        console.error('Failed to load user profile:', error);
      }
    };

    loadUserProfile();
  }, [authUser, studentId]);

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

      // If we have camera functionality, use it for presence detection
      if (captureFrameFromCamera && getUserCamera) {
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
  }, [studentId, captureFrameFromCamera, getUserCamera, userProfile, DISABLE_PERIODIC_DETECTION]);

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
    <CameraAttentivenessWrapper autoStart={true} cameraType="user">
    <div className="h-screen flex flex-col relative overflow-hidden bg-bg-soft">
      {/* Top Navigation Bar */}
      <motion.div 
        className="absolute top-0 left-0 right-0 z-20 bg-white/90 backdrop-blur-sm border-b border-gray-200 px-4 py-2"
        initial={{ y: -48 }}
        animate={{ y: 0 }}
        transition={{ delay: 0.5 }}
      >
        <div className="flex justify-between items-center">
          <div className="flex-1 text-sm text-text-secondary">
            <span>{new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
          </div>
          
          <div className="text-sm">
            {!isMultiCameraActive || globalError || !getUserCamera() ? (
              <div className="flex items-center space-x-2 text-red-500 font-medium">
                <UserX className="w-4 h-4" />
                <span>CAMERA BLOCKED</span>
              </div>
            ) : !anyPersonPresent ? (
              <div className="flex items-center space-x-2 text-orange-500 font-medium">
                <UserX className="w-4 h-4" />
                <span>NO ONE PRESENT</span>
              </div>
            ) : !isMainUserPresent && userProfile ? (
              <div className="flex items-center space-x-2 text-orange-500 font-medium">
                <UserX className="w-4 h-4" />
                <span>{userProfile.name || 'USER'} NOT PRESENT</span>
              </div>
            ) : (
              <span className="text-text-secondary">Home</span>
            )}
          </div>
          
          <div className="flex-1 flex justify-end space-x-2">
            <LanguageSelector className="text-xs" />

            <Button
              variant="ghost"
              size="sm"
              onClick={handleFullScreen}
              className="text-text-secondary hover:text-text-primary hover:bg-gray-100"
              title="Toggle Full Screen (F11)"
            >
              <Maximize className="w-4 h-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowUserSettings(true)}
              className="text-text-secondary hover:text-text-primary hover:bg-gray-100"
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={onExitStudent}
              className="text-text-secondary hover:text-orange-600 hover:bg-orange-50"
              title="Switch Student"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await apiRequest("POST", "/auth/logout", {});
                } catch (e) {}
                onLogout();
              }}
              className="text-text-secondary hover:text-red-600 hover:bg-red-50"
              title="Log Out"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Main 3-Section Board Layout */}
      <main className={`flex-1 flex flex-col relative ${
        showConversation ? 'pt-28' : 'pt-12'
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
        <div className="flex-1 min-h-0 overflow-hidden">
          {boardMode === 'ai' ? (
            <DynamicBoard
              board={boardData}
              boardPatch={boardPatchData}
              onButtonClick={handleBoardButtonClick}
              onBack={boardHistoryRef.current.length > 0 ? handleBoardBack : undefined}
              language={currentLanguage}
              voiceType={userProfile?.aacStudentVoiceType || 'boy'}
            />
          ) : (
            <PrebuiltBoardSection
              studentId={studentId}
              onSpeakAction={(text) => {
                // Send spoken text to AI conversation
                setSelectedSymbols([text]);
              }}
              language={currentLanguage}
              voiceType={userProfile?.aacStudentVoiceType || 'boy'}
              onBack={() => {
                // Handle back at root level - could show board selector
              }}
            />
          )}
        </div>

        {/* Bottom Row: Quick Actions */}
        <QuickActions
          onAction={(action, text) => {
            // Send quick action to AI
            setSelectedSymbols([text]);
          }}
          onBack={() => {
            // Call the prebuilt board's back function
            const goBack = (window as any).__prebuiltBoardGoBack;
            if (goBack) {
              goBack();
            }
          }}
          boardMode={boardMode}
          voiceType={userProfile?.aacStudentVoiceType || 'boy'}
        />

        {/* Passive Choice Options Overlay */}
        <AnimatePresence>
          {passiveChoiceOptions.length > 0 && (
            <motion.div
              className="absolute inset-0 bg-black/60 z-30 flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                className="bg-white dark:bg-gray-800 rounded-2xl p-6 max-w-2xl w-full shadow-2xl"
                initial={{ scale: 0.8, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.8, y: 20 }}
              >
                <div className="text-center mb-6">
                  <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                    💬 Choice Question Detected
                  </h3>
                  <p className="text-gray-600 dark:text-gray-300">
                    Tap an option to respond
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {passiveChoiceOptions.map((option, index) => (
                    <motion.button
                      key={index}
                      onClick={() => handlePassiveChoiceSelect(option)}
                      className="flex flex-col items-center p-4 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-xl border-2 border-blue-200 dark:border-blue-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      <div className="text-4xl mb-2">{option.emoji}</div>
                      <div className="text-lg font-medium text-gray-900 dark:text-white">
                        {option.label}
                      </div>
                      <div className="text-xs text-blue-600 dark:text-blue-400">
                        {Math.round(option.confidence * 100)}% confident
                      </div>
                    </motion.button>
                  ))}
                </div>

                <motion.button
                  onClick={() => setPassiveChoiceOptions([])}
                  className="mt-4 w-full py-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  Dismiss
                </motion.button>
              </motion.div>
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
          captureFrame={async () => {
            const userCamera = getUserCamera();
            if (userCamera && captureFrameFromCamera) {
              try {
                const frame = await captureFrameFromCamera(userCamera.deviceId);
                if (frame && frame.size > 0) {
                  return frame;
                }
              } catch (err) {
                console.log('[Home] Frame capture failed:', err);
              }
            }
            return null;
          }}
          getIdentifiedPerson={getIdentifiedPerson}
          getGestureContext={getGestureContext}
        >
          <DualAgentBridge
            onModeChange={setDualAgentMode}
            onInterpretReady={(fn) => { interpretFnRef.current = fn; }}
            onBoardPatchChange={setBoardPatchData}
          />
          <DualAgentConversationBox
            isVisible={showConversation}
            onToggle={() => setShowConversation(!showConversation)}
            selectedSymbols={selectedSymbols}
            onClearSymbols={() => setSelectedSymbols([])}
            onBoardUpdate={handleBoardUpdate}
            currentBoard={boardData}
            boardMode={boardMode}
            onBoardModeChange={setBoardMode}
            recentButtonPresses={recentButtonPresses}
            onInterpret={handleInterpret}
          />
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

      {/* Debug Controls - Only shown when debug mode is enabled */}
      {debugMode && (
        <>
          {/* Debug Windows */}
          <DebugToggle />
          <CameraDebugToggle onToggle={() => setShowCameraDebug(true)} />
          <CameraAttentivenessDebug
            isVisible={showAttentivenessDebug}
            onToggle={setShowAttentivenessDebug}
          />
          
          {/* AudioBETA Button - triggers unified PassiveCoListener window */}
          {debugMode && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Enable passive co-listener if user is authenticated
                if (studentId && userProfile) {
                  setUserProfile({ ...userProfile, passiveCoListenerEnabled: !userProfile.passiveCoListenerEnabled });
                }
              }}
              className={`
                fixed z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 shadow-lg
                flex items-center gap-2 transition-all duration-200
                ${userProfile?.passiveCoListenerEnabled ? 'bg-blue-100/90 dark:bg-blue-900/90 border-blue-300 dark:border-blue-700' : ''}
              `}
              style={{ bottom: '1rem', right: '15rem' }}
              title="Audio Debug Monitor (Beta) - Unified passive co-listener with real-time audio analysis"
            >
              <Mic className="w-4 h-4 text-green-500" />
              <span className="text-sm">
                AudioBETA
              </span>
            </Button>
          )}

          {/* Object Detection Window Toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowObjectDetectionWindow(!showObjectDetectionWindow)}
            className={`
              fixed z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 shadow-lg
              flex items-center gap-2 transition-all duration-200
              ${showObjectDetectionWindow ? 'bg-green-100/90 dark:bg-green-900/90 border-green-300 dark:border-green-700' : ''}
            `}
            style={{ bottom: '1rem', right: '24rem' }}
            title="Object Detection Window"
          >
            <Hand className="w-4 h-4 text-green-600" />
            <span className="text-sm">Objects</span>
          </Button>

          {/* Dual-Agent System Toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUseDualAgent(!useDualAgent)}
            className={`
              fixed z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 shadow-lg
              flex items-center gap-2 transition-all duration-200
              ${useDualAgent ? 'bg-purple-100/90 dark:bg-purple-900/90 border-purple-300 dark:border-purple-700' : ''}
            `}
            style={{ bottom: '1rem', right: '33rem' }}
            title="Toggle Dual-Agent System (Interactive + Monitor)"
          >
            <Brain className={`w-4 h-4 ${useDualAgent ? 'text-purple-600' : 'text-gray-500'}`} />
            <span className="text-sm">{useDualAgent ? 'Dual-Agent ON' : 'Dual-Agent'}</span>
          </Button>
        </>
      )}

      
      {/* Multi-Camera Debug Window */}
      <MultiCameraDebugWindow
        isOpen={showCameraDebug}
        onClose={() => setShowCameraDebug(false)}
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
      />

      {/* Audio Capture Component - only show in debug mode */}
      {debugMode && showAudioCapture && (
        <AudioCapture
          enabled={userProfile?.audioMonitoring !== false}
          isVisible={showAudioCapture}
          onClose={() => setShowAudioCapture(false)}
          onAudioProcessed={(context) => {
            console.log('Audio context received:', context);
            // Integration with existing visual context for enhanced scene understanding
          }}
        />
      )}

      {/* Two-Handed Object Detection - background detection controlled by settings, window visibility separate */}
      <TwoHandedObjectDetection
        isEnabled={userProfile?.objectDetectionEnabled || userProfile?.object_detection_enabled || false}
        showWindow={showObjectDetectionWindow}
        onObjectsDetected={handleObjectsDetected}
        onToggle={setShowObjectDetectionWindow}
      />

      {/* Object Detection Debug Window */}
      <ObjectDetectionDebug
        isVisible={showObjectDetectionDebug}
        onToggle={(visible) => setShowObjectDetectionDebug(visible)}
        detectedObjects={detectedObjects}
        isDetectionActive={userProfile?.objectDetectionEnabled || userProfile?.object_detection_enabled || false}
        lastDetectionTime={lastObjectDetectionTime}
      />
      {/* Passive Co-Listener with Audio Debug Monitor - only show in debug mode */}
      {debugMode && studentId && userProfile && (
        <PassiveCoListener
          enabled={userProfile.passiveCoListenerEnabled || false}
          onEnabledChange={(enabled) => {
            // Update user profile
            setUserProfile({ ...userProfile, passiveCoListenerEnabled: enabled });
          }}
          onChoiceDetected={handleChoiceDetected}
          studentId={studentId}
          language={currentLanguage as 'en' | 'he'}
          userProfile={userProfile}
          // Audio capture integration
          showAudioCapture={showAudioCapture}
          onAudioCaptureToggle={() => setShowAudioCapture(!showAudioCapture)}
          isAudioCaptureEnabled={userProfile?.audioMonitoring !== false}
          isAudioMonitoring={false} // Will be updated by audio monitoring logic
        />
      )}

    </div>
    </CameraAttentivenessWrapper>
  );
}

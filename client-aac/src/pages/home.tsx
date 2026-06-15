import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UserX, Eye, EyeOff, Play } from "lucide-react";
import DynamicBoard from "@/components/DynamicBoard";
import { SentenceConstructorBoard } from "@/components/SentenceConstructorBoard";
import AppsBoard from "@/components/AppsBoard";
import PrebuiltBoardSection from "@/components/PrebuiltBoardSection";
import QuickActions from "@/components/QuickActions";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { GUESSING_REJECT } from "@shared/guessing-mode/state.js";

import ChatLog from "@/components/ChatLog";
import ProfileSetup from "@/components/ProfileSetup";
import { AccessibilityProvider } from "@/contexts/AccessibilityContext";
import { ConversationBox } from "@/components/ConversationBox";
import { DualAgentConversationBox } from "@/components/DualAgentConversationBox";
import { FullscreenAvatarOverlay } from "@/components/FullscreenAvatarOverlay";
import { AvatarSpriteProvider } from "@/contexts/AvatarSpriteContext";
import { SocialBotProvider } from "@/contexts/SocialBotContext";
import { DualAgentProvider, useDualAgentContext } from "@/contexts/DualAgentContext";
import { Button } from "@/components/ui/button";
import { useGestures } from "@/hooks/useGestures";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useMultiCamera } from "@/hooks/useMultiCamera";
import { useCamera } from "@/hooks/useCamera";
import { usePersonIdentification } from "@/hooks/usePersonIdentification";
import { useFaceImageCache } from "@/hooks/useFaceImageCache";
import { usePeopleDirectory } from "@/hooks/usePeopleDirectory";
import { setFaceImageResolver } from "@/lib/glyph-images";
import UnifiedDebugPanel from "@/components/UnifiedDebugPanel";
import BinaryChoiceOverlay from "@/components/BinaryChoiceOverlay";
import AlarmOverlay from "@/components/AlarmOverlay";
import { DeviceManagerModal } from "@/components/DeviceManager";
import InitializationLoadingScreen from "@/components/InitializationLoadingScreen";
import YouTubeApp from "@/components/apps/YouTubeApp";
import DrawingApp from "@/components/apps/DrawingApp";
import MusicApp from "@/components/apps/MusicApp";
import SpotifyApp from "@/components/apps/SpotifyApp";
import GameEmbed from "@/components/games/GameEmbed";
import GoalTreeQuestPlayer from "@/components/games/GoalTreeQuestPlayer";
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
import { isValidSignLanguageCode, isValidLanguageCode } from "@/i18n";
import { serializeGestureContext } from "@/lib/gestureContextSerializer";
import { EyeTrackingDwellProvider } from "@/contexts/EyeTrackingDwellContext";
import DwellOverlay from "@/components/DwellOverlay";
import GazeCalibrationOverlay from "@/components/GazeCalibrationOverlay";
import { createPortal } from "react-dom";
import { useEyeGaze } from "@/hooks/useEyeGaze";
import { useGazeSidecar } from "@/hooks/useGazeSidecar";
import type { EyeGazeProviderType } from "@/lib/eyegaze/types";

import { useLanguage } from "@/contexts/LanguageContext";
import { useAppInitialization } from "@/contexts/AppInitializationContext";
import { useQuery } from "@tanstack/react-query";
import { fetchWithAuth } from "@/lib/queryClient";

interface HomeProps {
  studentId: string;
  // Set when the user entered AAC via a classroom (multi-student mode).
  // Currently propagated for future classroom-mode features (active-user
  // switching, classroom-level prompt compilation); the session still
  // operates around a single active studentId.
  classroomId?: string | null;
  onLogout: () => void;
  onExitStudent: () => void;
}

/**
 * Inner component that bridges DualAgentContext to parent Home for voicing/mode features.
 * Must be rendered inside DualAgentProvider.
 */
function DualAgentBridge({ onModeChange, onVoiceReady, onPlayGlyphReady, onDetectionChange, onBoardPatchChange, onSymbolUpdateChange, onAiButtonPressChange, onSendMessageReady, onSendContextOnlyReady, onBoardExitReady, onGuessingModeChange, onPressSuggestionReady, onPressNarrowReady, onEnterGuessingFromBuilderReady, onEnterGuessingReady, onExitGuessingReady, onSetBuilderVisibleReady, onContextButtonsChange, onInitializedChange, onBinaryChoiceChange, onAlarmChange, onRestartSessionReady, onPausedChange, onActiveAppChange, onEnabledAppsChange, onAvailableCustomAppsChange, onLaunchAppReady, onRequestAppOpenReady, onAppOpenPendingChange, onSendConstructionStateReady, onConstructionSuggestionsChange, onConstructionMemoryChipsChange }: {
  onModeChange: (state: 'unmuted' | 'muted') => void;
  onVoiceReady: (fn: ((buttons: string[], sentences?: Record<string, string>) => Promise<void>) | null) => void;
  onPlayGlyphReady?: (fn: ((glyphString: string) => void) | null) => void;
  onDetectionChange?: (enabled: boolean) => void;
  onBoardPatchChange?: (patch: import("@/hooks/dual-agent-types").BoardPatch | null) => void;
  onSymbolUpdateChange?: (data: { buttonLabel: string; symbolPath: string } | null) => void;
  onAiButtonPressChange?: (data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: import("@shared/schema").BoardButton[] } | null) => void;
  onSendMessageReady?: (fn: ((msg: string) => Promise<void>) | null) => void;
  onSendContextOnlyReady?: (fn: ((text: string) => void) | null) => void;
  onInitializedChange?: (initialized: boolean) => void;
  onBinaryChoiceChange?: (options: import("@/hooks/dual-agent-types").BinaryChoiceOption[] | null, escapeKind: "maybe" | "neither" | null, inputGlyph: { glyph: string; fallback?: string } | null, dismiss: () => void) => void;
  onAlarmChange?: (alarm: { level: "alert" | "emergency"; reason: string } | null, cancel: () => void) => void;
  onRestartSessionReady?: (fn: (() => void) | null) => void;
  onPausedChange?: (paused: boolean, setPaused: (p: boolean) => void) => void;
  onActiveAppChange?: (app: import("@/hooks/dual-agent-types").ActiveAppData | null, dismissApp: () => void, registerCapture: (fn: (() => Promise<Blob | null>) | null) => void) => void;
  onEnabledAppsChange?: (apps: Array<{ id: string; name: string; icon: string; needsStartupResolution?: boolean }>) => void;
  onAvailableCustomAppsChange?: (apps: Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>) => void;
  onLaunchAppReady?: (fn: ((appId: string, appData?: any) => void) | null) => void;
  onRequestAppOpenReady?: (fn: ((appId: string, appData?: any) => void) | null) => void;
  onAppOpenPendingChange?: (pendingAppId: string | null) => void;
  onBoardExitReady?: (fn: ((label: string, instruction: string) => void) | null) => void;
  onGuessingModeChange?: (active: boolean) => void;
  onPressSuggestionReady?: (fn: ((suggestionKey: string) => void) | null) => void;
  onPressNarrowReady?: (fn: ((dimension: string, value: string, sourceText?: string) => void) | null) => void;
  onEnterGuessingFromBuilderReady?: (fn: ((builderContext: { targetSlot: number | null; partialGlyph: string; category: string }) => void) | null) => void;
  onEnterGuessingReady?: (fn: (() => void) | null) => void;
  onExitGuessingReady?: (fn: ((reason?: string) => void) | null) => void;
  onSetBuilderVisibleReady?: (fn: ((open: boolean) => void) | null) => void;
  onContextButtonsChange?: (buttons: Array<{ label: string; iconRef: string; symbolPath?: string; sentence?: string }>) => void;
  onSendConstructionStateReady?: (fn: ((state: import("@/hooks/dual-agent-types").ConstructionStateClient) => void) | null) => void;
  onConstructionSuggestionsChange?: (data: import("@/hooks/dual-agent-types").ConstructionSuggestionsClient | null) => void;
  onConstructionMemoryChipsChange?: (data: Partial<Record<import("@/hooks/dual-agent-types").ConstructionStateClient["category"], import("@/hooks/dual-agent-types").ConstructionMemoryChipsClient>>) => void;
}) {
  const { muteState, voiceButtons, playGlyph, videoCaptureEnabled, voiceEnabled, boardPatch, symbolUpdate, aiButtonPress, sendMessage, sendContextOnly, sendBoardExit, isInitialized, binaryChoiceOptions, binaryChoiceEscapeKind, binaryChoiceInputGlyph, dismissBinaryChoice, activeAlarm, cancelAlarm, clearSession, initialize, paused, setPaused, activeApp, dismissApp, launchApp, requestAppOpen, appOpenPending, registerAppCanvasCapture, enabledApps, availableCustomApps, studentId, guessingMode, pressSuggestion, pressNarrow, enterGuessing, enterGuessingFromBuilder, exitGuessing, setBuilderVisible, contextButtons: contextButtonsFromCtx, sendConstructionState, constructionSuggestions, constructionMemoryChips } = useDualAgentContext();

  useEffect(() => {
    onModeChange(muteState);
  }, [muteState, onModeChange]);

  useEffect(() => {
    onVoiceReady((buttons: string[], sentences?: Record<string, string>) => voiceButtons(buttons, sentences));
    return () => onVoiceReady(null);
  }, [voiceButtons, onVoiceReady]);

  // playGlyph: hand the sentence-builder's composed glyph to the AI for
  // interpretation. Optional on the context (older sessions may not have
  // it); we silently skip wiring if undefined.
  useEffect(() => {
    if (!onPlayGlyphReady) return;
    if (playGlyph) {
      onPlayGlyphReady((glyphString: string) => playGlyph(glyphString));
    } else {
      onPlayGlyphReady(null);
    }
    return () => onPlayGlyphReady(null);
  }, [playGlyph, onPlayGlyphReady]);

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
    console.debug("[guessing] bridge registering pressSuggestion, type:", typeof pressSuggestion);
    onPressSuggestionReady?.(pressSuggestion ? (key: string) => pressSuggestion(key) : null);
    return () => onPressSuggestionReady?.(null);
  }, [pressSuggestion, onPressSuggestionReady]);

  useEffect(() => {
    onPressNarrowReady?.(pressNarrow ? (dim: string, value: string, sourceText?: string) => pressNarrow(dim, value, sourceText) : null);
    return () => onPressNarrowReady?.(null);
  }, [pressNarrow, onPressNarrowReady]);

  useEffect(() => {
    onSetBuilderVisibleReady?.(setBuilderVisible ? (open: boolean) => setBuilderVisible(open) : null);
    return () => onSetBuilderVisibleReady?.(null);
  }, [setBuilderVisible, onSetBuilderVisibleReady]);

  useEffect(() => {
    onEnterGuessingFromBuilderReady?.(enterGuessingFromBuilder ? (ctx) => enterGuessingFromBuilder(ctx) : null);
    return () => onEnterGuessingFromBuilderReady?.(null);
  }, [enterGuessingFromBuilder, onEnterGuessingFromBuilderReady]);

  useEffect(() => {
    onEnterGuessingReady?.(enterGuessing ? () => enterGuessing() : null);
    return () => onEnterGuessingReady?.(null);
  }, [enterGuessing, onEnterGuessingReady]);

  useEffect(() => {
    onExitGuessingReady?.(exitGuessing ? (reason?: string) => exitGuessing(reason) : null);
    return () => onExitGuessingReady?.(null);
  }, [exitGuessing, onExitGuessingReady]);

  useEffect(() => {
    onContextButtonsChange?.(contextButtonsFromCtx);
  }, [contextButtonsFromCtx, onContextButtonsChange]);

  useEffect(() => {
    onInitializedChange?.(isInitialized);
  }, [isInitialized, onInitializedChange]);

  useEffect(() => {
    onBinaryChoiceChange?.(binaryChoiceOptions, binaryChoiceEscapeKind, binaryChoiceInputGlyph, dismissBinaryChoice);
  }, [binaryChoiceOptions, binaryChoiceEscapeKind, binaryChoiceInputGlyph, dismissBinaryChoice, onBinaryChoiceChange]);

  useEffect(() => {
    onAlarmChange?.(activeAlarm, cancelAlarm);
  }, [activeAlarm, cancelAlarm, onAlarmChange]);

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

  useEffect(() => {
    onEnabledAppsChange?.(enabledApps);
  }, [enabledApps, onEnabledAppsChange]);

  useEffect(() => {
    onAvailableCustomAppsChange?.(availableCustomApps);
  }, [availableCustomApps, onAvailableCustomAppsChange]);

  useEffect(() => {
    onLaunchAppReady?.(launchApp);
    return () => onLaunchAppReady?.(null);
  }, [launchApp, onLaunchAppReady]);

  useEffect(() => {
    onRequestAppOpenReady?.(requestAppOpen);
    return () => onRequestAppOpenReady?.(null);
  }, [requestAppOpen, onRequestAppOpenReady]);

  useEffect(() => {
    onAppOpenPendingChange?.(appOpenPending);
  }, [appOpenPending, onAppOpenPendingChange]);

  useEffect(() => {
    onSendConstructionStateReady?.(sendConstructionState);
    return () => onSendConstructionStateReady?.(null);
  }, [sendConstructionState, onSendConstructionStateReady]);

  useEffect(() => {
    onConstructionSuggestionsChange?.(constructionSuggestions);
  }, [constructionSuggestions, onConstructionSuggestionsChange]);

  useEffect(() => {
    onConstructionMemoryChipsChange?.(constructionMemoryChips);
  }, [constructionMemoryChips, onConstructionMemoryChipsChange]);

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
        videos={activeApp.appData?.videos}
        playlists={activeApp.appData?.playlists}
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
        forwardGaze
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
  if (activeApp.appId === "space_trader") {
    return (
      <GameEmbed
        gameId="space-trader"
        src="/games/space-trader/"
        initParams={activeApp.appData?.params}
        onClose={dismissApp}
      />
    );
  }
  if (activeApp.appId === "musical_microbes") {
    return (
      <GameEmbed
        gameId="musical-microbes"
        src="/games/musical-microbes/"
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
  if (activeApp.appId === "goal_tree_game" && activeApp.appData?.game) {
    return (
      <GoalTreeQuestPlayer
        game={activeApp.appData.game}
        onClose={dismissApp}
        sendMessageToAi={sendMessageToAi}
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

export default function Home({ studentId, classroomId, onLogout, onExitStudent }: HomeProps) {
  // Disable periodic camera detection calls (detect-person, analyze-image) to focus on chat
  const DISABLE_PERIODIC_DETECTION = true;

  const [showChatLog, setShowChatLog] = useState(false);
  const [showProfileSetup, setShowProfileSetup] = useState(false);
  const [showDeviceManager, setShowDeviceManager] = useState(false);
  const [showConversation, setShowConversation] = useState(false);
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
  const { language: currentLanguage, setLanguage: setCurrentLanguage, t, direction, signLanguage } = useLanguage();
  const [useDualAgent, setUseDualAgent] = useState<boolean>(true); // Toggle for dual-agent system

  // Use the initialization context for loading state
  const { isComplete: isInitComplete } = useAppInitialization();
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

  // Recent button presses for Voice feature (silent mode)
  const [recentButtonPresses, setRecentButtonPresses] = useState<string[]>([]);


  // Context sidebar buttons (from AI's add_context_button tool)
  const [contextButtons, setContextButtons] = useState<Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string; buttonType?: string; glyph?: string; glyphFallback?: string }>>([]);

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

  // User-controlled mute state bridged from DualAgentContext
  const [_muteState, setMuteStateFromCtx] = useState<'unmuted' | 'muted'>('unmuted');
  const [aiSessionActive, setAiSessionActive] = useState(false);
  const [isGuessingMode, setIsGuessingMode] = useState(false);
  const [showConstructionBoard, setShowConstructionBoard] = useState(false);
  // Static apps page overlay — opened by the home "Apps" button (intercepted
  // client-side, not forwarded to the AI). Closes when the user picks an app
  // (which then triggers the existing launchApp flow) or hits Back/Home.
  const [showAppsBoard, setShowAppsBoard] = useState(false);
  // Notify the server when the sentence builder opens/closes so it can track
  // the conversation detour and inject a [RESUME] reminder afterward. Only fires
  // on an actual transition (skips the initial false on mount).
  const prevBuilderOpenRef = useRef(false);
  useEffect(() => {
    if (showConstructionBoard === prevBuilderOpenRef.current) return;
    prevBuilderOpenRef.current = showConstructionBoard;
    setBuilderVisibleRef.current?.(showConstructionBoard);
  }, [showConstructionBoard]);
  // Lifted from the DualAgentBridge — the construction board renders outside
  // the DualAgentProvider subtree, so it can't use the context directly.
  const sendConstructionStateRef = useRef<((state: import("@/hooks/dual-agent-types").ConstructionStateClient) => void) | null>(null);
  const [constructionSuggestionsState, setConstructionSuggestionsState] = useState<import("@/hooks/dual-agent-types").ConstructionSuggestionsClient | null>(null);
  const [constructionMemoryChipsState, setConstructionMemoryChipsState] = useState<Partial<Record<import("@/hooks/dual-agent-types").ConstructionStateClient["category"], import("@/hooks/dual-agent-types").ConstructionMemoryChipsClient>>>({});
  // Stable callback identity — otherwise an inline lambda re-creates on every
  // Home render (PCM audio, frame grids, etc.) and the child's state-push
  // effect spams the AI with construction-state turns, each one interrupting
  // the previous before it can respond.
  const stableSendConstructionState = useCallback(
    (state: import("@/hooks/dual-agent-types").ConstructionStateClient) => {
      sendConstructionStateRef.current?.(state);
    },
    []
  );

  // Active app state (bridged from DualAgentContext)
  const [activeApp, setActiveApp] = useState<import("@/hooks/dual-agent-types").ActiveAppData | null>(null);
  const dismissAppRef = useRef<() => void>(() => {});
  const registerAppCanvasCaptureRef = useRef<(fn: (() => Promise<Blob | null>) | null) => void>(() => {});
  // Apps available to launch from the static Apps board overlay, bridged from
  // DualAgentContext (the overlay renders outside the provider subtree).
  const [enabledApps, setEnabledApps] = useState<Array<{ id: string; name: string; icon: string; needsStartupResolution?: boolean }>>([]);
  const [availableCustomApps, setAvailableCustomApps] = useState<Array<{ id: string; name: string; imageUrl?: string | null; description?: string | null }>>([]);
  const launchAppFnRef = useRef<((appId: string, appData?: any) => void) | null>(null);
  // request_app_open round-trip (apps with server-resolved startup params),
  // bridged from DualAgentContext (the Apps overlay renders outside the provider).
  const requestAppOpenFnRef = useRef<((appId: string, appData?: any) => void) | null>(null);
  const [appOpenPending, setAppOpenPending] = useState<string | null>(null);
  // When a server-resolved app finishes opening (app_open arrives → activeApp
  // set), dismiss the Apps overlay + its loading state.
  useEffect(() => {
    if (activeApp) setShowAppsBoard(false);
  }, [activeApp]);

  // Binary-choice overlay state (bridged from DualAgentContext). Yes/no
  // questions are surfaced through this same overlay using the canonical
  // `yes` / `no` SYMBOLs — there's no separate yes/no overlay anymore.
  const [binaryChoiceOptions, setBinaryChoiceOptions] = useState<import("@/hooks/dual-agent-types").BinaryChoiceOption[] | null>(null);
  // Server-supplied escape-button kind ("maybe"/"neither") for the overlay.
  // Display layer doesn't decide — server tells it.
  const [binaryChoiceEscapeKind, setBinaryChoiceEscapeKind] = useState<"maybe" | "neither" | null>(null);
  // Experiment (glyphInputTranslation): glyph translation of the incoming
  // speech, rendered above the overlay buttons. Null when inactive.
  const [binaryChoiceInputGlyph, setBinaryChoiceInputGlyph] = useState<{ glyph: string; fallback?: string } | null>(null);
  const dismissBinaryChoiceRef = useRef<(() => void) | null>(null);

  // Caretaker alarm state (bridged from DualAgentContext). Set by the
  // Observer agent; the audible/visible effect lives in <AlarmOverlay>.
  const [alarmInfo, setAlarmInfo] = useState<{ level: "alert" | "emergency"; reason: string } | null>(null);
  // Debug-only locally-injected alarm (test buttons). Kept separate from
  // `alarmInfo` because the bridge effect continuously re-pushes the server's
  // (null) alarm into `alarmInfo`, which would otherwise wipe a test alarm
  // one render later.
  const [testAlarm, setTestAlarm] = useState<{ level: "alert" | "emergency"; reason: string } | null>(null);
  const cancelAlarmRef = useRef<(() => void) | null>(null);
  const voiceFnRef = useRef<((buttons: string[], sentences?: Record<string, string>) => Promise<void>) | null>(null);
  const playGlyphFnRef = useRef<((glyphString: string) => void) | null>(null);
  const sendBoardExitRef = useRef<((label: string, instruction: string) => void) | null>(null);
  const pressSuggestionRef = useRef<((suggestionKey: string) => void) | null>(null);
  const pressNarrowRef = useRef<((dimension: string, value: string, sourceText?: string) => void) | null>(null);
  const enterGuessingFromBuilderRef = useRef<((ctx: { targetSlot: number | null; partialGlyph: string; category: string }) => void) | null>(null);
  // Conversation-tier enterGuessing (no builder context). Bridged separately
  // from enterGuessingFromBuilder so callers don't have to construct a
  // builderContext.
  const enterGuessingRef = useRef<(() => void) | null>(null);
  // exitGuessing — single client-initiated cancel path used by every
  // word-finder surface (quick-button toggle, sentence-builder toggle,
  // any "back while guessing" press). Replaces the legacy [EXIT GUESSING]
  // board_exit kludge.
  const exitGuessingRef = useRef<((reason?: string) => void) | null>(null);
  const setBuilderVisibleRef = useRef<((open: boolean) => void) | null>(null);
  const sendMessageFnRef = useRef<((msg: string) => Promise<void>) | null>(null);
  const sendContextOnlyFnRef = useRef<((text: string) => void) | null>(null);

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
    captureUserFrame,
    userVideoEl,
    autoAssignCameras,
    globalError
  } = useMultiCamera({ autoStart: true });

  // Get shared camera stream from CameraProvider context
  const { stream: sharedCameraStream, startCamera: startSharedCamera } = useCamera();

  // Capture a user-camera frame WITHOUT spinning up a transient <video> element.
  // Prefers the single shared user-camera <video> (captureUserFrame); only falls
  // back to a device capture if the shared element isn't ready. Transient <video>
  // elements on the user MediaStream are an iOS freeze trigger — see useMultiCamera.tsx.
  const captureUserCameraFrame = useCallback(async (): Promise<Blob | null> => {
    const shared = await captureUserFrame();
    if (shared && shared.size > 0) return shared;
    const userCamera = getUserCamera();
    if (userCamera) {
      try {
        return await captureFrameFromCamera(userCamera.deviceId);
      } catch {
        return null;
      }
    }
    return null;
  }, [captureUserFrame, getUserCamera, captureFrameFromCamera]);

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

  // Shared-camera FALLBACK: only when multi-camera enrolled nothing. We must NOT
  // race the multi-camera acquisition — a premature start here would open a
  // SECOND getUserMedia on the front camera, which freezes the feed on iOS.
  // Wait for multi-cam to settle (no devices AND no user stream) before falling back.
  useEffect(() => {
    if (!(faceTrackingEnabled || handGestureEnabled)) return;
    if (sharedCameraStream || getUserCamera()?.stream || cameras.length > 0) return;
    const id = setTimeout(() => {
      if (!getUserCamera()?.stream && cameras.length === 0 && !sharedCameraStream) {
        console.log("[Tracking] No multi-camera stream after settle; starting shared-camera fallback");
        startSharedCamera();
      }
    }, 2500);
    return () => clearTimeout(id);
  }, [faceTrackingEnabled, handGestureEnabled, sharedCameraStream, getUserCamera, cameras, startSharedCamera]);

  // Face expression tracking via MediaPipe FaceLandmarker. Reads from the single
  // shared user-camera <video> element (userVideoEl) owned by MultiCameraProvider.
  const {
    isReady: faceTrackingReady,
    error: faceTrackingError,
    faces: rawFaces,
    fps: faceTrackingFps,
  } = useFaceTracking({
    videoEl: userVideoEl,
    enabled: faceTrackingEnabled,
  });

  // Unified eye gaze service — skip entirely for cursor control mode (mouse provider)
  const isCursorControlMode = eyegazeSettings.provider === "mouse";
  const eyeGaze = useEyeGaze({
    enabled: eyegazeSettings.enabled && !isCursorControlMode,
    rawFaces,
    preferredProvider: eyegazeSettings.provider,
  });

  // DLL-based hardware trackers (currently Tobii) need a sidecar process spawned
  // by the Electron main process. "auto" includes Tobii in its probe order, so we
  // start the sidecar for both. The sidecar reports if it can't find the DLL.
  const gazeSidecarDevice =
    eyegazeSettings.enabled && (eyegazeSettings.provider === "tobii" || eyegazeSettings.provider === "auto")
      ? "tobii"
      : null;
  const { status: gazeSidecarStatus, locateDll: locateGazeDll, openLog: openGazeLog } = useGazeSidecar({
    enabled: eyegazeSettings.enabled,
    device: gazeSidecarDevice,
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

  // Face image cache (in-memory, session-scoped — no server storage).
  // Populated only by live camera identification.
  const faceImageCache = useFaceImageCache();

  // Full selectable-people directory (all contacts/linked users/student),
  // with stored-photo URLs. Used by the sentence builder's person list and
  // as the stored-photo fallback when the camera hasn't seen someone.
  const peopleDirectory = usePeopleDirectory(studentId, useDualAgent);

  // Combined face resolver: prefer the live-camera capture (freshest, shows
  // the person as they look right now), then fall back to the contact's
  // stored photo. Used everywhere a `face:<id>` needs an image — main board,
  // app boards, and the sentence builder — so faces render consistently even
  // before the camera has identified someone this session.
  const resolveFaceImage = useCallback(
    (contactId: string): string | null =>
      faceImageCache.getFaceImage(contactId) ?? peopleDirectory.getPhotoUrl(contactId),
    [faceImageCache.getFaceImage, peopleDirectory.getPhotoUrl],
  );

  // Wire the resolver into glyph-images so any `face:<id>` slot inside a
  // glyph can render. Without this, glyphs fall back to the 👤 silhouette
  // emoji (still readable, but doesn't show the actual contact). Cleared on
  // unmount so a stale closure doesn't outlive this page mount.
  useEffect(() => {
    setFaceImageResolver(resolveFaceImage);
    return () => setFaceImageResolver(null);
  }, [resolveFaceImage]);

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
    videoEl: userVideoEl,
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

  // People identified as present at least once this session. The sentence
  // builder's person list surfaces these first so whoever is in the room is
  // easiest to pick.
  const [presentPersonIds, setPresentPersonIds] = useState<string[]>([]);
  useEffect(() => {
    const id = currentIdentification?.person?.id;
    if (!id) return;
    setPresentPersonIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [currentIdentification]);

  // Get serialized gesture/expression context for dual-agent AI
  const getGestureContext = useCallback(() => {
    return serializeGestureContext(trackedFaces, trackedHands);
  }, [trackedFaces, trackedHands]);

  // (Removed the separate sharedCameraStream <video>. The shared user-camera
  // element from MultiCameraProvider (userVideoEl) already binds to the
  // multi-cam user stream OR sharedCameraStream as a fallback, so face-api can
  // read pixels from it directly — one element, no iOS multi-element contention.)

  // Periodic face identification — runs across EVERY active camera (user + environment),
  // not just a single primary. Drops descriptors after each tick whichever the camera
  // count is. The user-facing camera additionally drives `currentIdentification` (which
  // feeds gesture/expression event tracking via useFaceEvents).
  useEffect(() => {
    if (!isPersonIdReady || !useDualAgent) return;

    const runIdentification = async () => {
      const tasks: Array<Promise<void>> = [];

      for (const camera of cameras) {
        if (!camera.isActive || !camera.stream) continue;
        const sourceKey = `multicam:${camera.deviceId}`;
        const cameraRole = camera.facing;
        const cameraLabel = camera.label;
        const updateCurrent = camera.facing === "user";

        // User camera: identify straight off the shared <video> element — no
        // transient <video> on the user stream (the iOS freeze trigger).
        if (camera.facing === "user" && userVideoEl && userVideoEl.readyState >= 2 && userVideoEl.videoWidth > 0) {
          tasks.push((async () => {
            try {
              await identifyFromVideo(userVideoEl, { sourceKey, cameraRole, cameraLabel, updateCurrent });
            } catch {
              /* identification is non-critical — silent fail */
            }
          })());
          continue;
        }

        if (!captureFrameFromCamera) continue;
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

      // Fall back to the shared element when no multi-cam entries are enrolled
      // (userVideoEl then binds to sharedCameraStream).
      if (cameras.length === 0 && userVideoEl && userVideoEl.readyState >= 2 && userVideoEl.videoWidth > 0) {
        tasks.push(
          (async () => {
            await identifyFromVideo(userVideoEl, {
              sourceKey: "shared",
              cameraRole: "user",
              cameraLabel: "shared camera",
              updateCurrent: true,
            });
          })(),
        );
      }

      if (tasks.length === 0) return;
      await Promise.all(tasks);
    };

    const interval = setInterval(runIdentification, 2000);
    runIdentification();
    return () => clearInterval(interval);
  }, [isPersonIdReady, useDualAgent, cameras, captureFrameFromCamera, userVideoEl, identifyFromImage, identifyFromVideo]);

  // Initialize gesture handling
  useGestures({
    onCornerTap: () => setShowChatLog(true),
    onSwipeRight: () => setShowConversation(!showConversation),
  });

  // System startup - initialization is now managed by AppInitializationContext
  useEffect(() => {
    console.log('Aivota System - Initializing...');
    // Language is now managed by LanguageContext (loaded from localStorage automatically)
    // Camera, Boards, and Conversation initialization is handled by their respective contexts
  }, []);


  // The AAC UI follows the *student's* primaryLanguage, not the logged-in
  // user's browser/localStorage preference. When the student profile loads,
  // adopt its language so e.g. a Hebrew student gets a Hebrew UI even when a
  // caregiver with an English browser opens the AAC client.
  useEffect(() => {
    const fromServer = userProfile?.primaryLanguage;
    if (!fromServer || typeof fromServer !== 'string') return;
    if (!isValidLanguageCode(fromServer)) return;
    if (fromServer === currentLanguage) return;
    setCurrentLanguage(fromServer);
  }, [userProfile?.primaryLanguage]);

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
                // User camera: read from the shared <video> (no transient element,
                // which freezes on iOS). Environment camera keeps device capture.
                const frame = camera.facing === "user"
                  ? await captureUserCameraFrame()
                  : await captureFrameFromCamera(camera.deviceId);
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
  }, [isStandbyMode, cameras, sharedCameraStream, globalError, captureFrameFromCamera, captureUserCameraFrame, userProfile, DISABLE_PERIODIC_DETECTION]);

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

    // Build the utterance and speak it using student voice
    const utterance = newSymbols.join(" ");
    setCurrentSpeech(utterance);
    const studentVoice = userProfile?.aacSettings?.studentVoiceType || 'boy';
    await speak(utterance, currentLanguage, studentVoice);

    // Clear symbols after speech
    setTimeout(() => {
      setSelectedSymbols([]);
      setCurrentSpeech("");
    }, 2000);
  };


  // Handle AAC board button click — send immediately to server
  const handleBoardButtonClick = useCallback((button: BoardButton, spokenText: string) => {
    console.debug("[guessing] board press:", button.label, "| buttonType:", (button as any).buttonType, "| suggestionKey:", (button as any).suggestionKey);

    // Word Finder entry button (set by AI via button_type: "wordfinder").
    // Treat the press as a mode-toggle: enter guessing without voicing the
    // button (it isn't an utterance) and without firing button_pressed (the
    // press is a meta action, not the user saying anything).
    if ((button as any).buttonType === "wordfinder") {
      console.debug("[guessing] board word-finder pressed → enterGuessing");
      enterGuessingRef.current?.();
      return;
    }

    // [MORE] equivalent — set by AI via button_type: "more". Same wire
    // protocol as the quick-actions [MORE] button (button_press with the
    // canonical "[MORE]" label); the server short-circuits in
    // handleButtonPress: no TTS, no Speaker user_turn, just kicks
    // BoardManager to refresh the surface.
    if ((button as any).buttonType === "more") {
      console.debug("[more] board more pressed → [MORE] press");
      if (voiceFnRef.current) {
        voiceFnRef.current(["[MORE]"]);
      }
      return;
    }

    // Guessing-mode SUGGESTION button — route to the narrowing assistant
    // (pressSuggestion) for state update AND voice through the SAME server
    // TTS path every other button uses (voiceFnRef → server student-voice
    // TTS via elevenlabs / Gemini). Falling back to client-side `speak()`
    // produced a noticeably different voice for these buttons compared to
    // regular SENTENCE BUTTONs, since the browser's built-in speech
    // synthesis doesn't go through the configured student-voice pipeline.
    if ((button as any).buttonType === "suggestion" && (button as any).suggestionKey) {
      console.debug("[guessing] → pressSuggestion, ref is:", typeof pressSuggestionRef.current);
      if (voiceFnRef.current) {
        voiceFnRef.current([spokenText], { [spokenText]: spokenText });
      } else {
        speak(spokenText, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
      }
      pressSuggestionRef.current?.((button as any).suggestionKey);
      return;
    }

    // Exit/exitBoard buttons: send directly as board_exit (no speech, no voicing)
    if (button.action?.type === "exit" || (button as any).exitBoard) {
      const instruction = button.action?.text || "";
      // Construction-board entry: open the overlay client-side; do NOT forward
      // to the AI. The construction board emits its own state injections.
      if (instruction.includes("[CONSTRUCTION BOARD]")) {
        console.log("[construction] home button intercept — opening overlay");
        setShowConstructionBoard(true);
        return;
      }
      // Apps page entry: open the static apps overlay client-side. The AI is
      // not involved in rendering this page; it only finds out which app the
      // user picked once they pick one (via a follow-up sendBoardExit call
      // from AppsBoard's onPick handler).
      if (instruction.includes("[APPS BOARD]")) {
        console.log("[apps] home button intercept — opening overlay");
        setShowAppsBoard(true);
        return;
      }
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

    // Track for Voice feature (keep last 10)
    setRecentButtonPresses(prev => [...prev.slice(-9), spokenText]);

    setCurrentSpeech(spokenText);
    setTimeout(() => setCurrentSpeech(""), 2000);

    const sentences = button.sentence ? { [spokenText]: button.sentence } : undefined;

    if (voiceFnRef.current) {
      voiceFnRef.current([spokenText], sentences);
      setRecentButtonPresses([]);
    } else {
      speak(spokenText, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
    }
  }, [speak, currentLanguage, userProfile?.aacSettings?.studentVoiceType]);

  // Handle Voice: synthesize recent button presses into speech
  const handleVoice = useCallback(() => {
    if (recentButtonPresses.length > 0 && voiceFnRef.current) {
      voiceFnRef.current(recentButtonPresses);
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
        const testFrame = await captureUserCameraFrame();
        
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
  }, [studentId, captureUserCameraFrame, cameras, sharedCameraStream, userProfile, DISABLE_PERIODIC_DETECTION]);

  // Real presence detection is handled in checkStatus above

  // Capture visual context periodically when conversation is active
  useEffect(() => {
    if (!showConversation || DISABLE_PERIODIC_DETECTION) return;

    const captureVisualContext = async () => {
      try {
        const frame = await captureUserCameraFrame();
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
  }, [showConversation, captureUserCameraFrame, DISABLE_PERIODIC_DETECTION]);

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

  // Experiment (glyphInputTranslation): when on, the header grows to show a
  // glyph translation of incoming speech, and the board area shrinks to fit.
  // Suppressed inside the Sentence Builder and when the header is hidden.
  const glyphStripActive =
    !!userProfile?.aacSettings?.glyphInputTranslation &&
    showConversation &&
    !showConstructionBoard;
  // Shared growth amount (rem) — used for both the <main> top padding and the
  // DynamicBoard font-size baseline so they stay in sync. Keep equal to the
  // strip height rendered in DualAgentConversationBox.
  const GLYPH_STRIP_REM = 5;

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
            {eyegazeNotification.name} {eyegazeNotification.type === "connected" ? t("eyegaze.connected") : t("eyegaze.notDetected")}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Eye-tracker sidecar status banner. Portaled to <body> and given a very
          high z-index so it sits ABOVE (and is not blurred by) the wake/pause
          overlay, whose transformed/filtered ancestor would otherwise contain
          this fixed element inside the blurred subtree. Shows whenever a DLL-
          based tracker is selected but not yet connected, surfacing the real
          status (driver not found, device error, connecting…) so the issue is
          diagnosable in the field. The sidecar's own messages are English. */}
      {createPortal(
        <AnimatePresence>
          {gazeSidecarStatus && gazeSidecarStatus.device && gazeSidecarStatus.sidecarCode !== "connected" && (
            <motion.div
              initial={{ y: -60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -60, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              style={{ zIndex: 2147483646 }}
              className="fixed top-2 left-1/2 -translate-x-1/2 max-w-[90vw] px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-sm font-medium bg-amber-500 text-white"
            >
              <EyeOff className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {gazeSidecarStatus.needsDll
                  ? t("eyegaze.driverNotFound")
                  : (gazeSidecarStatus.lastError || gazeSidecarStatus.sidecarMessage || "Connecting to eye tracker…")}
              </span>
              {gazeSidecarStatus.needsDll && (
                <button
                  type="button"
                  onClick={() => { void locateGazeDll(); }}
                  className="shrink-0 px-3 py-1 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                >
                  {t("eyegaze.locateDriver")}
                </button>
              )}
              {/* Debug affordance (English): open the sidecar log file. */}
              <button
                type="button"
                onClick={() => { void openGazeLog(); }}
                className="shrink-0 px-3 py-1 rounded-full bg-black/20 hover:bg-black/30 transition-colors"
              >
                Open log
              </button>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* Main 3-Section Board Layout */}
      <main
        className={`flex-1 flex flex-col relative ${
          showConversation ? 'pt-24' : 'pt-4'
        }`}
        style={glyphStripActive ? { paddingTop: `calc(6rem + ${GLYPH_STRIP_REM}rem)` } : undefined}
      >
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

        {/* Board Area — fills all remaining space. Plain `flex-row` because
            the document root has `dir="rtl"` for Hebrew/Arabic, and CSS already
            reverses the visual order for us. Forcing `flex-row-reverse` in RTL
            double-flips and lands the sidebar on the wrong side. */}
        <div className="flex-1 min-h-0 overflow-hidden relative flex flex-row"
          data-dwell-trap={activeApp ? true : undefined}
        >
          <BinaryChoiceOverlay
            options={binaryChoiceOptions}
            escapeKind={binaryChoiceEscapeKind}
            inputGlyph={binaryChoiceInputGlyph}
            onSelect={(option) => {
              dismissBinaryChoiceRef.current?.();
              setBinaryChoiceOptions(null);
              setBinaryChoiceEscapeKind(null);
              setBinaryChoiceInputGlyph(null);
              // Prefer the AI-supplied sentence; fall back to label.
              const spoken = (option.sentence?.trim() || option.label).trim();
              if (!spoken) return;
              if (voiceFnRef.current) {
                voiceFnRef.current([spoken], { [spoken]: spoken });
              } else {
                speak(spoken, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
              }
            }}
            onCancel={() => {
              dismissBinaryChoiceRef.current?.();
              setBinaryChoiceOptions(null);
              setBinaryChoiceEscapeKind(null);
              setBinaryChoiceInputGlyph(null);
            }}
            onDismiss={() => {
              dismissBinaryChoiceRef.current?.();
              setBinaryChoiceOptions(null);
              setBinaryChoiceEscapeKind(null);
              setBinaryChoiceInputGlyph(null);
            }}
          />

          <AlarmOverlay
            alarm={alarmInfo ?? testAlarm}
            onCancel={() => {
              cancelAlarmRef.current?.();
              setAlarmInfo(null);
              setTestAlarm(null);
            }}
          />

          {showAppsBoard && (
            // Static apps page — same dwell-trap pattern as the sentence
            // builder so gaze over empty areas doesn't fall through to buttons
            // behind. Picking an app launches it and tells the AI via the
            // same exit-instruction channel used by every home button.
            <div className="absolute inset-0 z-30 bg-white dark:bg-gray-900" data-dwell-trap>
              <AppsBoard
                enabledApps={enabledApps}
                availableCustomApps={availableCustomApps}
                onPick={(appId, displayName, appData) => {
                  // Ignore further taps while a startup-resolution round-trip
                  // is already in flight.
                  if (appOpenPending) return;
                  const needsResolution = enabledApps.find((a) => a.id === appId)?.needsStartupResolution;
                  if (needsResolution && requestAppOpenFnRef.current) {
                    // Defer to the server: it resolves startup params, then
                    // replies with app_open (which sets activeApp and closes
                    // this overlay via the effect above). Keep the overlay up
                    // with a loading state until then.
                    requestAppOpenFnRef.current(appId, appData);
                  } else {
                    launchAppFnRef.current?.(appId, appData);
                    setShowAppsBoard(false);
                  }
                  // Inform the AI which app the user opened. Uses the existing
                  // board-exit channel — the server treats this like any other
                  // home-button instruction.
                  sendBoardExitRef.current?.(
                    displayName,
                    `[APP OPENED] The user opened the ${displayName} app. Call rebuild_board() with context buttons relevant to this activity, or close_app() if the activity should end.`,
                  );
                }}
                onClose={() => setShowAppsBoard(false)}
              />
              {appOpenPending && (
                <div
                  className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-white/90 dark:bg-gray-900/90"
                  data-dwell-trap
                >
                  <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-blue-500" />
                  <p className="text-lg font-medium text-gray-700 dark:text-gray-200">{t("appsBoard.starting")}</p>
                </div>
              )}
            </div>
          )}

          {showConstructionBoard && (
            // data-dwell-trap confines eyegaze dwell selection to the sentence
            // builder while it's open — gaze over its empty areas resolves to
            // "nothing" instead of falling through to the board buttons behind.
            <div className="absolute inset-0 z-30 bg-white dark:bg-gray-900" data-dwell-trap>
              <SentenceConstructorBoard
                sendConstructionState={stableSendConstructionState}
                constructionSuggestions={constructionSuggestionsState}
                constructionMemoryChips={constructionMemoryChipsState}
                guessingActive={isGuessingMode}
                guessingBoard={boardData}
                onGuessingPress={(key) => pressSuggestionRef.current?.(key)}
                onGuessButtonPress={(button) => {
                  // A free-form AI guess button (no suggestion: key).
                  // Route through the normal board-button click — voices
                  // the SENTENCE and emits button_pressed to the server.
                  // Use the button's `speech` text (or sentence fallback)
                  // as the spoken-text argument.
                  const spoken = (button as any).speech || button.sentence || button.label;
                  handleBoardButtonClick(button, spoken);
                }}
                onNarrowPress={(dim, value, sourceText) => pressNarrowRef.current?.(dim, value, sourceText)}
                onEnterGuessing={(ctx) => enterGuessingFromBuilderRef.current?.(ctx)}
                onExitGuessing={() => {
                  // User picked a category tab / mode chip while guessing was
                  // active — single exit path now hits the server's
                  // `exit_guessing` handler directly (no board_exit kludge,
                  // no spurious "Back" button_pressed downstream).
                  exitGuessingRef.current?.("builder_category_chip");
                }}
                people={peopleDirectory.people}
                getFaceImage={resolveFaceImage}
                getPersonName={peopleDirectory.getName}
                presentPersonIds={presentPersonIds}
                onPlay={(glyphString) => {
                  // Hand the composed glyph to the AI. The relay sends it as
                  // a [GLYPH PRESS] turn; the AI calls interpret(sentence)
                  // with a natural-language reading, which streams the
                  // student-voice TTS and records the sentence as the
                  // student's turn. The AI then responds normally.
                  // Routed through playGlyphFnRef because the function lives
                  // on DualAgentContext, which DualAgentBridge consumes —
                  // not directly accessible from this Home component. Falls
                  // back to direct TTS only if the bridge hasn't wired up yet.
                  if (playGlyphFnRef.current) {
                    playGlyphFnRef.current(glyphString);
                  } else {
                    console.warn("[home] playGlyph unavailable, falling back to direct TTS");
                    speak(glyphString, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
                  }
                  setShowConstructionBoard(false);
                }}
                onClose={() => setShowConstructionBoard(false)}
              />
            </div>
          )}
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
                      imageKey: b.imageKey,
                      glyph: b.glyph,
                      glyphFallback: b.glyphFallback,
                      sentence: b.sentence,
                      buttonType: b.buttonType as BoardButton["buttonType"],
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
                getFaceImage={resolveFaceImage}
              />
            );
          })()}
          {/* App content — replaces board when an app is active.
              Exception: "social_trainer" runs in the header only and lets
              the board keep rendering underneath. */}
          {activeApp && activeApp.appId !== "social_trainer" ? (
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
                getFaceImage={resolveFaceImage}
                suppressLocalSpeech={aiSessionActive}
                extraHeaderOffset={glyphStripActive ? GLYPH_STRIP_REM : 0}
              />
            </div>
          ) : (
            <PrebuiltBoardSection
              studentId={studentId}
              onSpeakAction={(text) => {
                if (voiceFnRef.current) {
                  // Route through AI — voice the text and send as button press
                  voiceFnRef.current([text], { [text]: text });
                } else {
                  setSelectedSymbols([text]);
                }
              }}
              language={currentLanguage}
              voiceType={userProfile?.aacSettings?.studentVoiceType || 'boy'}
              suppressLocalSpeech={aiSessionActive}
              iconTextRatio={userProfile?.aacSettings?.iconTextRatio ?? 3}
              getFaceImage={resolveFaceImage}
              onBack={() => {
                // Handle back at root level - could show board selector
              }}
            />
          )}
        </div>

        {/* Bottom Row: Quick Actions */}
        <QuickActions
          onAction={(action, text) => {
            // While the sentence builder is open, the board/home/back end
            // button just dismisses it (returns to the board underneath)
            // rather than navigating. The Speak button already toggles it.
            if (showConstructionBoard && action === "home") {
              setShowConstructionBoard(false);
              return;
            }
            // Same dismiss-on-Home behavior for the static apps overlay.
            if (showAppsBoard && action === "home") {
              setShowAppsBoard(false);
              return;
            }
            if (action === "more") {
              // "More" = user can't find the right button. Ask AI to add
              // more options but NOT respond with speech.
              if (voiceFnRef.current) {
                voiceFnRef.current(["[MORE]"]);
              }
            } else if (action === "home") {
              // 3-tier Home button navigation
              if (isGuessingMode) {
                // Guessing mode: tell the server to exit guessing first so the
                // [EXIT GUESSING] tag flips the flag directly, then navigate
                // back to whatever page the user was on. Send the exit even
                // when there's no latestPage — otherwise the user gets stuck.
                sendBoardExitRef.current?.(
                  "Back",
                  "[EXIT GUESSING] The user cancelled word-finding by pressing Back. Continue the conversation naturally without finishing the word search.",
                );
                if (latestPage) {
                  setPrebuiltBoardData(null);
                  setBoardData(latestPage);
                  setCurrentTier("latest");
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
            } else if (action === "guess") {
              // "Find word" button. The same button toggles entry and exit
              // based on the current isGuessingMode flag (single source of
              // truth, server-driven via guessing_mode WS message). The
              // server's `clearGuessingState` / `applyGuessingState` IS
              // the authority; the client just calls the appropriate
              // bridged action.
              if (isGuessingMode) {
                console.debug("[guessing] quick-button toggle → exitGuessing");
                exitGuessingRef.current?.("quick_action_toggle");
              } else {
                console.debug("[guessing] quick-button toggle → enterGuessing");
                enterGuessingRef.current?.();
              }
            } else if (action === "no" && isGuessingMode) {
              // In guessing mode, "No" means "none of these" — reject the
              // current narrowing step AND voice the press as a normal
              // button. Voicing matters for two reasons:
              //   (1) Same student-voice TTS as every other button —
              //       without it, the press is silent on the client,
              //       which feels broken.
              //   (2) The AI sees [USER to YOU] לא in the conversational
              //       record, which is what nudges it to pivot when the
              //       narrowing state's history is already empty (state-
              //       only rejection becomes a no-op after enough
              //       rejections, leaving the AI with no signal that the
              //       user is still rejecting things).
              console.debug("[guessing] No → none of these");
              if (voiceFnRef.current) {
                voiceFnRef.current([text], { [text]: text });
              }
              pressSuggestionRef.current?.(GUESSING_REJECT);
            } else {
              // Yes/No — send as button press (server handles TTS if AI session active)
              if (voiceFnRef.current) {
                voiceFnRef.current([text], { [text]: text });
              } else {
                speak(text, currentLanguage, userProfile?.aacSettings?.studentVoiceType || 'boy');
              }
            }
          }}
          onBack={() => {
            // Back also dismisses the sentence builder when it's open. The
            // server's builder_close handler already exits builder-origin
            // guessing — but if guessing was launched from the conversation
            // tier, builder_close won't touch it, so we fire the explicit
            // exit_guessing here too.
            if (showConstructionBoard) {
              if (isGuessingMode) {
                exitGuessingRef.current?.("back_closes_builder");
              }
              setShowConstructionBoard(false);
              return;
            }
            // Same dismiss-on-Back behavior for the static apps overlay.
            if (showAppsBoard) {
              setShowAppsBoard(false);
              return;
            }
            // Top-level Back while in conversation-tier guessing: cancel it.
            if (isGuessingMode) {
              exitGuessingRef.current?.("back_button");
              return;
            }
            // Call the prebuilt board's back function
            const goBack = (window as any).__prebuiltBoardGoBack;
            if (goBack) {
              goBack();
            }
          }}
          boardMode={boardMode}
          // social_trainer takes over the header but doesn't render an app
          // overlay, so the "exit app" close button is misleading — the
          // return-to-menu button should stay. Other apps still get the
          // close button via the `hasActiveApp` flag.
          hasActiveApp={!!activeApp && activeApp.appId !== "social_trainer"}
          hasPrebuiltBoard={!!prebuiltBoardData}
          currentTier={currentTier}
          isGuessingMode={isGuessingMode}
          inSentenceBuilder={showConstructionBoard}
          onSpeak={() => setShowConstructionBoard((s) => !s)}
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
          captureFrame={captureUserCameraFrame}
          onBoardUpdate={handleBoardUpdate}
          currentBoard={boardData}
        />
      )}

      {/* Dual-Agent Conversation Box */}
      {studentId && useDualAgent && (
        <DualAgentProvider
          studentId={studentId}
          classroomId={classroomId}
          language={currentLanguage}
          pitchByTag={{
            ...(userProfile?.aacSettings?.aiVoicePitch ? { avatar: userProfile.aacSettings.aiVoicePitch } : {}),
            ...(userProfile?.aacSettings?.studentVoicePitch ? { utterance: userProfile.aacSettings.studentVoicePitch } : {}),
          }}
          captureFrame={captureUserCameraFrame}
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
          getFaceImage={resolveFaceImage}
        >
          <AvatarSpriteProvider>
          <SocialBotProvider>
          <DualAgentBridge
            onModeChange={setMuteStateFromCtx}
            onVoiceReady={(fn) => { voiceFnRef.current = fn; }}
            onPlayGlyphReady={(fn) => { playGlyphFnRef.current = fn; }}
            onBoardPatchChange={setBoardPatchData}
            onSymbolUpdateChange={setSymbolUpdateData}
            onAiButtonPressChange={setAiButtonPressData}
            onSendMessageReady={(fn) => { sendMessageFnRef.current = fn; }}
            onSendContextOnlyReady={(fn) => { sendContextOnlyFnRef.current = fn; }}
            onBoardExitReady={(fn) => { sendBoardExitRef.current = fn; }}
            onGuessingModeChange={setIsGuessingMode}
            onPressSuggestionReady={(fn) => { pressSuggestionRef.current = fn; }}
            onPressNarrowReady={(fn) => { pressNarrowRef.current = fn; }}
            onEnterGuessingFromBuilderReady={(fn) => { enterGuessingFromBuilderRef.current = fn; }}
            onEnterGuessingReady={(fn) => { enterGuessingRef.current = fn; }}
            onExitGuessingReady={(fn) => { exitGuessingRef.current = fn; }}
            onSetBuilderVisibleReady={(fn) => { setBuilderVisibleRef.current = fn; }}
            onContextButtonsChange={setContextButtons}
            onInitializedChange={setAiSessionActive}
            onBinaryChoiceChange={(options, escapeKind, inputGlyph, dismiss) => { setBinaryChoiceOptions(options); setBinaryChoiceEscapeKind(escapeKind); setBinaryChoiceInputGlyph(inputGlyph); dismissBinaryChoiceRef.current = dismiss; }}
            onAlarmChange={(alarm, cancel) => { setAlarmInfo(alarm); cancelAlarmRef.current = cancel; }}
            onPausedChange={(paused, setPausedFn) => { setIsPaused(paused); setPausedFnRef.current = setPausedFn; }}
            onActiveAppChange={(app, dismiss, registerCapture) => { setActiveApp(app); dismissAppRef.current = dismiss; registerAppCanvasCaptureRef.current = registerCapture; }}
            onEnabledAppsChange={setEnabledApps}
            onAvailableCustomAppsChange={setAvailableCustomApps}
            onLaunchAppReady={(fn) => { launchAppFnRef.current = fn; }}
            onRequestAppOpenReady={(fn) => { requestAppOpenFnRef.current = fn; }}
            onAppOpenPendingChange={setAppOpenPending}
            onSendConstructionStateReady={(fn) => { sendConstructionStateRef.current = fn; }}
            onConstructionSuggestionsChange={setConstructionSuggestionsState}
            onConstructionMemoryChipsChange={setConstructionMemoryChipsState}
          />
          <DualAgentConversationBox
            isVisible={showConversation}
            glyphStripActive={glyphStripActive}
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
            onVoice={handleVoice}
            onExitStudent={onExitStudent}
            onLogout={() => onLogout()}
            onManageDevices={() => setShowDeviceManager(true)}
            onFullScreen={handleFullScreen}
            debugMode={debugMode}
            showDebugPanel={showDebugPanel}
            onDebugPanelToggle={() => setShowDebugPanel(!showDebugPanel)}
            onTestAlarm={(level) =>
              setTestAlarm({
                level,
                reason: level === "emergency" ? "Test emergency alarm" : "Test alert",
              })
            }
            rawFaces={rawFaces}
            rawHands={rawHands}
            identification={currentIdentification}
          />
          <FullscreenAvatarOverlay />
          <DeviceManagerModal
            studentId={studentId}
            isOpen={showDeviceManager}
            onClose={() => setShowDeviceManager(false)}
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
          </SocialBotProvider>
          </AvatarSpriteProvider>
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

    </div>
    <DwellOverlay />
    <GazeCalibrationOverlay />
    </EyeTrackingDwellProvider>
    </CameraAttentivenessWrapper>
    </AccessibilityProvider>
  );
}

// src/contexts/FeaturePanelContext.tsx
// Updated to support chat popup mode, full-screen features, and URL-based navigation

import { FeatureType } from '@shared/schema';
import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';

// Chat display mode
export type ChatDisplayMode = 'expanded' | 'popup' | 'minimized';

// Mobile chat display mode
export type MobileChatMode = 'hidden' | 'full' | 'half';

// Panel configuration for each feature
export interface FeatureConfig {
  id: FeatureType;
  defaultSize: number;      // Default panel width percentage
  minSize: number;          // Minimum panel width percentage
  maxSize: number;          // Maximum panel width percentage
  hasBottomBar?: boolean;   // Whether to show a bottom bar below chat
  isFullScreen?: boolean;   // Whether the feature forces chat to popup mode
  isFullChat?: boolean;     // Whether chat takes full width when this feature is active
  path: string;             // URL path for this feature
}

// URL path to feature mapping
export const PATH_TO_FEATURE: Record<string, FeatureType> = {
  '/home': 'chat',
  '/interpret': 'interpret',
  '/boards': 'boards',
  '/custom-apps': 'customApps',
  '/docuslp': 'docuslp',
  '/overview': 'overview',
  '/students': 'students',
  '/student-info': 'studentInfo',
  '/contacts': 'contacts',
  '/progress': 'progress',
  '/institute': 'institute',
  '/settings': 'settings',
  '/aacsettings': 'aacsettings',
  '/symbols': 'symbols',
  '/calendar': 'calendar',
  '/locations': 'locations',
  '/userchat': 'userchat',
  '/deep-analysis': 'deepAnalysis',
  '/shares': 'shares',
  '/insurance-bridge': 'insuranceBridge',
};

// Feature to URL path mapping
export const FEATURE_TO_PATH: Record<FeatureType, string> = {
  chat: '/home',
  interpret: '/interpret',
  boards: '/boards',
  customApps: '/custom-apps',
  docuslp: '/docuslp',
  overview: '/overview',
  students: '/students',
  studentInfo: '/student-info',
  contacts: '/contacts',
  progress: '/progress',
  institute: '/institute',
  reports: '/reports',
  settings: '/settings',
  aacsettings: '/aacsettings',
  aac: '/aac',
  symbols: '/symbols',
  calendar: '/calendar',
  locations: '/locations',
  userchat: '/userchat',
  deepAnalysis: '/deep-analysis',
  shares: '/shares',
  insuranceBridge: '/insurance-bridge',
};

// Feature configurations
export const FEATURE_CONFIG: Record<FeatureType, FeatureConfig> = {
  chat: {
    id: 'chat',
    defaultSize: 0,
    minSize: 0,
    maxSize: 0,
    isFullScreen: false,
    isFullChat: true,
    path: '/home',
  },
  interpret: {
    id: 'interpret',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    hasBottomBar: false,
    isFullScreen: false,
    path: '/interpret',
  },
  boards: {
    id: 'boards',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    hasBottomBar: false,
    isFullScreen: false,
    path: '/boards',
  },
  customApps: {
    id: 'customApps',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    hasBottomBar: false,
    isFullScreen: false,
    path: '/custom-apps',
  },
  docuslp: {
    id: 'docuslp',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    hasBottomBar: false,
    isFullScreen: false,
    path: '/docuslp',
  },
  overview: {
    id: 'overview',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/overview',
  },
  // Full-screen features - these force chat into popup mode
  institute: {
    id: 'institute',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    isFullScreen: false,
    hasBottomBar: false,
    path: '/institute',
  },
  reports: {
    id: 'reports',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    isFullScreen: false,
    path: '/reports',
  },
  students: {
    id: 'students',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    isFullScreen: false,
    path: '/students',
  },
  studentInfo: {
    id: 'studentInfo',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
    path: '/student-info',
  },
  contacts: {
    id: 'contacts',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/contacts',
  },
  progress: {
    id: 'progress',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/progress',
  },
  settings: {
    id: 'settings',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
    path: '/settings',
  },
  aacsettings: {
    id: 'aacsettings',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    isFullScreen: false,
    path: '/aacsettings',
  },
  aac: {
    id: 'aac',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    isFullScreen: false,
    path: '/aac',
  },
  symbols: {
    id: 'symbols',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
    path: '/symbols',
  },
  calendar: {
    id: 'calendar',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/calendar',
  },
  locations: {
    id: 'locations',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/locations',
  },
  userchat: {
    id: 'userchat',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/userchat',
  },
  deepAnalysis: {
    id: 'deepAnalysis',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
    path: '/deep-analysis',
  },
  shares: {
    id: 'shares',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
    path: '/shares',
  },
  insuranceBridge: {
    id: 'insuranceBridge',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: false,
    path: '/insurance-bridge',
  },
};

// Helper function to get feature from URL path
export function getFeatureFromPath(path: string): FeatureType {
  // Handle paths with additional segments (e.g., /interpret/sessions/123)
  const basePath = '/' + (path.split('/')[1] || '');
  return PATH_TO_FEATURE[basePath] || PATH_TO_FEATURE[path] || 'chat';
}

// Panel state for each feature
interface PanelState {
  isOpen: boolean;
  size: number;
}

// Shared state that can be passed between features
interface SharedState {
  boardGeneratorData?: any;
  currentBoard?: any;
  selectedStudentId?: string;
  [key: string]: any;
}

// Metadata builder function type
type MetadataBuilder = () => Record<string, any> | undefined;

// Context type
interface FeaturePanelContextType {
  // Active feature
  activeFeature: FeatureType | null;
  setActiveFeature: (feature: FeatureType) => void;
  
  // Panel states
  panels: Record<FeatureType, PanelState>;
  togglePanel: (feature: FeatureType) => void;
  setPanelSize: (feature: FeatureType, size: number) => void;
  setPanelOpen: (feature: FeatureType, isOpen: boolean) => void;
  
  // Chat mode
  chatMode: ChatDisplayMode;
  setChatMode: (mode: ChatDisplayMode) => void;
  toggleChatMode: () => void;
  isFullScreenFeature: boolean;
  
  // Chat panel size (for resizable boundary)
  chatSize: number;
  setChatSize: (size: number) => void;
  
  // Feature config
  getFeatureConfig: (feature: FeatureType) => FeatureConfig;
  
  // Shared state
  sharedState: SharedState;
  setSharedState: (updates: Partial<SharedState>) => void;
  
  // Metadata builders for chat context
  registerMetadataBuilder: (feature: FeatureType, builder: MetadataBuilder) => void;
  unregisterMetadataBuilder: (feature: FeatureType) => void;
  getFeatureMetadata: (feature: FeatureType) => Record<string, any> | undefined;
  
  // Mobile chat mode
  mobileChatMode: MobileChatMode;
  setMobileChatMode: (mode: MobileChatMode) => void;

  // Animation
  transitionDuration: number;

  // Navigation helper
  navigateToFeature: (feature: FeatureType) => void;
}

const FeaturePanelContext = createContext<FeaturePanelContextType | null>(null);

// Provider component
export function FeaturePanelProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  
  // Initialize active feature from URL
  const [activeFeature, setActiveFeatureState] = useState<FeatureType | null>(() => {
    return getFeatureFromPath(location);
  });
  
  const [sharedState, setSharedStateInternal] = useState<SharedState>({});
  // Use a ref instead of state for metadata builders to avoid triggering re-renders
  // when builders are registered/unregistered. The builders are only accessed when
  // getFeatureMetadata is called, not on every render.
  const metadataBuildersRef = useRef<Partial<Record<FeatureType, MetadataBuilder>>>({});
  const [chatMode, setChatModeState] = useState<ChatDisplayMode>('expanded');
  const [chatSize, setChatSizeState] = useState<number>(50); // Default 50% width for chat
  const [mobileChatMode, setMobileChatMode] = useState<MobileChatMode>('hidden');
  
  // Track if we're currently syncing to prevent loops
  const isSyncingRef = useRef(false);
  
  // Initialize panel states
  const [panels, setPanels] = useState<Record<FeatureType, PanelState>>(() => {
    const initial: Record<FeatureType, PanelState> = {} as any;
    Object.keys(FEATURE_CONFIG).forEach((key) => {
      const feature = key as FeatureType;
      initial[feature] = {
        isOpen: false,
        size: FEATURE_CONFIG[feature].defaultSize,
      };
    });
    
    // Open the panel for the initial feature from URL
    const initialFeature = getFeatureFromPath(location);
    if (initialFeature && initialFeature !== 'chat') {
      initial[initialFeature] = {
        ...initial[initialFeature],
        isOpen: true,
      };
    }
    
    return initial;
  });

  const transitionDuration = 300;

  // Sync active feature with URL changes (browser back/forward)
  useEffect(() => {
    if (isSyncingRef.current) return;
    
    const featureFromUrl = getFeatureFromPath(location);
    if (featureFromUrl !== activeFeature) {
      isSyncingRef.current = true;
      setActiveFeatureState(featureFromUrl);
      
      // Open the panel for the new feature
      if (featureFromUrl !== 'chat') {
        setPanels(prev => ({
          ...prev,
          [featureFromUrl]: { ...prev[featureFromUrl], isOpen: true },
        }));
      }
      
      // Handle chat mode for full-screen features
      const config = FEATURE_CONFIG[featureFromUrl];
      if (config.isFullScreen) {
        setChatModeState(prev => prev === 'expanded' ? 'popup' : prev);
      } else if (config.isFullChat) {
        setChatModeState('expanded');
      }
      
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 0);
    }
  }, [location, activeFeature]);

  // Check if current feature is full-screen
  const isFullScreenFeature = useMemo(() => {
    if (!activeFeature) return false;
    return FEATURE_CONFIG[activeFeature]?.isFullScreen || false;
  }, [activeFeature]);

  const isFullChatFeature = useMemo(() => {
    if (!activeFeature) return false;
    return FEATURE_CONFIG[activeFeature]?.isFullChat || false;
  }, [activeFeature]);

  // Set chat mode with validation
  const setChatMode = useCallback((mode: ChatDisplayMode) => {
    // If in full-screen feature, only allow popup or minimized
    if (isFullScreenFeature && mode === 'expanded') {
      return;
    }
    setChatModeState(mode);
  }, [isFullScreenFeature]);

  // Toggle between expanded and popup modes
  const toggleChatMode = useCallback(() => {
    if (isFullScreenFeature) {
      // For full-screen features, toggle between popup and minimized
      setChatModeState(prev => prev === 'popup' ? 'minimized' : 'popup');
    } else {
      setChatModeState(prev => prev === 'expanded' ? 'popup' : 'expanded');
    }
  }, [isFullScreenFeature]);

  // Set chat size with bounds
  const setChatSize = useCallback((size: number) => {
    const clampedSize = Math.min(Math.max(size, 20), 80); // Min 20%, Max 80%
    setChatSizeState(clampedSize);
  }, []);

  // Navigate to a feature (updates both state and URL)
  const navigateToFeature = useCallback((feature: FeatureType) => {
    const path = FEATURE_TO_PATH[feature];
    if (path) {
      setLocation(path);
    }
  }, [setLocation]);

  // Set active feature (also updates URL)
  const setActiveFeature = useCallback((feature: FeatureType) => {
    if (isSyncingRef.current) return;
    
    isSyncingRef.current = true;
    setActiveFeatureState(feature);
    
    const config = FEATURE_CONFIG[feature];
    
    // Update URL to match the feature
    const targetPath = FEATURE_TO_PATH[feature];
    if (targetPath && location !== targetPath) {
      setLocation(targetPath);
    }
    
    // If switching to a full-screen feature, force chat to popup mode
    if (config.isFullScreen) {
      setChatModeState(prev => prev === 'expanded' ? 'popup' : prev);
    }

    if (config.isFullChat) {
      setChatModeState('expanded');
    }
    
    // For panel-based features, open the panel
    if (feature !== 'chat') {
      setPanels(prev => ({
        ...prev,
        [feature]: { ...prev[feature], isOpen: true },
      }));
    }
    
    setTimeout(() => {
      isSyncingRef.current = false;
    }, 0);
  }, [location, setLocation]);

  // When active feature changes, check if we need to adjust chat mode
  useEffect(() => {
    if (activeFeature) {
      const config = FEATURE_CONFIG[activeFeature];
      if (config.isFullScreen && chatMode === 'expanded') {
        setChatModeState('popup');
      }
    }
  }, [activeFeature, chatMode]);

  // Toggle panel
  const togglePanel = useCallback((feature: FeatureType) => {
    setPanels(prev => ({
      ...prev,
      [feature]: { ...prev[feature], isOpen: !prev[feature].isOpen },
    }));
  }, []);

  // Set panel size
  const setPanelSize = useCallback((feature: FeatureType, size: number) => {
    const config = FEATURE_CONFIG[feature];
    const clampedSize = Math.min(Math.max(size, config.minSize), config.maxSize);
    setPanels(prev => ({
      ...prev,
      [feature]: { ...prev[feature], size: clampedSize },
    }));
  }, []);

  // Set panel open state
  const setPanelOpen = useCallback((feature: FeatureType, isOpen: boolean) => {
    setPanels(prev => ({
      ...prev,
      [feature]: { ...prev[feature], isOpen },
    }));
  }, []);

  // Get feature config
  const getFeatureConfig = useCallback((feature: FeatureType) => {
    return FEATURE_CONFIG[feature];
  }, []);

  // Shared state
  const setSharedState = useCallback((updates: Partial<SharedState>) => {
    setSharedStateInternal(prev => ({ ...prev, ...updates }));
  }, []);

  // Metadata builders - use ref mutation (no state updates, no re-renders)
  const registerMetadataBuilder = useCallback((feature: FeatureType, builder: MetadataBuilder) => {
    metadataBuildersRef.current = { ...metadataBuildersRef.current, [feature]: builder };
  }, []);

  const unregisterMetadataBuilder = useCallback((feature: FeatureType) => {
    const next = { ...metadataBuildersRef.current };
    delete next[feature];
    metadataBuildersRef.current = next;
  }, []);

  const getFeatureMetadata = useCallback((feature: FeatureType) => {
    const builder = metadataBuildersRef.current[feature];
    return builder ? builder() : undefined;
  }, []);

  const contextValue = useMemo(() => ({
    activeFeature,
    setActiveFeature,
    panels,
    togglePanel,
    setPanelSize,
    setPanelOpen,
    chatMode,
    setChatMode,
    toggleChatMode,
    isFullScreenFeature,
    chatSize,
    setChatSize,
    getFeatureConfig,
    sharedState,
    setSharedState,
    registerMetadataBuilder,
    unregisterMetadataBuilder,
    getFeatureMetadata,
    mobileChatMode,
    setMobileChatMode,
    transitionDuration,
    navigateToFeature,
  }), [
    activeFeature,
    setActiveFeature,
    panels,
    togglePanel,
    setPanelSize,
    setPanelOpen,
    chatMode,
    setChatMode,
    toggleChatMode,
    isFullScreenFeature,
    chatSize,
    setChatSize,
    getFeatureConfig,
    sharedState,
    setSharedState,
    registerMetadataBuilder,
    unregisterMetadataBuilder,
    getFeatureMetadata,
    mobileChatMode,
    setMobileChatMode,
    navigateToFeature,
  ]);

  return (
    <FeaturePanelContext.Provider value={contextValue}>
      {children}
    </FeaturePanelContext.Provider>
  );
}

// Hook to use the feature panel context
export function useFeaturePanel() {
  const context = useContext(FeaturePanelContext);
  if (!context) {
    throw new Error('useFeaturePanel must be used within a FeaturePanelProvider');
  }
  return context;
}

// Hook to access shared state
export function useSharedState() {
  const { sharedState, setSharedState } = useFeaturePanel();
  return { sharedState, setSharedState };
}

// Hook for chat mode
export function useChatMode() {
  const { chatMode, setChatMode, toggleChatMode, isFullScreenFeature } = useFeaturePanel();
  return { chatMode, setChatMode, toggleChatMode, isFullScreenFeature };
}
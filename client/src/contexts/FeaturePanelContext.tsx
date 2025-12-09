// src/contexts/FeaturePanelContext.tsx
// Updated to support chat popup mode and full-screen features

import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode, useEffect } from 'react';

// Feature types including new student management features
export type FeatureType = 
  | 'chat' 
  | 'interpret' 
  | 'boards' 
  | 'docuslp'
  | 'overview'    // Student overview/dashboard
  | 'students'    // Student list
  | 'progress'    // Individual student progress
  | 'settings';   // Settings panel

// Chat display mode
export type ChatMode = 'expanded' | 'popup' | 'minimized';

// Panel configuration for each feature
export interface FeatureConfig {
  id: FeatureType;
  defaultSize: number;      // Default panel width percentage
  minSize: number;          // Minimum panel width percentage
  maxSize: number;          // Maximum panel width percentage
  hasBottomBar?: boolean;   // Whether to show a bottom bar below chat
  isFullScreen?: boolean;   // Whether the feature forces chat to popup mode
}

// Feature configurations
export const FEATURE_CONFIG: Record<FeatureType, FeatureConfig> = {
  chat: {
    id: 'chat',
    defaultSize: 0,
    minSize: 0,
    maxSize: 0,
    isFullScreen: false,
  },
  interpret: {
    id: 'interpret',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    hasBottomBar: false,
    isFullScreen: false,
  },
  boards: {
    id: 'boards',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    hasBottomBar: true,
    isFullScreen: false,
  },
  docuslp: {
    id: 'docuslp',
    defaultSize: 50,
    minSize: 30,
    maxSize: 70,
    hasBottomBar: false,
    isFullScreen: false,
  },
  overview: {
    id: 'overview',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
  },
  // Full-screen features - these force chat into popup mode
  students: {
    id: 'students',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: true,
  },
  progress: {
    id: 'progress',
    defaultSize: 100,
    minSize: 100,
    maxSize: 100,
    isFullScreen: true,
  },
  settings: {
    id: 'settings',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
  },
};

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
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
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
  
  // Animation
  transitionDuration: number;
}

const FeaturePanelContext = createContext<FeaturePanelContextType | null>(null);

// Provider component
export function FeaturePanelProvider({ children }: { children: ReactNode }) {
  const [activeFeature, setActiveFeatureState] = useState<FeatureType | null>('chat');
  const [sharedState, setSharedStateInternal] = useState<SharedState>({});
  const [metadataBuilders, setMetadataBuilders] = useState<Partial<Record<FeatureType, MetadataBuilder>>>({});
  const [chatMode, setChatModeState] = useState<ChatMode>('expanded');
  const [chatSize, setChatSizeState] = useState<number>(50); // Default 50% width for chat
  
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
    return initial;
  });

  const transitionDuration = 300;

  // Check if current feature is full-screen
  const isFullScreenFeature = useMemo(() => {
    if (!activeFeature) return false;
    return FEATURE_CONFIG[activeFeature]?.isFullScreen || false;
  }, [activeFeature]);

  // Set chat mode with validation
  const setChatMode = useCallback((mode: ChatMode) => {
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

  // Set active feature
  const setActiveFeature = useCallback((feature: FeatureType) => {
    setActiveFeatureState(feature);
    
    const config = FEATURE_CONFIG[feature];
    
    // If switching to a full-screen feature, force chat to popup mode
    if (config.isFullScreen) {
      setChatModeState(prev => prev === 'expanded' ? 'popup' : prev);
    }
    
    // For panel-based features, open the panel
    if (feature !== 'chat') {
      setPanels(prev => ({
        ...prev,
        [feature]: { ...prev[feature], isOpen: true },
      }));
    }
  }, []);

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

  // Metadata builders
  const registerMetadataBuilder = useCallback((feature: FeatureType, builder: MetadataBuilder) => {
    setMetadataBuilders(prev => ({ ...prev, [feature]: builder }));
  }, []);

  const unregisterMetadataBuilder = useCallback((feature: FeatureType) => {
    setMetadataBuilders(prev => {
      const next = { ...prev };
      delete next[feature];
      return next;
    });
  }, []);

  const getFeatureMetadata = useCallback((feature: FeatureType) => {
    const builder = metadataBuilders[feature];
    return builder ? builder() : undefined;
  }, [metadataBuilders]);

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
    transitionDuration,
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
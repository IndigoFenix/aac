// src/contexts/FeaturePanelContext.tsx
// Updated to support student management features

import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';

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

// Panel configuration for each feature
export interface FeatureConfig {
  id: FeatureType;
  defaultSize: number;      // Default panel width percentage
  minSize: number;          // Minimum panel width percentage
  maxSize: number;          // Maximum panel width percentage
  hasBottomBar?: boolean;   // Whether to show a bottom bar below chat
  isFullScreen?: boolean;   // Whether the feature takes the full screen
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
  // Student management features - all full screen
  overview: {
    id: 'overview',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
  },
  students: {
    id: 'students',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
  },
  progress: {
    id: 'progress',
    defaultSize: 60,
    minSize: 40,
    maxSize: 80,
    isFullScreen: false,
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

  // Set active feature
  const setActiveFeature = useCallback((feature: FeatureType) => {
    setActiveFeatureState(feature);
    
    // For panel-based features, open the panel
    const config = FEATURE_CONFIG[feature];
    if (!config.isFullScreen && feature !== 'chat') {
      setPanels(prev => ({
        ...prev,
        [feature]: { ...prev[feature], isOpen: true },
      }));
    }
  }, []);

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
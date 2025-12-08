// src/contexts/FeaturePanelContext.tsx
import React, { 
    createContext, 
    useContext, 
    useState, 
    useCallback, 
    ReactNode,
    useEffect,
    useRef
  } from 'react';
  import { useLocation, useNavigate } from 'react-router-dom';
  import { useLanguage } from './LanguageContext';
import { ChatMode } from '@shared/schema';
  
  // ============================================================================
  // TYPES
  // ============================================================================
  
  export type FeatureId = 'boards' | 'interpret' | 'docuslp' | 'chat';
  
  export type PanelPosition = 'start' | 'end' | 'top' | 'bottom';
  
  export interface FeaturePanel {
    id: FeatureId;
    component: React.ComponentType<FeaturePanelProps>;
    position: PanelPosition;
    defaultSize?: number;
    minSize?: number;
    maxSize?: number;
    resizable?: boolean;
  }
  
  export interface FeaturePanelProps {
    isOpen: boolean;
    onClose: () => void;
    position: PanelPosition;
  }
  
  export interface PanelState {
    isOpen: boolean;
    size: number;
    position: PanelPosition;
  }
  
  // Metadata builder function type - each feature can define its own
  export type MetadataBuilder = () => Record<string, any> | undefined;
  
  // Shared state that features can read/write
  export interface FeatureSharedState {
    // Board-related
    currentBoard?: any;
    boardGeneratorData?: any;
    selectedButton?: any;
    isEditMode?: boolean;
    
    // General
    pendingPrompt?: string;
    lastChatResponse?: any;
    
    // Custom feature data
    [key: string]: any;
  }
  
  interface FeaturePanelContextType {
    // Current feature
    activeFeature: ChatMode;
    setActiveFeature: (feature: FeatureId) => void;
    
    // Panel states
    panels: Record<FeatureId, PanelState | undefined>;
    openPanel: (feature: FeatureId) => void;
    closePanel: (feature: FeatureId) => void;
    togglePanel: (feature: FeatureId) => void;
    setPanelSize: (feature: FeatureId, size: number) => void;
    
    // Feature config helper
    getFeatureConfig: (feature: FeatureId) => FeatureConfig;
    
    // Shared state between features and chat
    sharedState: FeatureSharedState;
    setSharedState: (updates: Partial<FeatureSharedState>) => void;
    updateSharedState: <K extends keyof FeatureSharedState>(
      key: K, 
      value: FeatureSharedState[K]
    ) => void;
    
    // Metadata builders for chat requests
    registerMetadataBuilder: (feature: FeatureId, builder: MetadataBuilder) => void;
    unregisterMetadataBuilder: (feature: FeatureId) => void;
    getActiveFeatureMetadata: () => Record<string, any> | undefined;
    
    // Direction-aware positioning
    getPhysicalPosition: (logicalPosition: PanelPosition) => 'left' | 'right' | 'top' | 'bottom';
    
    // Animation states
    isTransitioning: boolean;
    transitionDuration: number;
  }
  
  // ============================================================================
  // FEATURE CONFIGURATION
  // ============================================================================
  
  export interface FeatureConfig {
    position: PanelPosition;
    defaultSize: number;
    minSize: number;
    maxSize: number;
    path: string;
    hasBottomBar?: boolean;
    hasTopBar?: boolean;
  }
  
  export const FEATURE_CONFIG: Record<FeatureId, FeatureConfig> = {
    boards: { 
      position: 'end', 
      defaultSize: 60,
      minSize: 40,
      maxSize: 80,
      path: '/boards',
      hasBottomBar: true,
    },
    interpret: { 
      position: 'end', 
      defaultSize: 45,
      minSize: 30,
      maxSize: 70,
      path: '/interpret',
      hasBottomBar: false,
    },
    docuslp: { 
      position: 'end', 
      defaultSize: 50,
      minSize: 30,
      maxSize: 70,
      path: '/docuslp',
      hasBottomBar: false,
    },
    chat: { 
      position: 'start', 
      defaultSize: 0,
      minSize: 0,
      maxSize: 0,
      path: '/',
    },
  };
  
  // ============================================================================
  // CONTEXT
  // ============================================================================
  
  const FeaturePanelContext = createContext<FeaturePanelContextType | null>(null);
  
  export const useFeaturePanel = () => {
    const context = useContext(FeaturePanelContext);
    if (!context) {
      throw new Error('useFeaturePanel must be used within a FeaturePanelProvider');
    }
    return context;
  };
  
  // Convenience hook for accessing shared state
  export const useSharedState = () => {
    const { sharedState, setSharedState, updateSharedState } = useFeaturePanel();
    return { sharedState, setSharedState, updateSharedState };
  };
  
  // ============================================================================
  // PROVIDER
  // ============================================================================
  
  interface FeaturePanelProviderProps {
    children: ReactNode;
    transitionDuration?: number;
  }
  
  export const FeaturePanelProvider = ({ 
    children,
    transitionDuration = 300
  }: FeaturePanelProviderProps) => {
    const { isRTL } = useLanguage();
    const location = useLocation();
    const navigate = useNavigate();
    
    // State
    const [activeFeature, setActiveFeatureState] = useState<FeatureId>('chat');
    const [panels, setPanels] = useState<Record<FeatureId, PanelState | undefined>>({
      boards: undefined,
      interpret: undefined,
      docuslp: undefined,
      chat: undefined,
    });
    const [sharedState, setSharedStateInternal] = useState<FeatureSharedState>({});
    const [isTransitioning, setIsTransitioning] = useState(false);
    
    // Metadata builders registry
    const metadataBuilders = useRef<Map<FeatureId, MetadataBuilder>>(new Map());
    
    // Refs for tracking
    const previousFeature = useRef<FeatureId>('chat');
  
    // ============================================================================
    // ROUTE SYNCHRONIZATION
    // ============================================================================
  
    const getFeatureFromPath = useCallback((): FeatureId => {
      const path = location.pathname;
      
      if (path.startsWith('/boards')) return 'boards';
      if (path.startsWith('/interpret')) return 'interpret';
      if (path.startsWith('/docuslp')) return 'docuslp';
      return 'chat';
    }, [location.pathname]);
  
    useEffect(() => {
      const featureFromPath = getFeatureFromPath();
      
      if (featureFromPath !== activeFeature) {
        previousFeature.current = activeFeature;
        setIsTransitioning(true);
        
        if (activeFeature) {
          setPanels(prev => ({
            ...prev,
            [activeFeature]: prev[activeFeature] 
              ? { ...prev[activeFeature]!, isOpen: false }
              : undefined
          }));
        }
        
        setTimeout(() => {
          setActiveFeatureState(featureFromPath);
          
          if (featureFromPath && featureFromPath !== 'chat') {
            const config = FEATURE_CONFIG[featureFromPath];
            setPanels(prev => ({
              ...prev,
              [featureFromPath]: {
                isOpen: true,
                size: prev[featureFromPath]?.size || config.defaultSize,
                position: config.position
              }
            }));
          }
          
          setIsTransitioning(false);
        }, transitionDuration);
      }
    }, [location.pathname, getFeatureFromPath, activeFeature, transitionDuration]);
  
    // ============================================================================
    // FEATURE NAVIGATION
    // ============================================================================
  
    const setActiveFeature = useCallback((feature: FeatureId) => {
      const config = FEATURE_CONFIG[feature];
      if (!config) {
        console.error(`Feature config not found for feature: ${feature}`);
      } else {
        navigate(config.path);
      }
    }, [navigate]);
  
    // ============================================================================
    // PANEL MANAGEMENT
    // ============================================================================
  
    const openPanel = useCallback((feature: FeatureId) => {
      if (!feature || feature === 'chat') return;
      
      const config = FEATURE_CONFIG[feature];
      setPanels(prev => ({
        ...prev,
        [feature]: {
          isOpen: true,
          size: prev[feature]?.size || config.defaultSize,
          position: config.position
        }
      }));
    }, []);
  
    const closePanel = useCallback((feature: FeatureId) => {
      if (!feature) return;
      
      setPanels(prev => ({
        ...prev,
        [feature]: prev[feature] 
          ? { ...prev[feature]!, isOpen: false }
          : undefined
      }));
    }, []);
  
    const togglePanel = useCallback((feature: FeatureId) => {
      if (!feature) return;
      
      const panel = panels[feature];
      if (panel?.isOpen) {
        closePanel(feature);
      } else {
        openPanel(feature);
      }
    }, [panels, openPanel, closePanel]);
  
    const setPanelSize = useCallback((feature: FeatureId, size: number) => {
      if (!feature) return;
      
      setPanels(prev => ({
        ...prev,
        [feature]: prev[feature]
          ? { ...prev[feature]!, size }
          : { isOpen: false, size, position: FEATURE_CONFIG[feature].position }
      }));
    }, []);
  
    // ============================================================================
    // SHARED STATE MANAGEMENT
    // ============================================================================
  
    const setSharedState = useCallback((updates: Partial<FeatureSharedState>) => {
      setSharedStateInternal(prev => ({ ...prev, ...updates }));
    }, []);
  
    const updateSharedState = useCallback(<K extends keyof FeatureSharedState>(
      key: K,
      value: FeatureSharedState[K]
    ) => {
      setSharedStateInternal(prev => ({ ...prev, [key]: value }));
    }, []);
  
    // ============================================================================
    // METADATA BUILDERS
    // ============================================================================
  
    const registerMetadataBuilder = useCallback((feature: FeatureId, builder: MetadataBuilder) => {
      metadataBuilders.current.set(feature, builder);
    }, []);
  
    const unregisterMetadataBuilder = useCallback((feature: FeatureId) => {
      metadataBuilders.current.delete(feature);
    }, []);
  
    const getActiveFeatureMetadata = useCallback((): Record<string, any> | undefined => {
      const builder = metadataBuilders.current.get(activeFeature);
      if (builder) {
        return builder();
      }
      return undefined;
    }, [activeFeature]);
  
    // ============================================================================
    // DIRECTION-AWARE POSITIONING
    // ============================================================================
  
    const getPhysicalPosition = useCallback((logicalPosition: PanelPosition): 'left' | 'right' | 'top' | 'bottom' => {
      switch (logicalPosition) {
        case 'start':
          return isRTL ? 'right' : 'left';
        case 'end':
          return isRTL ? 'left' : 'right';
        case 'top':
          return 'top';
        case 'bottom':
          return 'bottom';
        default:
          return 'right';
      }
    }, [isRTL]);
  
    // ============================================================================
    // FEATURE CONFIG HELPER
    // ============================================================================
  
    const getFeatureConfig = useCallback((feature: FeatureId): FeatureConfig => {
      return FEATURE_CONFIG[feature];
    }, []);
  
    // ============================================================================
    // CONTEXT VALUE
    // ============================================================================
  
    const contextValue: FeaturePanelContextType = {
      activeFeature,
      setActiveFeature,
      panels,
      openPanel,
      closePanel,
      togglePanel,
      setPanelSize,
      getFeatureConfig,
      sharedState,
      setSharedState,
      updateSharedState,
      registerMetadataBuilder,
      unregisterMetadataBuilder,
      getActiveFeatureMetadata,
      getPhysicalPosition,
      isTransitioning,
      transitionDuration,
    };
  
    return (
      <FeaturePanelContext.Provider value={contextValue}>
        {children}
      </FeaturePanelContext.Provider>
    );
  };
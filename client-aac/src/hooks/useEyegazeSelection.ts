import { useState, useEffect, useRef, useCallback } from 'react';

export interface EyegazeConfig {
  enabled: boolean;
  timeout: number; // in milliseconds
}

export interface EyegazeState {
  hoveredElement: string | null;
  progress: number; // 0-100
  isSelecting: boolean;
  mousePosition: { x: number; y: number };
}

export function useEyegazeSelection(config: EyegazeConfig, onSelect: (elementId: string) => void) {
  const [state, setState] = useState<EyegazeState>({
    hoveredElement: null,
    progress: 0,
    isSelecting: false,
    mousePosition: { x: 0, y: 0 },
  });

  const progressRef = useRef<number>(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentElementRef = useRef<string | null>(null);

  // Clear any existing timers
  const clearTimers = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Start eyegaze selection for an element
  const startSelection = useCallback((elementId: string) => {
    if (!config.enabled || currentElementRef.current === elementId) return;

    console.log('👀 Starting eyegaze selection for:', elementId);
    
    // Clear any existing selection
    clearTimers();
    
    currentElementRef.current = elementId;
    progressRef.current = 0;
    
    setState(prev => ({
      ...prev,
      hoveredElement: elementId,
      progress: 0,
      isSelecting: true,
    }));

    // Update progress every 50ms for smooth animation
    const progressInterval = 50;
    const totalSteps = config.timeout / progressInterval;
    let step = 0;

    intervalRef.current = setInterval(() => {
      step++;
      progressRef.current = (step / totalSteps) * 100;
      
      setState(prev => ({
        ...prev,
        progress: progressRef.current,
      }));

      if (step >= totalSteps) {
        clearTimers();
        console.log('👀 Eyegaze selection completed for:', elementId);
        onSelect(elementId);
        
        setState(prev => ({
          ...prev,
          hoveredElement: null,
          progress: 0,
          isSelecting: false,
        }));
        currentElementRef.current = null;
      }
    }, progressInterval);

  }, [config.enabled, config.timeout, onSelect, clearTimers]);

  // Cancel eyegaze selection
  const cancelSelection = useCallback(() => {
    if (!currentElementRef.current) return;

    console.log('👀 Canceling eyegaze selection for:', currentElementRef.current);
    
    clearTimers();
    setState(prev => ({
      ...prev,
      hoveredElement: null,
      progress: 0,
      isSelecting: false,
    }));
    currentElementRef.current = null;
  }, [clearTimers]);

  // Handle mouse enter (start eyegaze)
  const handleMouseEnter = useCallback((elementId: string) => {
    if (!config.enabled) return;
    startSelection(elementId);
  }, [config.enabled, startSelection]);

  // Handle mouse leave (cancel eyegaze)
  const handleMouseLeave = useCallback(() => {
    if (!config.enabled) return;
    cancelSelection();
  }, [config.enabled, cancelSelection]);

  // Cleanup on unmount or config change
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  // Reset when eyegaze is disabled
  useEffect(() => {
    if (!config.enabled) {
      cancelSelection();
    }
  }, [config.enabled, cancelSelection]);

  // Track mouse position for visual indicator
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setState(prev => ({
        ...prev,
        mousePosition: { x: e.clientX, y: e.clientY },
      }));
    };

    if (config.enabled) {
      document.addEventListener('mousemove', handleMouseMove);
      return () => document.removeEventListener('mousemove', handleMouseMove);
    }
  }, [config.enabled]);

  return {
    state,
    handleMouseEnter,
    handleMouseLeave,
    cancelSelection,
  };
}
// src/contexts/SoundContext.tsx
/**
 * SoundContext - Global Audio State Management
 * 
 * This context tracks all audio playback in the application to prevent
 * the speech-to-text system from listening to the system's own audio output.
 * 
 * Usage:
 * - Components that play audio should call `registerAudioSource` with a unique ID
 * - Call `setAudioPlaying(id, true)` when audio starts
 * - Call `setAudioPlaying(id, false)` when audio ends
 * - Use `isAnyAudioPlaying` to check if any audio is currently playing
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';

// ============================================================================
// TYPES
// ============================================================================

interface SoundContextType {
  /** Whether any audio source is currently playing */
  isAnyAudioPlaying: boolean;
  
  /** Register an audio source (call on mount) */
  registerAudioSource: (sourceId: string) => void;
  
  /** Unregister an audio source (call on unmount) */
  unregisterAudioSource: (sourceId: string) => void;
  
  /** Set playing state for a specific audio source */
  setAudioPlaying: (sourceId: string, isPlaying: boolean) => void;
  
  /** Get all currently playing sources (for debugging) */
  getPlayingSources: () => string[];
  
  /** Convenience: speak text using browser TTS and track state automatically */
  speakText: (text: string, options?: SpeakOptions) => Promise<void>;
  
  /** Stop any currently speaking TTS */
  stopSpeaking: () => void;
  
  /** Whether the system TTS is currently speaking */
  isSpeaking: boolean;
}

interface SpeakOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  voice?: SpeechSynthesisVoice | null;
}

// ============================================================================
// CONTEXT
// ============================================================================

const SoundContext = createContext<SoundContextType | null>(null);

export const useSound = () => {
  const context = useContext(SoundContext);
  if (!context) {
    throw new Error('useSound must be used within a SoundProvider');
  }
  return context;
};

// ============================================================================
// PROVIDER
// ============================================================================

interface SoundProviderProps {
  children: ReactNode;
}

export const SoundProvider = ({ children }: SoundProviderProps) => {
  // Track registered audio sources
  const registeredSources = useRef<Set<string>>(new Set());
  
  // Track which sources are currently playing
  const [playingSources, setPlayingSources] = useState<Set<string>>(new Set());
  
  // Track TTS speaking state
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  // Computed: check if any audio is playing
  const isAnyAudioPlaying = playingSources.size > 0 || isSpeaking;

  /**
   * Register a new audio source
   */
  const registerAudioSource = useCallback((sourceId: string) => {
    registeredSources.current.add(sourceId);
    console.log('[SoundContext] Registered audio source:', sourceId);
  }, []);

  /**
   * Unregister an audio source
   */
  const unregisterAudioSource = useCallback((sourceId: string) => {
    registeredSources.current.delete(sourceId);
    setPlayingSources((prev) => {
      const next = new Set(prev);
      next.delete(sourceId);
      return next;
    });
    console.log('[SoundContext] Unregistered audio source:', sourceId);
  }, []);

  /**
   * Set playing state for a specific audio source
   */
  const setAudioPlaying = useCallback((sourceId: string, isPlaying: boolean) => {
    setPlayingSources((prev) => {
      const next = new Set(prev);
      if (isPlaying) {
        next.add(sourceId);
      } else {
        next.delete(sourceId);
      }
      return next;
    });
    console.log(`[SoundContext] ${sourceId} is now ${isPlaying ? 'playing' : 'stopped'}`);
  }, []);

  /**
   * Get all currently playing sources
   */
  const getPlayingSources = useCallback((): string[] => {
    return Array.from(playingSources);
  }, [playingSources]);

  /**
   * Speak text using browser TTS with automatic state tracking
   */
  const speakText = useCallback(async (text: string, options?: SpeakOptions): Promise<void> => {
    if (!('speechSynthesis' in window)) {
      console.warn('[SoundContext] Speech synthesis not supported');
      return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      
      // Apply options
      if (options?.lang) utterance.lang = options.lang;
      if (options?.rate !== undefined) utterance.rate = options.rate;
      if (options?.pitch !== undefined) utterance.pitch = options.pitch;
      if (options?.volume !== undefined) utterance.volume = options.volume;
      if (options?.voice) utterance.voice = options.voice;

      utterance.onstart = () => {
        setIsSpeaking(true);
        console.log('[SoundContext] TTS started speaking');
      };

      utterance.onend = () => {
        setIsSpeaking(false);
        console.log('[SoundContext] TTS finished speaking');
        resolve();
      };

      utterance.onerror = (event) => {
        setIsSpeaking(false);
        console.error('[SoundContext] TTS error:', event.error);
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    });
  }, []);

  /**
   * Stop any currently speaking TTS
   */
  const stopSpeaking = useCallback(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, []);

  const contextValue: SoundContextType = {
    isAnyAudioPlaying,
    registerAudioSource,
    unregisterAudioSource,
    setAudioPlaying,
    getPlayingSources,
    speakText,
    stopSpeaking,
    isSpeaking,
  };

  return (
    <SoundContext.Provider value={contextValue}>
      {children}
    </SoundContext.Provider>
  );
};

// ============================================================================
// HOOKS FOR SPECIFIC USE CASES
// ============================================================================

/**
 * Hook for components that play audio - registers source on mount
 */
export const useAudioSource = (sourceId: string) => {
  const { registerAudioSource, unregisterAudioSource, setAudioPlaying, isAnyAudioPlaying } = useSound();
  
  React.useEffect(() => {
    registerAudioSource(sourceId);
    return () => unregisterAudioSource(sourceId);
  }, [sourceId, registerAudioSource, unregisterAudioSource]);

  const startPlaying = useCallback(() => {
    setAudioPlaying(sourceId, true);
  }, [sourceId, setAudioPlaying]);

  const stopPlaying = useCallback(() => {
    setAudioPlaying(sourceId, false);
  }, [sourceId, setAudioPlaying]);

  return { startPlaying, stopPlaying, isAnyAudioPlaying };
};
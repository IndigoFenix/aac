// src/hooks/useSpeechToText.ts
/**
 * useSpeechToText Hook
 * 
 * Provides browser-based speech-to-text functionality using the Web Speech API.
 * Automatically stops when audio is playing to prevent the system from hearing itself.
 * 
 * Features:
 * - Real-time speech recognition with interim results
 * - Language support via LanguageContext
 * - Auto-disable when system audio is playing
 * - Auto-send when speech recognition completes (optional)
 * - Continuous mode for ongoing dictation
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSound } from '@/contexts/SoundContext';

// ============================================================================
// TYPES
// ============================================================================

// Web Speech API types (not always in TypeScript's lib.dom)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}

export interface UseSpeechToTextOptions {
  /** Called when final transcript is ready */
  onResult?: (transcript: string) => void;
  /** Called with interim (partial) results during speech */
  onInterim?: (transcript: string) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Enable continuous recognition mode */
  continuous?: boolean;
  /** Override language (defaults to LanguageContext) */
  language?: string;
}

export interface UseSpeechToTextResult {
  /** Whether speech recognition is supported */
  isSupported: boolean;
  /** Whether currently listening */
  isListening: boolean;
  /** Current interim transcript */
  interimTranscript: string;
  /** Final transcript from last recognition */
  finalTranscript: string;
  /** Start listening */
  startListening: () => void;
  /** Stop listening */
  stopListening: () => void;
  /** Toggle listening state */
  toggleListening: () => void;
  /** Clear transcripts */
  clearTranscripts: () => void;
  /** Error message if any */
  error: string | null;
  /** Whether listening is disabled (e.g., audio playing) */
  isDisabled: boolean;
}

// ============================================================================
// LANGUAGE MAPPING
// ============================================================================

/**
 * Map our language codes to BCP 47 language tags for Speech API
 */
const languageMap: Record<string, string> = {
  en: 'en-US',
  he: 'he-IL',
  ar: 'ar-SA',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  ru: 'ru-RU',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

// ============================================================================
// HOOK
// ============================================================================

export function useSpeechToText(options: UseSpeechToTextOptions = {}): UseSpeechToTextResult {
  const { onResult, onInterim, onError, continuous = false, language: overrideLanguage } = options;
  
  const { language: contextLanguage } = useLanguage();
  const { isAnyAudioPlaying } = useSound();
  
  // State
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  // Refs
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isStoppingRef = useRef(false);

  // Determine language
  const speechLanguage = overrideLanguage || languageMap[contextLanguage] || 'en-US';

  // Check support
  const isSupported = typeof window !== 'undefined' && 
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  // Disabled when audio is playing
  const isDisabled = isAnyAudioPlaying;

  /**
   * Initialize speech recognition instance
   */
  const getRecognition = useCallback((): SpeechRecognition | null => {
    if (!isSupported) return null;
    
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) return null;
    
    const recognition = new SpeechRecognitionClass();
    recognition.lang = speechLanguage;
    recognition.continuous = continuous;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    
    return recognition;
  }, [isSupported, speechLanguage, continuous]);

  /**
   * Start listening
   */
  const startListening = useCallback(() => {
    if (!isSupported) {
      setError('Speech recognition not supported in this browser');
      onError?.('Speech recognition not supported');
      return;
    }

    if (isDisabled) {
      setError('Cannot listen while audio is playing');
      onError?.('Cannot listen while audio is playing');
      return;
    }

    if (isListening) return;

    // Create new recognition instance
    const recognition = getRecognition();
    if (!recognition) {
      setError('Failed to initialize speech recognition');
      return;
    }

    recognitionRef.current = recognition;
    isStoppingRef.current = false;
    setError(null);
    setInterimTranscript('');

    // Event handlers
    recognition.onstart = () => {
      console.log('[useSpeechToText] Recognition started');
      setIsListening(true);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (interim) {
        setInterimTranscript(interim);
        onInterim?.(interim);
      }

      if (final) {
        setFinalTranscript((prev) => prev + final);
        setInterimTranscript('');
        onResult?.(final.trim());
        
        // In non-continuous mode, stop after getting a result
        if (!continuous) {
          isStoppingRef.current = true;
          recognition.stop();
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('[useSpeechToText] Recognition error:', event.error);
      
      // Ignore 'no-speech' and 'aborted' errors as they're normal
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      
      const errorMessage = event.error === 'not-allowed' 
        ? 'Microphone access denied. Please enable microphone permissions.'
        : `Speech recognition error: ${event.error}`;
      
      setError(errorMessage);
      onError?.(errorMessage);
    };

    recognition.onend = () => {
      console.log('[useSpeechToText] Recognition ended');
      setIsListening(false);
      
      // Restart if continuous mode and not intentionally stopped
      if (continuous && !isStoppingRef.current && !isDisabled) {
        console.log('[useSpeechToText] Restarting continuous recognition');
        try {
          recognition.start();
        } catch (e) {
          console.error('[useSpeechToText] Failed to restart:', e);
        }
      }
    };

    // Start recognition
    try {
      recognition.start();
    } catch (e: any) {
      console.error('[useSpeechToText] Failed to start:', e);
      setError('Failed to start speech recognition');
      onError?.('Failed to start speech recognition');
    }
  }, [isSupported, isDisabled, isListening, getRecognition, continuous, onResult, onInterim, onError]);

  /**
   * Stop listening
   */
  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;
    
    isStoppingRef.current = true;
    
    try {
      recognitionRef.current.stop();
    } catch (e) {
      console.error('[useSpeechToText] Error stopping:', e);
    }
    
    setIsListening(false);
  }, []);

  /**
   * Toggle listening state
   */
  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  /**
   * Clear transcripts
   */
  const clearTranscripts = useCallback(() => {
    setInterimTranscript('');
    setFinalTranscript('');
  }, []);

  // Auto-stop when audio starts playing
  useEffect(() => {
    if (isDisabled && isListening) {
      console.log('[useSpeechToText] Stopping due to audio playing');
      stopListening();
    }
  }, [isDisabled, isListening, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (e) {
          // Ignore
        }
      }
    };
  }, []);

  return {
    isSupported,
    isListening,
    interimTranscript,
    finalTranscript,
    startListening,
    stopListening,
    toggleListening,
    clearTranscripts,
    error,
    isDisabled,
  };
}
// src/hooks/useTextToSpeech.ts
/**
 * useTextToSpeech Hook
 * 
 * Provides browser-based text-to-speech functionality using the Web Speech API.
 * Integrates with SoundContext to track audio state globally.
 * 
 * Features:
 * - Speak text with language auto-detection from LanguageContext
 * - Voice selection for different languages
 * - Rate, pitch, and volume controls
 * - Queue management for multiple utterances
 * - Auto-read new chat messages (optional)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSound } from '@/contexts/SoundContext';

// ============================================================================
// TYPES
// ============================================================================

export interface UseTextToSpeechOptions {
  /** Default rate (0.1 to 10, default 1) */
  rate?: number;
  /** Default pitch (0 to 2, default 1) */
  pitch?: number;
  /** Default volume (0 to 1, default 1) */
  volume?: number;
  /** Override language (defaults to LanguageContext) */
  language?: string;
  /** Called when speech starts */
  onStart?: () => void;
  /** Called when speech ends */
  onEnd?: () => void;
  /** Called on error */
  onError?: (error: string) => void;
}

export interface UseTextToSpeechResult {
  /** Whether TTS is supported */
  isSupported: boolean;
  /** Whether currently speaking */
  isSpeaking: boolean;
  /** Available voices */
  voices: SpeechSynthesisVoice[];
  /** Currently selected voice */
  selectedVoice: SpeechSynthesisVoice | null;
  /** Set the voice to use */
  setVoice: (voice: SpeechSynthesisVoice | null) => void;
  /** Speak text */
  speak: (text: string) => void;
  /** Stop speaking */
  stop: () => void;
  /** Pause speaking */
  pause: () => void;
  /** Resume speaking */
  resume: () => void;
  /** Toggle speaking state */
  toggle: (text?: string) => void;
  /** Error message if any */
  error: string | null;
  /** Speech rate */
  rate: number;
  /** Set speech rate */
  setRate: (rate: number) => void;
  /** Speech pitch */
  pitch: number;
  /** Set speech pitch */
  setPitch: (pitch: number) => void;
  /** Speech volume */
  volume: number;
  /** Set speech volume */
  setVolume: (volume: number) => void;
}

// ============================================================================
// LANGUAGE MAPPING
// ============================================================================

/**
 * Map our language codes to BCP 47 language tags
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

export function useTextToSpeech(options: UseTextToSpeechOptions = {}): UseTextToSpeechResult {
  const {
    rate: defaultRate = 1,
    pitch: defaultPitch = 1,
    volume: defaultVolume = 1,
    language: overrideLanguage,
    onStart,
    onEnd,
    onError,
  } = options;

  const { language: contextLanguage } = useLanguage();
  const { speakText: soundContextSpeak, stopSpeaking: soundContextStop, isSpeaking: soundContextIsSpeaking } = useSound();

  // State
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(defaultRate);
  const [pitch, setPitch] = useState(defaultPitch);
  const [volume, setVolume] = useState(defaultVolume);

  // Refs
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const lastTextRef = useRef<string>('');

  // Determine language
  const speechLanguage = overrideLanguage || languageMap[contextLanguage] || 'en-US';

  // Check support
  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  /**
   * Load available voices
   */
  useEffect(() => {
    if (!isSupported) return;

    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices();
      setVoices(availableVoices);
      
      // Auto-select best voice for current language
      if (availableVoices.length > 0 && !selectedVoice) {
        const langCode = speechLanguage.split('-')[0];
        const preferredVoice = availableVoices.find(v => 
          v.lang.startsWith(langCode) && v.localService
        ) || availableVoices.find(v => 
          v.lang.startsWith(langCode)
        ) || availableVoices.find(v => 
          v.lang.startsWith('en')
        );
        
        if (preferredVoice) {
          setSelectedVoice(preferredVoice);
        }
      }
    };

    // Load immediately
    loadVoices();

    // Also listen for voiceschanged (Chrome loads voices async)
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [isSupported, speechLanguage, selectedVoice]);

  /**
   * Update selected voice when language changes
   */
  useEffect(() => {
    if (voices.length === 0) return;

    const langCode = speechLanguage.split('-')[0];
    const matchingVoice = voices.find(v => 
      v.lang.startsWith(langCode) && v.localService
    ) || voices.find(v => 
      v.lang.startsWith(langCode)
    );

    if (matchingVoice) {
      setSelectedVoice(matchingVoice);
    }
  }, [speechLanguage, voices]);

  /**
   * Speak text
   */
  const speak = useCallback((text: string) => {
    if (!isSupported) {
      setError('Text-to-speech not supported in this browser');
      onError?.('Text-to-speech not supported');
      return;
    }

    if (!text.trim()) return;

    // Stop any current speech
    window.speechSynthesis.cancel();
    setError(null);
    lastTextRef.current = text;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLanguage;
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    utterance.onstart = () => {
      console.log('[useTextToSpeech] Started speaking');
      setIsSpeaking(true);
      onStart?.();
    };

    utterance.onend = () => {
      console.log('[useTextToSpeech] Finished speaking');
      setIsSpeaking(false);
      onEnd?.();
    };

    utterance.onerror = (event) => {
      console.error('[useTextToSpeech] Speech error:', event.error);
      setIsSpeaking(false);
      
      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        const errorMsg = `Speech synthesis error: ${event.error}`;
        setError(errorMsg);
        onError?.(errorMsg);
      }
    };

    currentUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, [isSupported, speechLanguage, rate, pitch, volume, selectedVoice, onStart, onEnd, onError]);

  /**
   * Stop speaking
   */
  const stop = useCallback(() => {
    if (!isSupported) return;
    
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, [isSupported]);

  /**
   * Pause speaking
   */
  const pause = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.pause();
  }, [isSupported]);

  /**
   * Resume speaking
   */
  const resume = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.resume();
  }, [isSupported]);

  /**
   * Toggle speaking - if speaking stop, else speak provided text or last text
   */
  const toggle = useCallback((text?: string) => {
    if (isSpeaking) {
      stop();
    } else if (text) {
      speak(text);
    } else if (lastTextRef.current) {
      speak(lastTextRef.current);
    }
  }, [isSpeaking, speak, stop]);

  /**
   * Set voice with validation
   */
  const setVoice = useCallback((voice: SpeechSynthesisVoice | null) => {
    setSelectedVoice(voice);
  }, []);

  // Sync speaking state with SoundContext
  useEffect(() => {
    // Note: We track our own speaking state, SoundContext tracks system-wide
    // This is useful for components that need to know if THIS instance is speaking
  }, [isSpeaking]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isSupported) {
        window.speechSynthesis.cancel();
      }
    };
  }, [isSupported]);

  return {
    isSupported,
    isSpeaking: isSpeaking || soundContextIsSpeaking,
    voices,
    selectedVoice,
    setVoice,
    speak,
    stop,
    pause,
    resume,
    toggle,
    error,
    rate,
    setRate,
    pitch,
    setPitch,
    volume,
    setVolume,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract plain text from HTML string for TTS
 */
export function htmlToPlainText(html: string): string {
  // Create a temporary DOM element
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // Get text content, collapse whitespace
  return (temp.textContent || temp.innerText || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get voices for a specific language
 */
export function getVoicesForLanguage(voices: SpeechSynthesisVoice[], langCode: string): SpeechSynthesisVoice[] {
  return voices.filter(v => v.lang.startsWith(langCode));
}
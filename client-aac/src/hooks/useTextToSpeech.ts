import { useState, useCallback } from "react";

interface UseTextToSpeechReturn {
  speak: (text: string) => Promise<void>;
  isSpeaking: boolean;
  cancel: () => void;
  supported: boolean;
}

export function useTextToSpeech(): UseTextToSpeechReturn {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const supported = 'speechSynthesis' in window;

  const speak = useCallback(async (text: string): Promise<void> => {
    if (!supported || !text.trim()) return;

    return new Promise((resolve) => {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      
      // Configure speech settings
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 0.8;
      
      // Try to use a clear, natural voice with language preference
      const voices = window.speechSynthesis.getVoices();
      
      // Check if text contains Hebrew characters
      const isHebrew = /[\u0590-\u05FF]/.test(text);
      
      let preferredVoice;
      
      if (isHebrew) {
        // For Hebrew text, prioritize Hebrew female voices
        preferredVoice = voices.find(voice => 
          voice.lang.startsWith('he') && 
          voice.name.toLowerCase().includes('female')
        ) || voices.find(voice => 
          voice.lang.startsWith('he') && 
          (voice.name.includes('Natural') || voice.name.includes('Google'))
        ) || voices.find(voice => voice.lang.startsWith('he'));
        
        // Adjust settings for Hebrew feminine pronunciation
        if (preferredVoice) {
          utterance.pitch = 1.3; // Higher pitch for more feminine sound
          utterance.rate = 0.9; // Slightly slower for clear Hebrew pronunciation
        }
      } else {
        // For English text, use existing logic
        preferredVoice = voices.find(voice => 
          voice.lang.startsWith('en') && 
          (voice.name.includes('Natural') || voice.name.includes('Google'))
        ) || voices.find(voice => voice.lang.startsWith('en'));
      }
      
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utterance.onstart = () => {
        setIsSpeaking(true);
      };

      utterance.onend = () => {
        setIsSpeaking(false);
        resolve();
      };

      utterance.onerror = () => {
        setIsSpeaking(false);
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    });
  }, [supported]);

  const cancel = useCallback(() => {
    if (supported) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, [supported]);

  return {
    speak,
    isSpeaking,
    cancel,
    supported,
  };
}

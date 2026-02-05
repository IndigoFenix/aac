import { useState, useCallback } from "react";

type VoiceType = "man" | "woman" | "boy" | "girl";

interface VoiceConfig {
  genderPreference: "male" | "female";
  enPitch: number;
  hePitch: number;
  heRate: number;
}

const VOICE_CONFIGS: Record<VoiceType, VoiceConfig> = {
  boy:   { genderPreference: "male",   enPitch: 1.15, hePitch: 1.1, heRate: 1.0 },
  girl:  { genderPreference: "female", enPitch: 1.25, hePitch: 1.2, heRate: 0.9 },
  man:   { genderPreference: "male",   enPitch: 1.0,  hePitch: 0.9, heRate: 1.0 },
  woman: { genderPreference: "female", enPitch: 1.0,  hePitch: 1.0, heRate: 0.9 },
};

interface UseTextToSpeechReturn {
  speak: (text: string, languageOrVoiceType?: string, voiceType?: VoiceType) => Promise<void>;
  isSpeaking: boolean;
  cancel: () => void;
  supported: boolean;
}

export function useTextToSpeech(): UseTextToSpeechReturn {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const supported = 'speechSynthesis' in window;

  const speak = useCallback(async (text: string, languageOrVoiceType?: string, voiceType?: VoiceType): Promise<void> => {
    if (!supported || !text.trim()) return;

    // Parse arguments: speak(text), speak(text, language), speak(text, language, voiceType)
    // Also support speak(text, voiceType) where voiceType is one of 'man','woman','boy','girl'
    let language: string | undefined;
    let resolvedVoiceType: VoiceType = "boy"; // default

    if (languageOrVoiceType && ["man", "woman", "boy", "girl"].includes(languageOrVoiceType)) {
      // speak(text, voiceType)
      resolvedVoiceType = languageOrVoiceType as VoiceType;
    } else {
      language = languageOrVoiceType;
      if (voiceType) {
        resolvedVoiceType = voiceType;
      }
    }

    const config = VOICE_CONFIGS[resolvedVoiceType];

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
        // For Hebrew text, find voices matching gender preference
        preferredVoice = voices.find(voice =>
          voice.lang.startsWith('he') &&
          voice.name.toLowerCase().includes(config.genderPreference)
        ) || voices.find(voice =>
          voice.lang.startsWith('he') &&
          (voice.name.includes('Natural') || voice.name.includes('Google'))
        ) || voices.find(voice => voice.lang.startsWith('he'));

        // Apply Hebrew-specific settings for this voice type
        if (preferredVoice) {
          utterance.pitch = config.hePitch;
          utterance.rate = config.heRate;
        }
      } else {
        // For English text, find voices matching gender preference
        preferredVoice = voices.find(voice =>
          voice.lang.startsWith('en') &&
          voice.name.toLowerCase().includes(config.genderPreference) &&
          (voice.name.includes('Natural') || voice.name.includes('Google'))
        ) || voices.find(voice =>
          voice.lang.startsWith('en') &&
          (voice.name.includes('Natural') || voice.name.includes('Google'))
        ) || voices.find(voice => voice.lang.startsWith('en'));

        // Apply English pitch for this voice type
        utterance.pitch = config.enPitch;
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

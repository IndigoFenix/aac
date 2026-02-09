// client-aac/src/hooks/useSignLanguageClassifier.ts
// Hook that augments raw hand data with sign language classifications.
// Loads the appropriate model on-demand when sign language changes,
// then classifies each hand's landmarks per frame.

import { useState, useEffect, useRef, useMemo } from "react";
import type { RawTrackedHand } from "@/lib/handGestureTypes";
import type { SignLanguageModel } from "@/lib/signLanguageClassifier";
import { loadSignLanguageModel, classifySign } from "@/lib/signLanguageClassifier";
import type { SignLanguageCode } from "@/i18n";

export interface UseSignLanguageClassifierOptions {
  hands: RawTrackedHand[];
  signLanguage: SignLanguageCode | null;
  threshold?: number;
}

export function useSignLanguageClassifier(
  options: UseSignLanguageClassifierOptions
): RawTrackedHand[] {
  const { hands, signLanguage, threshold = 0.5 } = options;

  const [model, setModel] = useState<SignLanguageModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadingRef = useRef<string | null>(null);

  // Load model when sign language changes
  useEffect(() => {
    if (!signLanguage) {
      setModel(null);
      setLoadError(null);
      loadingRef.current = null;
      return;
    }

    const modelUrl = `/models/${signLanguage}/model.json`;

    // Avoid re-loading the same model
    if (loadingRef.current === signLanguage && model?.locale === signLanguage) {
      return;
    }

    loadingRef.current = signLanguage;
    setLoadError(null);

    loadSignLanguageModel(modelUrl)
      .then((loaded) => {
        // Only set if this is still the current language
        if (loadingRef.current === signLanguage) {
          setModel(loaded);
        }
      })
      .catch((err) => {
        console.warn(`[SignLanguage] Failed to load ${signLanguage} model:`, err);
        if (loadingRef.current === signLanguage) {
          setLoadError(err.message);
          setModel(null);
        }
      });
  }, [signLanguage]);

  // Classify each hand and return augmented copies
  const augmentedHands = useMemo(() => {
    // No model or no sign language → return hands unchanged
    if (!model || !signLanguage) return hands;

    // Model has no labels (placeholder) → return hands unchanged
    if (model.labels.length === 0) return hands;

    return hands.map((hand) => {
      if (!hand.landmarks || hand.landmarks.length < 21) return hand;

      const result = classifySign(model, hand.landmarks, threshold);
      if (!result) return hand;

      // Return a copy with sign language fields populated
      return {
        ...hand,
        signLanguageGesture: result.label,
        signLanguageConfidence: result.confidence,
      };
    });
  }, [hands, model, signLanguage, threshold]);

  return augmentedHands;
}

export default useSignLanguageClassifier;

import { createContext, useContext, useEffect, useState } from "react";
import type { AccessibilitySettings } from "@shared/schema";

export interface AccessibilityState extends Required<AccessibilitySettings> {
  setFontSize: (v: number) => void;
  setHighContrast: (v: boolean) => void;
  setReduceAnimations: (v: boolean) => void;
  setEnhancedFocusIndicator: (v: boolean) => void;
}

const DEFAULTS: Required<AccessibilitySettings> = {
  fontSize: 100,
  highContrast: false,
  reduceAnimations: false,
  enhancedFocusIndicator: false,
};

const AccessibilityCtx = createContext<AccessibilityState | undefined>(undefined);

interface Props {
  children: React.ReactNode;
  /** Accessibility blob from the student's aacSettings (may be undefined before profile loads) */
  settings?: AccessibilitySettings | null;
}

export function AccessibilityProvider({ children, settings }: Props) {
  const [fontSize, setFontSize] = useState(settings?.fontSize ?? DEFAULTS.fontSize);
  const [highContrast, setHighContrast] = useState(settings?.highContrast ?? DEFAULTS.highContrast);
  const [reduceAnimations, setReduceAnimations] = useState(settings?.reduceAnimations ?? DEFAULTS.reduceAnimations);
  const [enhancedFocusIndicator, setEnhancedFocusIndicator] = useState(settings?.enhancedFocusIndicator ?? DEFAULTS.enhancedFocusIndicator);

  // Sync from DB when settings prop changes (e.g. after save)
  useEffect(() => {
    if (settings) {
      setFontSize(settings.fontSize ?? DEFAULTS.fontSize);
      setHighContrast(settings.highContrast ?? DEFAULTS.highContrast);
      setReduceAnimations(settings.reduceAnimations ?? DEFAULTS.reduceAnimations);
      setEnhancedFocusIndicator(settings.enhancedFocusIndicator ?? DEFAULTS.enhancedFocusIndicator);
    }
  }, [settings]);

  // Apply CSS classes / variables to document root
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-scale", String(fontSize / 100));
    root.classList.toggle("high-contrast", highContrast);
    root.classList.toggle("reduce-animations", reduceAnimations);
    root.classList.toggle("enhanced-focus", enhancedFocusIndicator);
  }, [fontSize, highContrast, reduceAnimations, enhancedFocusIndicator]);

  return (
    <AccessibilityCtx.Provider value={{ fontSize, highContrast, reduceAnimations, enhancedFocusIndicator, setFontSize, setHighContrast, setReduceAnimations, setEnhancedFocusIndicator }}>
      {children}
    </AccessibilityCtx.Provider>
  );
}

export function useAccessibility() {
  const ctx = useContext(AccessibilityCtx);
  if (!ctx) throw new Error("useAccessibility must be used within AccessibilityProvider");
  return ctx;
}

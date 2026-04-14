import { createContext, useContext, useEffect, useState } from "react";

export interface AccessibilityState {
  fontSize: number;              // 75–200, default 100
  highContrast: boolean;
  reduceAnimations: boolean;
  enhancedFocusIndicator: boolean;
  setFontSize: (v: number) => void;
  setHighContrast: (v: boolean) => void;
  setReduceAnimations: (v: boolean) => void;
  setEnhancedFocusIndicator: (v: boolean) => void;
}

const STORAGE_KEY = "accessibility";

function load(): Partial<AccessibilityState> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

const AccessibilityCtx = createContext<AccessibilityState | undefined>(undefined);

export function AccessibilityProvider({ children }: { children: React.ReactNode }) {
  const stored = load();
  const [fontSize, setFontSize] = useState(stored.fontSize ?? 100);
  const [highContrast, setHighContrast] = useState(stored.highContrast ?? false);
  const [reduceAnimations, setReduceAnimations] = useState(stored.reduceAnimations ?? false);
  const [enhancedFocusIndicator, setEnhancedFocusIndicator] = useState(stored.enhancedFocusIndicator ?? false);

  // Persist to localStorage whenever any value changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize, highContrast, reduceAnimations, enhancedFocusIndicator }));
  }, [fontSize, highContrast, reduceAnimations, enhancedFocusIndicator]);

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

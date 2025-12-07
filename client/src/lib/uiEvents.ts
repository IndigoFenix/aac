// src/lib/uiEvents.ts
import { useEffect } from "react";

export type UIEventName = "login" | "register" | "settings" | "about" | "privacy" | "terms";

export function openUI(name: UIEventName) {
  window.dispatchEvent(new CustomEvent(`ui:open:${name}`));
}

export function useUIEvent(name: UIEventName, handler: () => void) {
  useEffect(() => {
    const fn = () => handler();
    window.addEventListener(`ui:open:${name}`, fn as EventListener);
    return () => window.removeEventListener(`ui:open:${name}`, fn as EventListener);
  }, [name, handler]);
}

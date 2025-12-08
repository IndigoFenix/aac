// src/lib/uiEvents.ts
import { useEffect } from "react";

export type UIEventName = "login" | "register" | "settings" | "about" | "privacy" | "terms" | "createStudent" | "editStudent";

export function openUI(name: UIEventName, data?: any) {
  window.dispatchEvent(new CustomEvent(`ui:open:${name}`, { detail: data }));
}

export function useUIEvent(name: UIEventName, handler: (data?: any) => void) {
  useEffect(() => {
    const fn = (event: CustomEvent) => handler(event.detail);
    window.addEventListener(`ui:open:${name}`, fn as EventListener);
    return () => window.removeEventListener(`ui:open:${name}`, fn as EventListener);
  }, [name, handler]);
}
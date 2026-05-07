// Tiny accessibility helpers shared across the clinician client.
//
// `clickableProps(handler)` returns the set of attributes that turns a
// generic element (typically a styled `<div>`) into a keyboard-and-mouse
// reachable button without changing its layout. Use only when a real
// `<button type="button">` would break the surrounding markup (e.g.
// nested-button antipattern, table-row click) — prefer `<button>` otherwise.
//
// Also exports a focus-ring class that matches the project's standard ring
// (2px ring + 2px offset against background) so click-through divs that get
// keyboard focus look like buttons do.

import type { KeyboardEvent } from "react";

export const a11yFocusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export interface ClickableProps {
  role: "button";
  tabIndex: 0;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export function clickableProps(handler: () => void): ClickableProps {
  return {
    role: "button",
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    },
  };
}

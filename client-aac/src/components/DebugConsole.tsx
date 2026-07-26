// client-aac/src/components/DebugConsole.tsx
//
// On-device log viewer for the packaged clients (see lib/debug-log.ts). There
// is no Safari inspector on a sideloaded iPad, so this is how a tester surfaces
// errors — including the login/auth flow, which is why it's mounted at the app
// root and works on the login screen too.
//
// Hidden trigger (won't collide with AAC buttons, which are single-tap):
//   • Touch: a 4-finger tap anywhere toggles the console.
//   • Desktop dev: Ctrl+Shift+D.
// It renders nothing until opened, so students never see it.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearLog, exportText, getEntries, subscribe, type LogEntry } from "@/lib/debug-log";

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  error: "#ff6b6b",
  warn: "#ffd166",
  info: "#8ecae6",
  log: "#e0e0e0",
  debug: "#b8b8b8",
};

export default function DebugConsole() {
  const [open, setOpen] = useState(false);
  const entries = useSyncExternalStore(subscribe, getEntries);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // ── Hidden triggers ──
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 4) setOpen((v) => !v);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    // passive: a toggle gesture never needs to preventDefault, and passive
    // listeners don't interfere with the AAC touch/dwell handlers.
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Auto-scroll to newest while open.
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, entries]);

  const handleCopy = useCallback(async () => {
    const text = exportText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked; fall back to a selectable prompt so the
      // tester can still long-press → copy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.inset = "0";
      ta.style.zIndex = "2147483647";
      ta.style.height = "40vh";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      setTimeout(() => ta.remove(), 4000);
    }
  }, []);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "rgba(10,10,14,0.96)",
        color: "#e0e0e0",
        display: "flex",
        flexDirection: "column",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
      }}
    >
      {/* Toolbar — large touch targets for iPad */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderBottom: "1px solid #333" }}>
        <strong style={{ fontSize: 14 }}>Debug log</strong>
        <span style={{ opacity: 0.6 }}>{entries.length}</span>
        <div style={{ flex: 1 }} />
        <button onClick={handleCopy} style={btn}>{copied ? "Copied ✓" : "Copy"}</button>
        <button onClick={() => clearLog()} style={btn}>Clear</button>
        <button onClick={() => setOpen(false)} style={{ ...btn, background: "#a33" }}>Close</button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 8, WebkitOverflowScrolling: "touch" }}>
        {entries.length === 0 && (
          <div style={{ opacity: 0.5, padding: 16 }}>
            No log entries yet. Reproduce the issue, then Copy.
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} style={{ padding: "3px 0", borderBottom: "1px solid #1e1e26", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ opacity: 0.5 }}>{new Date(e.time).toISOString().slice(11, 23)} </span>
            <span style={{ color: LEVEL_COLOR[e.level], fontWeight: e.level === "error" || e.level === "warn" ? 700 : 400 }}>
              {e.text}
            </span>
          </div>
        ))}
      </div>

      <div style={{ padding: "6px 10px", borderTop: "1px solid #333", opacity: 0.6, fontSize: 11 }}>
        4-finger tap (or Ctrl+Shift+D) toggles this panel.
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "#2a2a34",
  color: "#fff",
  border: "1px solid #444",
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 13,
  minHeight: 40,
};

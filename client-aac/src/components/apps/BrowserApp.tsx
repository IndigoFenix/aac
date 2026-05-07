// client-aac/src/components/apps/BrowserApp.tsx
// In-frame web browser app for permitted websites.
//
// Limitations (by design):
// - Cross-origin iframes can't be captured visually (canvas.toBlob() fails on
//   tainted origins), so we send only URL + title as text context to the AI.
// - Many popular sites (Google, YouTube, Facebook, etc.) set X-Frame-Options /
//   frame-ancestors CSP that block iframe embedding. We detect these failures
//   and notify the AI so it can redirect.
// - TODO: build dedicated apps for popular blocked sites. YouTube already has one.

import { useEffect, useRef, useState, useCallback } from "react";
import { X, RefreshCw, ChevronLeft, Globe } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { isUrlPermitted } from "@shared/permitted-websites";
import type { PermittedWebsite } from "@shared/schema";

/** Window after which a failure to fire `onload` is treated as "blocked by X-Frame-Options". */
const LOAD_TIMEOUT_MS = 4000;

interface BrowserAppProps {
  url: string;
  label?: string;
  permittedWebsites: PermittedWebsite[];
  onClose: () => void;
  /** Send free-form context to the AI (routed through context_injection). */
  sendContextOnly?: (text: string) => void;
}

export default function BrowserApp({
  url,
  label,
  permittedWebsites,
  onClose,
  sendContextOnly,
}: BrowserAppProps) {
  const { t } = useLanguage();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialNotifyDoneRef = useRef(false);

  const [history, setHistory] = useState<string[]>([url]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [blocked, setBlocked] = useState(false);

  const notifyContext = useCallback(
    (text: string) => {
      try {
        sendContextOnly?.(text);
      } catch {
        /* ignore */
      }
    },
    [sendContextOnly],
  );

  const clearLoadTimer = useCallback(() => {
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
  }, []);

  const armLoadTimer = useCallback(
    (targetUrl: string) => {
      clearLoadTimer();
      loadTimerRef.current = setTimeout(() => {
        // If onload never fired, the site almost certainly refused iframe embedding.
        setBlocked(true);
        notifyContext(
          `[SYSTEM] The site ${targetUrl} could not be embedded in the browser app (the site blocks iframe embedding). Close the browser app and suggest a different activity or another permitted site.`,
        );
      }, LOAD_TIMEOUT_MS);
    },
    [clearLoadTimer, notifyContext],
  );

  // First load
  useEffect(() => {
    armLoadTimer(url);
    return clearLoadTimer;
     
  }, []);

  // Handle iframe load: read URL + title where same-origin allows, notify AI.
  const handleIframeLoad = useCallback(() => {
    clearLoadTimer();
    setBlocked(false);
    const frame = iframeRef.current;
    let observedUrl = currentUrl;
    let title: string | undefined;
    try {
      const doc = frame?.contentDocument;
      const win = frame?.contentWindow;
      if (doc && win) {
        observedUrl = win.location.href || observedUrl;
        title = doc.title || undefined;
      }
    } catch {
      // Cross-origin — we can't read location / title. Keep what we had.
    }

    if (observedUrl !== currentUrl) {
      setCurrentUrl(observedUrl);
      setHistory((prev) => {
        const cut = prev.slice(0, historyIndex + 1);
        if (cut[cut.length - 1] === observedUrl) return cut;
        return [...cut, observedUrl];
      });
      setHistoryIndex((i) => i + 1);
    }

    const titleSuffix = title ? ` — ${title}` : "";
    const sitelabel = label ? ` (${label})` : "";
    // Only skip if we'd send the exact same initial URL twice.
    if (!initialNotifyDoneRef.current || observedUrl !== url) {
      notifyContext(`[BROWSER] The student is viewing ${observedUrl}${titleSuffix}${sitelabel}. Adapt the board to the current page.`);
      initialNotifyDoneRef.current = true;
    }
  }, [clearLoadTimer, currentUrl, history, historyIndex, label, notifyContext, url]);

  const go = useCallback(
    (nextUrl: string) => {
      if (!isUrlPermitted(nextUrl, permittedWebsites)) {
        notifyContext(`[BROWSER] Blocked a navigation to a non-permitted URL (${nextUrl}).`);
        return;
      }
      setBlocked(false);
      setCurrentUrl(nextUrl);
      armLoadTimer(nextUrl);
    },
    [armLoadTimer, notifyContext, permittedWebsites],
  );

  const handleBack = useCallback(() => {
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    setHistoryIndex(historyIndex - 1);
    setBlocked(false);
    setCurrentUrl(target);
    armLoadTimer(target);
  }, [armLoadTimer, history, historyIndex]);

  const handleRefresh = useCallback(() => {
    setBlocked(false);
    armLoadTimer(currentUrl);
    const frame = iframeRef.current;
    if (frame) {
      // Setting src to itself forces a reload even across origins.
      frame.src = currentUrl;
    }
  }, [armLoadTimer, currentUrl]);

  const handleClose = useCallback(() => {
    notifyContext(`[BROWSER] The student closed the browser app.`);
    onClose();
  }, [notifyContext, onClose]);

  // Keep iframe src in sync with currentUrl (distinct var so React always re-renders).
  const iframeSrc = currentUrl;

  return (
    <div className="h-full w-full bg-gray-100 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200 shadow-sm">
        <button type="button"
          data-dwell
          onClick={handleBack}
          disabled={historyIndex <= 0}
          className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
          aria-label={t("browserApp.back")}
        >
          <ChevronLeft size={28} className="text-gray-700" />
        </button>
        <button type="button"
          data-dwell
          onClick={handleRefresh}
          className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("browserApp.refresh")}
        >
          <RefreshCw size={24} className="text-gray-700" />
        </button>

        <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-xl">
          <Globe size={18} className="text-gray-500 shrink-0" />
          <span className="text-sm text-gray-700 truncate font-mono">{currentUrl}</span>
        </div>

        <button type="button"
          data-dwell
          onClick={handleClose}
          className="w-12 h-12 rounded-xl bg-red-500 flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("browserApp.close")}
        >
          <X size={28} className="text-white" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 relative">
        {blocked && (
          <div className="absolute inset-0 z-10 bg-white flex flex-col items-center justify-center text-center p-6">
            <Globe size={48} className="text-gray-400 mb-3" />
            <h3 className="text-lg font-semibold text-gray-800 mb-1">
              {t("browserApp.blockedTitle")}
            </h3>
            <p className="text-sm text-gray-600 max-w-md">
              {t("browserApp.blockedHint")}
            </p>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src={iframeSrc}
          onLoad={handleIframeLoad}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
          className="w-full h-full border-0 bg-white"
          title={label || "Browser"}
        />
      </div>
    </div>
  );
}

// External helper: expose `go` so parent contexts (AI tool calls while the
// browser is already open) can request a new URL. Not wired yet — future work.
export type { BrowserAppProps };

// client-aac/src/components/apps/ElectronBrowserApp.tsx
// Electron-only in-app browser. Renders permitted websites in a hardened
// <webview> (isolated partition, main-process navigation gate) and lays an
// eyegaze DWELL control overlay on top so a student who can't use a mouse can
// SCROLL, CLICK and TYPE.
//
// Why a <webview> and not the plain iframe (BrowserApp.tsx):
//  - A cross-origin iframe can't be reached in — no scrollBy, no synthetic
//    input, no DOM. A <webview>'s executeJavaScript / sendInputEvent run inside
//    the guest, so we drive third-party sites without their cooperation.
//  - <webview> loads top-level, so it is NOT subject to X-Frame-Options /
//    frame-ancestors — sites the iframe couldn't embed load fine here.
//
// Eyegaze model: the control bars are host [data-dwell] buttons inside a
// [data-dwell-trap] (so the shared EyeTrackingDwell engine only fires on our
// controls, never on opaque webview content). Clicking INTO the page is a
// separate, explicitly-armed dwell loop (below) that reads gaze and injects a
// mouse event at the content point — reading must never trigger a click.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  X, RefreshCw, Globe,
  ChevronUp, ChevronDown, ChevronsUp, ChevronsDown,
  Play, Pause, MousePointerClick, Keyboard as KeyboardIcon,
  Delete, CornerDownLeft, CircleDot,
} from "lucide-react";
// Back, and the tab-step arrows: both follow the reading direction, so they
// come from the logical set rather than naming a physical side. Scroll
// up/down and the transport icons above are axis-neutral and stay lucide's.
import { ChevronBack, ArrowBackToLine, ArrowForwardToLine } from "@/components/ui/directional-icons";
import { useLanguage } from "@/contexts/LanguageContext";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import { isUrlPermitted } from "@shared/permitted-websites";
import { DwellEngine } from "@shared/dwell-engine";
import type { PermittedWebsite } from "@shared/schema";
import { getBrowserBridge } from "@/lib/platform";
import type { WebviewTag } from "@/types/electron-webview";

interface ElectronBrowserAppProps {
  url: string;
  label?: string;
  permittedWebsites: PermittedWebsite[];
  onClose: () => void;
  /** Send free-form context to the AI (routed through context_injection). */
  sendContextOnly?: (text: string) => void;
}

/** Isolated partition — MUST match BROWSER_PARTITION in electron/main.ts. */
const BROWSER_PARTITION = "persist:aac-browser";

/**
 * Injected into the guest on every `dom-ready`. Defines scroll helpers that
 * target the nearest / largest scrollable element (book readers usually scroll
 * an inner container, not the document) and a self-contained auto-scroll loop
 * that runs at the guest's own frame rate for smoothness.
 */
const HELPER_JS = `(function(){
  if (window.__aivotaBrowser) { return; }
  window.__aivotaBrowser = true;
  function scrollableAncestor(el){
    var node = el;
    while (node && node !== document.body && node !== document.documentElement){
      var s = getComputedStyle(node), oy = s.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function biggestScrollable(){
    var best = document.scrollingElement || document.documentElement;
    var bestOver = (best.scrollHeight||0) - (best.clientHeight||0);
    var all = document.querySelectorAll('*');
    for (var i=0;i<all.length;i++){
      var n = all[i];
      var over = n.scrollHeight - n.clientHeight;
      if (over > bestOver){
        var s = getComputedStyle(n), oy = s.overflowY;
        if (oy === 'auto' || oy === 'scroll'){ best = n; bestOver = over; }
      }
    }
    return best;
  }
  function targetAt(x,y){
    var el = (x>=0 && y>=0) ? document.elementFromPoint(x,y) : null;
    return el ? scrollableAncestor(el) : (document.scrollingElement||document.documentElement);
  }
  window.__aivotaScrollPage = function(dir, x, y){
    var t = targetAt(x,y);
    var amt = Math.max(120, Math.round((t.clientHeight||window.innerHeight) * 0.82)) * dir;
    t.scrollBy({ top: amt, left: 0, behavior: 'smooth' });
  };
  window.__aivotaScrollEnd = function(dir, x, y){
    var t = targetAt(x,y);
    t.scrollTo({ top: dir>0 ? t.scrollHeight : 0, behavior: 'smooth' });
  };
  var raf = null;
  window.__aivotaAutoScroll = function(on, pace){
    if (raf){ cancelAnimationFrame(raf); raf = null; }
    if (!on) return;
    var t = biggestScrollable();
    var step = function(){ t.scrollBy({ top: pace || 1.6, left: 0 }); raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  };
  // Activate the currently Tab-focused element (link / button / control).
  window.__aivotaActivateFocused = function(){
    var el = document.activeElement;
    if (el && el !== document.body && typeof el.click === 'function') el.click();
  };
})();`;

/**
 * Injected into the guest so the Tab-focused element is clearly visible to an
 * eyegaze user (the browser's default focus ring is often too subtle).
 */
const FOCUS_CSS = `:focus, :focus-visible { outline: 3px solid #14b8a6 !important; outline-offset: 2px !important; }`;

export default function ElectronBrowserApp({
  url,
  label,
  permittedWebsites,
  onClose,
  sendContextOnly,
}: ElectronBrowserAppProps) {
  const { t } = useLanguage();
  const dwell = useEyeTrackingDwell();

  const webviewRef = useRef<WebviewTag | null>(null);
  const lastPermittedUrlRef = useRef(url);
  const initialNotifyDoneRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(url);

  // Overlay modes
  const [autoScrolling, setAutoScrolling] = useState(false);
  const [tapArmed, setTapArmed] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [clickProgress, setClickProgress] = useState(0);

  const notifyContext = useCallback(
    (text: string) => {
      try { sendContextOnly?.(text); } catch { /* ignore */ }
    },
    [sendContextOnly],
  );

  // ── Push the allowlist to the main process (hard nav gate) on mount ──
  useEffect(() => {
    const browser = getBrowserBridge();
    browser?.setAllowlist?.(permittedWebsites);
    if (!isUrlPermitted(url, permittedWebsites)) {
      setBlocked(true);
      notifyContext(`[BROWSER] Blocked opening a non-permitted URL (${url}).`);
    }
    return () => { browser?.clearAllowlist?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Wire webview lifecycle events ──
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onDomReady = () => {
      setReady(true);
      // Re-inject helpers + focus styling each navigation (dom-ready fires per page).
      wv.executeJavaScript(HELPER_JS).catch(() => {});
      wv.insertCSS(FOCUS_CSS).catch(() => {});
      let observedUrl = currentUrl;
      let title = "";
      try { observedUrl = wv.getURL() || observedUrl; title = wv.getTitle() || ""; } catch { /* ignore */ }
      const titleSuffix = title ? ` — ${title}` : "";
      const sitelabel = label ? ` (${label})` : "";
      if (!initialNotifyDoneRef.current || observedUrl !== url) {
        notifyContext(`[BROWSER] The student is viewing ${observedUrl}${titleSuffix}${sitelabel}. Adapt the board to the current page.`);
        initialNotifyDoneRef.current = true;
      }
    };

    // Enforce the allowlist on navigation. The main process already CANCELS
    // off-list navigation; this handles the UX (blocked state) and reverts to
    // the last permitted page if anything slipped through a client-side push.
    const onNavigate = (e: Event) => {
      const navUrl = (e as unknown as { url?: string }).url;
      if (!navUrl) return;
      if (!isUrlPermitted(navUrl, permittedWebsites)) {
        notifyContext(`[BROWSER] Blocked navigation to a non-permitted URL (${navUrl}).`);
        setBlocked(true);
        try { wv.stop(); wv.loadURL(lastPermittedUrlRef.current); } catch { /* ignore */ }
        return;
      }
      lastPermittedUrlRef.current = navUrl;
      setCurrentUrl(navUrl);
      setBlocked(false);
      // A fresh page isn't auto-scrolling (the guest helper is re-injected on
      // dom-ready without the loop running), so clear the indicator.
      if ((e.type as string) === "did-navigate") setAutoScrolling(false);
    };

    const onFailLoad = (e: Event) => {
      const code = (e as unknown as { errorCode?: number }).errorCode ?? 0;
      // -3 is ERR_ABORTED (our own stop() during a redirect revert) — ignore.
      if (code === -3 || code === 0) return;
      setBlocked(true);
      notifyContext(`[SYSTEM] The site ${currentUrl} failed to load (error ${code}). Suggest another activity or permitted site.`);
    };

    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("did-navigate", onNavigate as EventListener);
    wv.addEventListener("did-navigate-in-page", onNavigate as EventListener);
    wv.addEventListener("did-fail-load", onFailLoad as EventListener);
    return () => {
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("did-navigate", onNavigate as EventListener);
      wv.removeEventListener("did-navigate-in-page", onNavigate as EventListener);
      wv.removeEventListener("did-fail-load", onFailLoad as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, permittedWebsites]);

  // ── Content coordinate of the current gaze (null when off / outside) ──
  const gazeToContent = useCallback((): { x: number; y: number } | null => {
    const wv = webviewRef.current;
    const pos = dwell.gazePosition;
    if (!wv || !pos) return null;
    const rect = wv.getBoundingClientRect();
    const x = pos.x - rect.left;
    const y = pos.y - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return { x, y };
  }, [dwell.gazePosition]);

  // ── Scroll actions (guest-side helpers) ──
  const runInGuest = useCallback((expr: string) => {
    webviewRef.current?.executeJavaScript(expr).catch(() => {});
  }, []);

  const scrollPage = useCallback((dir: 1 | -1) => {
    const c = gazeToContent();
    const x = c?.x ?? -1, y = c?.y ?? -1;
    runInGuest(`window.__aivotaScrollPage && window.__aivotaScrollPage(${dir}, ${Math.round(x)}, ${Math.round(y)})`);
  }, [gazeToContent, runInGuest]);

  const scrollEnd = useCallback((dir: 1 | -1) => {
    const c = gazeToContent();
    const x = c?.x ?? -1, y = c?.y ?? -1;
    runInGuest(`window.__aivotaScrollEnd && window.__aivotaScrollEnd(${dir}, ${Math.round(x)}, ${Math.round(y)})`);
  }, [gazeToContent, runInGuest]);

  const toggleAutoScroll = useCallback(() => {
    setAutoScrolling((on) => {
      const next = !on;
      runInGuest(`window.__aivotaAutoScroll && window.__aivotaAutoScroll(${next ? "true" : "false"}, 1.6)`);
      return next;
    });
  }, [runInGuest]);

  // ── Synthetic click into the guest ──
  const clickAt = useCallback((x: number, y: number) => {
    const wv = webviewRef.current;
    if (!wv) return;
    wv.sendInputEvent({ type: "mouseMove", x, y }).catch(() => {});
    wv.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 }).catch(() => {});
    wv.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 }).catch(() => {});
  }, []);

  // ── Dwell-to-click loop (only while Tap is armed) ──
  // A dedicated DwellEngine over the content region. We feed it gaze from a ref
  // updated each fresh sample so a STILL gaze (identical coords) still counts as
  // fresh — matching EyeTrackingDwellContext's freshness handling.
  const gazeRef = useRef(dwell.gazePosition);
  const gazeFreshRef = useRef(0);
  gazeRef.current = dwell.gazePosition;
  useEffect(() => {
    if (dwell.gazePosition) gazeFreshRef.current = performance.now();
  }, [dwell.gazePosition]);

  useEffect(() => {
    if (!tapArmed) { setClickProgress(0); return; }
    const engine = new DwellEngine<"content">({
      dwellTimeMs: dwell.dwellTimeMs,
      staleGazeMs: dwell.mode === "eyegaze" ? 500 : null,
    });
    let rafId = 0;
    let last = 0;
    const tick = (time: number) => {
      rafId = requestAnimationFrame(tick);
      if (time - last < 50) return; // ~20Hz
      last = time;
      const wv = webviewRef.current;
      const pos = gazeRef.current;
      if (!wv || !pos) { setClickProgress(0); return; }
      const rect = wv.getBoundingClientRect();
      const x = pos.x - rect.left, y = pos.y - rect.top;
      const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
      const r = engine.update(inside ? "content" : null, pos, time, gazeFreshRef.current);
      setClickProgress(r.progress);
      if (r.fired) {
        clickAt(x, y);
        setTapArmed(false); // one-shot
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [tapArmed, dwell.dwellTimeMs, dwell.mode, clickAt]);

  // ── Keyboard: inject key events into the focused guest field ──
  const typeChar = useCallback((ch: string) => {
    const wv = webviewRef.current;
    if (!wv) return;
    wv.sendInputEvent({ type: "keyDown", keyCode: ch }).catch(() => {});
    wv.sendInputEvent({ type: "char", keyCode: ch }).catch(() => {});
    wv.sendInputEvent({ type: "keyUp", keyCode: ch }).catch(() => {});
  }, []);
  const typeSpecial = useCallback((keyCode: string) => {
    const wv = webviewRef.current;
    if (!wv) return;
    wv.sendInputEvent({ type: "keyDown", keyCode }).catch(() => {});
    wv.sendInputEvent({ type: "keyUp", keyCode }).catch(() => {});
  }, []);

  // ── Tab navigation ──
  // An alternative to dwell-to-click for eyegaze: step focus through the page's
  // focusable elements (links/buttons/fields) and activate the focused one —
  // no precise pointing needed. Injected via sendInputEvent so it works even
  // with the webview pointer-transparent (see below).
  const sendKeyCombo = useCallback((keyCode: string, modifiers?: string[]) => {
    const wv = webviewRef.current;
    if (!wv) return;
    const evt = modifiers ? { keyCode, modifiers } : { keyCode };
    wv.sendInputEvent({ type: "keyDown", ...evt }).catch(() => {});
    wv.sendInputEvent({ type: "keyUp", ...evt }).catch(() => {});
  }, []);
  const tabNext = useCallback(() => sendKeyCombo("Tab"), [sendKeyCombo]);
  const tabPrev = useCallback(() => sendKeyCombo("Tab", ["shift"]), [sendKeyCombo]);
  const activateFocused = useCallback(() => {
    runInGuest("window.__aivotaActivateFocused && window.__aivotaActivateFocused()");
  }, [runInGuest]);

  const handleBack = useCallback(() => {
    const wv = webviewRef.current;
    if (wv?.canGoBack()) wv.goBack();
  }, []);
  const handleRefresh = useCallback(() => { webviewRef.current?.reload(); }, []);
  const handleClose = useCallback(() => {
    notifyContext(`[BROWSER] The student closed the browser app.`);
    onClose();
  }, [notifyContext, onClose]);

  // Whether the dwell gaze cursor should be shown over content (armed for click,
  // or keyboard open so the student can aim at a field to focus it).
  const showCursor = (tapArmed || keyboardOpen) && dwell.enabled && !!dwell.gazePosition;

  return (
    <div className="h-full w-full bg-gray-100 flex flex-col" data-dwell-trap>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200 shadow-sm">
        <button type="button" data-dwell onClick={handleBack}
          className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("browserApp.back")}>
          <ChevronBack size={28} className="text-gray-700" />
        </button>
        <button type="button" data-dwell onClick={handleRefresh}
          className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("browserApp.refresh")}>
          <RefreshCw size={24} className="text-gray-700" />
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-xl">
          <Globe size={18} className="text-gray-500 shrink-0" />
          <span className="text-sm text-gray-700 truncate font-mono">{currentUrl}</span>
        </div>
        <button type="button" data-dwell onClick={handleClose}
          className="w-12 h-12 rounded-xl bg-red-500 flex items-center justify-center active:scale-95 transition-transform"
          aria-label={t("browserApp.close")}>
          <X size={28} className="text-white" />
        </button>
      </div>

      {/* Body: webview + gaze cursor overlay */}
      <div className="flex-1 relative">
        {blocked && (
          <div className="absolute inset-0 z-20 bg-white flex flex-col items-center justify-center text-center p-6">
            <Globe size={48} className="text-gray-400 mb-3" />
            <h3 className="text-lg font-semibold text-gray-800 mb-1">{t("browserApp.blockedTitle")}</h3>
            <p className="text-sm text-gray-600 max-w-md">{t("browserApp.blockedHint")}</p>
          </div>
        )}
        {/* While dwell input is active the webview is pointer-TRANSPARENT: a
            <webview> is a separate compositing layer that otherwise swallows
            mouse/pointer events, freezing the host dwell cursor at its edge
            (mouse-driven trackers). We never rely on real clicks anyway —
            scroll/click/type go through executeJavaScript/sendInputEvent, which
            bypass CSS pointer-events — so making it transparent lets the cursor
            track over the page while dwell-to-click still works. When dwell is
            off, keep it interactive for normal mouse/touch use. */}
        <webview
          ref={(el) => { webviewRef.current = (el as unknown as WebviewTag) ?? null; }}
          src={url}
          partition={BROWSER_PARTITION}
          className="w-full h-full border-0 bg-white"
          style={{ display: "flex", pointerEvents: dwell.enabled ? "none" : "auto" }}
        />
        {/* Gaze cursor + dwell-to-click progress ring */}
        {showCursor && dwell.gazePosition && (
          <div
            className="pointer-events-none fixed z-30"
            style={{ left: dwell.gazePosition.x, top: dwell.gazePosition.y, transform: "translate(-50%, -50%)" }}
          >
            <div className="relative w-10 h-10">
              <div className="absolute inset-0 rounded-full border-2 border-teal-400/70" />
              <div
                className="absolute inset-0 rounded-full border-2 border-teal-500"
                style={{ clipPath: `inset(${100 - Math.round(clickProgress * 100)}% 0 0 0)` }}
              />
              <div className="absolute inset-[38%] rounded-full bg-teal-500" />
            </div>
          </div>
        )}
      </div>

      {/* Control bar OR keyboard */}
      {keyboardOpen ? (
        <DwellKeyboard
          onChar={typeChar}
          onSpecial={typeSpecial}
          onHide={() => setKeyboardOpen(false)}
          disabled={!ready}
          t={t}
        />
      ) : (
        <div className="flex flex-wrap items-stretch justify-center gap-2 px-3 py-2 bg-white border-t border-gray-200">
          <ControlButton onClick={() => scrollEnd(-1)} disabled={!ready} label={t("browserApp.scrollTop")}>
            <ChevronsUp size={26} />
          </ControlButton>
          <ControlButton onClick={() => scrollPage(-1)} disabled={!ready} label={t("browserApp.scrollUp")}>
            <ChevronUp size={26} />
          </ControlButton>
          <ControlButton onClick={toggleAutoScroll} disabled={!ready} active={autoScrolling} label={t("browserApp.autoScroll")}>
            {autoScrolling ? <Pause size={24} /> : <Play size={24} />}
          </ControlButton>
          <ControlButton onClick={() => scrollPage(1)} disabled={!ready} label={t("browserApp.scrollDown")}>
            <ChevronDown size={26} />
          </ControlButton>
          <ControlButton onClick={() => scrollEnd(1)} disabled={!ready} label={t("browserApp.scrollBottom")}>
            <ChevronsDown size={26} />
          </ControlButton>
          <div className="w-px bg-gray-200 mx-1" />
          {/* Tab navigation: step focus through the page + activate, an
              eyegaze-friendly alternative to dwell-to-click on small targets. */}
          <ControlButton onClick={tabPrev} disabled={!ready} label={t("browserApp.tabPrev")}>
            <ArrowBackToLine size={24} />
          </ControlButton>
          <ControlButton onClick={tabNext} disabled={!ready} label={t("browserApp.tabNext")}>
            <ArrowForwardToLine size={24} />
          </ControlButton>
          <ControlButton onClick={activateFocused} disabled={!ready} label={t("browserApp.activate")}>
            <CircleDot size={24} />
          </ControlButton>
          <div className="w-px bg-gray-200 mx-1" />
          <ControlButton onClick={() => setTapArmed((a) => !a)} disabled={!ready} active={tapArmed} label={t("browserApp.tap")}>
            <MousePointerClick size={24} />
          </ControlButton>
          <ControlButton onClick={() => setKeyboardOpen(true)} disabled={!ready} label={t("browserApp.keyboard")}>
            <KeyboardIcon size={24} />
          </ControlButton>
        </div>
      )}
    </div>
  );
}

// ── Reusable big dwell control button ──
function ControlButton({
  onClick, children, label, disabled, active,
}: {
  onClick: () => void;
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      data-dwell
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`h-14 min-w-14 px-3 rounded-xl flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40 ${
        active ? "bg-teal-500 text-white ring-2 ring-teal-300" : "bg-gray-100 text-gray-700"
      }`}
    >
      {children}
    </button>
  );
}

// ── On-screen dwell keyboard ──
const KEY_ROWS: string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m", ".", "-", "/"],
];

function DwellKeyboard({
  onChar, onSpecial, onHide, disabled, t,
}: {
  onChar: (ch: string) => void;
  onSpecial: (keyCode: string) => void;
  onHide: () => void;
  disabled?: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="bg-white border-t border-gray-200 px-2 py-2 select-none">
      {KEY_ROWS.map((row, i) => (
        <div key={i} className="flex justify-center gap-1.5 mb-1.5">
          {row.map((k) => (
            <button
              key={k}
              type="button"
              data-dwell
              disabled={disabled}
              onClick={() => onChar(k)}
              className="h-11 w-11 rounded-lg bg-gray-100 text-gray-800 text-lg font-medium flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
            >
              {k}
            </button>
          ))}
        </div>
      ))}
      <div className="flex justify-center gap-1.5">
        <button type="button" data-dwell disabled={disabled} onClick={() => onSpecial("Backspace")}
          aria-label={t("browserApp.backspace")}
          className="h-11 px-4 rounded-lg bg-gray-100 text-gray-800 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40">
          <Delete size={22} />
        </button>
        <button type="button" data-dwell disabled={disabled} onClick={() => onChar(" ")}
          aria-label={t("browserApp.space")}
          className="h-11 flex-1 max-w-xs rounded-lg bg-gray-100 text-gray-800 active:scale-95 transition-transform disabled:opacity-40">
          &nbsp;
        </button>
        <button type="button" data-dwell disabled={disabled} onClick={() => onSpecial("Return")}
          aria-label={t("browserApp.enter")}
          className="h-11 px-4 rounded-lg bg-gray-100 text-gray-800 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40">
          <CornerDownLeft size={22} />
        </button>
        <button type="button" data-dwell onClick={onHide}
          aria-label={t("browserApp.hideKeyboard")}
          className="h-11 px-4 rounded-lg bg-teal-500 text-white flex items-center justify-center active:scale-95 transition-transform">
          <ChevronDown size={22} />
        </button>
      </div>
    </div>
  );
}

// client-aac/src/components/apps/photo-viewer-chrome.tsx
//
// The frame every picture-viewing app in the AAC wears: a titled dark shell with
// one big close target, and the full-height prev/next side targets.
//
// Extracted from PhotosApp when the web picture search (PictureSearchApp) grew
// the same two surfaces. These are DWELL TARGETS before they are decoration —
// their size, position and `data-dwell` marking are the accessibility contract,
// and two hand-maintained copies would drift the moment one app got a tweak.
//
// Every control is a host [data-dwell] button, which is what the shared
// EyeTrackingDwell engine looks for. No local dwell loop — one driver only.

import { X } from "lucide-react";
import { ChevronBack, ChevronForward } from "@/components/ui/directional-icons";

export function ViewerShell({
  title, onClose, closeLabel, children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full w-full bg-gray-900 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 bg-black/70 border-b border-gray-800 shrink-0">
        <h2 className="text-white text-lg font-semibold truncate flex-1">{title}</h2>
        <button
          type="button"
          data-dwell
          onClick={onClose}
          className="w-12 h-12 rounded-xl bg-red-600 text-white flex items-center justify-center active:scale-95 transition-transform"
          aria-label={closeLabel}
        >
          <X className="w-6 h-6" />
        </button>
      </div>
      {children}
    </div>
  );
}

/** The stage a full-size picture renders on.
 *
 *  The img is ABSOLUTE inside a relative frame on purpose — not `max-h-full`
 *  in normal flow. Percentage heights resolve against the ancestor chain's
 *  definiteness, and WKWebView (the iPad shell) fails to resolve them against
 *  flexed heights: the image falls back to its intrinsic size and the bottom
 *  gets clipped by the row's overflow-hidden ("images too tall, lower parts
 *  cut off", 2026-08-19 — both viewers). Absolute + inset-0 sizes against the
 *  frame's real laid-out box, which every engine agrees on; object-contain
 *  letterboxes inside it. The grids already used this trick — this brings the
 *  viewers onto it, shared so the two apps cannot drift apart again.
 *
 *  `fallback` replaces the img entirely (e.g. a broken-image notice), centered
 *  on the same stage. */
export function ViewerImage({
  src, alt, onError, fallback,
}: {
  src: string;
  alt: string;
  onError?: () => void;
  fallback?: React.ReactNode;
}) {
  return (
    <div className="flex-1 min-w-0 min-h-0 relative bg-black rounded-2xl overflow-hidden">
      {fallback ? (
        <div className="absolute inset-0 flex items-center justify-center">{fallback}</div>
      ) : (
        <img
          src={src}
          alt={alt}
          className="absolute inset-0 w-full h-full object-contain"
          onError={onError}
        />
      )}
    </div>
  );
}

/** A full-height side target. Tall and wide on purpose: paging through pictures
 *  is the main thing a student does here, so it should be the easiest thing to
 *  hit. */
export function ViewerNav({
  direction, label, disabled, onClick,
}: {
  direction: "prev" | "next";
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-dwell
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className="w-24 shrink-0 rounded-2xl bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-20 disabled:bg-gray-900"
      aria-label={label}
    >
      {/* Logical, not physical: in RTL the row itself reverses (dir=rtl), so
          "prev" sits on the right and must POINT right too. */}
      {direction === "prev" ? <ChevronBack className="w-12 h-12" /> : <ChevronForward className="w-12 h-12" />}
    </button>
  );
}

/** The prev / page-count / next strip under a thumbnail grid. Rendered only
 *  when there is more than one page, so the grid keeps its height otherwise. */
export function PagerStrip({
  page, totalPages, onPage, previousLabel, nextLabel,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  previousLabel: string;
  nextLabel: string;
}) {
  const canPrev = page > 0;
  const canNext = page < totalPages - 1;
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 pb-2">
      <button
        type="button"
        data-dwell
        onClick={() => canPrev && onPage(page - 1)}
        disabled={!canPrev}
        className="flex-1 h-14 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-25 disabled:bg-gray-700"
        aria-label={previousLabel}
      >
        <ChevronBack className="w-8 h-8" />
      </button>
      <span className="text-white/60 text-lg tabular-nums px-2">
        {page + 1} / {totalPages}
      </span>
      <button
        type="button"
        data-dwell
        onClick={() => canNext && onPage(page + 1)}
        disabled={!canNext}
        className="flex-1 h-14 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-25 disabled:bg-gray-700"
        aria-label={nextLabel}
      >
        <ChevronForward className="w-8 h-8" />
      </button>
    </div>
  );
}

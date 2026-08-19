// client-aac/src/components/apps/PictureSearchApp.tsx
//
// "Find a Picture" — web image search results in the AAC's picture viewer.
//
// Deliberately a DUMB renderer. The search already ran on the server before this
// mounted (picture-search-service.ts), so there is no query box, no re-search
// and no fetching here: the student sees exactly the set the assistant was told
// about. That symmetry is the whole point — it is what stops the assistant
// describing a picture the device never showed. To search again, the student
// asks, and the assistant calls open_app("picture_search", …) once more.
//
// Every src points at OUR image proxy, never at the host the picture came from.
// See image-proxy-token.ts for why that matters on a child's device.
//
// Eyegaze: every control is a host [data-dwell] button, which is what the shared
// EyeTrackingDwell engine looks for. No local dwell loop — one driver only.

import { useCallback, useMemo, useState } from "react";
import { ImageOff, LayoutGrid, Search } from "lucide-react";
import { apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import type { PictureSearchPayload, PictureSearchResult } from "@shared/picture-search";
import { PagerStrip, ViewerImage, ViewerNav, ViewerShell } from "./photo-viewer-chrome";

/** Same coarse grid as the family album: these are dwell targets for a student
 *  who may be aiming with their eyes, not a desktop image browser. */
const GRID_COLS = 3;
const GRID_ROWS = 2;
const PAGE_SIZE = GRID_COLS * GRID_ROWS;

export interface PictureSearchAppProps {
  payload: PictureSearchPayload | undefined;
  onClose: () => void;
  sendContextOnly?: (text: string) => void;
}

export function PictureSearchApp({ payload, onClose, sendContextOnly }: PictureSearchAppProps) {
  const { t } = useLanguage();
  const results = useMemo(() => payload?.results ?? [], [payload]);
  const query = payload?.query ?? "";
  const [page, setPage] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  /** Ids whose bytes the proxy could not deliver. A dead tile is shown as a dead
   *  tile rather than as a blank one, so a student never dwells on nothing. */
  const [broken, setBroken] = useState<Set<string>>(new Set());

  const markBroken = useCallback((id: string) => {
    setBroken((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  /** Tell the assistant which picture is on screen.
   *
   *  Only the search words and the picture's own caption travel — the assistant
   *  cannot see the image, and must not be led into pretending otherwise. The
   *  reminder is repeated on every open because this is exactly the moment the
   *  model is most tempted to describe what it "knows" a giraffe looks like. */
  const announce = useCallback(
    (picture: PictureSearchResult) => {
      // AI-facing, so English — the same convention PhotosApp.announce follows.
      const what = picture.title
        ? `a web picture captioned "${picture.title}"`
        : `an untitled web picture`;
      sendContextOnly?.(
        `[PICTURES] The student is looking at ${what}, from the search for "${query}". ` +
          `You cannot see it. Talk about what was searched for — never describe details of this picture.`,
      );
    },
    [sendContextOnly, query],
  );

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => results.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [results, page],
  );

  const open = useCallback(
    (index: number) => {
      setOpenIndex(index);
      announce(results[index]);
    },
    [results, announce],
  );

  const step = useCallback(
    (delta: number) => {
      setOpenIndex((current) => {
        if (current === null) return current;
        const next = current + delta;
        if (next < 0 || next >= results.length) return current;
        setPage(Math.floor(next / PAGE_SIZE));
        announce(results[next]);
        return next;
      });
    },
    [results, announce],
  );

  const title = query
    ? t("pictureSearchApp.titleFor", { query })
    : t("pictureSearchApp.title");

  // ── Empty ───────────────────────────────────────────────────────────────
  // Two different empties, and telling a student the wrong one is a small lie:
  //   no query  → they tapped the tile and nothing has been searched yet. This
  //               is the ASK, and it is why the server opens the app at all on
  //               a bare tap: a press that changes nothing on screen is the one
  //               outcome an eyegaze user cannot recover from.
  //   a query   → the search genuinely found nothing (the server normally says
  //               so without opening, so this is a belt-and-braces path).
  if (results.length === 0) {
    return (
      <ViewerShell title={title} onClose={onClose} closeLabel={t("pictureSearchApp.close")}>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
          {query ? <ImageOff className="w-16 h-16 text-white/30" /> : <Search className="w-16 h-16 text-white/30" />}
          <span className="text-white/70 text-xl">
            {query ? t("pictureSearchApp.empty") : t("pictureSearchApp.askMe")}
          </span>
        </div>
      </ViewerShell>
    );
  }

  // ── Viewer ──────────────────────────────────────────────────────────────
  if (openIndex !== null) {
    const picture = results[openIndex];
    return (
      <ViewerShell
        title={picture.title || title}
        onClose={onClose}
        closeLabel={t("pictureSearchApp.close")}
      >
        <div className="flex-1 min-h-0 flex items-stretch gap-2 p-2">
          <ViewerNav
            direction="prev"
            label={t("pictureSearchApp.previous")}
            disabled={openIndex === 0}
            onClick={() => step(-1)}
          />

          <ViewerImage
            src={apiUrl(picture.displayPath)}
            alt={picture.title || title}
            onError={() => markBroken(picture.id)}
            fallback={
              broken.has(picture.id) ? (
                <div className="flex flex-col items-center gap-3 text-white/50">
                  <ImageOff className="w-14 h-14" />
                  <span className="text-lg">{t("pictureSearchApp.pictureFailed")}</span>
                </div>
              ) : undefined
            }
          />

          <ViewerNav
            direction="next"
            label={t("pictureSearchApp.next")}
            disabled={openIndex === results.length - 1}
            onClick={() => step(1)}
          />
        </div>

        {/* Where it came from. Small, but present: a picture pulled off a
            stranger's website should say so, not masquerade as the student's
            own. */}
        {picture.sourceDomain && (
          <div className="shrink-0 px-4 pb-1 text-center text-white/40 text-sm truncate">
            {t("pictureSearchApp.source", { domain: picture.sourceDomain })}
          </div>
        )}

        {/* Back to the grid — a separate, large target rather than a corner X,
            because leaving one picture is a different intent from leaving the app. */}
        <div className="shrink-0 px-2 pb-2">
          <button
            type="button"
            data-dwell
            onClick={() => setOpenIndex(null)}
            className="w-full h-16 rounded-2xl bg-gray-700 hover:bg-gray-600 active:scale-[0.98] transition-all text-white text-xl font-semibold flex items-center justify-center gap-2"
            aria-label={t("pictureSearchApp.backToAll")}
          >
            <LayoutGrid className="w-6 h-6" /> {t("pictureSearchApp.backToAll")}
          </button>
        </div>
      </ViewerShell>
    );
  }

  // ── Browse ──────────────────────────────────────────────────────────────
  return (
    <ViewerShell title={title} onClose={onClose} closeLabel={t("pictureSearchApp.close")}>
      <div
        className="flex-1 min-h-0 px-3 pb-2 grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {pageItems.map((picture, i) => (
          <button
            key={picture.id}
            type="button"
            data-dwell
            onClick={() => open(page * PAGE_SIZE + i)}
            className="min-h-0 min-w-0 flex flex-col rounded-2xl overflow-hidden bg-gray-800 hover:bg-gray-700 active:scale-95 transition-all"
            aria-label={picture.title || t("pictureSearchApp.untitled")}
          >
            <span className="relative flex-1 min-h-0 w-full bg-black flex items-center justify-center">
              {broken.has(picture.id) ? (
                <ImageOff className="w-10 h-10 text-white/25" />
              ) : (
                <img
                  src={apiUrl(picture.thumbPath)}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  loading="lazy"
                  onError={() => markBroken(picture.id)}
                />
              )}
            </span>
            {picture.title && (
              <span className="px-2 py-1.5 shrink-0 text-white text-base font-medium truncate w-full">
                {picture.title}
              </span>
            )}
          </button>
        ))}
        {/* Keep the grid geometry stable on a short last page, so a dwell target
            never jumps position between pages. */}
        {Array.from({ length: PAGE_SIZE - pageItems.length }).map((_, i) => (
          <div key={`empty-${i}`} className="min-h-0 min-w-0" />
        ))}
      </div>

      {totalPages > 1 && (
        <PagerStrip
          page={page}
          totalPages={totalPages}
          onPage={setPage}
          previousLabel={t("pictureSearchApp.previousPage")}
          nextLabel={t("pictureSearchApp.nextPage")}
        />
      )}
    </ViewerShell>
  );
}

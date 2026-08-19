// client-aac/src/components/apps/PhotosApp.tsx
//
// The student-facing family photo album — planning-docs/aac-photos-plan.md §6.
//
// Two surfaces off one fetch:
//   BROWSE — a paginated grid of thumbnails, one dwell target each.
//   VIEW   — one photo filling the screen, with large prev/next/close targets.
//
// The point of the feature is not the looking, it is the TALKING: opening a
// photo pushes its caption to the AI via sendContextOnly, so the assistant can
// say "that's Grandma at your birthday" instead of letting the student stare at
// a picture in silence. An uncaptioned photo deliberately reports itself as
// uncaptioned rather than unnamed, so the assistant knows not to guess a name —
// naming the wrong relative to a student who cannot correct you is worse than
// saying nothing.
//
// Eyegaze: every control is a host [data-dwell] button, which is what the shared
// EyeTrackingDwell engine looks for. No local dwell loop — one driver only.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Images, Loader2 } from "lucide-react";
import { PagerStrip, ViewerImage, ViewerNav, ViewerShell } from "./photo-viewer-chrome";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { matchPhoto } from "@shared/photo-match";

interface StudentPhoto {
  photoId: string;
  caption: string | null;
  aiDescription: string | null;
  width: number | null;
  height: number | null;
  scope: "student" | "institute";
  thumbUrl: string;
  displayUrl: string;
}

interface PhotosResponse {
  photos: StudentPhoto[];
  urlTtlSeconds: number;
}

/** Grid shape. Deliberately coarse — these are dwell targets for a student who
 *  may be aiming with their eyes, not a desktop photo manager. */
const GRID_COLS = 3;
const GRID_ROWS = 2;
const PAGE_SIZE = GRID_COLS * GRID_ROWS;

export interface PhotosAppProps {
  studentId: string;
  /** A photo the SERVER already resolved from the AI's query. When present it
   *  wins over `query`: the server has already told the assistant which photo is
   *  on screen, so re-matching here could disagree with what was announced. */
  photoId?: string;
  /** Raw caption fragment, for entry points that did not resolve server-side
   *  (a client-initiated launch). Matched with the same shared matcher. */
  query?: string;
  onClose: () => void;
  sendContextOnly?: (text: string) => void;
}

export function PhotosApp({ studentId, photoId, query, onClose, sendContextOnly }: PhotosAppProps) {
  const { t } = useLanguage();
  const [photos, setPhotos] = useState<StudentPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/aac/photos?studentId=${encodeURIComponent(studentId)}`);
        const body: PhotosResponse = await res.json();
        if (cancelled) return;
        setPhotos(body.photos ?? []);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [studentId]);

  /** Tell the AI which photo is on screen. The caption is the whole payload —
   *  it is what the assistant is allowed to say about this picture. */
  const announce = useCallback(
    (photo: StudentPhoto) => {
      sendContextOnly?.(
        photo.caption
          ? `[PHOTOS] The student is looking at a photo captioned "${photo.caption}". Talk about it warmly.`
          : `[PHOTOS] The student is looking at a photo that has NO caption. ` +
            `Do not guess who or what is in it — invite them to tell you about it instead.`,
      );
    },
    [sendContextOnly],
  );

  // Open straight to the photo the AI asked for, when there is one.
  //
  // A server-resolved `photoId` takes precedence over `query`: by the time this
  // renders, the coordinator has already told the Speaker which photo is on
  // screen, so re-deriving it here could put a different one up than the one
  // being talked about. `announce` is skipped in that case for the same reason —
  // the server already injected the context.
  useEffect(() => {
    if (loading || photos.length === 0 || openIndex !== null) return;

    if (photoId) {
      const index = photos.findIndex((p) => p.photoId === photoId);
      if (index >= 0) {
        setOpenIndex(index);
        setPage(Math.floor(index / PAGE_SIZE));
        return;
      }
      // Resolved id not in the list (deleted or hidden between resolve and
      // render) — fall through to browse rather than showing the wrong photo.
      return;
    }

    const match = matchPhoto(photos, query);
    if (!match) return;
    const index = photos.indexOf(match);
    setOpenIndex(index);
    setPage(Math.floor(index / PAGE_SIZE));
    announce(match);
    // Only ever fires once per load: openIndex is non-null afterwards.
  }, [loading, photos, photoId, query, openIndex, announce]);

  const totalPages = Math.max(1, Math.ceil(photos.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => photos.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [photos, page],
  );

  const open = useCallback(
    (index: number) => {
      setOpenIndex(index);
      announce(photos[index]);
    },
    [photos, announce],
  );

  const step = useCallback(
    (delta: number) => {
      setOpenIndex((current) => {
        if (current === null) return current;
        const next = current + delta;
        if (next < 0 || next >= photos.length) return current;
        setPage(Math.floor(next / PAGE_SIZE));
        announce(photos[next]);
        return next;
      });
    },
    [photos, announce],
  );

  // ── States ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <ViewerShell title={t("photosApp.title")} onClose={onClose} closeLabel={t("photosApp.close")}>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-10 h-10 animate-spin text-white/60" />
        </div>
      </ViewerShell>
    );
  }

  if (failed || photos.length === 0) {
    return (
      <ViewerShell title={t("photosApp.title")} onClose={onClose} closeLabel={t("photosApp.close")}>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
          <Images className="w-16 h-16 text-white/30" />
          <span className="text-white/70 text-xl">
            {failed ? t("photosApp.loadFailed") : t("photosApp.empty")}
          </span>
        </div>
      </ViewerShell>
    );
  }

  // ── Viewer ──────────────────────────────────────────────────────────────
  if (openIndex !== null) {
    const photo = photos[openIndex];
    return (
      <ViewerShell
        title={photo.caption || t("photosApp.uncaptioned")}
        onClose={onClose}
        closeLabel={t("photosApp.close")}
      >
        <div className="flex-1 min-h-0 flex items-stretch gap-2 p-2">
          <ViewerNav
            direction="prev"
            label={t("photosApp.previous")}
            disabled={openIndex === 0}
            onClick={() => step(-1)}
          />

          <ViewerImage
            src={photo.displayUrl}
            alt={photo.caption || t("photosApp.uncaptioned")}
          />

          <ViewerNav
            direction="next"
            label={t("photosApp.next")}
            disabled={openIndex === photos.length - 1}
            onClick={() => step(1)}
          />
        </div>

        {/* Back to the grid — a separate, large target rather than a corner X,
            because leaving one photo is a different intent from leaving the app. */}
        <div className="shrink-0 px-2 pb-2">
          <button
            type="button"
            data-dwell
            onClick={() => setOpenIndex(null)}
            className="w-full h-16 rounded-2xl bg-gray-700 hover:bg-gray-600 active:scale-[0.98] transition-all text-white text-xl font-semibold flex items-center justify-center gap-2"
            aria-label={t("photosApp.backToAll")}
          >
            <Images className="w-6 h-6" /> {t("photosApp.backToAll")}
          </button>
        </div>
      </ViewerShell>
    );
  }

  // ── Browse ──────────────────────────────────────────────────────────────
  return (
    <ViewerShell title={t("photosApp.title")} onClose={onClose} closeLabel={t("photosApp.close")}>
      <div
        className="flex-1 min-h-0 px-3 pb-2 grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {pageItems.map((photo, i) => (
          <button
            key={photo.photoId}
            type="button"
            data-dwell
            onClick={() => open(page * PAGE_SIZE + i)}
            className="min-h-0 min-w-0 flex flex-col rounded-2xl overflow-hidden bg-gray-800 hover:bg-gray-700 active:scale-95 transition-all"
            aria-label={photo.caption || t("photosApp.uncaptioned")}
          >
            <span className="relative flex-1 min-h-0 w-full bg-black">
              <img
                src={photo.thumbUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
              />
            </span>
            {photo.caption && (
              <span className="px-2 py-1.5 shrink-0 text-white text-base font-medium truncate w-full">
                {photo.caption}
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
          previousLabel={t("photosApp.previousPage")}
          nextLabel={t("photosApp.nextPage")}
        />
      )}
    </ViewerShell>
  );
}

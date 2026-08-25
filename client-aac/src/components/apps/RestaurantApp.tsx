// client-aac/src/components/apps/RestaurantApp.tsx
//
// THE RESTAURANT APP — three lanes, and the SERVER picks which one opens.
//
// The CARETAKER lane (this file) does the three things that happen at a table:
//
//   1. Which restaurant is this?   — GPS, then the picker
//   2. Get its menu                — photograph it, or look it up
//   3. Hand it back to the student — one press opens the menu board
//
// It is deliberately plain and text-heavy, unlike everything else in this
// client, and NOTHING in it is dwellable. A board is designed for a child who
// cannot read; this is designed for an adult holding a phone in a noisy
// restaurant, and dressing it up as an AAC board would make it worse at both
// jobs. Confirming which venue we are at is also the step that attaches a menu
// to a kitchen (§3.1a), so it stays a deliberate adult touch.
//
// The STUDENT lanes are MenuLane (the venue's menu, and the generic eating-out
// words behind a toggle) and FoodBrowseLane ("what do you want to eat?"). Both
// are dwellable and glyph-first; neither binds anything.
//
// The floor board is one of THIS APP'S screens, not one of the student's
// boards. It used to be registered in `availableBoards`, which put it in the
// Board Manager's <prebuilt_boards> list competing with the boards a clinician
// actually built for the child, in every session where the feature was on.
//
// ──────────────────────────────────────────────────────────────────────────────────
// THE MODE ARRIVES IN THE PAYLOAD
//
// This is an APP, opened by `open_app("restaurant", <food>)` from the Speaker or
// from a Board Manager launch button, and its startup payload already says
// which lane to show — resolved server-side, where the facts are (is a venue
// bound? did its menu pass review? may this student browse?). The client does
// not choose, and does not probe: a screen that guessed and then corrected
// itself would flash the wrong lane at a child who cannot ask what happened.
//
// See planning-docs/aac-restaurant-menus.md §4.1, §4.3, §4.6.

import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import type { RestaurantAppPayload } from "@shared/venue-cuisine";
import type { ParsedBoardData } from "@shared/schema";
import { FoodBrowseLane } from "./FoodBrowseLane";
import { MenuLane } from "./MenuLane";

interface VenueCandidate {
  venue: { id: string; name: string; address?: string | null };
  distanceM: number;
  visitedBefore: boolean;
  hasMenu: boolean;
}

interface RestaurantAppProps {
  studentId?: string;
  onClose: () => void;
  /** Tell the AI what happened, without speaking it to the student. */
  sendContextOnly?: (text: string) => void;
  /** The startup payload from `open_app`. Carries the mode and its data. */
  payload?: RestaurantAppPayload;
  /** Voice a student-lane press exactly as a board button press is voiced. */
  onSpeak?: (label: string, sentence: string) => void;
  /**
   * Re-open the app with a fresh payload. Used after a capture lands approved:
   * the menu now exists, and the resolver will pick menu mode on the way back
   * in — so nothing here has to know how to build a board.
   */
  onReopen?: (data?: string) => void;
  /** Per-student rendering settings, passed through to the menu board. */
  language?: string;
  iconTextRatio?: number;
  selectionMethod?: any;
  restSpace?: any;
}

type Phase = "start" | "picking" | "chosen";

/** Base64 without the data-URL prefix — what the capture endpoint wants. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

type Lane = "menu" | "floor" | "search" | "caretaker";

export function RestaurantApp({
  studentId,
  onClose,
  sendContextOnly,
  payload,
  onSpeak,
  onReopen,
  language,
  iconTextRatio,
  selectionMethod,
  restSpace,
}: RestaurantAppProps) {
  const { t } = useLanguage();

  // The server already decided. A missing payload means the app was opened by
  // some path that did not resolve one, and the adult's screen is the only
  // honest default — it is the one lane that works with no data at all.
  const [lane, setLane] = useState<Lane>(payload?.mode ?? "caretaker");

  const [phase, setPhase] = useState<Phase>("start");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<VenueCandidate[]>([]);
  const [chosen, setChosen] = useState<VenueCandidate | null>(null);
  const [sources, setSources] = useState({ camera: true, web: false, manual: true });
  /** An APPROVED menu exists for the chosen venue, so the board has something
   *  on it. A `pending_review` capture deliberately does not set this: the
   *  student must not order from a menu nobody has checked. */
  const [menuReady, setMenuReady] = useState(false);

  /** Translate an `error:CODE` body, falling back to a generic message. */
  const showError = async (response: Response) => {
    let code: string | null = null;
    try {
      const body = await response.json();
      const message = String(body?.message ?? "");
      code = message.startsWith("error:") ? message.slice(6) : null;
    } catch {
      /* a non-JSON failure — the generic message is right */
    }
    setError(code ? t(`errors.${code}`) : t("aac.restaurant.failed"));
  };

  // ── 1. Where are we? ──────────────────────────────────────────────────────

  const findNearby = () => {
    if (!studentId) return;
    setError(null);
    setNote(null);
    setBusy("locate");

    if (!navigator.geolocation) {
      setBusy(null);
      setError(t("aac.restaurant.noLocation"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          // The coordinate goes in the BODY, never a query string.
          const response = await apiRequest("POST", "/api/venue-menus/nearby", {
            studentId,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            // This press IS the caretaker asking, which is what unlocks the
            // one outbound search tier.
            allowOutboundSearch: true,
          });

          if (!response.ok) {
            await showError(response);
            return;
          }

          const data = await response.json();
          setSources(data.sources ?? sources);
          setCandidates(data.candidates ?? []);

          if (!data.candidates?.length) {
            setNote(t("aac.restaurant.noneFound"));
            return;
          }

          // `resolved` is non-null only when the server was willing to decide
          // without us. Otherwise the picker is the answer, not a fallback.
          if (data.resolved) {
            setChosen(data.resolved);
            setPhase("chosen");
          } else {
            setPhase("picking");
          }
        } catch {
          setError(t("aac.restaurant.failed"));
        } finally {
          setBusy(null);
        }
      },
      () => {
        setBusy(null);
        setError(t("aac.restaurant.noLocation"));
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const choose = async (candidate: VenueCandidate) => {
    if (!studentId) return;
    setBusy("choose");
    setError(null);
    try {
      const response = await apiRequest("POST", `/api/students/${studentId}/venues`, {
        venueId: candidate.venue.id,
      });
      if (!response.ok) {
        await showError(response);
        return;
      }
      setChosen(candidate);
      setPhase("chosen");
      // Second visit: the menu is already cached and approved, so there is
      // nothing to photograph — hand it straight over.
      setMenuReady(candidate.hasMenu);
      sendContextOnly?.(`We are at ${candidate.venue.name}.`);
    } finally {
      setBusy(null);
    }
  };

  // ── 2. Get the menu ───────────────────────────────────────────────────────

  const capture = async (files: FileList | null) => {
    if (!files?.length || !studentId || !chosen) return;
    setBusy("capture");
    setError(null);
    setNote(null);

    try {
      // MAX_FRAMES on the server is 8; beyond that a caretaker is
      // photographing the wallpaper.
      const frames = await Promise.all(Array.from(files).slice(0, 8).map(readAsBase64));

      const response = await apiRequest("POST", "/api/venue-menus/capture", {
        studentId,
        venueId: chosen.venue.id,
        frames,
      });

      if (!response.ok) {
        await showError(response);
        return;
      }

      const data = await response.json();
      setMenuReady(data.status === "approved");
      setNote(
        data.status === "approved"
          ? t("aac.restaurant.captureReady", { count: String(data.itemCount) })
          : t("aac.restaurant.captureNeedsReview", { count: String(data.itemCount) }),
      );
    } catch {
      setError(t("aac.restaurant.failed"));
    } finally {
      setBusy(null);
    }
  };

  const fetchOnline = async () => {
    if (!studentId || !chosen) return;
    setBusy("web");
    setError(null);
    setNote(null);

    try {
      const response = await apiRequest("POST", "/api/venue-menus/fetch-web", {
        studentId,
        venueId: chosen.venue.id,
      });

      if (!response.ok) {
        await showError(response);
        return;
      }

      const data = await response.json();
      setMenuReady(data.status === "approved");
      setNote(
        data.status === "approved"
          ? t("aac.restaurant.captureReady", { count: String(data.itemCount) })
          : t("aac.restaurant.captureNeedsReview", { count: String(data.itemCount) }),
      );
    } catch {
      setError(t("aac.restaurant.failed"));
    } finally {
      setBusy(null);
    }
  };

  // ── 3. Hand it back ───────────────────────────────────────────────────────

  // ── Render ────────────────────────────────────────────────────────────────

  const button =
    "w-full rounded-xl px-4 py-3 text-base font-medium disabled:opacity-50 " +
    "bg-blue-600 text-white active:bg-blue-700";

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white dark:bg-gray-900 p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">{t("aac.restaurant.title")}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700"
          data-testid="restaurant-close"
        >
          {t("common.close")}
        </button>
      </div>

      {(lane === "menu" || lane === "floor") && (payload?.menuBoard || payload?.floorBoard) ? (
        <MenuLane
          venueName={payload.venueName}
          menuBoard={payload.menuBoard as ParsedBoardData | undefined}
          floorBoard={payload.floorBoard as ParsedBoardData | undefined}
          initial={lane === "menu" ? "menu" : "floor"}
          onSpeak={onSpeak}
          onSwitchToCaretaker={() => setLane("caretaker")}
          language={language}
          iconTextRatio={iconTextRatio}
          selectionMethod={selectionMethod}
          restSpace={restSpace}
        />
      ) : lane === "search" ? (
        <FoodBrowseLane
          studentId={studentId}
          initialCategories={payload?.categories}
          initialPlaces={payload?.places}
          initialFood={payload?.food ?? null}
          // False when the clinician left venue searching off. The grid still
          // renders in full and still speaks — only the places half is withheld.
          canSearch={payload?.canSearch !== false}
          onSpeak={onSpeak}
          onSwitchToCaretaker={() => setLane("caretaker")}
          onDisabled={() => setLane("caretaker")}
          // The four per-student rendering settings. MenuLane has always been
          // given these; this lane was not, so every one of them was silently
          // dropped for the whole browse half of the app.
          language={language}
          iconTextRatio={iconTextRatio}
          selectionMethod={selectionMethod}
          restSpace={restSpace}
        />
      ) : (
        <>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        {t("aac.restaurant.forCaretaker")}
      </p>

      {phase === "start" && (
        <button
          type="button"
          className={button}
          disabled={busy !== null}
          onClick={findNearby}
          data-testid="restaurant-find"
        >
          {busy === "locate" ? t("aac.restaurant.locating") : t("aac.restaurant.findNearby")}
        </button>
      )}

      {phase === "picking" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("aac.restaurant.whichOne")}</p>
          {candidates.map((candidate) => (
            <button
              key={candidate.venue.id}
              type="button"
              disabled={busy !== null}
              onClick={() => choose(candidate)}
              className="w-full rounded-xl border p-3 text-start disabled:opacity-50"
              data-testid={`restaurant-candidate-${candidate.venue.id}`}
            >
              <div className="font-medium">{candidate.venue.name}</div>
              <div className="text-xs text-gray-500">
                {candidate.distanceM}m
                {candidate.visitedBefore ? ` · ${t("aac.restaurant.beenHere")}` : ""}
                {candidate.hasMenu ? ` · ${t("aac.restaurant.hasMenu")}` : ""}
              </div>
            </button>
          ))}
        </div>
      )}

      {phase === "chosen" && chosen && (
        <div className="space-y-3">
          <div className="rounded-xl border p-3">
            <div className="font-medium">{chosen.venue.name}</div>
            {chosen.venue.address && (
              <div className="text-xs text-gray-500">{chosen.venue.address}</div>
            )}
          </div>

          {/* The handover, FIRST — once a menu is ready it is the only thing
              on this screen anyone still wants. Green rather than blue so it
              reads as the finished step, not another source to try.
              It RE-OPENS the app rather than pushing a screen: the resolver
              will now find the menu and pick menu mode, so the one place that
              decides what a student sees stays the one place. */}
          {menuReady && onReopen && (
            <button
              type="button"
              className={`${button} bg-green-600 active:bg-green-700`}
              onClick={() => onReopen()}
              data-testid="restaurant-open-menu"
            >
              {t("aac.restaurant.openMenu")}
            </button>
          )}

          {sources.camera && (
            <label className={`${button} block text-center cursor-pointer`}>
              {busy === "capture"
                ? t("aac.restaurant.reading")
                : t("aac.restaurant.photograph")}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                disabled={busy !== null}
                onChange={(e) => capture(e.target.files)}
                data-testid="restaurant-capture"
              />
            </label>
          )}

          {sources.web && (
            <button
              type="button"
              className={`${button} bg-gray-600 active:bg-gray-700`}
              disabled={busy !== null}
              onClick={fetchOnline}
              data-testid="restaurant-fetch-web"
            >
              {busy === "web" ? t("aac.restaurant.searching") : t("aac.restaurant.findOnline")}
            </button>
          )}

          <button
            type="button"
            className="w-full rounded-xl border px-4 py-2 text-sm"
            onClick={() => setPhase("picking")}
            data-testid="restaurant-change-venue"
          >
            {t("aac.restaurant.changeVenue")}
          </button>
        </div>
      )}

      {note && (
        <p className="mt-4 rounded-lg bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-200">
          {note}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
        </>
      )}
    </div>
  );
}

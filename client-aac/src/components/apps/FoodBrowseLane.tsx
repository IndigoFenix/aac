// client-aac/src/components/apps/FoodBrowseLane.tsx
//
// THE STUDENT'S HALF of the restaurant app — "what do you want to eat?".
//
// Everything else in RestaurantApp is built for the companion holding the device.
// This lane is built for the child, and the difference is not decoration:
//
//   - it renders through the ORDINARY BOARD RENDERER, so it is a real AAC
//     surface rather than a grid that looks like one;
//   - every press SPEAKS. That is the point of the lane. Finding a pizzeria is
//     useful, but saying "I want pizza" is the thing an AAC device is for.
//
// 🚨 ONE PRESS, ONE VOICE. The lane passes `suppressLocalSpeech` and voices
// every utterance itself through `onSpeak`, which is the student-voice TTS path
// every other button in this client uses. Without it the renderer ALSO spoke
// the press through browser speechSynthesis — and it speaks `spokenText ||
// label`, which on this board was the raw registry key. So a Hebrew child
// pressing 🍦 heard a Hebrew voice attempt "ice_cream" and then, a beat later,
// the real sentence in the real voice (reported 2026-09-01: "it reads it both
// locally AND with the server voice"). Hence `spokenText` below, and hence the
// back button — which is navigation, not an utterance — saying nothing at all.
//
// ⚠️ `spokenText` is also what the renderer puts in `data-speech`, which is what
// the AUDIO SCAN reads. Without it, pressing the ear button (or the automatic
// scan firing on a hunting gaze) read the twelve raw keys aloud in sequence —
// "pizza, burger, ice_cream, falafel, noodles…" — to a student whose board was
// otherwise entirely in Hebrew. Same reported session. A registry key is a
// lookup token; it must never reach a speaker.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS RENDERS WITH `DynamicBoard` (the same argument MenuLane makes)
//
// This lane used to hand-roll its own `grid-cols-4` of `<button>`s with an
// emoji and a `text-sm` word inside each. It looked approximately right and was
// wrong in every way that matters to the child using it, because a hand-rolled
// grid silently drops every per-student rendering setting:
//
//   - `iconTextRatio` — how big the picture is relative to the word. A student
//     who cannot read runs at 1 and got the same `text-4xl`/`text-sm` split as
//     a student who reads fluently.
//   - `restSpace` — the dead zone that stops a gaze landing on a button while
//     crossing the screen. Without it a browse grid is a minefield for an
//     eyegaze user, and rest space is a STUDENT setting, never a per-screen one.
//   - `selectionMethod` — dwell vs. switch vs. touch.
//   - RTL — a Hebrew student read the grid left-to-right.
//   - button sizing — the renderer sizes buttons to fill the available area;
//     a fixed `aspect-square p-3` does not, which is why twelve tiles came out
//     small on a tablet.
//
// None of that was visible from this file, which is exactly the problem: the
// settings were not overridden here, they were never plumbed in at all. Handing
// the board to the renderer is not a shortcut, it is the only way a screen in
// this client is actually the child's screen.
//
// ─────────────────────────────────────────────────────────────────────────────
// PRESSING A PLACE IS A WANT, NOT AN ARRIVAL
//
// Choosing "Pizza Roma" here says *I would like to go to Pizza Roma*. It does
// not bind a menu, and the endpoint behind it cannot: binding stays with the
// caretaker's confirmation tap, because that tap is what stops a menu being
// attached to the wrong kitchen. See venue-browse-service.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GRID IS A VOCABULARY BOARD, AND IT NEVER SWITCHES ITSELF OFF
//
// It renders in full with no position, and it renders in full when a clinician
// has not enabled venue searching (`canSearch === false`) — in that case the
// places half simply never appears. "I want pizza" at home is a sentence a
// child is entitled to say, and gating it on a GPS fix or on a search
// permission would be a vocabulary board that switches itself off indoors.
//
// ─────────────────────────────────────────────────────────────────────────────
// "NOWHERE NEAR US HAS THAT" IS A CLAIM ABOUT THE WORLD
//
// It may only be shown after a search actually ran. Not knowing where we are —
// the student's `deviceLocationEnabled` is off, the reading failed, or it has
// not landed yet — is a different sentence, and the lane says that one instead.
// The two were conflated, so a child who pressed 🍕 with location off was told,
// on screen and then out loud by the Speaker, that no pizza place was near him.
// Nobody had looked.
//
// See planning-docs/aac-restaurant-menus.md §4.1.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { getCurrentGps, mayReadDeviceLocation } from "@/lib/geolocation";
import { getHost } from "@/lib/platform";
import { useLanguage } from "@/contexts/LanguageContext";
import { CUISINE_CATEGORIES } from "@shared/venue-cuisine";
import { getVocabularyItem } from "@shared/glyph-registry";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import DynamicBoard from "@/components/DynamicBoard";

interface BrowsePlace {
  venueId: string;
  name: string;
  distanceM: number;
  visitedBefore: boolean;
  hasMenu: boolean;
}

interface FoodBrowseLaneProps {
  studentId?: string;
  /**
   * What the server already found when it resolved the app open.
   *
   * The lane does NOT search on mount. `open_app` resolved the mode and did the
   * lookup in the same pass, so mounting and immediately re-asking would spend
   * a second round trip to learn what we were just told. An EMPTY array is
   * meaningful and distinct from undefined: it means the server looked and
   * found no position, so the full grid shows.
   */
  initialCategories?: Array<{ key: string; emoji: string; count: number }>;
  initialPlaces?: BrowsePlace[];
  /** A food the AI named, so the lane opens on it rather than on the grid. */
  initialFood?: string | null;
  /**
   * May this student look for PLACES? False when the clinician left "Student
   * can look for somewhere to eat" off — the food grid still works in full and
   * still speaks, there is just nothing to search. See restaurant-app-open.ts.
   */
  canSearch?: boolean;
  /**
   * Per-student `deviceLocationEnabled`. Independent of `canSearch`: that one
   * asks whether this child may look for places at all, this one asks whether
   * the device may say where it is. Either being off withholds the places half
   * and nothing else — the grid still renders in full and still speaks.
   */
  locationEnabled?: boolean;
  /**
   * Did the SERVER know where the student was when it resolved the open?
   *
   * Only meaningful alongside `initialFood`, where the lane opens straight on
   * the places view: it says whether an empty `initialPlaces` means "we looked
   * and found nothing" or "no search ran". The lane's own presses answer this
   * for themselves — see `located`.
   */
  positionKnown?: boolean;
  /**
   * The server is FETCHING this venue's menu right now. The lane shows a
   * "getting the menu…" pane; the server pushes a fresh payload when the fetch
   * settles (the menu, or `menuFetchFailed`), so this screen always resolves.
   * The local backstop below is the net for a push that never comes.
   */
  fetchingMenuFor?: string;
  /** A fetch for this venue's menu just finished with nothing to show. */
  menuFetchFailed?: string;
  /** Voice a press the way a board button is voiced — student's voice, and the
   *  AI is told. `label` is what was pressed; `sentence` is what is said. */
  onSpeak?: (label: string, sentence: string) => void;
  /**
   * Open THIS venue's menu, by re-opening the app through the server with a
   * `venue:<id>` token. Only called for a place that already HAS an approved
   * menu. The press still speaks the want first — the sentence is the point of
   * the lane — and the resolver still applies every gate (approval, staleness,
   * allergen filter) before anything reaches the screen. Nothing binds.
   */
  onOpenVenueMenu?: (venueId: string) => void;
  /** Hand the device to the companion. Deliberately not dwellable — see below. */
  onSwitchToCaretaker: () => void;
  /** Reported once, so the parent can fall back to the caretaker lane when a
   *  clinician has not enabled student browsing for this child. */
  onDisabled?: () => void;
  /** Per-student rendering settings. These are the whole reason this lane
   *  renders through the board renderer — see the header. */
  language?: string;
  iconTextRatio?: number;
  selectionMethod?: any;
  restSpace?: any;
}

/** A position, or null when we could not get one. Never an error to the
 *  student: the grid works either way.
 *
 *  Goes through getCurrentGps rather than navigator.geolocation directly, so it
 *  inherits the watchdog: the platform `timeout` alone is not enough, because a
 *  host with no location usage-description key fires NEITHER callback and the
 *  promise never settles (docs/IPAD_BUILD.md). */
function currentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  return getCurrentGps().then((gps) =>
    gps ? { latitude: gps.latitude, longitude: gps.longitude } : null,
  );
}

/**
 * Lay `count` buttons out in as square a grid as fits.
 *
 * The renderer sizes buttons to fill the board area, so the grid shape IS the
 * button size — three places should be three big buttons, not three small ones
 * in a row of four. Capped at 4 columns because past that the buttons get
 * narrow enough that a gaze cannot separate them.
 */
function gridFor(count: number): { rows: number; cols: number } {
  if (count <= 0) return { rows: 1, cols: 1 };
  const cols = Math.min(4, Math.ceil(Math.sqrt(count)));
  return { rows: Math.ceil(count / cols), cols };
}

export function FoodBrowseLane({
  studentId,
  initialCategories,
  initialPlaces,
  initialFood,
  canSearch = true,
  locationEnabled = false,
  positionKnown,
  fetchingMenuFor,
  menuFetchFailed,
  onSpeak,
  onOpenVenueMenu,
  onSwitchToCaretaker,
  onDisabled,
  language,
  iconTextRatio,
  selectionMethod,
  restSpace,
}: FoodBrowseLaneProps) {
  const { t } = useLanguage();

  const [gps, setGps] = useState<{ latitude: number; longitude: number } | null>(null);
  /** Category keys with something behind them, or null for "show them all" —
   *  which is what an empty server result means: it looked and had no position
   *  to look from, so filtering to "nearby" would filter on nothing.
   *
   *  Derived, not state: it only ever comes from the open payload. It was a
   *  useState whose setter nothing ever called, which reads as "this narrows as
   *  you browse" and does not. */
  const available = useMemo<Set<string> | null>(
    () =>
      initialCategories && initialCategories.length
        ? new Set(initialCategories.map((c) => c.key))
        : null,
    [initialCategories],
  );
  const [chosenFood, setChosenFood] = useState<string | null>(initialFood ?? null);
  const [places, setPlaces] = useState<BrowsePlace[]>(initialPlaces ?? []);
  const [busy, setBusy] = useState(false);
  /**
   * Did the search behind the CURRENT places view actually run?
   *
   * `null` — nothing has been asked yet. `false` — we do not know where we
   * are, so an empty list means nothing. `true` — a real search happened and
   * an empty list is a fact about the street.
   *
   * Seeded from the server's own answer, because with `initialFood` the lane
   * opens on the places view without ever running a search of its own.
   */
  const [located, setLocated] = useState<boolean | null>(
    initialFood ? positionKnown ?? null : null,
  );
  /**
   * The in-flight position read.
   *
   * A GPS fix can take seconds and a child can press well inside that window.
   * The press used to read the `gps` STATE, find it still null, and return
   * without searching or saying so — and nothing re-ran it when the fix landed,
   * so the whole visit stayed unsearchable. Awaiting the promise makes an early
   * press slow rather than silently empty.
   */
  const gpsPendingRef = useRef<Promise<{ latitude: number; longitude: number } | null> | null>(null);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await apiRequest("POST", "/api/venue-menus/browse", body);
      if (response.status === 403) {
        onDisabled?.();
        return null;
      }
      if (!response.ok) return null;
      return response.json();
    },
    [onDisabled],
  );

  // A position for the presses that come NEXT, not for this render — the
  // server already did the lookup when it resolved the app open, and its answer
  // is in `initialCategories`. Pressing a food type is what needs coordinates,
  // and asking for them now means the press does not wait on a GPS fix.
  //
  // Skipped entirely when this student may not search, or when the clinician
  // has not enabled device location: asking a child's device where it is to
  // support a lookup that will never happen is a permission prompt bought for
  // nothing. The grid itself is unaffected either way — see the header.
  useEffect(() => {
    if (!canSearch) return;
    if (!mayReadDeviceLocation({ enabled: locationEnabled, host: getHost() })) return;
    let cancelled = false;
    const pending = currentPosition();
    gpsPendingRef.current = pending;
    void pending.then((position) => {
      if (!cancelled) setGps(position);
    });
    return () => {
      cancelled = true;
    };
  }, [canSearch, locationEnabled]);

  const pressFood = async (key: string) => {
    const food = t(`aac.glyph.${key}`);
    // Speak FIRST. The search may take a second and may find nothing; the
    // sentence is the part the student actually asked for, and it must not
    // wait on a network call to be voiced.
    onSpeak?.(food, t("aac.restaurant.wantFood", { food }));

    // Vocabulary-only: the press said the thing, which is the whole point. Stay
    // on the grid so the next press is one look away instead of behind a back
    // button, and never show a places view that cannot be filled.
    if (!canSearch) return;

    setChosenFood(key);
    setPlaces([]);
    setLocated(null);

    if (!studentId) return;
    setBusy(true);
    try {
      // The fix may still be in flight — see gpsPendingRef. `gps` first so a
      // second press costs nothing.
      const position = gps ?? (await gpsPendingRef.current) ?? null;
      if (position && !gps) setGps(position);
      if (!position) {
        // We never looked, and the screen must not pretend otherwise.
        setLocated(false);
        return;
      }
      setLocated(true);
      const data = await post({ studentId, ...position, category: key });
      setPlaces(data?.places ?? []);
    } finally {
      setBusy(false);
    }
  };

  const pressPlace = (place: BrowsePlace) => {
    // A venue name is a proper noun and is spoken as written — the same rule
    // the menu board follows for dish names.
    onSpeak?.(place.name, t("aac.restaurant.wantToGo", { place: place.name }));
    // ALWAYS to the server, deterministic (`venue:<id>` rides the reopen) —
    // never via the AI hearing the sentence: the Speaker romanizes Hebrew
    // venue names in its tool call ("Triola" for "טריולה", observed live
    // 2026-09-01), which matches nothing and reset the app to the food grid.
    // The server decides what the press gets: the cached menu, a
    // "getting the menu…" screen while it fetches one, or a plain "couldn't"
    // — every one of them a visible change. This used to be gated on
    // `place.hasMenu`, and since nothing HAD a menu yet, a place press
    // produced no screen change, no spinner, and no failure: three invisible
    // outcomes in a row, which to the student is a dead button.
    onOpenVenueMenu?.(place.venueId);
  };

  const showAll = available === null;
  const categories = useMemo(
    () => CUISINE_CATEGORIES.filter((c) => showAll || available!.has(c.key)),
    [showAll, available],
  );

  /** The food grid, as a real board. */
  const foodBoard = useMemo<ParsedBoardData>(() => {
    const { rows, cols } = gridFor(categories.length);
    const buttons: BoardButton[] = categories.map((category, i) => {
      // The registry entry is what gives the button its picture. Every cuisine
      // key is registered; `getVocabularyItem` is how the emoji fallback is
      // found when generated art is not ready, exactly as the floor board does.
      const item = getVocabularyItem(category.key);
      const emoji = item?.emoji ?? category.emoji;
      return {
        id: `food_${category.key}`,
        row: Math.floor(i / cols),
        col: i % cols,
        label: category.key,
        glyph: category.key,
        // The server-built floor board bakes English and lets the client
        // localize; this board is built ON the client, but the same flag is
        // what makes the renderer show `aac.glyph.<key>` rather than the raw
        // key, so a Hebrew student sees Hebrew and not "ice_cream".
        localizeFromGlyph: true,
        // What this button SAYS, in the student's language. `label` is the raw
        // key — that is what `localizeFromGlyph` needs — and the press path
        // falls back to the label when there is no `spokenText`, so without
        // this line the voice said "ice_cream". A registry key is a lookup
        // token, never a word anybody says.
        spokenText: t(`aac.glyph.${category.key}`),
        ...(emoji ? { glyphFallback: emoji, iconRef: emoji } : {}),
        action: { type: "speak" as const, text: category.key },
      } as BoardButton;
    });
    return {
      name: t("aac.restaurant.whatToEat"),
      grid: { rows, cols },
      pages: [{ id: "food_page_main", name: "Main", buttons }],
    };
  }, [categories, t]);

  /** The places grid, as a real board. */
  const placesBoard = useMemo<ParsedBoardData | null>(() => {
    if (!chosenFood) return null;
    // The back button is a board button too, so it is the same size as
    // everything else and reachable by the same selection method. It used to be
    // a `text-base` strip under the grid.
    const count = places.length + 1;
    const { rows, cols } = gridFor(count);
    const foodItem = getVocabularyItem(chosenFood);

    const buttons: BoardButton[] = places.map((place, i) => ({
      id: `place_${place.venueId}`,
      row: Math.floor(i / cols),
      col: i % cols,
      // A place button used to be pure text — a name and a distance, no picture
      // at all, on a screen for a child who may not read. It carries the glyph
      // of the food they just asked for: it is not a picture OF this restaurant
      // (we have none), but it says what the button is about, which is the job.
      label: place.name,
      glyph: chosenFood,
      // NOT localizeFromGlyph: the label is a proper noun. Localizing would
      // turn "Pizza Roma" into the word "pizza".
      ...(foodItem?.emoji ? { glyphFallback: foodItem.emoji, iconRef: foodItem.emoji } : {}),
      spokenText: place.name,
      sentence: t("aac.restaurant.wantToGo", { place: place.name }),
      action: { type: "speak" as const, text: place.name },
    } as BoardButton));

    // "Back to the food grid", drawn as FOOD rather than as an arrow.
    //
    // `back` is not a registry key, so it would have rendered as the raw
    // fallback — and the obvious fallback, a ◀️, is a directional emoji. Those
    // are mirrored in RTL by default in this client, so it would point the
    // wrong way for a Hebrew or Arabic student exactly half the time depending
    // on how the mirroring rule landed. `food` is registered, translated in all
    // 11 locales, non-directional, and says what is on the other side of the
    // press, which is what the child needs to know.
    const backIndex = places.length;
    const backItem = getVocabularyItem("food");
    buttons.push({
      id: "food_back",
      row: Math.floor(backIndex / cols),
      col: backIndex % cols,
      label: t("aac.restaurant.backToFood"),
      glyph: "food",
      ...(backItem?.emoji ? { glyphFallback: backItem.emoji, iconRef: backItem.emoji } : {}),
      // Navigation, not an utterance — the handler below intercepts it and it
      // is never passed to `onSpeak`. Nothing voices it either, because the
      // board runs with `suppressLocalSpeech`; before that the renderer read
      // the LABEL aloud, so going back announced "Something else" to the room.
      action: { type: "speak" as const, text: "" },
    } as BoardButton);

    return {
      name: t(`aac.glyph.${chosenFood}`),
      grid: { rows, cols },
      pages: [{ id: "places_page_main", name: "Main", buttons }],
    };
  }, [chosenFood, places, t]);

  const showingPlaces = !!chosenFood && canSearch;

  // The net under the fetching screen: the server GUARANTEES a completion
  // push (menu or failure), but a dropped socket must not leave a child
  // staring at a spinner forever. After 90s — comfortably past the fetch's
  // own worst case — the pane flips to the failure text on its own.
  const [fetchTimedOut, setFetchTimedOut] = useState(false);
  useEffect(() => {
    if (!fetchingMenuFor) return;
    setFetchTimedOut(false);
    const timer = setTimeout(() => setFetchTimedOut(true), 90_000);
    return () => clearTimeout(timer);
  }, [fetchingMenuFor]);

  // ── The "getting the menu…" pane. A whole-lane state, not a banner: the
  //    student asked for ONE thing and this is its answer in progress. ──
  if (fetchingMenuFor && !fetchTimedOut) {
    return (
      <div className="flex flex-col h-full min-h-0 items-center justify-center gap-4">
        <div className="h-14 w-14 animate-spin rounded-full border-4 border-gray-300 border-t-blue-500" />
        <p className="text-xl font-medium text-center text-gray-700 dark:text-gray-200">
          {t("aac.restaurant.fetchingMenu", { place: fetchingMenuFor })}
        </p>
      </div>
    );
  }

  const failedPlace = fetchTimedOut ? fetchingMenuFor : menuFetchFailed;

  return (
    <div className="flex flex-col h-full min-h-0">
      <h2 className="text-xl font-semibold mb-2 text-center">
        {showingPlaces ? t(`aac.glyph.${chosenFood}`) : t("aac.restaurant.whatToEat")}
      </h2>

      {/* The fetch ended with nothing to show. Said, not silent — a press
          whose outcome is invisible reads as a dead button, and the Speaker
          is saying the same sentence out loud. */}
      {failedPlace && (
        <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-center text-base text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t("aac.restaurant.menuUnavailable", { place: failedPlace })}
        </p>
      )}

      {/* A REAL loading state, not a caption. While the places search runs the
          board below would be one lonely back button — which is what a student
          saw and read as "it found nothing" (2026-09-01). The board is withheld
          until there is an answer to show. */}
      {showingPlaces && busy && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-blue-500" />
          <p className="text-lg font-medium text-gray-700 dark:text-gray-200">
            {t("aac.restaurant.searching")}
          </p>
        </div>
      )}
      {/* Two different sentences, and the difference is the point — see the
          header. `located === false` means no search ran; only a search that
          ran may report an empty street. */}
      {showingPlaces && !busy && places.length === 0 && (
        <p className="text-center text-sm text-gray-500 mb-1">
          {located === false
            ? t("aac.restaurant.dontKnowWhere")
            : t("aac.restaurant.nothingNearby")}
        </p>
      )}

      {/* One renderer for both grids. `min-h-0` matters: without it the flex
          child refuses to shrink and the board renders off the bottom.
          Hidden while the places search runs — the loading view above holds
          the space instead. */}
      <div className={busy && showingPlaces ? "hidden" : "flex-1 min-h-0"}>
        <DynamicBoard
          board={showingPlaces ? placesBoard : foodBoard}
          language={language}
          iconTextRatio={iconTextRatio}
          selectionMethod={selectionMethod}
          restSpace={restSpace}
          // 🚨 This lane owns its own voice — see the header. `onSpeak` routes
          // every utterance through the student-voice TTS; letting the renderer
          // speak as well produced two voices per press.
          suppressLocalSpeech
          onButtonClick={(button: BoardButton) => {
            if (button.id === "food_back") {
              setChosenFood(null);
              setPlaces([]);
              return;
            }
            if (showingPlaces) {
              const place = places.find((p) => `place_${p.venueId}` === button.id);
              if (place) pressPlace(place);
              return;
            }
            void pressFood(button.id.replace(/^food_/, ""));
          }}
        />
      </div>

      {/* The way to the companion's half. NOT dwellable, on purpose: a student who
          lands there by gaze reaches a text screen they cannot use, and one of
          its buttons starts a camera. It stays a deliberate touch. */}
      <button
        type="button"
        onClick={onSwitchToCaretaker}
        className="mt-2 pt-2 text-xs text-gray-400 underline self-center shrink-0"
        data-testid="restaurant-caretaker-lane"
      >
        {t("aac.restaurant.forCompanion")}
      </button>
    </div>
  );
}

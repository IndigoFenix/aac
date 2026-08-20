/**
 * Venue-menu settings — shared by the server (discovery gating, menu
 * acquisition, board construction) and the clinician client (the AAC settings
 * editor). See planning-docs/aac-restaurant-menus.md §4.7-4.9.
 *
 * Stored as one jsonb object on `aac_settings.venue_menus`, mirroring how
 * `home_actions` / `permitted_websites` carry structured config rather than
 * spraying N boolean columns across the table.
 *
 * `normalizeVenueMenuSettings` is the single sanitization chokepoint:
 * everything downstream — discovery, the provider seam, the board builder, the
 * agent context block — reads the column through it, never raw. Same contract
 * as `normalizeHomeActions` in shared/home-actions.ts.
 *
 * These settings are deliberately EXCLUDED from the AI-editable whitelists in
 * `server/services/memory-schema/aac-settings-memory-schema.ts`. The AI may
 * surface a venue it has been told about; it must never enable location
 * search, switch on a menu source, or author a menu.
 */

import { languageLevelFromInt, type LanguageLevel } from "./aac-language-level.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How precisely the student's position is sent to an outbound POI provider. */
export type LocationSearchMode = "off" | "coarse" | "precise";

/** When a caretaker must approve a menu before the student can use it. */
export type ReviewPolicy = "never" | "web_only" | "always";

/**
 * The stored form of a policy that can defer to the student's age.
 * `'auto'` is STORED, not computed — resolution happens at read time
 * (`resolveVenueMenuSettings`) so a student's settings stay correct as they
 * age, instead of freezing whatever was true the day a clinician last opened
 * the settings page.
 */
export type ReviewPolicySetting = ReviewPolicy | "auto";
export type ShowPricesSetting = boolean | "auto";

export interface VenueMenuSettings {
  /** Master switch. Everything else is inert while this is false. */
  enabled: boolean;

  // ── Discovery ──
  locationSearch: LocationSearchMode;
  /** Metres. Clamped to [MIN_SEARCH_RADIUS_M, MAX_SEARCH_RADIUS_M]. */
  searchRadiusM: number;
  providers: {
    /** Overpass/OSM — free tier. */
    osm: boolean;
    /** Bright Data Google Maps Scraper API — paid, and the only tier that
     *  yields the per-place `website` field the binding check needs. */
    brightData: boolean;
  };

  // ── Menu sources (independently switchable) ──
  sources: {
    camera: boolean;
    web: boolean;
    manual: boolean;
  };

  // ── Trust ──
  /** Caretaker taps WHICH venue before any menu opens. The food-court fix. */
  requireVenueConfirmation: boolean;
  requireReview: ReviewPolicySetting;
  /** Days before a cached menu is treated as stale. 0 = never stale. */
  maxMenuAgeDays: number;
  /** Tell the caretaker when a menu is the chain's rather than the branch's. */
  showBranchDisclaimer: boolean;
  /**
   * A student with recorded allergies gets every venue board reviewed, whatever
   * the age-derived policy says.
   *
   * Here rather than hardcoded because it is a decision ABOUT A STUDENT, and
   * per-student decisions live in AAC settings. On by default: the allergen
   * filter reads whatever text the source carried, and on a menu of bare names
   * (the Wolt shape) its silence means very little — see
   * `AllergenFilterResult.uninspectableCount`.
   */
  requireReviewWithAllergies: boolean;

  // ── Board ──
  readingModeDefault: boolean;
  showPrices: ShowPricesSetting;
  categoryPages: boolean;
  /** Advisory display only — NEVER a safety gate. See resolveAllergenPolicy. */
  showDietaryTags: boolean;
}

/** The same settings with every `'auto'` resolved to a concrete value. */
export interface ResolvedVenueMenuSettings extends Omit<VenueMenuSettings, "requireReview" | "showPrices"> {
  requireReview: ReviewPolicy;
  showPrices: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_SEARCH_RADIUS_M = 50;
export const MAX_SEARCH_RADIUS_M = 500;

/**
 * Age at which prices appear by default. Money work starts around school year
 * 2-3, so 8 is the line. Reasoned, not measured — a one-line constant on
 * purpose, so a clinician can move it once there is real usage to argue from.
 */
export const PRICE_MIN_AGE = 8;

/**
 * Age at which review relaxes from 'always' to 'web_only'. Same caveat as
 * PRICE_MIN_AGE: reasoned, not measured.
 */
export const REVIEW_RELAX_AGE = 12;

const LOCATION_SEARCH_MODES: readonly LocationSearchMode[] = ["off", "coarse", "precise"];
const REVIEW_POLICIES: readonly ReviewPolicy[] = ["never", "web_only", "always"];

/**
 * Defaults. The feature is OFF, and every default leans conservative:
 * location precise (see §5 — coarsening destroys venue disambiguation, and the
 * privacy property that matters is that the request carries no identifier),
 * paid provider off, web source off, confirmation on, review deferred to age.
 */
export const DEFAULT_VENUE_MENU_SETTINGS: VenueMenuSettings = {
  enabled: false,
  locationSearch: "precise",
  searchRadiusM: 150, // NEAR_RADIUS_M from shared/location-matching
  providers: { osm: true, brightData: false },
  sources: { camera: true, web: false, manual: true },
  requireVenueConfirmation: true,
  requireReview: "auto",
  maxMenuAgeDays: 30,
  showBranchDisclaimer: true,
  requireReviewWithAllergies: true,
  readingModeDefault: true,
  showPrices: "auto",
  categoryPages: true,
  showDietaryTags: false,
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** `'auto'` is a legal stored value here, so it can't go through `oneOf`. */
function reviewSetting(value: unknown, fallback: ReviewPolicySetting): ReviewPolicySetting {
  if (value === "auto") return "auto";
  if (typeof value === "string" && (REVIEW_POLICIES as readonly string[]).includes(value)) {
    return value as ReviewPolicy;
  }
  return fallback;
}

/** Same, for the boolean-or-`'auto'` shape. */
function pricesSetting(value: unknown, fallback: ShowPricesSetting): ShowPricesSetting {
  if (value === "auto") return "auto";
  if (typeof value === "boolean") return value;
  return fallback;
}

/**
 * Sanitize the raw jsonb column into a complete settings object.
 *
 * Unknown keys are DROPPED rather than carried through — a stale key from an
 * older shape must never survive into code that thinks it means something.
 * Absent or malformed input yields the documented defaults.
 */
export function normalizeVenueMenuSettings(raw: unknown): VenueMenuSettings {
  const d = DEFAULT_VENUE_MENU_SETTINGS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d, providers: { ...d.providers }, sources: { ...d.sources } };

  const r = raw as Record<string, unknown>;
  const providers = (r.providers && typeof r.providers === "object" ? r.providers : {}) as Record<string, unknown>;
  const sources = (r.sources && typeof r.sources === "object" ? r.sources : {}) as Record<string, unknown>;

  return {
    enabled: bool(r.enabled, d.enabled),

    locationSearch: oneOf(r.locationSearch, LOCATION_SEARCH_MODES, d.locationSearch),
    searchRadiusM: clampInt(r.searchRadiusM, MIN_SEARCH_RADIUS_M, MAX_SEARCH_RADIUS_M, d.searchRadiusM),
    providers: {
      osm: bool(providers.osm, d.providers.osm),
      brightData: bool(providers.brightData, d.providers.brightData),
    },

    sources: {
      camera: bool(sources.camera, d.sources.camera),
      web: bool(sources.web, d.sources.web),
      manual: bool(sources.manual, d.sources.manual),
    },

    requireVenueConfirmation: bool(r.requireVenueConfirmation, d.requireVenueConfirmation),
    requireReview: reviewSetting(r.requireReview, d.requireReview),
    // 0 is meaningful ("never stale"), so it must survive the clamp.
    maxMenuAgeDays: clampInt(r.maxMenuAgeDays, 0, 3650, d.maxMenuAgeDays),
    showBranchDisclaimer: bool(r.showBranchDisclaimer, d.showBranchDisclaimer),
    requireReviewWithAllergies: bool(r.requireReviewWithAllergies, d.requireReviewWithAllergies),

    readingModeDefault: bool(r.readingModeDefault, d.readingModeDefault),
    showPrices: pricesSetting(r.showPrices, d.showPrices),
    categoryPages: bool(r.categoryPages, d.categoryPages),
    showDietaryTags: bool(r.showDietaryTags, d.showDietaryTags),
  };
}

// ---------------------------------------------------------------------------
// Age-derived defaults (§4.8)
// ---------------------------------------------------------------------------

/**
 * Calendar age in whole years, or null when the birth date is absent or
 * unparseable. `students.birthDate` is nullable, so null is a real case and
 * NOT an error.
 */
export function ageInYears(birthDate: string | Date | null | undefined, now: Date): number | null {
  if (!birthDate) return null;
  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;

  let age = now.getFullYear() - dob.getFullYear();
  const monthDelta = now.getMonth() - dob.getMonth();
  // Birthday has not landed yet this year.
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age < 0 ? null : age;
}

/**
 * Resolve the `'auto'` policies from the student's age, with a clinical guard.
 *
 * Age is the requested axis for both. For PRICES that is straightforwardly
 * right — money is developmental.
 *
 * For REVIEW it needs a guard. Review protects against the student being shown
 * an item the restaurant does not serve; what actually matters is whether they
 * can NOTICE it and SAY SO. In this population age tracks that poorly — a
 * 17-year-old with Rett's at `single_words` has no more repair capacity than a
 * 6-year-old, and a pure age table would hand them the looser tier. So the
 * resolution takes the MORE CAUTIOUS of the age-derived and
 * languageLevel-derived answers.
 *
 * Missing data fails cautious: a null birth date resolves to 'always' with no
 * prices. Unknown age is never treated as adult.
 *
 * `now` is injected rather than read so tests do not drift as the clock moves.
 */
export function resolveAutoDefaults(
  birthDate: string | Date | null | undefined,
  languageLevel: LanguageLevel | number | null | undefined,
  now: Date,
): { requireReview: ReviewPolicy; showPrices: boolean } {
  const age = ageInYears(birthDate, now);

  const level: LanguageLevel =
    typeof languageLevel === "number" || languageLevel == null
      ? languageLevelFromInt(languageLevel as number | null | undefined)
      : languageLevel;

  // Levels 1-2. A student who communicates in single words or short phrases
  // cannot mount the repair ("that's not on the menu") that makes an
  // unreviewed menu survivable, whatever their age.
  const cannotRepair = level === "single_words" || level === "short_phrases";

  const ageReview: ReviewPolicy =
    age === null || age < REVIEW_RELAX_AGE ? "always" : "web_only";

  return {
    // 'never' is selectable by a clinician but is NEVER an auto default: no
    // age makes an unreviewed web menu safe to hand a nonverbal student.
    requireReview: cannotRepair ? "always" : ageReview,
    showPrices: age !== null && age >= PRICE_MIN_AGE,
  };
}

/**
 * The settings as the rest of the system should see them: normalized, with
 * every `'auto'` resolved against this student.
 */
export function resolveVenueMenuSettings(
  raw: unknown,
  student: { birthDate?: string | Date | null; languageLevel?: number | null } | null | undefined,
  now: Date,
): ResolvedVenueMenuSettings {
  const settings = normalizeVenueMenuSettings(raw);
  const auto = resolveAutoDefaults(student?.birthDate, student?.languageLevel, now);

  return {
    ...settings,
    requireReview: settings.requireReview === "auto" ? auto.requireReview : settings.requireReview,
    showPrices: settings.showPrices === "auto" ? auto.showPrices : settings.showPrices,
  };
}

// ---------------------------------------------------------------------------
// Source gating
// ---------------------------------------------------------------------------

/**
 * Is this menu source usable right now? Folded into one place so no caller
 * has to remember that the master switch outranks the per-source toggle.
 */
export function isSourceEnabled(
  settings: VenueMenuSettings | ResolvedVenueMenuSettings,
  source: "camera" | "web" | "manual",
): boolean {
  return settings.enabled && settings.sources[source];
}

/**
 * Does a menu from this source need caretaker review before a student sees it?
 *
 * Camera menus are exempt under 'web_only' because the camera cannot suffer
 * the wrong-restaurant defect at all — the menu was physically in front of the
 * student. Gating it only adds friction to the safest path.
 */
export interface ReviewContext {
  /** The student has at least one allergy recorded on their medical record. */
  hasAllergies?: boolean;
  /** `VenueMenuSettings.requireReviewWithAllergies`. */
  requireReviewWithAllergies?: boolean;
}

export function needsReview(
  policy: ReviewPolicy,
  provenance: "camera" | "web" | "manual",
  context: ReviewContext = {},
): boolean {
  // Allergies outrank the policy, including 'never'. The allergen filter reads
  // whatever text the source carried, and on a menu of bare names its silence
  // means very little — so a human looks. This is a per-student decision and
  // therefore lives in AAC settings (`requireReviewWithAllergies`), not here.
  if (context.hasAllergies && context.requireReviewWithAllergies) return true;

  if (policy === "always") return true;
  if (policy === "never") return false;
  return provenance === "web";
}

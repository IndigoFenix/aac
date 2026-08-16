// shared/world-engine/interaction/quest/family-hud.ts
//
// The DOLLHOUSE family HUD (household-duties-and-sims-mode.md §3 "in-game UI
// later" — this is that UI's data layer). Each household member surfaces as ONE
// chip: a state EMOJI (simple and legible, deliberately not a motive bar) + a
// short name. The host samples the live need machinery every tick and pushes
// entries through the optional `QuestPresenter.family` channel; a presenter
// renders them however it likes and feeds taps back as `selectFamilyMember`
// (the chip is a STABLE eyegaze target for addressing spoken commands — a
// moving body is hard to dwell on).
//
// This module is PURE (signals in, state out) so the emoji priority ladder is
// unit-testable without booting a host.
import { iconGlyph } from "./activity-bubble.js";

/** One family member's chip. */
export interface FamilyHudEntry {
  /** Creature id (`resident_<house>_<member>`) — the `selectFamilyMember` target. */
  id: string;
  /** Short display name: the authored family member's name, else a number. */
  label: string;
  /** The ONE state emoji — what the member feels or is doing right now. */
  emoji: string;
  /** Stable state key (presenters may caption it; tests assert on it). */
  state: FamilyStateKey;
  /** This member is the ADDRESSED one — spoken commands go here. */
  selected: boolean;
  /** The body is IN THE WORLD right now. False = out of the house and past
   *  the streaming range (working, shopping, walking) — presenters dim the
   *  chip so absence is visible instead of the member silently vanishing. */
  present: boolean;
  /** WHAT BODY this member wears — the same two dials the avatar factory
   *  dresses it with (`speciesFor` / `outfitFor`): a registered species id, and
   *  the wardrobe preset index it spawned in (absent = bare, as pets and fauna
   *  run). The host resolves them because the host OWNS that resolution; a
   *  presenter that draws a member's own body (the sentence builder's creature
   *  portraits — creatures/portrait.ts) must never re-derive it. Spawn dress,
   *  not the live worn garment: an identity picture holds still. */
  species?: string;
  outfit?: number;
}

export type FamilyStateKey =
  | "commanded" // running a spoken order
  | "asleep" // arrived at the bed, sleeping it off
  | "hungry"
  | "thirsty"
  | "toilet" // the waste meter fired — needs the toilet
  | "tired"
  | "lonely"
  | "dirty" // the hygiene meter fired — wants the bath
  | "washing" // arrived at the bath, scrubbing (dwell counting down)
  | "dressing" // worn clothes are done for — fetching/putting on a clean garment
  | "laundering" // carrying dirty garments to the tub / washing them
  | "bored" // the fun meter fired — wants to play
  | "playing" // arrived at the box, playing it off
  | "tidying" // sweeping loose clutter into the box
  | "helping" // serving a housemate's surfaced want (an adoption row)
  | "stressed" // content but frayed — unmet needs have been piling up
  | "errand" // out shopping / restocking (clock trip or live provision step)
  | "working" // at a job shift
  | "content"
  | "guest" // a recruited visitor from the street (host-assigned, not the ladder)
  | "away"; // not embodied and the clock names no duty — simply out (host-assigned)

/** The live signals the host samples for one member. */
export interface FamilySignals {
  /** A spoken command's errand is still queued (direct obedience in progress). */
  commanded: boolean;
  /** The active need step, if the live loop is driving the body:
   *  `tplKey` names the motive ("hunger:food" / "thirst:water" / "energy" /
   *  "waste" / "hygiene" / "tidy" / "adopt:<wanter>|…" / "provision:*");
   *  `resting` = arrived at the station (dwell counting down). */
  step: { tplKey: string; resting: boolean } | null;
  /** Meters at threshold (the need FIRES, whether or not a step is active). */
  hungry: boolean;
  thirsty: boolean;
  toilet: boolean;
  tired: boolean;
  lonely: boolean;
  dirty: boolean;
  /** The dress meter fired — worn clothes want a change (round 3). */
  scruffy: boolean;
  bored: boolean;
  /** Derived stress at the visible level (mood.ts) — shows only when nothing
   *  else claims the chip: the "fine but fraying" face. */
  stressed?: boolean;
  /** Clock-driven absence: mid job shift, or out on the shopping cycle. */
  away: "shift" | "shopping" | null;
}

const STATE_EMOJI: Record<FamilyStateKey, string> = {
  commanded: "🏃",
  asleep: "💤",
  hungry: "🍽️",
  thirsty: "🥤",
  toilet: "🚽",
  tired: "😴",
  lonely: "🥺",
  dirty: "🛁",
  washing: "🫧",
  dressing: "👕",
  laundering: "🧼",
  bored: "🧸",
  playing: "🎮",
  tidying: "🧹",
  helping: "🤝",
  stressed: "😟",
  errand: "🧺",
  working: "💼",
  content: "😊",
  guest: "🙋",
  away: "🚶",
};

/**
 * The registered GLYPH KEY each state renders through (glyph-registry.ts) — so
 * the chip is a COMPOSED glyph image, exactly like the over-head bubbles, never
 * a raw text-node emoji. States whose meaning has bundled ARTWORK map to that
 * glyph (its image shows): commanded→run, hungry→eat, playing→play,
 * lonely→lonely, dirty→dirty, tidying→clean, away→walk. States with a matching
 * art-less vocabulary item still map to the KEY (thirsty→drink, toilet→
 * bathroom, tired→tired, dressing→wear, content→happy) so a future icon
 * upgrades them automatically. The rest (`undefined`) fall back to their own
 * STATE_EMOJI, which the compositor still renders through the glyph system.
 */
const STATE_GLYPH: Record<FamilyStateKey, string | undefined> = {
  commanded: "run",
  asleep: undefined, // 💤 — distinct from tired's 😴; no "sleep" art
  hungry: "eat",
  thirsty: "drink",
  toilet: "bathroom",
  tired: "tired",
  lonely: "lonely",
  dirty: "dirty",
  washing: undefined, // 🫧 — bathing; no washing-specific art
  dressing: "wear",
  laundering: undefined, // 🧼
  bored: undefined, // 🧸 — the authored toy cue, not the bored FACE
  playing: "play",
  tidying: "clean",
  helping: undefined, // 🤝
  stressed: undefined, // 😟 — no frayed-but-fine glyph
  errand: undefined, // 🧺 — the shopping basket; no errand art
  working: undefined, // 💼
  content: "happy",
  guest: undefined, // 🙋 / ⛺ (founding) — kept per-entry, never state-mapped
  away: "walk",
};

/**
 * The composed-glyph string a chip renders — a REGISTERED glyph key (art or its
 * own emoji) where the state maps one, else the entry's own emoji (still routed
 * THROUGH the compositor, never a bare text node). Presenters hand this to the
 * GlyphCompositor. `emoji` is the entry's live emoji so per-entry cues the state
 * ladder never sets (the founding ⛺, a commanded guest's 🏃) survive unmapped.
 */
export function familyStateGlyph(state: FamilyStateKey, emoji: string): string {
  return iconGlyph(STATE_GLYPH[state], emoji);
}

/**
 * The priority ladder: what the chip SHOWS when several things are true at
 * once. A running command wins (the student should see their word being
 * obeyed); then the active need step names the motive being served; then any
 * firing meter (hunger > thirst > toilet > energy > dress > social > hygiene >
 * fun — the same order the walker acts in); then clock absences; then a
 * frayed-but-fine face (derived stress); else content.
 */
export function familyStateOf(sig: FamilySignals): { emoji: string; state: FamilyStateKey } {
  const pick = (state: FamilyStateKey) => ({ emoji: STATE_EMOJI[state], state });
  if (sig.commanded) return pick("commanded");
  if (sig.step) {
    const k = sig.step.tplKey;
    if (k.startsWith("hunger")) return pick("hungry");
    if (k.startsWith("thirst")) return pick("thirsty");
    if (k === "waste") return pick("toilet");
    if (k === "energy") return pick(sig.step.resting ? "asleep" : "tired");
    if (k === "social") return pick("lonely");
    if (k === "hygiene") return pick(sig.step.resting ? "washing" : "dirty");
    if (k === "dress") return pick("dressing");
    if (k === "laundry") return pick("laundering");
    if (k === "tidy") return pick("tidying");
    if (k.startsWith("adopt:")) return pick("helping");
    if (k === "fun") return pick(sig.step.resting ? "playing" : "bored");
    return pick("errand"); // provision / any other supply run
  }
  if (sig.hungry) return pick("hungry");
  if (sig.thirsty) return pick("thirsty");
  if (sig.toilet) return pick("toilet");
  if (sig.tired) return pick("tired");
  if (sig.scruffy) return pick("dressing");
  if (sig.lonely) return pick("lonely");
  if (sig.dirty) return pick("dirty");
  if (sig.bored) return pick("bored");
  if (sig.away === "shift") return pick("working");
  if (sig.away === "shopping") return pick("errand");
  if (sig.stressed) return pick("stressed");
  return pick("content");
}

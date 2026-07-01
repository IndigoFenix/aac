// shared/symbol-game/types.ts
//
// Core data shapes for the Symbol Learning Adventure Game's CONTENT layer.
// See planning-docs/symbol-learning-game-plan.md.
//
// This layer is net-new (the "thin layer above the goal-tree author"): QUOTES
// (the endpoint unit) + POOLS that fill their blanks. It sits ON TOP of the
// goal-tree engine (shared/goal-tree) and the glyph system (shared/glyph-*);
// it does not re-implement either. A bound quote compiles down to ordinary
// goal-tree nodes (observe/choose/transport) that the existing solver certifies.
//
// Terminology (canonical, per server/services/memory-schema/canonical-terms.ts):
//   SYMBOL   — one image = one word (a registry key / emoji / generate: request)
//   GLYPH    — a HEAD SYMBOL + zero or more MODIFIER SYMBOLs joined by `.`
//   SENTENCE — up to three GLYPHs joined by `+`, with #-OPERATOR tags
//   QUOTE    — an authored SENTENCE template with fillable {slots} + per-locale text

// ---------------------------------------------------------------------------
// Affordance tags (NEW concept; §6.1)
// ---------------------------------------------------------------------------

/**
 * A closed set of affordances a pooled object can offer. These gate which slot
 * an object may fill and which ACTION the scene can teach with it. Where a
 * world-engine capability already implies the affordance, DERIVE it rather than
 * re-declaring (carry → graspable/transferable, contains → container, a locked
 * door's keyObjectId → openable). Tags with no world-engine analog (repeatable,
 * goal-blocked, requestable) are authored directly on the pool member.
 */
export type AffordanceTag =
  | "repeatable" // emits/acts again on demand (MORE/AGAIN)
  | "repeatable-edible" // a consumable treat
  | "repeatable-effect" // an emitter output (bubbles, sparks)
  | "graspable" // can be picked up (GET/PUT)
  | "transferable" // can be handed between agents (GIVE/TAKE)
  | "receptive-npc" // a character who can receive/respond
  | "openable" // OPEN/CLOSE
  | "container" // holds other objects (in/on/under)
  | "startable-movable" // GO/STOP vehicle
  | "ongoing-process" // a running process that can be stopped
  | "toggleable" // ON/OFF
  | "vertical-movable" // UP/DOWN
  | "goal-blocked" // a stuck agent that needs HELP
  | "goal-blocked-heavy" // a heavy load blocking an agent
  | "requestable" // can be wanted (≈ any) (WANT/DON'T-WANT)
  | "unwanted" // a plausible reject target
  | "attention-worthy" // LOOK
  | "rotatable" // TURN
  | "causative"; // MAKE

// ---------------------------------------------------------------------------
// Symbols, pools, slots (§6.2)
// ---------------------------------------------------------------------------

/** Whether a referenced SYMBOL already ships in the glyph registry (§6.5, pillar 5). */
export type GlyphStatus = "ships" | "queued";

/**
 * One concrete object that can fill a pool slot. Carries BOTH the world-facing
 * entity material (label/icon → a goal-tree EntityDef) and the SYMBOL key
 * dropped into a quote's glyph template.
 */
export interface PoolMember {
  /** Stable id; seeds the compiled goal-tree entity id. */
  id: string;
  /** Player-facing display name (in the game locale). */
  label: string;
  /** Emoji fallback for the entity. */
  iconRef?: string;
  /** The registry SYMBOL key substituted into quote {slots} (e.g. "cookie"). */
  symbol: string;
  /**
   * Author's claim about whether `symbol` exists yet. Advisory only — the binder
   * is registry-authoritative (§6.5): a `symbol` present in the registry is
   * always treated as shipped. `queued` legitimizes a not-yet-built symbol so it
   * lands on the worklist instead of erroring. Defaults to "ships".
   */
  glyphStatus?: GlyphStatus;
}

/** A pool id, used both as the slot name in templates (`{treat}`) and the pool key. */
export type PoolId = string;

/** A set of glyphed objects sharing an affordance — the fill source for one slot. */
export interface PoolDef {
  id: PoolId;
  affordance: AffordanceTag;
  members: PoolMember[];
}

// ---------------------------------------------------------------------------
// Quotes (§3)
// ---------------------------------------------------------------------------

/** A sentence-level OPERATOR tag (canonical `#` tone tags). */
export type SentenceOperator = "question" | "exclamation" | "past" | "future";

/** A concept id — the symbol/glyph a quote teaches. Free string keyed to the §5 inventory. */
export type ConceptId = string;

/** Who utters a quote: an NPC (speech bubble) or the student (board option). */
export type QuoteSpeaker = "npc" | "board";

/**
 * The authored endpoint unit. One canonical, language-agnostic glyph SENTENCE
 * template + a per-locale text key, over one shared skeleton of {slots}.
 */
export interface Quote {
  id: string;
  /**
   * Canonical SENTENCE template with `{slot}` placeholders, e.g.
   * "i_me + want + {treat}". Language-INVARIANT — stored once, never translated.
   */
  glyph: string;
  /** i18n key resolving to the per-locale text template (same {slots}). */
  textKey: string;
  /** Slot names referenced in `glyph` (each must be a PoolId present in the scene). */
  slots: PoolId[];
  speaker: QuoteSpeaker;
  concept: ConceptId;
  /** Optional sentence operator appended as `#tag`. */
  operator?: SentenceOperator;
  /**
   * Head/modifier SYMBOLs the author knows aren't in the registry yet (e.g.
   * "all_done", "come"). Not-in-registry symbols listed here go to the queued
   * worklist instead of erroring (pillar 5). Pool-supplied symbols use the
   * member's `glyphStatus` instead.
   */
  queuedSymbols?: string[];
}

/**
 * What a DO exchange asks the student to physically do (the "follow a request"
 * archetype, catalog B). Present on exchanges with no board responses; names the
 * world action the NPC instruction compiles to (§7).
 *   • fetch     — carry the RIGHT one (the named {slot}) among its pool siblings
 *                 to a goal spot; the spot shows the target's icon ("bring the
 *                 matching one"). Wrong picks are declined, not punished (§7b).
 *   • transport — carry the named {slot} to a goal spot (no choice; placement / PUT).
 *   • collect   — GATHER a group of the named {slot} (multi-pick), not selection.
 */
export type DoAction =
  | { kind: "fetch"; slot: PoolId; relation?: "on" | "in" | "under" }
  | { kind: "transport"; slot: PoolId; relation?: "on" | "in" | "under" }
  | { kind: "collect"; slot: PoolId };

/** One response option in an exchange. */
export interface QuoteResponse {
  quote: Quote; // speaker: "board"
  /** Exactly one response is `correct` unless the exchange is `intentNoKey`. */
  correct?: boolean;
}

/**
 * A prompt + response set — the real communicative event (§3.2). Compiles to a
 * goal-tree beat (observe/choose) plus the entities the binding produces.
 */
export interface QuoteExchange {
  id: string;
  concept: ConceptId;
  /** What the NPC says (speaker: "npc"). */
  prompt: Quote;
  /** What the student may answer (speaker: "board"). */
  responses: QuoteResponse[];
  /** For a DO exchange (no board responses): the world action to compile to. */
  action?: DoAction;
  /** P4 intent quote: logged with context, not scored; no fixed key (§3.4, §10). */
  intentNoKey?: boolean;
  /** Scene must contain a present-but-noncausal decoy by construction (§10). */
  needsNoncausalDecoy?: boolean;
  /** Scene must contain a comparison set by construction (§10). */
  needsComparisonSet?: boolean;
}

// ---------------------------------------------------------------------------
// Binding (§6.2): bind slots → freeze → (distractors / compile) → certify
// ---------------------------------------------------------------------------

/**
 * A frozen slot→member assignment for one scene instance. Constant across the
 * whole option set (so minimal-pair distractors vary only the slot under test).
 */
export type SlotBinding = Record<PoolId, PoolMember>;

/** A quote with its slots resolved to a concrete, parseable glyph SENTENCE. */
export interface BoundQuote {
  quote: Quote;
  binding: SlotBinding;
  /** The concrete glyph string after slot substitution + operator tag. */
  glyph: string;
}

/**
 * The outcome of checking every SYMBOL a bound quote references against the
 * registry (§6.5). `missing` is an authoring error (typo or undeclared gap);
 * `queued` is the intentional "we'll add it" worklist.
 */
export interface SymbolResolution {
  /** Symbols present in the registry. */
  resolved: string[];
  /** Not in the registry but declared queued (pool member or quote.queuedSymbols). */
  queued: string[];
  /** Not in the registry and NOT declared queued — an error; blocks authoring. */
  missing: string[];
}

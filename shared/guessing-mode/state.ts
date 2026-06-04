// shared/guessing-mode/state.ts
//
// The fuzzy narrowing engine. Pure functions over GuessingModeState:
//   - applyPress        — soft multiplicative weight update for one selection
//   - suggestNextDimension — pick the dimension to ask about next
//   - buildStateInjection  — render the [GUESSING STATE] text + suggestion keys
//
// Design note on scoring: the original plan listed
//   score = priority * (1 - normalizedEntropy)
// which is inverted — a freshly-entered dimension has MAXIMUM entropy, so that
// product is ~0 and the dimension would never be asked, meaning narrowing could
// never even start. We instead lead with priority and use (1 - entropy) only as
// a small bonus that nudges the assistant to FINISH a dimension it has partial
// evidence on before opening a new one:
//   score = priority * roleMult + PROGRESS_BONUS * (1 - normalizedEntropy)
// (see planning-docs/aac-guessing-mode → "Reconciled design (v2)").

import type {
  CustomNarrowingFact,
  DimensionDef,
  DimensionState,
  GuessingCategory,
  GuessingModeState,
  GuessingInjectionWire,
} from "./types.js";

// ─── Tunable constants (revisit after live testing) ────────────────────────
export const PRESS_MULT = 2.0;          // pressed value boost (all types)
export const CATEGORICAL_OTHER = 0.7;   // non-pressed categorical/ternary values
export const BINARY_OPPOSITE = 0.5;     // the opposite value in a binary dim
export const DESCRIPTIVE_DAMP = 0.25;   // role multiplier for descriptive dims
export const PROGRESS_BONUS = 3.0;      // entropy nudge ceiling in scoring
export const CONFIDENT_DOMINANCE = 2.0; // dominant must exceed 2× the runner-up
export const CONFIDENT_VS_UNKNOWN = 1.5;// …and 1.5× the "unknown" weight
export const READY_CONFIDENT_STEERING = 2;
export const READY_TOTAL_PRESSES = 5;
export const MAX_SUGGESTION_VALUES = 6;  // cap values surfaced per dimension

export const UNKNOWN = "unknown";

/** Sentinel key for a "none of these" press routed through `pressSuggestion`. */
export const GUESSING_REJECT = "__guessing_reject__";

// Late binding to break the dimensions ↔ state import cycle: these are only
// touched inside functions (call time), never at module-eval time (ESM live
// bindings make this safe regardless of which module loads first).
import {
  DIMENSION_BY_ID,
  DIMENSIONS_BY_CATEGORY,
  CATEGORY_VALUES,
  CATEGORY_DIM_ID,
} from "./dimensions.js";

// ─── State lifecycle ───────────────────────────────────────────────────────

export function createState(specialInterests: string[] = []): GuessingModeState {
  return {
    category: null,
    dimensions: {},
    history: [],
    specialInterests: [...specialInterests],
    turnCount: 0,
    customFacts: [],
    rejectedFacts: [],
  };
}

export function cloneState(s: GuessingModeState): GuessingModeState {
  const dimensions: Record<string, DimensionState> = {};
  for (const [id, ds] of Object.entries(s.dimensions)) {
    dimensions[id] = {
      weights: { ...ds.weights },
      dismissed: ds.dismissed,
      lastPressedTurn: ds.lastPressedTurn,
    };
  }
  return {
    category: s.category,
    dimensions,
    history: s.history.map((h) => ({ ...h, fact: h.fact ? { ...h.fact } : undefined })),
    specialInterests: [...s.specialInterests],
    turnCount: s.turnCount,
    focus: s.focus,
    expandSameDimension: s.expandSameDimension,
    justRejected: s.justRejected,
    customFacts: s.customFacts.map((f) => ({ ...f })),
    rejectedFacts: s.rejectedFacts.map((f) => ({ ...f })),
  };
}

function ensureDim(state: GuessingModeState, def: DimensionDef): DimensionState {
  let ds = state.dimensions[def.id];
  if (!ds) {
    const weights: Record<string, number> = { [UNKNOWN]: 1 };
    for (const v of def.values) weights[v] = 1;
    ds = { weights };
    state.dimensions[def.id] = ds;
  }
  return ds;
}

// ─── Dominance / confidence ─────────────────────────────────────────────────

/**
 * True when `value` is the clear leader of `dimId`: it is the strict max among
 * the dimension's values AND outweighs "unknown". Used to gate nested clusters
 * (e.g. animal sub-dimensions apply once things.kind leans "animal").
 */
export function isDominant(state: GuessingModeState, dimId: string, value: string): boolean {
  const ds = state.dimensions[dimId];
  if (!ds) return false;
  const w = ds.weights[value];
  if (w == null) return false;
  const unknown = ds.weights[UNKNOWN] ?? 1;
  if (w <= unknown) return false;
  for (const [k, v] of Object.entries(ds.weights)) {
    if (k === value || k === UNKNOWN) continue;
    if (v >= w) return false;
  }
  return true;
}

/** The current top value of a dimension (ignoring "unknown"), or null. */
export function dominantValue(state: GuessingModeState, def: DimensionDef): string | null {
  const ds = state.dimensions[def.id];
  if (!ds) return null;
  let best: string | null = null;
  let bestW = -Infinity;
  for (const v of def.values) {
    const w = ds.weights[v] ?? 1;
    if (w > bestW) {
      bestW = w;
      best = v;
    }
  }
  return best;
}

export function isConfident(state: GuessingModeState, def: DimensionDef): boolean {
  const ds = state.dimensions[def.id];
  if (!ds) return false;
  const sorted = def.values
    .map((v) => ds.weights[v] ?? 1)
    .sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  const unknown = ds.weights[UNKNOWN] ?? 1;
  if (second > 0 && top <= CONFIDENT_DOMINANCE * second) return false;
  if (top <= CONFIDENT_VS_UNKNOWN * unknown) return false;
  return true;
}

/** Shannon entropy over a dimension's distribution, normalized to [0,1]. */
function normalizedEntropy(state: GuessingModeState, def: DimensionDef): number {
  const ds = state.dimensions[def.id];
  const keys = [...def.values, UNKNOWN];
  const weights = keys.map((k) => ds?.weights[k] ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 1;
  let h = 0;
  for (const w of weights) {
    const p = w / total;
    if (p > 0) h -= p * Math.log(p);
  }
  const maxH = Math.log(keys.length);
  return maxH > 0 ? h / maxH : 1;
}

// ─── Presses ────────────────────────────────────────────────────────────────

/**
 * Apply a `suggestion:<dimId>:<value>` press. Mutates and returns `state`
 * (callers managing React state should pass a clone — see `cloneState`).
 * A `dimId` of "category" sets the mode switch instead of touching weights.
 *
 * Newest-press-wins semantics within a dimension: the dimension's weights
 * are RESET before the new press is applied, and any prior contradicting
 * knowledge about the same dimension (customFacts, rejectedFacts) is
 * cleared. This makes the user's most recent answer authoritative —
 * "is it red? yes" followed by "actually, blue" leaves the AI with
 * "blue" as the unambiguous color, not a tie. (Older soft-overwrite
 * semantics produced ties + contradictions between "Known" and "Rejected"
 * in the injection.)
 */
export function applyPress(state: GuessingModeState, dimId: string, value: string): GuessingModeState {
  state.turnCount += 1;
  state.history.push({ turn: state.turnCount, key: `${dimId}:${value}` });
  state.expandSameDimension = false;
  state.justRejected = false;

  if (dimId === CATEGORY_DIM_ID) {
    if ((CATEGORY_VALUES as string[]).includes(value)) {
      state.category = value as GuessingCategory;
      state.focus = value;
    }
    return state;
  }

  const def = DIMENSION_BY_ID[dimId];
  if (!def) return state; // unknown key — ignored (server logs it separately)
  if (!def.values.includes(value)) return state;

  // Newer knowledge overrides older about the same dimension. Clear any
  // contradicting custom or rejected entries for this dimension before
  // bumping weights, so the injection doesn't list the same dim+value
  // simultaneously in "Known" and "Rejected".
  const dimLabel = localName(dimId);
  state.customFacts = state.customFacts.filter((f) => f.dimension !== dimLabel);
  state.rejectedFacts = state.rejectedFacts.filter((f) => f.dimension !== dimLabel);

  const ds = ensureDim(state, def);
  // Hard reset weights — newest press is the sole positive signal. Without
  // this, repeated presses with different values within the same dimension
  // produce ties (PRESS_MULT × CATEGORICAL_OTHER ≈ PRESS_MULT × 1 for the
  // earlier value), so the AI sees two competing "answers" instead of the
  // user's latest pick.
  for (const v of def.values) ds.weights[v] = 1;
  ds.weights[UNKNOWN] = 1;
  ds.dismissed = false;          // user is actively pressing in this dim
  ds.lastPressedTurn = state.turnCount;

  if (def.type === "binary") {
    ds.weights[value] = PRESS_MULT;
    const opposite = def.values.find((v) => v !== value);
    if (opposite) ds.weights[opposite] = BINARY_OPPOSITE;
  } else {
    // categorical & ternary
    for (const v of def.values) {
      ds.weights[v] = v === value ? PRESS_MULT : CATEGORICAL_OTHER;
    }
  }

  state.focus = dimId.includes(".") ? dimId.slice(0, dimId.indexOf(".")) : dimId;
  return state;
}

/** "No" during a suggestion board — drop the asked dimension for this session. */
export function dismissDimension(state: GuessingModeState, dimId: string): GuessingModeState {
  const def = DIMENSION_BY_ID[dimId];
  if (def) ensureDim(state, def).dismissed = true;
  return state;
}

/**
 * Apply an AI-proposed narrowing step the user confirmed via a `[NARROW:<dim>]
 * <value>` button. Records the fact (so the AI sees it in the next
 * `[GUESSING STATE]`) and logs it in `history` so a subsequent rejection can
 * unwind it. Runs on a parallel track to the registry-driven `applyPress` —
 * custom facts do NOT touch dimension weights.
 *
 * Newest-fact-wins within the same dimension: any prior customFact OR
 * rejectedFact about the same `dimension` is removed before the new fact
 * is appended. This prevents the AI from seeing contradictory state like
 * `customFacts: [size=big, size=small]` after the user changed their mind.
 */
export function applyCustomFact(
  state: GuessingModeState,
  dimension: string,
  value: string,
  sourceText?: string,
): GuessingModeState {
  const dim = dimension.trim();
  const val = value.trim();
  if (!dim || !val) return state;
  // Newer knowledge overrides older about the same dimension.
  state.customFacts = state.customFacts.filter((f) => f.dimension !== dim);
  state.rejectedFacts = state.rejectedFacts.filter((f) => f.dimension !== dim);
  state.turnCount += 1;
  const fact: CustomNarrowingFact = {
    dimension: dim,
    value: val,
    sourceText: sourceText?.trim() || undefined,
    addedAt: state.turnCount,
  };
  state.customFacts.push(fact);
  state.history.push({ turn: state.turnCount, key: `custom:${dim}:${val}`, fact });
  state.expandSameDimension = false;
  state.justRejected = false;
  state.focus = dim;
  return state;
}

/**
 * Pop the most recent positive narrowing step (registry press OR custom fact)
 * and move it to `rejectedFacts`. The AI sees the rejection in the next
 * `[GUESSING STATE]` and is told to pivot to a different angle.
 *
 * Returns true if a fact was rejected; false if there was nothing to undo
 * (caller can fall back to `rejectCurrentDimension` in that case).
 */
export function rejectMostRecentFact(state: GuessingModeState): boolean {
  // Walk backwards looking for a positive press — skip nothing, but ignore the
  // category mode-switch press (rejecting "things" would just strand the user).
  for (let i = state.history.length - 1; i >= 0; i--) {
    const entry = state.history[i];
    if (entry.key.startsWith(`${CATEGORY_DIM_ID}:`)) continue;

    if (entry.fact) {
      // Custom fact — remove from customFacts + rejectedFacts gets the dropped one.
      const idx = state.customFacts.findIndex(
        (f) => f.dimension === entry.fact!.dimension && f.value === entry.fact!.value && f.addedAt === entry.fact!.addedAt,
      );
      if (idx >= 0) state.customFacts.splice(idx, 1);
      state.rejectedFacts.push({ ...entry.fact });
      state.history.splice(i, 1);
      state.justRejected = true;
      state.expandSameDimension = false;
      return true;
    }

    // Registry press: parse `<dimId>:<value>`, dismiss the dimension, and
    // mark the value rejected so the AI doesn't propose it again. We don't
    // unwind the weight update — pressing the dimension's other values
    // remains the more natural path forward; dismiss prevents the engine
    // from re-asking the dimension.
    const colon = entry.key.indexOf(":");
    if (colon <= 0) continue;
    const dimId = entry.key.slice(0, colon);
    const value = entry.key.slice(colon + 1);
    dismissDimension(state, dimId);
    state.rejectedFacts.push({
      dimension: localName(dimId),
      value,
      addedAt: state.turnCount + 1,
    });
    state.history.splice(i, 1);
    state.turnCount += 1;
    state.justRejected = true;
    state.expandSameDimension = false;
    return true;
  }
  return false;
}

/** "More" — ask the assistant to expand values in the same dimension next turn. */
export function flagExpand(state: GuessingModeState): GuessingModeState {
  state.expandSameDimension = true;
  return state;
}

// ─── Selection ────────────────────────────────────────────────────────────

export interface NextDimension {
  /** null + isCategory:true means "offer the top-level category buttons". */
  def: DimensionDef | null;
  isCategory: boolean;
}

function candidateDimensions(state: GuessingModeState): DimensionDef[] {
  if (!state.category) return [];
  return DIMENSIONS_BY_CATEGORY[state.category].filter((def) => {
    const ds = state.dimensions[def.id];
    if (ds?.dismissed) return false;
    if (def.applicableWhen && !def.applicableWhen(state)) return false;
    if (isConfident(state, def)) return false;
    return true;
  });
}

function score(state: GuessingModeState, def: DimensionDef): number {
  const roleMult = def.role === "descriptive" ? DESCRIPTIVE_DAMP : 1;
  const progress = 1 - normalizedEntropy(state, def);
  return def.priority * roleMult + PROGRESS_BONUS * progress;
}

export function suggestNextDimension(state: GuessingModeState): NextDimension {
  if (!state.category) return { def: null, isCategory: true };

  // "More" overrides selection: re-ask the most recently pressed dimension
  // (so the assistant offers additional values for it). The pressed dim may
  // live in a sub-namespace (e.g. animal.* while category is things).
  if (state.expandSameDimension && state.history.length) {
    for (let i = state.history.length - 1; i >= 0; i--) {
      const id = state.history[i].key.split(":")[0];
      const def = DIMENSION_BY_ID[id];
      if (def && !state.dimensions[def.id]?.dismissed) return { def, isCategory: false };
    }
  }

  const candidates = candidateDimensions(state);
  if (!candidates.length) return { def: null, isCategory: false };
  candidates.sort((a, b) => score(state, b) - score(state, a));
  return { def: candidates[0], isCategory: false };
}

/**
 * "None of these" — the user rejected the currently-offered options. Dismiss
 * the dimension being asked (so it's never suggested again this session) and
 * flag the next injection so the AI is told not to re-offer those options.
 */
export function rejectCurrentDimension(state: GuessingModeState): GuessingModeState {
  const next = suggestNextDimension(state);
  if (next.def) dismissDimension(state, next.def.id);
  state.justRejected = true;
  return state;
}

export function readyForGuesses(state: GuessingModeState): boolean {
  if (!state.category) return false;
  const confidentSteering = DIMENSIONS_BY_CATEGORY[state.category].filter(
    (def) => def.role === "steering" && isConfident(state, def),
  ).length;
  const presses = state.history.filter((h) => !h.key.startsWith(`${CATEGORY_DIM_ID}:`)).length;
  return confidentSteering >= READY_CONFIDENT_STEERING || presses >= READY_TOTAL_PRESSES;
}

// ─── Injection rendering ─────────────────────────────────────────────────

/** Strip the namespace for human-readable lines: "animal.where_found" → "where_found".
 *  Function declaration (not const arrow) so it's hoisted and usable from
 *  earlier helpers like `rejectMostRecentFact`. */
function localName(id: string) {
  return id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
}

/** Render a list of facts as "dim=value (sourceText)" entries. */
function renderFacts(facts: CustomNarrowingFact[]): string {
  return facts
    .map((f) => (f.sourceText ? `${f.dimension}=${f.value} ("${f.sourceText}")` : `${f.dimension}=${f.value}`))
    .join(", ");
}

export function buildStateInjection(state: GuessingModeState): GuessingInjectionWire {
  const lines: string[] = ["[GUESSING STATE]"];
  const next = suggestNextDimension(state);
  const customFacts = state.customFacts ?? [];
  const rejectedFacts = state.rejectedFacts ?? [];

  // Category-selection turn.
  if (next.isCategory) {
    if (state.justRejected) {
      lines.push("The user pressed 'none of these' — none of the categories fit. Ask a short, friendly clarifying question, or make a [GUESS] if you have a hunch.");
    }
    lines.push("No category chosen yet — offer the top-level category buttons.");
    const keys = CATEGORY_VALUES.map((c) => `${CATEGORY_DIM_ID}:${c}`).map((k) => `suggestion:${k}`);
    lines.push("Offer these as buttons — keys only, COMMA-separated (the system fills picture + label), never pipe-joined:");
    lines.push(`  ${keys.join(",")}`);
    if (rejectedFacts.length) {
      lines.push(`Rejected so far (do NOT propose these again): ${renderFacts(rejectedFacts)}`);
    }
    if (state.specialInterests.length) {
      lines.push(`Student's known interests: ${state.specialInterests.join(", ")}`);
    }
    lines.push(
      'You may also offer [GUESS] buttons at any time if you already have a strong hunch.',
    );
    return { text: lines.join("\n"), suggestionKeys: keys, customFacts, rejectedFacts };
  }

  const category = state.category!;
  const catDims = DIMENSIONS_BY_CATEGORY[category];

  if (state.justRejected) {
    lines.push("The user pressed 'none of these' — your last options/guesses were wrong. Do NOT repeat them. Use ALL the clues below plus what you know about this user to make a FRESH batch of DIFFERENT [GUESS] buttons (offer several), or ask about a new aspect. Keep going — do not give up.");
  }
  if (next.def?.subquestionLabel) lines.push(`Now figuring out: ${next.def.subquestionLabel}`);
  lines.push(`Category: ${category}`);

  // Known (confident) dimensions, split by role.
  const knownSteering: string[] = [];
  const knownDescriptive: string[] = [];
  for (const def of catDims) {
    if (def.applicableWhen && !def.applicableWhen(state)) continue;
    if (!isConfident(state, def)) continue;
    const dv = dominantValue(state, def);
    if (!dv) continue;
    (def.role === "descriptive" ? knownDescriptive : knownSteering).push(`${localName(def.id)}=${dv}`);
  }
  if (knownSteering.length) lines.push(`Known: ${knownSteering.join(", ")}`);
  if (knownDescriptive.length) lines.push(`Descriptive facts so far: ${knownDescriptive.join(", ")}`);

  // Unknown steering dimensions still in play.
  const unknownSteering = candidateDimensions(state)
    .filter((d) => d.role === "steering")
    .map((d) => localName(d.id));
  if (unknownSteering.length) lines.push(`Still unknown (steering): ${unknownSteering.join(", ")}`);

  // Suggested next dimension + its keys.
  let keys: string[] = [];
  if (next.def) {
    const label = next.def.subquestionLabel ?? localName(next.def.id);
    lines.push(`Suggested next dimension: ${localName(next.def.id)} — ${label}`);
    const values = next.def.values.slice(0, MAX_SUGGESTION_VALUES);
    keys = values.map((v) => `suggestion:${next.def!.id}:${v}`);
    lines.push("  Offer these as buttons — keys only, COMMA-separated (the system fills picture + label), never pipe-joined:");
    lines.push(`    ${keys.join(",")}`);
  } else {
    lines.push("No more narrowing dimensions — offer [GUESS] buttons now.");
  }

  if (customFacts.length) {
    lines.push(`Custom narrowing facts (your earlier proposals the user confirmed): ${renderFacts(customFacts)}`);
  }
  if (rejectedFacts.length) {
    lines.push(`Rejected (do NOT propose the same dimension+value again): ${renderFacts(rejectedFacts)}`);
  }

  lines.push(`Ready for guesses: ${readyForGuesses(state) ? "yes" : "not yet (still broad)"}`);
  if (state.specialInterests.length) {
    lines.push(`Student's known interests: ${state.specialInterests.join(", ")}`);
  }
  const presses = state.history.map((h) => h.key).join(", ");
  if (presses) lines.push(`Presses so far: ${state.history.length} — ${presses}`);
  lines.push(
    "You may also offer [GUESS] buttons at any time, or pick a different dimension if you have a reason to. " +
    "When the registry's `Suggested next dimension` doesn't fit the live conversation, propose your own narrowing dimension via `[NARROW:<dimension>] <value>` buttons instead (see <guessing_mode> in your role).",
  );

  return { text: lines.join("\n"), suggestionKeys: keys, customFacts, rejectedFacts };
}

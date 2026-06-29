// Cell Systems — JSON schema for a custom "enclosed system" (Step 1: the flask).
//
// This is the data model for the idle-safe rule engine we designed: a single
// cell holds named SCALARS, optional discrete STAGE attributes, and autonomous
// CLOCKS, evolved by RULES. The whole point is that any spec the validator
// (validate.ts) accepts is GUARANTEED to be "fast-forwardable" — from any state
// it either reaches rest or rides a predictable cycle, so catch-up after a long
// absence is cheap and never chaotic. The guarantees come from constraints on
// the *form* of rules, not from tuning, exactly like the terrain engine:
//
//   • a cell can only change by SPENDING a bounded, non-self-regenerating budget
//     (the energy/progress measure) or by ADVANCING a stage forward through a DAG
//     — so the number of changes is finite (→ reaches rest), and
//   • the ONLY sanctioned indefinite cycle is an autonomous fixed-rate CLOCK
//     (read-only) or an isolated ≤2-variable feedback loop (2-D ⇒ Poincaré–
//     Bendixson forbids chaos). Three mutually-coupled variables are rejected.
//
// Conditions/effects are STRUCTURED (not parsed strings) so the validator can
// read the read/write dependency graph straight off the spec.

// --- Value references ---------------------------------------------------------

/** A read-only numeric source used in guards and flow/change targets. `scalar`
 *  and `sensor` refs may carry an affine `scale`/`offset` (value = base·scale +
 *  offset) so guards like "moisture > height·0.9" are expressible. */
export type Ref =
  | { const: number }
  /** Current value of a scalar. */
  | { scalar: string; scale?: number; offset?: number }
  /** A clock's phase, normalised to [0,1). Read-only — clocks are autonomous. */
  | { clock: string }
  /** A sensor (a derived field — an aggregate of a var over a neighbourhood).
   *  Read-only; it adds no dynamics, so it can't break termination on its own. */
  | { sensor: string; scale?: number; offset?: number }
  /** EDGE RULES ONLY: an aggregate of an entity attribute over this relationship's
   *  two endpoints (read-only graph sensor — lets a relationship respond to the
   *  cities it connects). */
  | { endpoints: string; agg: 'sum' | 'min' | 'max' | 'mean' | 'absdiff'; scale?: number; offset?: number };

// --- Conditions (guards) ------------------------------------------------------

export type Cmp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type Condition =
  | { cmp: Cmp; left: Ref; right: Ref }
  /** A discrete stage attribute equals / has reached (at-or-past) a value. */
  | { stageIs: { state: string; is: string } }
  | { stageAtLeast: { state: string; is: string } }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

// --- Effects ------------------------------------------------------------------

export type Effect =
  /** One-shot constant delta to a scalar (the natural effect of a timer firing).
   *  On a budget var, autonomous rules may only use amount ≤ 0 (spend, never
   *  regenerate); raising a budget needs an `external` rule. */
  | { add: { scalar: string; amount: number } }
  /** Continuous monotone move of a scalar toward a target by a clamped fraction
   *  of the remaining gap, with ε-snap — converges and stops. The target may be
   *  a constant (always safe) or another scalar (creates a dependency edge the
   *  validator checks for feedback loops). Not allowed on a budget var. */
  | { toward: { scalar: string; target: Ref; rate: number } }
  /** Linear-coupled delta: `scalar += perStep × ((times?value:1) − offset)`,
   *  optionally clamped to `±cap`. This is what lets two variables drive each
   *  other (a predator–prey-style oscillator). With `cap` it's a capped-but-
   *  smooth trickle (`min(cap, excess)`): proportional near the threshold so it
   *  settles, throttled above — the way a spring emits at most its flow rate.
   *  Reading another scalar via `times` creates a dependency edge — the validator
   *  only permits the resulting feedback loop if it stays within an isolated
   *  ≤2-variable set (2-D ⇒ provably non-chaotic). */
  | { change: { scalar: string; perStep: number; times?: Ref; offset?: number | Ref; cap?: number } }
  /** Move a discrete stage to `to`. The validator requires `to` be at or after
   *  the current stage in the declared order (forward-only ⇒ a finite DAG). */
  | { setStage: { state: string; to: string } }
  // --- Neighbour coupling (grid only — the Step-2 transport primitives) -------
  // Both are CONSERVATIVE (material is moved, never created/destroyed) and
  // MONOTONE (each exchange moves a quantity down a gradient by a no-overshoot
  // fraction), so they have a Lyapunov function and settle for any rate. That is
  // why the coupled grid stays fast-forwardable. They are the ONLY way a rule may
  // reach another tile — free-form "read neighbour X, write my Y" is disallowed
  // (it would be a cellular automaton, i.e. possibly chaotic / unpredictable).
  /** Equalising diffusion of a scalar to the 4 neighbours (population/heat
   *  spread): a tile gives a clamped fraction of its surplus to lower neighbours.
   *  Relaxes to a flat field and stops. */
  | { spread: { scalar: string; rate: number } }
  /** Flow a scalar to neighbours with a lower SURFACE = (potential value, if
   *  given) + the scalar itself — water running downhill over a landscape, pooling
   *  in minima. `potential` names a (typically static) var; omit it to level the
   *  scalar against its own surface. `block` names a var that, where > 0.5, makes a
   *  tile a wall for this flow: it neither sends nor receives (e.g. solid stone).
   *  `drainEdge` (bounded grids only) gives the world an OUTLET: a boundary tile
   *  also sheds flow off-map whenever its surface exceeds this "sea level", so
   *  inflow can't pile up and flood — water leaves to the sea. Without it the flow
   *  is conservative (the only sink is whatever consumes the scalar elsewhere). */
  | { flowDown: { scalar: string; potential?: string; rate: number; block?: string; drainEdge?: number } }
  /** Erosion: flowing `by` (water) carries `scalar` (the SUBSTRATE itself, e.g.
   *  height) one cell DOWNSTREAM — incising channels and building deltas. Moves to
   *  the steepest-descent neighbour by SURFACE (scalar + by), only where `by` >
   *  `minFlow` and the surface drops more than `minSlope`. Amount = rate·(by −
   *  minFlow), capped by `max`, by what's present, and by HALF the surface drop
   *  (so it can never invert the slope it's grading — sand only ever moves
   *  downhill, so its potential energy strictly falls and the field settles).
   *  CONSERVATIVE. `block` tiles (stone) neither erode nor receive. */
  | { erode: { scalar: string; by: string; rate: number; minFlow?: number; minSlope?: number; max?: number; block?: string } };

// --- Rules --------------------------------------------------------------------

/** How a rule fires:
 *  - {every:true}     — evaluated every active step while `when` holds (the
 *                       continuous / step-by-step fallback). Use for flows.
 *  - {timer:N}        — when `when` first becomes true, schedule the effect N
 *                       steps in the future; on fire it is RE-VALIDATED (a timer
 *                       is a prediction). The preferred, catch-up-cheap primitive. */
export type Trigger = { every: true } | { timer: number };

export interface RuleSpec {
  id?: string;
  /** Guard; omitted = always enabled. */
  when?: Condition;
  trigger: Trigger;
  effects: Effect[];
  /** Marks a rule as driven by an EXTERNAL input (player action / a neighbour in
   *  Step 2), exempting it from the "no autonomous budget increase" rule. An
   *  external rule never fires on its own — only when the runtime is told to. */
  external?: boolean;
}

// --- Declarations -------------------------------------------------------------

export interface VarSpec {
  name: string;
  /** Hard floor & ceiling — bounding the state space is part of the termination
   *  argument (a bounded, monotone-spent budget can only fire finitely often). */
  min: number;
  max: number;
  initial: number;
  /** A budget is the system's progress measure: autonomous rules may only LOWER
   *  it (raising it requires `external:true`). The validator treats every budget
   *  as part of the Lyapunov function. At least one budget is recommended; a
   *  spec with none must rely entirely on stage-DAGs and clocks for its progress.
   *  (Receiving material from a neighbour via transport is an EXTERNAL input and
   *  may raise a budget — that is not self-regeneration.) */
  budget?: boolean;
  /** How to seed this var across a grid at creation (grid mode only). Default
   *  'flat' = `initial` everywhere. */
  init?: 'flat' | 'bowl' | 'noise' | 'centerBlob';
}

export interface ClockSpec {
  name: string;
  /** Period in world steps. Fixed at design time — a clock's rate may NEVER
   *  depend on a dynamic value (that is the chaos gateway). */
  period: number;
  /** Initial phase in steps, [0, period). Defaults to 0. */
  phase?: number;
}

export interface StageSpec {
  name: string;
  /** Ordered states. setStage may only move forward through this list, so the
   *  lifecycle is a finite DAG (Seed → Sprout → … → Dead) that cannot cycle. */
  stages: string[];
  initial: string;
}

// --- The system spec ----------------------------------------------------------

/** A SENSOR is a read-only DERIVED field: an aggregate of a var over a tile's
 *  surrounding neighbourhood. It's the "surroundings-aware" primitive (rainfall
 *  via terrain prominence; "is anything tall/crowded near me"). Because it is a
 *  pure function of current state — no dynamics of its own — it can't break
 *  termination; it only adds a wide scheduling coupling (cells within `radius`
 *  re-wake when the source var changes). On a 1×1 grid / flask it's trivial
 *  (mean = the value, prominence = 0). */
export interface SensorSpec {
  name: string;
  /** Source var aggregated. */
  of: string;
  /** mean / prominence(=value − mean) / max / min / sum over the neighbourhood. */
  op: 'mean' | 'prominence' | 'max' | 'min' | 'sum';
  /** Neighbourhood radius in tiles. */
  radius: number;
  /** Kernel for mean/prominence: 'box' (uniform) or 'cosine' (smooth edge,
   *  avoids a hard ripple at the radius). Default 'box'. */
  weight?: 'box' | 'cosine';
  /** Clamp the sensor's output to [−cap, cap]. For prominence this bounds how much
   *  "rain" a tall steep peak can catch, so inflow stays finite for any terrain. */
  cap?: number;
}

/** One render layer (composite painting for the main grid). Layers draw in order;
 *  a layer with `over` only paints where its field exceeds that threshold (so
 *  water/plant/stone overlay the substrate). `shade` applies relief shading from
 *  the field (use on a height base layer). */
export interface LayerSpec {
  field: string;
  kind?: 'var' | 'stage';
  min?: number;
  max?: number;
  from?: [number, number, number];
  to?: [number, number, number];
  over?: number;
  shade?: boolean;
}

/** How the grid renderer colours a tile. Single-field by default (the lab); the
 *  main grid uses `layers` for a composite (substrate + water + plants + stone). */
export interface DisplaySpec {
  field: string;
  kind?: 'var' | 'stage';
  min?: number;
  max?: number;
  from?: [number, number, number];
  to?: [number, number, number];
  /** Composite layers, painted in order (later on top). Overrides single-field. */
  layers?: LayerSpec[];
}

/** A player tool — a toolbar button that paints material / changes substrate on
 *  the tiles under the brush (an external input). */
export interface ToolSpec {
  id: string;
  label: string;
  /** Emoji/glyph shown on the button. */
  symbol: string;
  /** Brush radius in tiles (default ~1.5). */
  radius?: number;
  /** Scalars to add under the brush (signed — e.g. raise vs lower sand). */
  paints?: { scalar: string; amount: number }[];
  /** Or advance a discrete stage (e.g. plant a seed). */
  setStage?: { state: string; to: string };
}

export interface SystemSpec {
  id: string;
  name?: string;
  description?: string;
  vars?: VarSpec[];
  clocks?: ClockSpec[];
  states?: StageSpec[];
  /** Derived neighbourhood fields readable via {sensor} refs (grid only). */
  sensors?: SensorSpec[];
  rules: RuleSpec[];
  /** Grid-mode only: which field to visualise, and the var a click seeds. */
  display?: DisplaySpec;
  /** Player toolbar buttons (main-grid mode). */
  tools?: ToolSpec[];
}

// --- Step 3: entity / relationship layer (the cell algebra on a graph) --------
//
// A WorldSpec models sparse ENTITIES (cities) joined by RELATIONSHIPS (edges).
// Per-entity behaviour reuses the whole rule engine (a SystemSpec). Cross-entity
// interaction is the SAME two idle-safe primitives as the grid, lifted to an
// arbitrary graph: conservative diffusion ALONG EDGES (trade/migration) and a
// dissipative budget SPEND (war). So the termination/no-chaos guarantees carry
// over unchanged (they never depended on the lattice) — long-distance coupling is
// fine as long as it's conservative-monotone or budget-bounded, and no 3+ dynamic
// attributes form a feedback loop (entity AND edge attributes counted together).

/** Per-relationship attributes + their own dynamics (decay, bounded growth). Edge
 *  rules may read their two endpoints via {endpoints} refs. */
export interface EdgeSpec {
  vars?: VarSpec[];
  rules?: RuleSpec[];
}

/** Conservative diffusion of an ENTITY scalar along relationships — wealth traded,
 *  population migrating. Equalises across connected entities and settles (a
 *  Lyapunov function on any graph). `by` optionally scales the flow by an edge
 *  attribute (relationship strength). */
export interface ExchangeSpec {
  scalar: string;
  rate: number;
  by?: string;
}

/** A dissipative interaction driven by an edge attribute (hostility → war): both
 *  endpoints pay from a budget (amounts ≤ 0), and the driving attribute decays —
 *  net loss each firing ⇒ bounded ⇒ settles. */
export interface ConflictSpec {
  id?: string;
  by: string;
  threshold?: number;
  cost: { scalar: string; amount: number }[];
  /** How much to reduce the edge `by` per step while active (dissipation). */
  decay?: number;
}

/** A ROAD: an edge attribute that GROWS with the trade flowing along it (a
 *  desire path) and DECAYS when unused. Bounded growth + dissipative decay ⇒ it
 *  settles at a level matching demand. Pair with `exchange.by: <attr>` so roads
 *  also ease trade — a bounded road↔traffic loop (allowed, predictable). */
export interface RoadSpec {
  /** Edge var to build up (the road strength). */
  attr: string;
  /** Entity scalar whose per-step exchange |flow| builds the road. */
  use: string;
  /** road += rate · |flow|. */
  rate: number;
  /** road -= decay each step (fades when unused). */
  decay: number;
}

export interface WorldSpec {
  id: string;
  name?: string;
  description?: string;
  /** Per-entity attributes + rules (the rule engine, reused). */
  entity: SystemSpec;
  /** Relationship attributes + rules. */
  edge?: EdgeSpec;
  /** Shared autonomous clocks for the whole world. */
  clocks?: ClockSpec[];
  exchanges?: ExchangeSpec[];
  conflicts?: ConflictSpec[];
  roads?: RoadSpec[];
}

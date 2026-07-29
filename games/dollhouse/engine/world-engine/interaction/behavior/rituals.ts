// shared/world-engine/interaction/behavior/rituals.ts
//
// RITUALS — a social activity as CULTURE DATA, over the same generic machinery
// needs.ts established. A ritual is a DECLARED, LOCATED, MULTI-PARTY EVENT:
// something calls it, a place is chosen, participants are recruited, the things
// it needs are prepared for the heads actually coming, everyone takes their
// place, and they perform it together.
//
// ⚠️ THE LAW THIS RESTS ON: **a ritual introduces no new action.** It
// coordinates EXISTING need satisfactions in one place at one time — it
// guarantees the PLACE, the SUPPLIES and the COMPANY, and each participant's own
// need template does the performing (hunger's `consume` at the table, fun's
// `use` at the play area). A ritual that defined its own verb would be a
// hard-coded composite, which is precisely what the need-template system exists
// to avoid. Everything here is therefore about the ROSTER, the BILL and the
// CLOCK — never about what a body does when it gets there.
//
// What this replaces: meals used to be a STANDING STOCK PROBLEM. The cook row
// fired while the table held fewer than N meals and the serve row topped it up,
// so the table was a larder the household was obliged to keep full forever,
// whether or not anyone was about to eat — nobody ever DECIDED to have dinner.
// A ritual makes the decision the object: strong hunger CALLS a meal, and the
// portions cooked are the portions the heads at the table will eat.
//
// PURE (no world coordinates, no RNG, no wall-clock): the caller resolves the
// place, who is in scope, what is already there and how many stations are free —
// exactly the NeedCtx contract — and this module only chooses. Adding a ritual
// (a song, a dance, a festival) is a new data row, not new code.

// ---------------------------------------------------------------------------
// The template — data, not code
// ---------------------------------------------------------------------------

/** How a participant PUTS ITSELF at the place. A `seat` claims one fixture of
 *  `fixture` kind pulled up to the place (a chair at the table) — bounded, so
 *  the roster is bounded by the furniture. A `ring` stands around the place
 *  from any free side (the play area's `playRingSpot`) — unbounded by
 *  furniture, so only `maxHeads` and the crowding rule limit it. */
export type RitualStation = { kind: "seat"; fixture: string } | { kind: "ring" };

/** ONE call on a ritual: a need, and how far up its own meter counts.
 *
 *  `strong` DECLARES — a body this far into the need may start the ritual.
 *  `weak` only JOINS one already declared — the housemate who isn't really
 *  hungry but comes to the table because everyone else is. That asymmetry is
 *  the whole social mechanic: a ritual is called by the need that genuinely
 *  needs it, and swelled by the ones that merely like company.
 *
 *  `level` is a FRACTION of the need's own threshold, never an absolute —
 *  meters are scale-tuned per world (scale.ts), so 1 means "that need is
 *  firing" on every world and 0.5 means "halfway there". (Deliberately NOT
 *  named `at`: the template's own `at` is the ritual's PLACE, and one field
 *  name for two unrelated things is how authored rows get written wrong.) */
export interface RitualCall {
  tplKey: string;
  kind: "strong" | "weak";
  level: number;
}

/** A TIME WINDOW as fractions of the day, [from, to) — wraps past midnight
 *  (from 0.8 to 0.1 is late evening through the small hours). */
export interface RitualWindow {
  from: number;
  to: number;
}

/** A ritual as a culture declares it. */
export interface RitualTemplate {
  /** Stable key, unique per culture ("meal", "play"). */
  key: string;
  /** What calls it — see RitualCall. */
  calls: readonly RitualCall[];
  /** WHERE it happens: fixture kinds in preference order. EMPTY means the
   *  place is whatever the first participant's own satisfy CREATES — a toy set
   *  out on the floor is the play ritual's place, and there is no fixture to
   *  look for. */
  at: readonly string[];
  /** WHAT MUST BE PRESENT before the performance can begin: `perHead` units of
   *  `category` AT the place. Absent = nothing to prepare (a chat, a dance) and
   *  the gathering waits only on the heads. */
  prepare?: { category: string; perHead: number };
  station: RitualStation;
  /** ROSTER BOUNDS. `minHeads: 1` = may be performed alone; 2 makes the ritual
   *  genuinely social — it retires at the deadline rather than start solo. */
  minHeads: number;
  maxHeads: number;
  /** THE WAIT DEADLINE: seconds the gathering will wait for its heads and its
   *  supplies before starting with whoever is actually seated. It is what stops
   *  one slow (or stuck) housemate from starving the table. */
  gatherS: number;
  /** Seconds the performance itself runs. */
  performS: number;
  /** Meters every participant CLEARS by taking part, on top of whatever its own
   *  satisfy does — "eating together is company". Template keys, as
   *  `needMeters` names them. */
  relieves?: readonly string[];
  /** OPTIONAL culture time window. ⚠️ A window LOWERS THE BAR, it does not
   *  summon: inside it a WEAK call is enough to declare (suppertime — you come
   *  to the table because it is suppertime), outside it only a STRONG one. A
   *  culture gets real mealtimes without a scheduler dragging uninterested
   *  bodies across the house. */
  window?: RitualWindow;
}

// ---------------------------------------------------------------------------
// The live ritual + the resolved context
// ---------------------------------------------------------------------------

export type RitualPhase = "gather" | "perform";

/** What a body does about a ritual it is offered: OPEN one (`call`), come to
 *  one already open (`join`), or stay out (`decline`) — see `ritualAnswer`. */
export type RitualAnswer = "call" | "join" | "decline";

export interface RitualState {
  /** The template this instance runs. */
  key: string;
  /** The world id of the place — a fixture, or the set-out thing itself. */
  placeId: string;
  /** The roster, in join order. FROZEN when the performance begins. */
  heads: readonly string[];
  phase: RitualPhase;
  /** Units of `prepare.category` wanted at the place — perHead × heads. */
  bill: number;
  /** Seconds spent in the CURRENT phase. */
  phaseT: number;
}

/** One body the caller offers as a candidate/participant. */
export interface RitualBody {
  id: string;
  /** tplKey → that meter as a FRACTION of its own threshold. */
  levels: Readonly<Record<string, number>>;
  /** May this body take part HERE? The caller answers by checking the body's
   *  OWN satisfy against the place — which is what keeps a pet, whose hunger
   *  eats at its bowl, from ever being called to the table. Never enumerate
   *  species here; ask the need. */
  eligible: boolean;
  /** Is it AT its station right now (seated / ringed)? The gathering waits for
   *  every head to be true before it starts. */
  seated?: boolean;
  /** SOMEONE ASKED IT. An invitation is a PER-BODY WINDOW: it lowers this
   *  body's declare bar to a WEAK call exactly as `window` lowers everyone's at
   *  suppertime, and it lets a body with NO call at all JOIN one already
   *  declared — coming to the table because you were asked, not because you are
   *  hungry. Same rule as `window`, narrower scope, which is why an invitation
   *  needs no new template field and no new phase.
   *
   *  ⚠️ It is never a SUMMONS. `eligible` still decides (wrong species, no
   *  station, a stronger need in force), the roster bounds still bound, and the
   *  answer is still the body's own — `ritualAnswer` is where a caller asks for
   *  it, and it may well be "no". */
  invited?: boolean;
}

/** Everything the decider reads for ONE ritual, resolved fresh each step. */
export interface RitualCtx {
  /** Candidates + current participants in scope (one household). A head that
   *  is NO LONGER LISTED, or listed with `eligible: false`, has left — it went
   *  to bed, it was commanded away, the ritual lost it. */
  bodies: readonly RitualBody[];
  /** Units of `prepare.category` at the place right now. */
  ready: number;
  /** How many stations the place has at all (free + taken by this roster) — a
   *  table with three chairs seats three. */
  capacity: number;
  /** Fraction of the day (0…1), for `window`. */
  dayF: number;
}

/** What one step of a ritual DID — the edges the caller must act on. */
export interface RitualStep {
  /** The advanced ritual, or null to RETIRE it. */
  next: RitualState | null;
  /** Heads that COMPLETED the performance — their `relieves` meters clear.
   *  Only ever non-empty on the tick a perform phase ends. */
  completed: readonly string[];
  /** Bodies that joined this step — the caller claims their station. */
  joined: readonly string[];
  /** Bodies that left the roster this step — the caller releases their station. */
  left: readonly string[];
}

// ---------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------

/** Is `dayF` inside the template's window? No window = always (the window only
 *  ever lowers the bar, so "no window" cannot mean "never"). */
export function inRitualWindow(tpl: RitualTemplate, dayF: number): boolean {
  const w = tpl.window;
  if (!w) return true;
  const f = ((dayF % 1) + 1) % 1;
  // A window that wraps past midnight (from > to) is the union of two spans.
  return w.from <= w.to ? f >= w.from && f < w.to : f >= w.from || f < w.to;
}

/** Does this body meet a call of the given strength? */
function meets(tpl: RitualTemplate, body: RitualBody, kind: RitualCall["kind"]): boolean {
  for (const c of tpl.calls) {
    if (c.kind !== kind) continue;
    if ((body.levels[c.tplKey] ?? 0) >= c.level) return true;
  }
  return false;
}

/** THE DECLARE BAR: a strong call always opens a ritual; inside a culture's
 *  window — or when someone has ASKED THIS BODY — a weak one is enough.
 *
 *  ⚠️ The weak path needs the window to EXIST, not merely to be satisfied.
 *  `inRitualWindow` answers true for a template with no window (a window can
 *  only ever lower the bar, so "no window" must never read as "never"), and
 *  leaning on it here would have let a weak call declare on every template that
 *  didn't declare a window — which is every default one. `invited` is the
 *  per-body twin of that window and joins it on the SAME side of the `&&`. */
function mayDeclare(tpl: RitualTemplate, body: RitualBody, dayF: number): boolean {
  if (!body.eligible) return false;
  if (meets(tpl, body, "strong")) return true;
  const barLowered = body.invited === true || (!!tpl.window && inRitualWindow(tpl, dayF));
  return barLowered && meets(tpl, body, "weak");
}

/** Bodies whose call is strong enough to DECLARE this ritual, in ctx order
 *  (the caller orders its candidates — nearest-first, like NeedCtx). */
export function ritualCallers(tpl: RitualTemplate, ctx: RitualCtx): string[] {
  return ctx.bodies.filter((b) => mayDeclare(tpl, b, ctx.dayF)).map((b) => b.id);
}

/** How much room a live ritual has left for more heads. */
function roomIn(tpl: RitualTemplate, live: RitualState, ctx: RitualCtx): number {
  return Math.max(0, Math.min(tpl.maxHeads, ctx.capacity) - live.heads.length);
}

/** May this body join a ritual already declared? Joining is always the lower
 *  bar: the ritual exists, the food is being made, all a housemate needs is a
 *  reason to come — strong OR weak, window or not. An INVITED body needs no
 *  call at all, which is the whole of "I'm not hungry, but I'll sit with you". */
function mayJoin(tpl: RitualTemplate, body: RitualBody): boolean {
  if (!body.eligible) return false;
  return body.invited === true || meets(tpl, body, "strong") || meets(tpl, body, "weak");
}

/** Bodies that may JOIN a ritual already declared. Excludes current heads, and
 *  stops at `maxHeads` / the station capacity. */
export function ritualJoiners(tpl: RitualTemplate, live: RitualState, ctx: RitualCtx): string[] {
  const room = roomIn(tpl, live, ctx);
  if (room <= 0) return [];
  const out: string[] = [];
  for (const b of ctx.bodies) {
    if (out.length >= room) break;
    if (live.heads.includes(b.id)) continue;
    if (mayJoin(tpl, b)) out.push(b.id);
  }
  return out;
}

/** What ONE body does about this ritual, right now: open it, come to one
 *  already open, or stay out.
 *
 *  THE SINGLE SOURCE OF TRUTH FOR AN ANSWER. The host phrases it (an accepted
 *  invitation speaks its intent line, a declined one speaks "I'm not hungry"),
 *  but the DECISION lives here, so a creature's spoken answer and its actual
 *  attendance can never disagree — which is the failure mode a separately
 *  authored refusal path would have shipped on day one.
 *
 *  `live` = the ritual already running at this place, or null if none. A body
 *  already on the roster answers `join` (it is coming — it is already here). */
export function ritualAnswer(
  tpl: RitualTemplate,
  body: RitualBody,
  live: RitualState | null,
  ctx: RitualCtx,
): RitualAnswer {
  if (!body.eligible) return "decline";
  if (live) {
    if (live.heads.includes(body.id)) return "join";
    // The performance has begun: arriving late means the NEXT gathering, not a
    // re-opened bill (stepRitual freezes the roster) — so there is nothing to
    // accept, however willing the body is.
    if (live.phase !== "gather") return "decline";
    if (roomIn(tpl, live, ctx) <= 0) return "decline";
    return mayJoin(tpl, body) ? "join" : "decline";
  }
  if (ctx.capacity <= 0) return "decline"; // nowhere to put anybody
  return mayDeclare(tpl, body, ctx.dayF) ? "call" : "decline";
}

/** Units the place must hold for this roster. */
export function ritualBill(tpl: RitualTemplate, heads: number): number {
  return tpl.prepare ? tpl.prepare.perHead * heads : 0;
}

/** DECLARE a ritual at `placeId` with `caller` as its first head. The roster
 *  grows by recruitment on later steps — a ritual whose `minHeads` is 2 opens
 *  with one body and simply retires at the deadline if nobody joins, which is
 *  what "some things you cannot do alone" looks like without a special case. */
export function declareRitual(tpl: RitualTemplate, placeId: string, caller: string): RitualState {
  return { key: tpl.key, placeId, heads: [caller], phase: "gather", bill: ritualBill(tpl, 1), phaseT: 0 };
}

const bodyOf = (ctx: RitualCtx, id: string): RitualBody | undefined => ctx.bodies.find((b) => b.id === id);

/** A retirement, with whoever was on the roster released. */
const retire = (live: RitualState, completed: readonly string[] = []): RitualStep => ({
  next: null,
  completed,
  joined: [],
  left: live.heads.filter((h) => !completed.includes(h)),
});

/**
 * Advance ONE live ritual by `dt`. Re-decided every step from current state —
 * the same robustness the need walker has: lose the food and the gathering
 * waits, lose a head and the roster shrinks, lose the place and it retires.
 *
 * GATHER → PERFORM when the bill is met AND every head is at its station, or
 * when `gatherS` lapses — the deadline trims the roster to whoever is actually
 * seated AND to the portions that actually arrived, then starts if that still
 * clears `minHeads`. A ritual that cannot reach its minimum retires, and its
 * heads fall straight back to their ordinary solo satisfy, because a ritual
 * only ever SHAPED THEIR CONTEXT — it never held their bodies.
 */
export function stepRitual(tpl: RitualTemplate, live: RitualState, ctx: RitualCtx, dt: number): RitualStep {
  // A head no longer offered (or no longer eligible) has left of its own
  // accord — a stronger need fired, a command took it, it went to bed.
  const kept = live.heads.filter((h) => bodyOf(ctx, h)?.eligible === true);
  const lost = live.heads.filter((h) => !kept.includes(h));
  const phaseT = live.phaseT + dt;

  if (live.phase === "perform") {
    // The performance runs to its length. Bodies that drop out mid-meal are
    // simply not on the completion list — no relief for a meal you walked out of.
    if (kept.length < tpl.minHeads) return { ...retire({ ...live, heads: kept }), left: [...kept, ...lost] };
    if (phaseT >= tpl.performS) {
      return { next: null, completed: kept, joined: [], left: lost };
    }
    return { next: { ...live, heads: kept, phaseT }, completed: [], joined: [], left: lost };
  }

  // ── GATHER ────────────────────────────────────────────────────────────────
  // Recruit first: the bill is sized to the roster, so a body that joins now
  // gets its portion cooked. (Once the performance starts the roster freezes —
  // arriving late means the next ritual, not a re-opened bill.)
  const joined = ritualJoiners(tpl, { ...live, heads: kept }, ctx);
  const heads = [...kept, ...joined];
  if (heads.length === 0) return { next: null, completed: [], joined: [], left: lost };
  const bill = ritualBill(tpl, heads.length);
  const seated = heads.filter((h) => bodyOf(ctx, h)?.seated === true);

  const start = (roster: readonly string[]): RitualStep => ({
    next: { ...live, heads: roster, phase: "perform", bill: ritualBill(tpl, roster.length), phaseT: 0 },
    completed: [],
    joined: joined.filter((j) => roster.includes(j)),
    left: [...lost, ...heads.filter((h) => !roster.includes(h))],
  });

  // Everyone is here and the table is laid.
  if (ctx.ready >= bill && seated.length === heads.length && heads.length >= tpl.minHeads) return start(heads);

  if (phaseT >= tpl.gatherS) {
    // THE DEADLINE. Start with who is actually at the table, fed by what
    // actually arrived — a dinner where two of three portions made it feeds
    // two, rather than retiring and wasting the cooking.
    const fed = tpl.prepare && tpl.prepare.perHead > 0
      ? seated.slice(0, Math.floor(ctx.ready / tpl.prepare.perHead))
      : seated;
    if (fed.length >= tpl.minHeads) return start(fed);
    return { ...retire({ ...live, heads }, []), joined: [], left: [...lost, ...heads] };
  }

  return { next: { ...live, heads, phase: "gather", bill, phaseT }, completed: [], joined, left: lost };
}

// ---------------------------------------------------------------------------
// The kernel's default culture
// ---------------------------------------------------------------------------

/** THE MEAL. Strong hunger calls it, mild loneliness joins it; it happens at
 *  the table, in chairs, and it needs one cooked meal per head standing on the
 *  table before anyone eats. `minHeads: 1` — a lone resident still lays a place
 *  and sits down to eat, which is what "may be performed alone or in a group"
 *  means. Eating together is company: `social` clears for everyone who stays. */
export const MEAL_RITUAL: RitualTemplate = {
  key: "meal",
  calls: [
    { tplKey: "hunger:food", kind: "strong", level: 1 },
    { tplKey: "social", kind: "weak", level: 0.5 },
  ],
  at: ["table"],
  prepare: { category: "meal", perHead: 1 },
  station: { kind: "seat", fixture: "chair" },
  minHeads: 1,
  maxHeads: 4,
  gatherS: 30,
  performS: 8,
  relieves: ["social"],
};

/** PLAYING TOGETHER — the same template over the toy that is already set out.
 *  `at: []`: the place is not a fixture to be found but the thing the first
 *  player's own `use` satisfy PUT THERE (the play area), so there is nothing to
 *  prepare and nothing to sit on — the others ring it. */
export const PLAY_RITUAL: RitualTemplate = {
  key: "play",
  calls: [
    { tplKey: "fun", kind: "strong", level: 1 },
    { tplKey: "social", kind: "weak", level: 0.5 },
  ],
  at: [],
  station: { kind: "ring" },
  minHeads: 1,
  maxHeads: 4,
  gatherS: 20,
  performS: 12,
  relieves: ["social"],
};

export const DEFAULT_RITUALS: readonly RitualTemplate[] = [MEAL_RITUAL, PLAY_RITUAL];

/** Kernel defaults ⊕ a culture's authored rows: a same-key row REPLACES the
 *  default IN PLACE (order is meaning — earlier rituals get first refusal on a
 *  body), a new key APPENDS. The exact rule kernel/town/programs.ts uses for
 *  room and structure programs. */
export function resolveRituals(authored?: readonly RitualTemplate[] | null): RitualTemplate[] {
  const out = DEFAULT_RITUALS.map((r) => ({ ...r }));
  for (const row of authored ?? []) {
    const i = out.findIndex((r) => r.key === row.key);
    if (i >= 0) out[i] = { ...row };
    else out.push({ ...row });
  }
  return out;
}

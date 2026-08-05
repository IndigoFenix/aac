// shared/world-engine/interaction/quest/dwell-interaction.ts
//
// THE ONE RULE FOR WHAT A HOVER MEANS.
//
// The spark settles over exactly one thing, and THAT is the thing interacted
// with — always, no exceptions. What the interaction IS depends on only three
// facts, and nothing else may be consulted:
//
//   1. WHAT the spark is over  — a creature, an object/fixture, or bare ground
//   2. HOW LONG it has rested  — short or long
//   3. WHETHER a conversation is running — and WHO IS IN IT
//
// Everything the player can express with their eyes is one cell of that table.
// It is written here as a pure function so the rules are readable in one place
// and provable without a world, a renderer, or a session — quest-host binds it
// to the live game, and the SAME resolved target drives the spark's visual, so
// the highlight can never disagree with what a dwell would act on.
//
// A THING OR A PLACE, NEVER BOTH (user law). Whatever the spark is over decides
// which rule applies, and only one rule ever applies: hovering an object means
// THAT object, hovering an area means THAT area. Modes narrow what a cell does;
// they never add a second claim on the same hover.
//
// WHY A TABLE AND NOT FIVE GESTURES. Each interaction used to own its own read
// of the gaze plus its own preconditions — five dwells racing per frame, each
// able to discard a target the others accepted. That is how looking straight at
// a person failed to start a conversation: the talk gesture filtered candidates
// by a 7 m radius and by node-talkability BEFORE it ever asked where the player
// was looking, so a hovered body could be thrown away before the gaze was
// consulted. Reach may VETO an action; it must never decide what is aimed at.
//
// NOTE ON LOOKING AWAY. Under these rules a glance off the partner is never a
// "leave" — it is an instruction (ground ⇒ go there, object ⇒ go interact with
// that). A conversation therefore ends only on its own inactivity timeout or
// when a different one begins; there is deliberately no leave-by-looking-away
// action in this table.
//
// ═══ THE GAZE PICKS THE PARTNER, INSIDE A ROSTER ═════════════════════════════
// A conversation stopped being a pair (multi-entity-conversations.md §3f). The
// table therefore reads TWO facts about the people it is shown instead of one:
// who the player is facing (`conversingWith` — still exactly "the creature whose
// board I face"), and WHO ELSE IS IN THE CIRCLE (`members`). The same gaze law
// (talk-target.ts: whoever the player is LOOKING at wins) then splits into three
// cells, because the same long rest means three different things depending on
// which side of the roster the person is standing:
//
//   IN NO CONVERSATION, they are in one   → talk, marked `join` — the host opens
//     THEIR conversation instead of a fresh one. Walking up to a circle is
//     joining it; it was never a reason to pull somebody out of it.
//   FELLOW MEMBER of MY conversation      → `address`: they become the person I
//     am talking TO. Nothing is handed anywhere — we are already in the same
//     conversation, so there is no partner to take them from, and commanding my
//     current addressee to go attend somebody standing in the same circle would
//     break the circle to say what a look already says.
//   OUTSIDER, while I am conversing       → the old cells stand: a glance points
//     my addressee at them, a long rest hands the conversation over (`switch`).
//
// A ROSTER NEVER SILENCES AN OUTSIDER. `currentAddressee` is a no-op only for a
// FELLOW MEMBER: the host's addressee stack (addressee.ts) can name a nearest
// body or a selected family chip who is in no conversation at all, and that must
// not quietly delete the outsider cells.
//
// ALL THREE INPUTS ARE OPTIONAL AND ABSENCE IS THE OLD TABLE. A caller that
// passes no roster gets byte-identical answers to the dyadic table, including
// the absence of the `join` key itself (never `join: false`) — that is what lets
// the host adopt the new cells one at a time.

/** What the spark can be resting on. Exactly one per frame — never two. */
export type HoverKind = "creature" | "object" | "ground";

/** The resolved hover: the single thing the spark is over this frame. Ground
 *  carries no id; a creature or object carries the id it answers to. */
export interface HoverTarget {
  kind: HoverKind;
  /** Entity id — present for `creature` and `object`, absent for `ground`. */
  id?: string;
  x: number;
  y: number;
}

/** How long the spark has rested. Two lengths, deliberately: a third would stop
 *  being something a student can perform on purpose. */
export type DwellPhase = "short" | "long";

/** The live context a hover is read against. `conversingWith` is the creature
 *  whose board the player is facing right now; `members` is the roster that
 *  creature's conversation has; `buildSpot` is the marked construction spot
 *  under this frame's hover, if the player has the build word up. Those are the
 *  ONLY state that changes what a hover means. */
export interface DwellContext {
  conversingWith: string | null;
  /** THE ROSTER of the conversation the player is IN, when they are in one —
   *  every member's id, including the player's own and `conversingWith`. Absent
   *  (or empty) means "no roster known", and every cell below falls back to the
   *  dyadic reading. The order is irrelevant here; this table only asks whether
   *  a hovered body is inside the circle or outside it. */
  members?: readonly string[];
  /** Is the DWELLED creature in SOME conversation — anyone's, not necessarily
   *  the player's? Purely a discriminant: it never changes WHICH act comes back,
   *  only marks the one that does, so the host can open the conversation that
   *  already exists rather than starting a rival one. */
  targetInConversation?: boolean;
  /** The member the player is currently ADDRESSING inside their conversation.
   *  Dwelling them says nothing new (they are already being spoken to), exactly
   *  as dwelling `conversingWith` does. Only consulted for fellow members — see
   *  "A ROSTER NEVER SILENCES AN OUTSIDER" above. */
  currentAddressee?: string;
  /** BUILD MODE (⑦): is the player holding the build word, with the ground
   *  lit? While they are, a settled look is ABOUT the ground. */
  building?: boolean;
  /** The highlighted build spot the hover is over, or null for unmarked
   *  ground. Resolved by the host from the SAME point the hover reports —
   *  and only for a GROUND hover, because that is the only hover this table
   *  reads it on — so the lit spot and the acted-on spot can never disagree. */
  buildSpot?: string | null;
}

/**
 * What a settled hover does. One variant per cell of the table — the caller
 * dispatches on `act` and performs it; it never re-decides the target.
 */
export type DwellAction =
  /** Put the fixture and whatever it holds on the board. */
  | { act: "menu"; id: string }
  /** Open a conversation with this creature. `join` = this creature is ALREADY
   *  in one, so the host is being asked to seat the player in THAT conversation
   *  rather than to start a second one around the same body. Absent means "no
   *  conversation to join" — the key is never present-and-false, so an old
   *  caller's answers are unchanged down to the shape. */
  | { act: "talk"; id: string; join?: true }
  /** Hand the conversation from the current partner to this one. Carries the
   *  same `join` discriminant: leaving my circle for someone standing in another
   *  is a hand-off at this end and a JOIN at the far end. */
  | { act: "switch"; id: string; join?: true }
  /** Make this FELLOW MEMBER the player's current addressee — whom the next
   *  thing said is said TO. Never a hand-off: the roster does not change, and
   *  nobody leaves anything (multi-entity-conversations.md §3f). */
  | { act: "address"; id: string }
  /** Name the room under the point (no conversation running). */
  | { act: "room"; x: number; y: number }
  /** Send the partner to this spot. */
  | { act: "sendTo"; cid: string; x: number; y: number }
  /** Point the partner at a thing — it acts on it if it has a need for it. */
  | { act: "attendObject"; cid: string; id: string }
  /** Point the partner at another person — likewise, need-gated. */
  | { act: "attendCreature"; cid: string; id: string }
  /** Choose the marked construction spot the spark settled on — or NULL to
   *  let the last one go (the ground outside every spot is a deselection,
   *  not nothing). */
  | { act: "buildSpot"; id: string | null };

/**
 * THE TABLE. Pure: same inputs, same answers, no world access.
 *
 * Returns EVERY effect the hover has — a list, because a conversation ADDS
 * meaning rather than replacing it. Looking at a chest still puts it on the
 * board while you are talking to someone; it ALSO points your partner at it.
 * Those are not alternatives, and treating them as such broke two things at
 * once: menus stopped opening mid-conversation, and the rule that selecting a
 * menu item instructs your partner became unreachable, since the menu it needs
 * could never be open.
 *
 * Empty means the cell is deliberately silent — a glance across bare ground
 * says nothing, and looking at the partner you are already talking to (or at the
 * fellow member you are already addressing) is attention rather than an
 * instruction about anybody.
 */
export function dwellInteraction(
  target: HoverTarget | null,
  phase: DwellPhase,
  ctx: DwellContext,
): DwellAction[] {
  if (!target) return [];
  const partner = ctx.conversingWith;

  // BUILD MODE (⑦). While the build word is up the GROUND is what the world
  // is FOR: a long rest on a marked place chooses it, and a long rest on
  // ANYWHERE ELSE lets the chosen one go — settling on open ground is a real
  // answer ("not that one"), not silence.
  //
  // IT CLAIMS THE GROUND AND NOTHING ELSE. A person is never a spot (someone
  // standing on a plot is still someone) and neither is a THING: the mode
  // used to claim any non-creature hover, which meant a fixture standing on a
  // lit place fired two cells of this table at once — the short rest opened
  // its board, the long rest selected the place under it — and since each of
  // those releases the other (one selection at a time), the board flipped
  // between the chest and the build menu for as long as the player looked at
  // it. Two rules were racing for one hover. The hover itself decides now.
  if (ctx.building && phase === "long" && target.kind === "ground") {
    return [{ act: "buildSpot", id: ctx.buildSpot ?? null }];
  }

  if (target.kind === "ground") {
    // Only a LONG rest on bare ground means anything: the ground is what the
    // gaze crosses on its way everywhere else, so a short one would fire
    // constantly in transit.
    if (phase !== "long") return [];
    const room: DwellAction = { act: "room", x: target.x, y: target.y };
    return partner ? [room, { act: "sendTo", cid: partner, x: target.x, y: target.y }] : [room];
  }

  const id = target.id;
  if (!id) return []; // a creature or object with no identity is not a target

  if (target.kind === "object") {
    // A thing reads the same way in and out of a conversation — SHORT, because
    // naming a thing is the commonest act the player performs. The board always
    // opens; a running conversation adds the instruction on top.
    if (phase !== "short") return [];
    const menu: DwellAction = { act: "menu", id };
    return partner ? [menu, { act: "attendObject", cid: partner, id }] : [menu];
  }

  // A CREATURE. Which cell applies depends on which side of the roster this
  // person is standing on — inside the player's conversation, or outside it.
  // With no roster nobody is ever a fellow member, so the dyadic cells stand.
  const fellow = !!ctx.members && id !== partner && ctx.members.includes(id);
  // The `join` discriminant rides whichever of the two opening acts comes back;
  // the key is OMITTED rather than set false, so an absent context reproduces
  // the old objects exactly.
  const opening = (act: "talk" | "switch"): DwellAction =>
    ctx.targetInConversation ? { act, id, join: true } : { act, id };

  // Looking at the person whose board I face — or at the fellow member I am
  // already addressing — is ATTENTION, not an instruction, in either phase.
  // Otherwise listening to someone would keep re-commanding them.
  if (id === partner || (fellow && id === ctx.currentAddressee)) return [];

  // A FELLOW MEMBER IS NEVER SWITCHED TO, and never commanded ABOUT. We are in
  // the same conversation already: there is no partner to take them from, so
  // both phases mean the one thing a look inside a circle can mean — I am
  // talking to YOU now. (The long rest repeats the short one; addressing is
  // idempotent, and a player whose short rest was spent elsewhere still gets to
  // choose whom they are speaking to.)
  if (fellow) return [{ act: "address", id }];

  // Nobody's board is up: the only thing a person affords is being talked to,
  // and that is a LONG rest — a conversation is a commitment, and a short glance
  // at a passer-by must not open one. If they are already talking to someone,
  // the long rest asks to JOIN that conversation rather than to start a rival.
  if (!partner) return phase === "long" ? [opening("talk")] : [];

  // An OUTSIDER while I am conversing: a glance points my partner at them; a
  // long rest is the player turning to that person instead, which ends the
  // current conversation by starting (or joining) another.
  return phase === "short" ? [{ act: "attendCreature", cid: partner, id }] : [opening("switch")];
}

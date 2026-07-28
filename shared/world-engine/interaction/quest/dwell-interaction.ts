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
//   3. WHETHER a conversation is running — and with whom
//
// Everything the player can express with their eyes is one cell of that table.
// It is written here as a pure function so the rules are readable in one place
// and provable without a world, a renderer, or a session — quest-host binds it
// to the live game, and the SAME resolved target drives the spark's visual, so
// the highlight can never disagree with what a dwell would act on.
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
 *  the player is talking to right now, and is the ONLY state that changes what a
 *  hover means. */
export interface DwellContext {
  conversingWith: string | null;
}

/**
 * What a settled hover does. One variant per cell of the table — the caller
 * dispatches on `act` and performs it; it never re-decides the target.
 */
export type DwellAction =
  /** Put the fixture and whatever it holds on the board. */
  | { act: "menu"; id: string }
  /** Open a conversation with this creature. */
  | { act: "talk"; id: string }
  /** Hand the conversation from the current partner to this one. */
  | { act: "switch"; id: string }
  /** Name the room under the point (no conversation running). */
  | { act: "room"; x: number; y: number }
  /** Send the partner to this spot. */
  | { act: "sendTo"; cid: string; x: number; y: number }
  /** Point the partner at a thing — it acts on it if it has a need for it. */
  | { act: "attendObject"; cid: string; id: string }
  /** Point the partner at another person — likewise, need-gated. */
  | { act: "attendCreature"; cid: string; id: string };

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
 * says nothing, and looking at the partner you are already talking to is
 * attention rather than an instruction about anybody.
 */
export function dwellInteraction(
  target: HoverTarget | null,
  phase: DwellPhase,
  ctx: DwellContext,
): DwellAction[] {
  if (!target) return [];
  const partner = ctx.conversingWith;

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

  // A CREATURE. With no conversation running, the only thing a person affords is
  // being talked to, and that is a LONG rest — a conversation is a commitment,
  // and a short glance at a passer-by must not open one.
  if (!partner) return phase === "long" ? [{ act: "talk", id }] : [];

  // Already talking. Looking at the PARTNER is attention, not an instruction.
  if (id === partner) return [];
  // Someone else: a glance points the partner at them; a long rest is the
  // player turning to that person instead, which ends the current conversation
  // by starting another.
  return phase === "short"
    ? [{ act: "attendCreature", cid: partner, id }]
    : [{ act: "switch", id }];
}

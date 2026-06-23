// Pure addressee-resolution for group AAC chat (shape C).
//
// Deciding who an outgoing utterance is aimed at, by the cheapest reliable
// signal first. Stakes are low — the floor it drives is advisory, never a gate —
// so a heuristic stack with a ROOM default is the right amount of engineering.
//
// Priority:
//   1. Explicit face-focus  — the student tapped/dwelt on a peer's face. An
//      exact studentId; their direct, current intent. Strongest.
//   2. Board-Manager tag    — a peer NAME the AI set on the button when it built
//      a reply/bid for that peer. Resolved to a room studentId.
//   3. Adjacency            — a peer just asked the group (floor "awaiting"); a
//      reply most likely answers them.
//   4. ROOM                 — default / 2-party / anything ambiguous.
//
// Kept pure (no coordinator state) so it's unit-testable.

export interface AddresseeInputs {
  /** The speaker's own personId (never addresses themselves). */
  me: string;
  /** Room roster: personId → display name. */
  roster: Map<string, string>;
  /** Focused peer personId from a face tap/dwell, or null. */
  focus: string | null;
  /** Peer (personId) currently awaiting a response (floor adjacency), or null. */
  floorAwaiting: string | null;
  /** Peer NAME the Board Manager tagged on the pressed button, if any. */
  buttonAddressee?: string;
}

/** Resolve a peer display name (case-insensitive) to a personId in the roster.
 *  Returns null on no match or an ambiguous one (two peers share the name). */
export function resolveRosterName(roster: Map<string, string>, name: string): string | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  let hit: string | null = null;
  for (const [id, n] of roster) {
    if (n.trim().toLowerCase() === needle) {
      if (hit) return null; // ambiguous
      hit = id;
    }
  }
  return hit;
}

/** Returns the addressee personId, or "ROOM". */
export function resolveAddressee(inp: AddresseeInputs): string {
  const { me, roster, focus, floorAwaiting, buttonAddressee } = inp;

  // 1. Explicit face-focus.
  if (focus && focus !== me && roster.has(focus)) return focus;

  // 2. Board-Manager button tag (a peer NAME).
  if (buttonAddressee && buttonAddressee.trim().toUpperCase() !== "ROOM") {
    const id = resolveRosterName(roster, buttonAddressee);
    if (id && id !== me) return id;
  }

  // 3. Adjacency — a peer just asked the group.
  if (floorAwaiting && floorAwaiting !== me && roster.has(floorAwaiting)) return floorAwaiting;

  // 4. Default.
  return "ROOM";
}

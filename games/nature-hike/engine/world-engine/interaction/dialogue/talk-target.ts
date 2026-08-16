// WHO AM I TALKING TO — choosing the conversation partner from the bodies in
// play. Pure: the host collects the candidates (posers, wilderness locals,
// townsfolk) and this decides between them.
//
// THE GAZE PICKS THE PARTNER. Whoever the player is LOOKING at wins, however
// far down the queue proximity would have put them — that is how a person is
// addressed in a crowd, and how a conversation is handed from one person to the
// next (looking at somebody else while talking switches to them; it is not a
// leave). Proximity only decides when the gaze is on nobody: the approach case,
// where the greeting bubble belongs to whoever is being walked up to.

export interface TalkCandidate {
  /** The node/body id the caller knows this candidate by. */
  id: string;
  /** Distance from the player, for the approach case. */
  dist: number;
  /** Is the gaze resting on this body right now? */
  gazed: boolean;
  /** A poser/creature with something to say, as against a passing townsperson —
   *  on an equal distance the quest-giver is the one being approached. */
  questGiver: boolean;
}

/**
 * The partner, or null for nobody.
 *
 * `gazeOnly` = there is no walking up to anyone (the formless SPIRIT talks to
 * whatever it rests on, at any distance), so an unlooked-at body is never a
 * partner.
 */
export function pickTalkTarget(
  candidates: readonly TalkCandidate[],
  opts: { gazeOnly: boolean },
): string | null {
  const gazed = candidates.filter((c) => c.gazed);
  const pool = gazed.length ? gazed : opts.gazeOnly ? [] : candidates;
  let best: TalkCandidate | undefined;
  for (const c of pool) {
    if (!best || c.dist < best.dist || (c.dist === best.dist && c.questGiver && !best.questGiver)) best = c;
  }
  return best?.id ?? null;
}

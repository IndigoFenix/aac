// server/services/dual-agent/word-finder-open-gate.ts
//
// Whether an AI-initiated `open_app` may proceed while the WORD FINDER is
// open — the one decision, kept out of AgentCoordinator so it can be tested
// without the Coordinator's live-provider import graph.
//
// THE RULE. The first AI open during narrowing is ASKED, not refused: the
// Speaker is told the Word Finder is still up and invited to repeat the call
// if this app is what the user has been searching for. An immediate repeat of
// the SAME app is the yes — the Word Finder closes and the app opens.
//
// Why an ask and not a gate. A flat refusal was the behavior until
// 2026-08-25, and it inverted the feature: the Word Finder does not close
// itself, so a child who used it to reach a picture or a restaurant hit a
// silent wall at the exact moment the search succeeded (five refused
// `picture_search` calls in one session, none of them visible to the child).
// The 2026-08-19 failure it was written for — an open on a topic three turns
// stale — does not survive one explicit "don't repeat this if you are changing
// the subject", while a genuine end-of-search open does.
//
// A STUDENT press never reaches here. Their press IS the ask.

/** An asked-but-unconfirmed open, held between the two calls. */
export interface PendingWordFinderOpen {
  appId: string;
  /** `Date.now()` at the moment the ask went out. */
  at: number;
}

/** How long an ask stays answerable. Long enough for the AI to reply within
 *  its own turn, short enough that an unrelated open a minute later is a fresh
 *  ask rather than a stale yes. */
export const WORD_FINDER_OPEN_CONFIRM_MS = 60_000;

export type WordFinderOpenVerdict =
  /** First ask — nothing opens; the AI is invited to confirm. */
  | { kind: "ask" }
  /** The AI repeated the same open — close the Word Finder and open it. */
  | { kind: "confirmed" };

export function decideWordFinderOpen(
  pending: PendingWordFinderOpen | null,
  appId: string,
  now: number,
  windowMs: number = WORD_FINDER_OPEN_CONFIRM_MS,
): WordFinderOpenVerdict {
  const confirmed =
    pending !== null && pending.appId === appId && now - pending.at <= windowMs;
  return confirmed ? { kind: "confirmed" } : { kind: "ask" };
}

/**
 * What the Speaker is told when the ask goes out. Two branches and no prose:
 * the model has to pick one, and the wrong pick has to be spelled out or it
 * reads the refusal as "try again", which is exactly what it did before.
 */
export function wordFinderOpenAskNote(appId: string): string {
  return (
    `[APP OPEN HELD] The WORD FINDER is open, so nothing opened.\n` +
    `- Is this what the user has been searching for? Then call open_app("${appId}") again NOW — that closes the WORD FINDER and opens it.\n` +
    `- Changing the subject instead? Then don't. Keep helping them find their word.`
  );
}

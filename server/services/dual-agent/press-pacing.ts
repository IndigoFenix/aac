// server/services/dual-agent/press-pacing.ts
//
// Pure decision logic for the two per-student PRESS PACING options, kept out of
// AgentCoordinator so it can be unit-tested without constructing a session
// (providers, sockets, TTS). The coordinator owns the timers and the wiring;
// everything here is a function of its arguments.
//
//   pressResponseDelay (ms, 0 = off)
//     Hold the AI's answer for a beat after a press so the student can CHAIN
//     buttons into one thought. The press itself is voiced immediately — only
//     the turn handed to the agents waits. Each further press inside the window
//     joins the chain and re-arms the hold; when it finally expires the agents
//     see ONE combined utterance. Without this, a student spelling out "I want
//     juice" one button at a time gets answered after "I".
//
//   interruptOnNewPress (barge-in, default off)
//     A press on a DIFFERENT button while the AI is answering (or while its
//     replacement board is still being generated) means the student has moved
//     on. Cut the answer, cancel the board build, voice the new press now.
//     A re-press of the SAME button is never a barge-in — that is
//     perseveration, and press-repeat-guard.ts already owns it.
//
// The two compose: barge-in decides what to TEAR DOWN at press time, the chain
// delay decides WHEN the replacement turn is handed over.

/** The subset of `aac_settings` this module reads. */
export interface PressPacingSettings {
  pressResponseDelay?: number | null;
  interruptOnNewPress?: boolean | null;
}

export interface PressPacing {
  /** How long to hold a press before routing it to the agents. 0 = off. */
  chainDelayMs: number;
  /** Whether a different-button press tears down the in-flight response. */
  bargeIn: boolean;
}

/** Longest hold we will honor. A misconfigured 60s would look like the device
 *  had died — the student presses, hears themselves, and nothing ever answers. */
export const PRESS_CHAIN_MAX_MS = 15_000;

/** Shortest hold worth arming. Below this the timer costs more than it buys and
 *  a stray small value would just add jitter, so it reads as "off". */
export const PRESS_CHAIN_MIN_MS = 250;

export const PRESS_PACING_DEFAULTS: PressPacing = { chainDelayMs: 0, bargeIn: false };

/**
 * Resolve the pacing options from a student's AAC settings. Missing settings
 * (no row yet, older student) resolve to today's behavior.
 */
export function resolvePressPacing(aac: PressPacingSettings | null | undefined): PressPacing {
  const raw = Number(aac?.pressResponseDelay);
  const delay = Number.isFinite(raw) && raw >= PRESS_CHAIN_MIN_MS
    ? Math.min(Math.round(raw), PRESS_CHAIN_MAX_MS)
    : 0;
  return { chainDelayMs: delay, bargeIn: !!aac?.interruptOnNewPress };
}

/**
 * Join the social-trainer's BUFFERED REPLIES into one peer turn. Each fragment
 * is a complete reply the student chose off a board, so each is terminated —
 * the peer reads "Me too. What about you?".
 */
export function joinPressSentences(sentences: string[]): string {
  return sentences
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`))
    .join(" ")
    .trim();
}

/**
 * Join a CHAIN of presses into the one thought the student was building.
 *
 * Deliberately NOT joinPressSentences: chaining exists so a student who says
 * "I" → "want" → "juice" gets answered once, and terminating each fragment
 * would hand the agents "I. Want. Juice." — three statements, which is exactly
 * the reading the feature is meant to prevent. Fragments keep whatever
 * punctuation they already carry (a chain of full sentence buttons still reads
 * "I'm hungry. Can we eat?"); nothing is invented for a bare word, because
 * inventing it is an English-orthography guess this string will not survive in
 * Hebrew, Arabic or Chinese.
 */
export function joinChainedPresses(sentences: string[]): string {
  return sentences
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Join chained press LABELS for the flow log / press signature. Labels are
 *  UI text, not prose — no punctuation is invented for them. */
export function joinPressLabels(labels: string[]): string {
  return labels.map((l) => l.trim()).filter(Boolean).join(" ");
}

export interface BargeInParams {
  /** The student's `interruptOnNewPress` setting. */
  enabled: boolean;
  /** True when the repeated-press guard already classified this press as a
   *  re-press of the open burst. Such a press must NEVER barge in. */
  isRepeat: boolean;
  /** The AI/peer voice is rendering or playing. */
  aiSpeaking: boolean;
  /** A BoardManager rebuild is in flight, or deferred and armed — i.e. the
   *  board on screen is about to be replaced. */
  boardBuilding: boolean;
}

/**
 * Should this press abandon whatever response is in flight?
 *
 * Only when the option is on, the press is a genuinely different button, and
 * there is actually something to abandon. With nothing in flight there is
 * nothing to cut, and the press takes the ordinary path.
 */
export function shouldBargeIn(p: BargeInParams): boolean {
  return p.enabled && !p.isRepeat && (p.aiSpeaking || p.boardBuilding);
}

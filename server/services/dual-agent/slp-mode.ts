// server/services/dual-agent/slp-mode.ts
//
// SLP MODE — a therapist-facing AAC session behavior.
//
// Unlike every other AAC option this is scoped to the LOGGED-IN USER
// (`users.slp_mode`), not the student: it describes who is sitting at the
// device — a speech-language pathologist running a session WITH the student —
// so it follows the professional from student to student rather than sticking
// to one student record.
//
// While on, for every AAC session that user opens:
//   1. MECHANICAL sleep is off (see `allowsIdleRest` / `allowsIdleSleep`) —
//      nothing drops the session because a timer expired or because no face is
//      visible. An SLP carries the device around a room, so "I can't see
//      anyone" is not evidence the session ended, and the long silences in
//      therapy are the therapy.
//   2. DELIBERATE sleep is untouched. The Observer may still call rest() and
//      sleep(); it is the one participant that can actually judge whether the
//      session is over, and taking that away just burns budget on an ended
//      session. An AI sleep shows up on the AAC as the sleep overlay, and the
//      therapist wakes it by hand — presence never re-wakes it on its own.
//   3. an explicit wake/sleep control appears in the AAC header chrome
//      (client side; driven by `ClientConfig.slpMode`).
//   4. the live agents are told a clinician is co-present and facilitating
//      (see `buildSlpModeBlock`) instead of assuming the student is alone
//      with the AI.
//
// The line is DELIBERATE vs MECHANICAL, not "AI vs human". Judgment is allowed
// from whoever has it; clocks and face-detectors have none.
//
// This module holds the PURE decisions plus the model-facing prompt fragment,
// so both are unit-testable without standing up a live WebSocket session.

// ---------------------------------------------------------------------------
// Canonical terminology
//
// Same pattern as memory-schema/canonical-terms.ts: the LABELS the model sees
// live in exactly one place, in ALL CAPS so the model reads them as a defined
// role rather than generic prose. Scoped here (rather than in `T`) because
// they are only meaningful while SLP MODE is on.
// ---------------------------------------------------------------------------

/** The professional running the session. Full form, used on first mention. */
export const SLP_ROLE = "SPEECH-LANGUAGE PATHOLOGIST";
/** Short form, used for every mention after the first. */
export const SLP = "SLP";

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** The shape of any record that can carry the flag (a `users` row, a session
 *  cache entry, a test double). Deliberately structural — this module must not
 *  depend on the schema. */
export interface SlpModeSource {
  slpMode?: boolean | null;
}

/**
 * Resolve SLP MODE for the user who opened the session. Strictly boolean:
 * a missing user, a null column, or a legacy row all mean OFF, so nothing
 * changes for the overwhelming majority of sessions.
 */
export function resolveSlpMode(user: SlpModeSource | null | undefined): boolean {
  return user?.slpMode === true;
}

/**
 * May a TIMER drop the session to `resting`?
 *
 * NO while SLP MODE is on. The idle watchdog measures elapsed silence, and a
 * therapy session is mostly silence — the student is being given time to
 * answer. Dropping the Speaker mid-wait is exactly the wrong read.
 *
 * This gates the MECHANICAL path only. The Observer's own rest() call is a
 * judgment and is NOT gated — see the module header.
 */
export function allowsIdleRest(slpMode: boolean): boolean {
  return !slpMode;
}

/**
 * May a TIMER (or the "no face visible" score) tear the agents down and go
 * fully cold?
 *
 * NO while SLP MODE is on. An SLP moves the device around the room, so losing
 * the student's face proves nothing about whether the session is over, and a
 * cold session costs the therapist a visible rebuild delay right when the
 * student finally produces the answer they were waiting for.
 *
 * Separate from `allowsIdleRest` so the two ends of the ladder can diverge
 * later. Again MECHANICAL only — the Observer's sleep() is a judgment and runs
 * ungated; when it fires, the AAC shows the sleep overlay and the therapist
 * wakes it by hand.
 */
export function allowsIdleSleep(slpMode: boolean): boolean {
  return !slpMode;
}

/**
 * Should a client→server sleep/wake notification actually move the SERVER
 * session? Only when the human pressed the control (`source: "user"`).
 *
 * The client's own engagement state machine reports every transition it makes
 * with `source: "system"`; acting on those would let a quiet room tear the
 * server's agents down behind the idle watchdog's back. The manual header
 * button is the one caller that speaks for a person.
 */
export function isManualSleepRequest(source: string | undefined): boolean {
  return source === "user";
}

// ---------------------------------------------------------------------------
// Prompt fragment
// ---------------------------------------------------------------------------

/** Which agent is asking for the block. Each gets the shared framing plus the
 *  two rules that are actually actionable from its seat. */
export type SlpModeAgent = "speaker" | "observer";

/**
 * The `<slp_session>` block injected into the live agents' system prompts.
 *
 * Returns "" when SLP MODE is off, so a normal session's prompt is byte-for-byte
 * unchanged. Consumed by prompts/speaker.ts and prompts/observer.ts.
 */
export function buildSlpModeBlock(args: {
  studentName: string;
  agent: SlpModeAgent;
  slpMode?: boolean;
}): string {
  const { studentName, agent, slpMode = true } = args;
  if (!slpMode) return "";

  const rules = agent === "speaker"
    ? [
        `  - The ${SLP} sets the task and the target. Follow their lead; never start your own agenda.`,
        `  - Long silences are the therapy — [${studentName}] is being given time. Wait; don't fill the gap.`,
        `  - The ${SLP} leads turn-taking. Speak when addressed, or when [${studentName}] answers you.`,
        `  - Never compete for [${studentName}]'s attention while the ${SLP} has it.`,
      ]
    : [
        `  - Expect a second adult who prompts, models, and cues. Their speech is THEIRS, not [${studentName}]'s.`,
        `  - Quiet and an empty frame mean NOTHING here:`,
        `    - A long silence is a therapy pause, not disengagement.`,
        `    - The ${SLP} carries the device around. Losing sight of [${studentName}] does NOT mean they left.`,
        `  - Ending the session is YOUR judgment, never the camera's:`,
        `    - You MAY call rest() freely during quiet stretches.`,
        `    - Call sleep() only on real evidence the session ENDED — goodbyes, packing up, the ${SLP} saying so.`,
        `    - Never sleep() merely because you can't see or hear anyone.`,
        `  - Report what the ${SLP} asks for and what [${studentName}] does. Don't grade the therapy.`,
      ];

  return `

<slp_session>
A ${SLP_ROLE} (${SLP}) is at the device, running a session WITH [${studentName}].
You ASSIST the ${SLP}. You are not [${studentName}]'s only partner here.
${rules.join("\n")}
</slp_session>`;
}

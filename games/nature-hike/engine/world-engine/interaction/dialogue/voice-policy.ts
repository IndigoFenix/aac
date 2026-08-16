// shared/world-engine/interaction/dialogue/voice-policy.ts
//
// VOICE POLICY — what the world SAYS when a composed word cannot be honored.
//
// ═══ THE PATTERN CLASS ═══════════════════════════════════════════════════════
// A child composes a marker. It parses. It compiles. And then it finds nothing
// in THIS world to act on — the word was well-formed and simply had no purchase
// here. "You sleep with me" in a culture that holds no shared sleeping is the
// first instance; there will be more, because every marker we add is a marker
// some world will not implement.
//
// Such a word has exactly two honest fates, and the difference is PEDAGOGY, not
// engineering:
//
//   SPEAK  — name what was not honored ("we do not sleep together"). The child
//            learns that the word was heard and that the world has a shape.
//            This is the house discipline everywhere else in the engine: an
//            explicit not-understood over a silent drop, a named refusal over a
//            misleading "ok".
//   SILENT — do the honorable part and say nothing about the rest. Fewer words,
//            less to process, no negative alongside a positive.
//
// Which is right DEPENDS ON THE AUDIENCE, which is why it is a constant and not
// a hard-coded branch. For the current audience — AAC users, largely children
// with Rett's syndrome, whose receptive language typically outruns what they
// can express — SPEAK wins: a learner who understands more than they can say is
// exactly the learner most cheated by silence. Shift the audience (a younger
// cohort, a lower language level, a therapy goal that wants minimal verbal
// load) and the calculus can flip, per marker.
//
// ⚠️ WHEN YOU ADD A NEW MARKER, ADD ITS ENTRY HERE. The failure mode this
// module exists to prevent is a marker that quietly does nothing, which reads
// to a child as "the system ignored me" and to us as "the feature works".
//
// The SHAPE is the contract a future per-student settings surface will
// serialise (the world-tunables.ts precedent) — so keep it flat and boring.

/** Per-marker: does an unhonored composition SPEAK, or pass in silence? */
export interface VoicePolicy {
  /**
   * A COMPANY marker (`with` / `together`, or a `we` subject) on an activity
   * this world holds NO GATHERING for — "you sleep with me" where the culture's
   * ritual rows declare no shared sleeping.
   *
   * The ordinary solo order still lands either way: the sleeping happens. This
   * only decides whether the body also says that the TOGETHER part did not.
   */
  inertCompany: boolean;

  /**
   * An ATTACHED AVATAR speaking on its own initiative — the body a session in
   * attached-avatar mode CREATES for a player (quest-host `avatarMode:
   * "creature"`), which permanently follows that player's spark.
   *
   * That body is a PLAYER'S BODY, not a character. No mind is ever minted for
   * it, so any line it produced would be the world putting words in the
   * player's mouth. False = it never self-speaks.
   *
   * WHY THIS IS A POLICY SEAT AND NOT AN `if` SOMEWHERE. The avatar is also
   * unreachable by the talk targeter (it has no `nodeByCreature` entry, so
   * nothing can pick it as an addressee), and it would be tempting to call
   * that "already silent" and move on. That is an ad-hoc mute wearing a hat:
   * it holds only for as long as every speech surface happens to route
   * through the targeter, and it fails silently — and in the wrong direction
   * — the first time one doesn't. The gate is therefore consulted at the
   * speech CHOKEPOINT itself, where the answer cannot depend on who asked.
   */
  attachedAvatarSpeaks: boolean;
}

/** The shipped policy. One place to retune when the audience shifts. */
export const DEFAULT_VOICE_POLICY: VoicePolicy = {
  inertCompany: true,
  attachedAvatarSpeaks: false,
};

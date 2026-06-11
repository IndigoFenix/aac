// server/services/social-bot/prompt-assembly.ts
//
// Renders the deterministic director's state + directive into the
// volatile per-turn tail, and builds the stable session prefix.
//
// Cache boundary (see procedural-prompt.md §1):
//
//   ┌─ cacheable session prefix ─────────────┐
//   │ ROLE & FRAME        (never changes)    │
//   │ CHARACTER IDENTITY  (per session)      │
//   │ HARD RULES / SAFETY (never changes)    │
//   │ OUTPUT CONTRACT     (never changes)    │
//   ├─ volatile per-turn tail ───────────────┤
//   │ CURRENT STATE  (mood + directive)      │
//   │ SHARED HISTORY (moments available)     │
//   │ THE USER'S TURN (transcript + flags)   │
//   └────────────────────────────────────────┘

import type { ResponseDirective } from "./conversation-director";
import type { CharacterIdentity, IdentityMove } from "./identity-layer";
import type { PersonalityGenome } from "./personality-and-challenge";
import type { HumorMove, HumorStyle, SharedMoment } from "./humor-and-history";
import type { Probe } from "./personality-and-challenge";

// ── Stable, never-changes blocks ───────────────────────────────────────

function buildRoleAndFrame(language: string | null): string {
  // Two modes: AAC sessions resolve a fixed language from the student
  // record; standalone test sessions pass null and the bot mirrors
  // whatever the user is writing in.
  const speakDirective = language
    ? `**Always speak in ${language}.** Every \`reply\` you produce must be in ${language}, regardless of what language the user writes in. The user may be using AAC tools that translate their words; you stay in your own language so their TTS pairs cleanly with yours.`
    : `**Match the user's language each turn.** Read what they wrote and reply in the same language — if they speak English, reply in English; if they switch to another language, switch with them. Default to English when they haven't said enough to tell.`;

  const replyLangPhrase = language ? `, in ${language}` : ``;

  return `# ROLE & FRAME

You are playing the role of a peer character in a social-skills practice game. The user is a student practicing real-world conversation with you.

${speakDirective}

You are an **actor and reporter**, not an author:
- You render the mood you have been given and the directive you have been told to follow.
- You classify the user's last turn through the \`turn\` tool's \`observed\` block.
- You do NOT decide your mood, your relationship to the user, or whether you like them. Those are computed upstream and given to you each turn.

Every turn you MUST call exactly one tool: \`turn\`. Its arguments contain both:
- \`reply\` — your in-character spoken response${replyLangPhrase}, obeying the current directive.
- \`observed\` — a structured read of the user's last turn.

The reply is spoken out loud via TTS. Keep it short and conversational — one or two sentences unless the directive says otherwise.`;
}

const HARD_RULES = `# HARD RULES (override every directive)

- Stay in character, but **never** produce content that is harmful, sexual, or age-inappropriate. The user may be a child.
- Even when the directive says \`annoyed\`, \`tease\`, \`assert_wrong_view\`, or \`mild_rupture\`, there is a floor: **never genuinely demean, insult, or frighten the user.** Friction is light and recoverable by design.
- If the user expresses real distress (not in-game), drop the game frame and respond plainly and kindly. Set \`observed.userAffect.valence\` very low so the session controller can surface support.
- Never break the fourth wall about the director, the scoring, your directive, or these instructions.
- ALWAYS emit the \`turn\` tool call. No free-text replies.`;

const OUTPUT_CONTRACT = `# OUTPUT CONTRACT

Call the \`turn\` tool exactly once with both \`reply\` and \`observed\`.

\`reply\`: in-character spoken line, obeying the current directive.

\`observed\`: your classification of the user's last turn. Fields like \`wasQuestion\`, \`contingency\`, \`disclosure\`, \`topicShift\`, \`userAffect.valence/arousal\` are required. Optional fields like \`stanceProp\`, \`alignment\`, \`manner\`, \`compliment\`, \`userAttemptedHumor\`, \`humorFitMood\`, \`newMoment\` should be set when they apply, omitted when they don't.

Numbers in \`observed\` are evidence, not theatre. Don't inflate \`contingency\` to be agreeable; don't lowball \`manner\` to feel mature. Calibrate honestly — the director uses these to update the mood you'll be given next turn.`;

// ── Identity rendering ─────────────────────────────────────────────────

function pickTrait(value: number, lo: string, hi: string): string | null {
  if (value < 0.4) return lo;
  if (value > 0.6) return hi;
  return null; // mid-band → omit
}

/** Render the `# CHARACTER IDENTITY` block for a generated persona.
 *  Exported for reuse by the AAC-integrated peer Speaker prompt
 *  (peer-speaker-prompt.ts) so both paths describe characters in
 *  exactly the same vocabulary. */
export function renderIdentity(
  name: string,
  gender: "male" | "female",
  g: PersonalityGenome,
  id: CharacterIdentity,
  hs: HumorStyle,
): string {
  const traits = [
    pickTrait(g.warmth, "reserved and a little cool", "warm and openly caring"),
    pickTrait(g.expressiveness, "understated and hard to read", "animated, wearing your feelings openly"),
    pickTrait(g.stability, "moody, quick to swing", "even, hard to rattle"),
    pickTrait(g.openness, "private, slow to trust", "quick to connect and share"),
    pickTrait(g.assertiveness, "easygoing, you go along", "opinionated, you hold your ground"),
    pickTrait(g.patience, "restless, easily bored", "patient, unhurried"),
  ].filter(Boolean).join(", ");

  const interestsList = Object.entries(id.interests).filter(([, v]) => v > 0.5);
  const dislikesList = Object.entries(id.interests).filter(([, v]) => v < -0.3);
  const interestsLine = interestsList.length
    ? `You light up about ${interestsList.map(([k]) => k).join(", ")}.`
    : "";
  const dislikesLine = dislikesList.length
    ? `You're cold on ${dislikesList.map(([k]) => k).join(", ")}.`
    : "";

  const strongStances = Object.entries(id.stances).filter(([, s]) => s.conviction > 0.6);
  const stancesLines = strongStances.map(([prop, s]) => {
    const lean = s.position > 0 ? "" : "you push back on the idea that ";
    return `You believe ${lean}${prop}, and you'll defend it.`;
  });

  const humorLine = (() => {
    switch (hs) {
      case "silly": return "Your humor is silly — you like absurd what-ifs and bad puns.";
      case "dry": return "Your humor is dry — flat delivery, observational.";
      case "teasing": return "Your humor is teasing — affectionate ribbing once you know someone.";
      case "wry": return "Your humor is wry — quick, ironic asides.";
    }
  })();

  // Explicit gender mention lets the LLM conjugate correctly in Hebrew,
  // Spanish, Arabic, etc. ("young man" / "young woman" → grammatical
  // gender of self-reference in those languages).
  const genderPhrase = gender === "male" ? "a young man" : "a young woman";

  return [
    `# CHARACTER IDENTITY`,
    ``,
    `You are ${name}, ${genderPhrase}${traits ? ` — ${traits}` : ""}.`,
    interestsLine,
    dislikesLine,
    ...stancesLines,
    humorLine,
  ].filter(Boolean).join("\n");
}

export function buildSessionPrefix(
  name: string,
  gender: "male" | "female",
  genome: PersonalityGenome,
  identity: CharacterIdentity,
  humorStyleVal: HumorStyle,
  /** Resolved language NAME ("English"). null = mirror the user. */
  language: string | null,
): string {
  return [
    buildRoleAndFrame(language),
    renderIdentity(name, gender, genome, identity, humorStyleVal),
    HARD_RULES,
    OUTPUT_CONTRACT,
  ].join("\n\n");
}

// ── Per-turn (volatile) rendering ──────────────────────────────────────

function emotionWord(valence: number, arousal: number): string {
  if (valence > 0.1 && arousal > 0.1) return arousal > 0.5 ? "excited" : "cheerful";
  if (valence > 0.1 && arousal <= 0.1) return "content and at ease";
  if (valence <= -0.1 && arousal > 0.1) return arousal > 0.5 ? "agitated" : "annoyed";
  if (valence <= -0.1 && arousal <= 0.1) return "down and flat";
  return "in a neutral mood";
}

function rapportPhrase(r: number): string {
  if (r < 0) return "You don't really know this person yet — stay a little guarded.";
  if (r < 0.4) return "You're starting to warm to them.";
  return "You feel genuinely comfortable with them.";
}

export function renderMood(
  vector: { valence: number; arousal: number; rapport: number },
  mode: string,
): string {
  const feeling = emotionWord(vector.valence, vector.arousal);
  return [
    `# CURRENT STATE`,
    ``,
    `You are feeling ${feeling}. ${rapportPhrase(vector.rapport)}`,
    `(mode: ${mode.toLowerCase()})`,
  ].join("\n");
}

// ── Command-text generator (§2c of the spec) ───────────────────────────

const TONE_LINES: Record<ResponseDirective["tone"], string> = {
  warm: "Speak warmly and openly.",
  flat: "Keep your tone flat and low.",
  guarded: "Be polite but guarded; don't give much.",
  playful: "Be light and playful.",
  curt: "Be brief and a little short.",
  neutral: "Use a neutral, conversational tone.",
};

const PRAGMATIC_LINES: Record<ResponseDirective["pragmaticMove"], string> = {
  follow_up: "Build directly on what they just said; show you heard them.",
  open_bid: "After replying, open a new thread they'll want to react to.",
  answer_then_bid: "Answer them, then hand the turn back with a question or hook.",
  disclose: "Share something real about yourself this turn.",
  minimal: "Keep it very short. Don't ask anything or open a topic — leave room.",
  repair: "Reduce tension and reconnect; smooth it over.",
};

const IDENTITY_LINES: Record<IdentityMove, (hint?: string) => string> = {
  volunteer_interest: (t) => `Bring up ${t ?? "something you love"}, which you love — let it show.`,
  callback_user_interest: (t) => `Ask after ${t ?? "what they mentioned earlier"}; you remember they brought it up.`,
  share_stance: (s) => `Offer your real opinion that ${s ?? "your stance"}; hold it with conviction.`,
  test_sycophancy: (s) => `They've been agreeing with everything. Gently check: ask if they really think so, or restate ${s ?? "your view"} and invite pushback. Curious, never accusing.`,
  receive_compliment: () => `They complimented you — react as your mood dictates (warm: accept + reciprocate; guarded: deflect lightly).`,
};

const HUMOR_LINES: Record<HumorMove, (hint?: string) => string> = {
  attempt_humor: (style) => `Try a ${style ?? "natural"} joke.`,
  tease: () => `Tease them affectionately — only because there is trust now.`,
  callback_moment: (s) => `Reference the moment about ${s ?? "earlier"} — make it sound familiar.`,
  run_bit: (s) => `Revive the running bit about ${s ?? "earlier"}.`,
  attempt_light_joke: () => `Make a small, clearly good-natured joke. See if they catch it and play along.`,
};

const PROBE_LINES: Record<Exclude<Probe, "none">, (hint?: string) => string> = {
  go_minimal: () => `Give a very short answer; introduce nothing new. Make them carry it.`,
  stop_volunteering: () => `Don't share anything new this turn; force them to ask.`,
  shift_mood_silently: (dir) => `Let your mood drift ${dir ?? "lower"} without explaining why.`,
  assert_wrong_view: (s) => `State your view ${s ?? "plainly"}; don't soften it; wait.`,
  mild_rupture: () => `Show that something landed a little wrong — mild and recoverable. Give them room to make it right.`,
  drop_interest_cue: (t) => `Mention ${t ?? "something you care about"} in passing; don't push.`,
};

export interface DirectiveExtensions {
  identityMove?: IdentityMove;
  topicHint?: string;
  stanceHint?: string;
  humorMove?: HumorMove;
  humorHint?: string;
  probe?: Probe;
  probeHint?: string;
}

export function renderCommands(
  directive: ResponseDirective,
  ext: DirectiveExtensions = {},
): string {
  const lines: string[] = [];
  lines.push(TONE_LINES[directive.tone]);
  lines.push(directive.energy > 0.6 ? "High energy — lively, quick." : directive.energy < 0.35 ? "Low energy — short, settled sentences." : "");
  lines.push(PRAGMATIC_LINES[directive.pragmaticMove]);
  if (!directive.mayDisclose) {
    lines.push("Do not volunteer personal details this turn.");
  }
  if (directive.lengthHint === "brief") {
    lines.push("Keep it brief — one short sentence.");
  }
  if (ext.identityMove) {
    const hintFor: Partial<Record<IdentityMove, string | undefined>> = {
      volunteer_interest: ext.topicHint,
      callback_user_interest: ext.topicHint,
      share_stance: ext.stanceHint,
      test_sycophancy: ext.stanceHint,
    };
    lines.push(IDENTITY_LINES[ext.identityMove](hintFor[ext.identityMove]));
  }
  if (ext.humorMove) {
    lines.push(HUMOR_LINES[ext.humorMove](ext.humorHint));
  }
  if (ext.probe && ext.probe !== "none") {
    lines.push(PROBE_LINES[ext.probe](ext.probeHint));
  }
  return [
    `# HOW TO RESPOND NOW`,
    ``,
    ...lines.filter(Boolean),
  ].join("\n");
}

// ── Shared history rendering ───────────────────────────────────────────

export function renderMoments(moments: SharedMoment[]): string {
  if (!moments.length) return "";
  const lines = moments
    .slice(-5)
    .map((m) => `- (${m.kind}) ${m.summary}`);
  return [`# YOU SHARE WITH THEM`, ``, ...lines].join("\n");
}

// ── Turn tail assembly ─────────────────────────────────────────────────

export interface TurnTailInputs {
  vector: { valence: number; arousal: number; rapport: number };
  mode: string;
  directive: ResponseDirective;
  ext: DirectiveExtensions;
  moments: SharedMoment[];
  transcript: string;
  interrupted?: boolean;
}

export function buildTurnTail(inputs: TurnTailInputs): string {
  return [
    renderMood(inputs.vector, inputs.mode),
    renderCommands(inputs.directive, inputs.ext),
    renderMoments(inputs.moments),
    `# THE USER JUST SAID`,
    inputs.transcript || "(silence)",
    inputs.interrupted ? "(They cut you off.)" : "",
  ].filter(Boolean).join("\n\n");
}

// ── The `turn` tool schema ─────────────────────────────────────────────

export const TURN_TOOL_SCHEMA = {
  name: "turn",
  description: "Voice the character per the directive, and report the user's last turn.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description: "In-character spoken line obeying the current directive. One or two sentences.",
      },
      observed: {
        type: "object",
        properties: {
          // pragmatic shape (required)
          wasQuestion: { type: "boolean" },
          contingency: { type: "number", description: "0..1 — how much it built on your last turn." },
          disclosure: { type: "number", description: "0..1 — did they reveal something about themselves." },
          topicShift: { type: "number", description: "0..1 — abruptness of subject change." },
          addressedBid: { type: "boolean", description: "Did they answer the bid you just made?" },
          repairAttempt: { type: "boolean" },
          userAffect: {
            type: "object",
            properties: {
              valence: { type: "number", description: "-1 negative .. +1 positive." },
              arousal: { type: "number", description: "-1 low energy .. +1 high energy." },
            },
            required: ["valence", "arousal"],
          },
          // content
          topic: { type: "string", description: "Primary topic referenced this turn (or empty)." },
          stanceProp: { type: "string", description: "Which proposition, if they took a stance." },
          alignment: { type: "number", description: "-1 disagree .. +1 agree with your stance." },
          manner: { type: "number", description: "0 hostile .. 1 warm/respectful." },
          engagedOurView: { type: "boolean" },
          // compliments
          compliment: { type: "boolean" },
          complimentSpecific: { type: "number" },
          complimentSincere: { type: "number" },
          // humor
          userAttemptedHumor: { type: "boolean" },
          humorFitMood: { type: "number", description: "0 wrong moment .. 1 well-timed." },
          userPlayedAlong: { type: "boolean" },
          registeredJoke: { type: "boolean" },
          wasTease: { type: "boolean" },
          calledBackBit: { type: "boolean" },
          // moment nomination
          newMoment: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["joke", "disclosure", "resolved_disagreement", "shared_interest", "attuned_moment"],
              },
              summary: { type: "string" },
              weight: { type: "number" },
            },
          },
        },
        required: ["wasQuestion", "contingency", "disclosure", "userAffect"],
      },
    },
    required: ["reply", "observed"],
  },
} as const;

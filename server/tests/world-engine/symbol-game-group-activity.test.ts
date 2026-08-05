// GROUP ACTIVITY SYNTAX (planning-docs/games/world-engine/group-activity-syntax.md) — how
// "eat with me", "I will eat with Mara", "we will play together" and their
// refusals get from a tapped glyph sentence to a shared gathering.
//
// The whole design in one line: an invitation is NOT a new activity. It marks
// an ordinary activity as SHARED, and the ritual machinery that already exists
// does the gathering. So these tests check a MARKER, never a new verb.
//
// Pure (parser + compiler + the sociability gate) — DB-free, `test:engine`.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  compileAction,
  defaultBinder,
  type IntentBinder,
} from "@shared/world-engine/interaction/intent/intent-compile.js";
import { intentToAct } from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import { willingnessToJoin } from "@shared/world-engine/interaction/behavior/willingness.js";
import { makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";
import { DEFAULT_RELATION } from "@shared/world-engine/interaction/behavior/relations.js";
import { noGatheringLine } from "@shared/world-engine/interaction/dialogue/law-lines.js";
import { DEFAULT_VOICE_POLICY } from "@shared/world-engine/interaction/dialogue/voice-policy.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import type { CreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";

// The child "child" speaks to the resident "bear"; "mara" is another creature.
const CREATURES = new Set(["bear", "mara", "dog"]);
const binder: IntentBinder = defaultBinder({ player: "child", listener: "bear" });
binder.isCompanion = (ref) => ref?.kind === "entity" && CREATURES.has(ref.symbol);

const goalOf = (s: string) => compileAction(parseSentence(s, {
  classifyEntity: (sym) => (CREATURES.has(sym) ? "creature" : "item"),
}), binder);

// ---------------------------------------------------------------------------
// The parser — three ways to mean "together"
// ---------------------------------------------------------------------------

describe("jointness — a child means it with whichever word they have", () => {
  const frame = (s: string) =>
    parseSentence(s, { classifyEntity: (sym) => (CREATURES.has(sym) ? "creature" : "item") });

  it("the explicit marker: 'eat + together'", () => {
    expect(frame("eat + together").joint).toBe(true);
  });

  it("a COMPANIONS subject: 'we + eat'", () => {
    expect(frame("we + eat").joint).toBe(true);
  });

  it("a with-marked ANIMATE companion: 'eat + with + mara'", () => {
    expect(frame("eat + with + mara").joint).toBe(true);
  });

  it("deixis counts as animate: 'you + eat + with + i_me'", () => {
    expect(frame("you + eat + with + i_me").joint).toBe(true);
  });

  it("a PLACE or a THING is not company — 'trade + wood + with + city'", () => {
    expect(frame("trade + wood + with + city").joint).toBeUndefined();
  });

  it("a plain activity says nothing about company", () => {
    expect(frame("you + eat").joint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The compiler — company is a MODIFIER, never a verb
// ---------------------------------------------------------------------------

describe("company rides the goal, it never replaces it", () => {
  it("'you + eat + with + i_me' stays an EAT, marked with the speaker", () => {
    expect(goalOf("you + eat + with + i_me")).toEqual({
      kind: "satisfy",
      need: "eat",
      with: { kind: "creatures", ids: ["child"] },
    });
  });

  it("'eat + with + mara' names Mara", () => {
    expect(goalOf("eat + with + mara")).toEqual({
      kind: "satisfy",
      need: "eat",
      with: { kind: "creatures", ids: ["mara"] },
    });
  });

  it("'we + eat + together' is the SPEAKER'S GROUP — the world resolves who", () => {
    expect(goalOf("we + eat + together")).toEqual({
      kind: "satisfy",
      need: "eat",
      with: { kind: "group" },
    });
  });

  it("a bare 'eat + together' is the group too — no name, still shared", () => {
    expect(goalOf("eat + together")).toEqual({
      kind: "satisfy",
      need: "eat",
      with: { kind: "group" },
    });
  });

  it("a NAMED companion beats the group — the one name the child said survives", () => {
    expect(goalOf("we + play + with + mara")).toEqual({
      kind: "satisfy",
      need: "play",
      with: { kind: "creatures", ids: ["mara"] },
    });
  });

  it("company NEVER leaks onto a non-activity goal", () => {
    // "trade wood with the city" — a partner in barter, not a dinner guest.
    expect(goalOf("trade + wood + with + city")).toMatchObject({ kind: "trade" });
  });

  it("an ordinary solo order is untouched — no marker, no behavior change", () => {
    expect(goalOf("you + eat")).toEqual({ kind: "satisfy", need: "eat" });
  });
});

// ---------------------------------------------------------------------------
// The dialogue move — one meaning, several sentence shapes
// ---------------------------------------------------------------------------

const emptyWorld: CreatureWorld = { creatures: {}, items: {} };
const actOpts = {
  symbolOf: (id: string) => id,
  creatureOf: (sym: string) => (CREATURES.has(sym) ? sym : undefined),
  jointActivities: ["eat", "play"],
};
const actOf = (s: string) =>
  intentToAct(
    parseSentence(s, { classifyEntity: (sym) => (CREATURES.has(sym) ? "creature" : "item") }),
    emptyWorld,
    { speakerId: "child", addresseeId: "bear" },
    actOpts,
  );

describe("an invitation is one move, however it is said", () => {
  it("'i_me + want + play + with + you' — the wish shape", () => {
    expect(actOf("i_me + want + play + with + you")).toMatchObject({ kind: "invite", verb: "play" });
  });

  it("'i_me + eat + with + you' — the announcement shape", () => {
    expect(actOf("i_me + eat + with + you")).toMatchObject({ kind: "invite", verb: "eat" });
  });

  it("'i_me + want + eat + together' — the bare-together shape", () => {
    expect(actOf("i_me + want + eat + together")).toMatchObject({ kind: "invite", verb: "eat" });
  });

  it("a with naming a THIRD PARTY stays a disclosure — it tells you, it doesn't ask you", () => {
    expect(actOf("i_me + want + play + with + mara")).not.toMatchObject({ kind: "invite" });
  });

  it("an activity this world does NOT gather for keeps its old reading", () => {
    const act = intentToAct(
      parseSentence("i_me + want + play + with + you"),
      emptyWorld,
      { speakerId: "child", addresseeId: "bear" },
      { ...actOpts, jointActivities: [] },
    );
    expect(act).not.toMatchObject({ kind: "invite" });
  });

  it("a solo want is not an invitation — no company was named", () => {
    expect(actOf("i_me + want + play")).not.toMatchObject({ kind: "invite" });
  });
});

// ---------------------------------------------------------------------------
// The refusal — personality-linked, deliberately simple
// ---------------------------------------------------------------------------

describe("willingnessToJoin — will you do it WITH me?", () => {
  const warm = makePersonality({ warmth: 0.9 });
  const cold = makePersonality({ warmth: 0.1 });

  it("a NEUTRAL creature comes along — a family that only dines with adorers is wrong", () => {
    expect(willingnessToJoin({})).toBe(true);
  });

  it("a COLD creature declines a stranger", () => {
    expect(willingnessToJoin({ personality: cold, relation: DEFAULT_RELATION })).toBe(false);
  });

  it("…but comes if it WANTS the activity — you don't refuse dinner over the cook", () => {
    expect(willingnessToJoin({ personality: cold, relation: DEFAULT_RELATION, level: 1 })).toBe(true);
  });

  it("a cold creature comes for someone it LIKES — affinity, not just warmth", () => {
    expect(willingnessToJoin({ personality: cold, relation: { ...DEFAULT_RELATION, affinity: 1 } })).toBe(true);
  });

  it("a WARM creature says yes to anyone — warmth outweighs even active dislike", () => {
    expect(willingnessToJoin({ personality: warm, relation: { ...DEFAULT_RELATION, affinity: -1 } })).toBe(true);
  });

  it("a MIDDLING creature does refuse someone it dislikes — the bar is real", () => {
    const middling = makePersonality({ warmth: 0.6 });
    expect(willingnessToJoin({ personality: middling, relation: { ...DEFAULT_RELATION, affinity: -1 } })).toBe(false);
    // …and comes for that same person once the relation warms up.
    expect(willingnessToJoin({ personality: middling, relation: DEFAULT_RELATION })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE INERT MARKER — a word that parsed, compiled, and found nothing to act on
// ---------------------------------------------------------------------------
// "you sleep with me" in a culture with no shared sleeping. Whether that SPEAKS
// is an audience decision (voice-policy.ts), so the behavior hangs off a
// constant rather than a hard-coded branch.

describe("the no-gathering line", () => {
  it("names the ACTIVITY and the TOGETHERNESS, and refuses neither activity", () => {
    // The sleeping is NOT refused — only the company has nowhere to go — so the
    // line must not read as a refusal to sleep.
    expect(noGatheringLine("sleep")).toEqual({
      a: "together",
      b: "sleep.not + together",
      c: "we + sleep.not + together",
    });
  });

  it("teaches back the word the child tapped — level a is `together`", () => {
    expect(noGatheringLine("wash").a).toBe("together");
  });

  it("speaks the CULTURAL 'we', like the taboo refusal — not one creature's no", () => {
    expect(noGatheringLine("sleep").c.startsWith("we + ")).toBe(true);
  });

  it("renders as true sentences in every shipped ruleset", () => {
    const c = noGatheringLine("sleep").c;
    expect(translateGlyph(c, "en")).toBe("We don't sleep together.");
    expect(translateGlyph(c, "he-IL")).toBe("אנחנו לא ישנים ביחד.");
    expect(translateGlyph(c, "es")).toBe("No dormimos juntos.");
    expect(translateGlyph(c, "pt-BR")).toBe("Nós não dormimos juntos.");
  });

  it("NEVER drops the marker — a silent drop would make the sentence FALSE", () => {
    // The trap this shape exists to avoid: as a verb modifier, `together` is
    // dropped and "we + sleep.not.together" renders "We don't sleep." — a claim
    // that is simply untrue, and worse than saying nothing at all.
    for (const locale of ["en", "he-IL", "es", "pt-BR"]) {
      expect(translateGlyph(noGatheringLine("sleep").c, locale)).toMatch(/ביחד|together|juntos/);
    }
  });
});

describe("voice policy — the audience knob", () => {
  it("ships SPEAKING an inert company marker", () => {
    // Current audience: AAC users whose receptive language outruns expression —
    // the learner most cheated by silence. Flip per marker if that shifts.
    expect(DEFAULT_VOICE_POLICY.inertCompany).toBe(true);
  });
});

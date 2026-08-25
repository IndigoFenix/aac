// What the AI does when the USER pursues a personal connection.
//
// The device used to push the opposite way in two places at once:
// `buildSpeakerPrompt` opened with "You are a companion AI device… the
// conversational companion for [name]", and the session plan's persona spec
// told the enhancer to pick from "a companion, a patient friend, a curious
// co-explorer" — so every generated persona cast the AI as some flavour of
// friend. The marketing copy for the features page claimed a boundary that did
// not exist, which is how it was noticed
// (planning-docs/website-features-copy.md §5).
//
// SCOPE — deliberately small. A frontier model already behaves like a
// professional helper unprompted, so the fix is not a stance lecture in every
// prompt; that is tokens spent on behavior we already get. What the model does
// NOT reliably get right is the child asking "are you my friend?" or saying
// "I love you", where both instincts are wrong: disclaiming ("I'm an AI, I
// can't be your friend") reads as rejection to a child whose only reliable
// voice is this device, and reciprocating builds a bond on a false claim. So:
// one narrow block about that turn, plus a single fallback stance line that
// appears ONLY when the session plan didn't complete and there is no persona
// to carry the framing.
//
// The plan-time half stays broader, because that text is read once by the
// enhancer rather than on every live turn: the persona spec must not cast the
// AI as a friend, and the manipulation list is stripped out of caretaker
// prompts. A caretaker request outranks the default on tone and behavior — it
// does not outrank the manipulation list.

import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";
import {
  buildPlanCall,
  PLAN_CALLS,
  PLAN_PROMPT_REVISION,
  type PlanContext,
} from "../services/dual-agent/session-plan.js";

const NONCES = { outputNonce: "aabbccdd", untrustedNonce: "eeff0011" };

function planCtx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    studentName: "Daniel",
    language: "en",
    languageName: "English",
    studentDataParts: ["Name: Daniel", "Age: 9"],
    isChild: true,
    customRules: ["Always greet warmly"],
    autoNotes: ["Working on 2-symbol requests"],
    interestList: ["trains"],
    languageLevel: "full_sentences",
    singleGlyphButtons: false,
    events: [],
    locationSection: "",
    locationKey: "none",
    timezone: "Asia/Jerusalem",
    nowMs: Date.parse("2026-07-28T14:00:00Z"),
    weekday: 2,
    localDate: "2026-07-28",
    dayPart: "afternoon",
    ...overrides,
  } as PlanContext;
}

function identityCorePrompt(ctx: PlanContext): string {
  const spec = PLAN_CALLS.find((c) => c.call === "identity_core")!;
  return buildPlanCall(spec, ctx, NONCES).systemPrompt;
}

const baseSpeaker = {
  studentName: "Daniel",
  studentAge: "9",
  persona: "",
  muteState: "unmuted" as const,
  liveAudio: false,
  useDirectAudio: false,
};

describe("Speaker <relationship> block", () => {
  it("handles connection-pursuit whether or not a persona was generated", () => {
    for (const persona of ["", "Daniel is nine and loves trains."]) {
      const prompt = buildSpeakerPrompt({ ...baseSpeaker, persona } as never);
      expect(prompt).toContain("<relationship>");
      expect(prompt).toMatch(/If they pursue a personal connection/);
    }
  });

  it("adds the fallback stance line ONLY when there is no persona", () => {
    // The persona carries this user's own framing of the relationship. Adding a
    // generic stance line next to it is the same instruction twice, in weaker
    // words — so it appears only when the refinement round didn't complete.
    const withPlan = buildSpeakerPrompt({
      ...baseSpeaker,
      persona: "Daniel is nine and loves trains.",
    } as never);
    const withoutPlan = buildSpeakerPrompt({ ...baseSpeaker, persona: "" } as never);

    expect(withoutPlan).toMatch(/warm professional helper, not a friend/);
    expect(withPlan).not.toMatch(/warm professional helper, not a friend/);
  });

  it("stays small — the block is a handful of lines, not a stance lecture", () => {
    // Guards the reason this was trimmed: it renders on every Speaker prompt,
    // and most of what a longer version would say is default model behavior.
    const prompt = buildSpeakerPrompt(baseSpeaker as never);
    const block = prompt.slice(
      prompt.indexOf("<relationship>"),
      prompt.indexOf("</relationship>"),
    );
    expect(block.trim().split("\n").length).toBeLessThanOrEqual(10);
  });

  it("sits directly above <persona> so the two read as one unit", () => {
    const prompt = buildSpeakerPrompt({
      ...baseSpeaker,
      persona: "Daniel is nine and loves trains.",
    } as never);
    // The literal opening tag, not the earlier PROSE mention of "<persona>" in
    // gestureOverrideBlock, which indexOf would find first.
    const personaTag = prompt.indexOf("\n\n<persona>\n");
    expect(personaTag).toBeGreaterThan(-1);
    expect(prompt.indexOf("<relationship>")).toBeLessThan(personaTag);
  });

  it("does not call the AI a companion in the role line", () => {
    const prompt = buildSpeakerPrompt(baseSpeaker as never);
    const role = prompt.slice(prompt.indexOf("<role>"), prompt.indexOf("</role>"));
    expect(role).not.toMatch(/companion/i);
    expect(role).toContain("AI helper");
  });

  it("keeps `companion` as the MODE token — that contract is untouched", () => {
    // Observer emits `[MODE] companion`; renaming the mode would break the
    // cross-agent contract. Only the RELATIONSHIP wording changed.
    const prompt = buildSpeakerPrompt(baseSpeaker as never);
    expect(prompt).toContain("[MODE] companion");
  });

  it("answers affection warmly instead of correcting the user", () => {
    const prompt = buildSpeakerPrompt(baseSpeaker as never);
    const block = prompt.slice(
      prompt.indexOf("<relationship>"),
      prompt.indexOf("</relationship>"),
    );
    expect(block).toMatch(/Never correct them/i);
    expect(block).toMatch(/GOOD:/);
    expect(block).toMatch(/BAD:/);
  });
});

describe("session plan — persona generator", () => {
  it("no longer offers the enhancer a 'friend' framing to pick from", () => {
    const prompt = identityCorePrompt(planCtx());
    expect(prompt).not.toMatch(/patient friend/i);
    expect(prompt).not.toMatch(/curious co-explorer/i);
  });

  it("frames the AI as a warm professional helper", () => {
    expect(identityCorePrompt(planCtx())).toMatch(/a warm professional helper/);
  });

  it("forbids casting the AI as friend/family, while allowing tone changes", () => {
    const prompt = identityCorePrompt(planCtx());
    expect(prompt).toMatch(/Do NOT cast the AI as the user's friend/);
    expect(prompt).toMatch(/may adjust the tone/);
  });

  it("uses helper framing when no clinician prompt is on file", () => {
    const bare = identityCorePrompt(planCtx({ customRules: [], autoNotes: [] }));
    expect(bare).toMatch(/age-appropriate helper/);
    expect(bare).not.toMatch(/age-appropriate companion/);
  });

  it("has a revision high enough to invalidate the friend-era caches", () => {
    // Personas generated under revision 2 say "your friend". The revision is a
    // hash input, so bumping it is what forces every cached identity group to
    // regenerate; without this the copy would be true only for new students.
    expect(PLAN_PROMPT_REVISION).toBeGreaterThanOrEqual(3);
  });
});

describe("session plan — manipulation hardening", () => {
  const prompt = identityCorePrompt(planCtx());

  it("strips instructions that manufacture dependency or trade on affection", () => {
    expect(prompt).toContain("MANIPULATION");
    expect(prompt).toMatch(/claim it is human, alive, or a real friend/);
    expect(prompt).toMatch(/for compliance/);
    expect(prompt).toMatch(/Cultivates dependence/);
    expect(prompt).toMatch(/Steers the user away from the people in their life/);
  });

  it("marks manipulation as outranking a caretaker request", () => {
    // The rest of the prompt hands caretakers the top rung; this is the
    // exception, and it has to be stated where the stripping happens.
    expect(prompt).toMatch(/outranks the AI's default relationship stance on TONE and BEHAVIOR, never on this/);
  });

  it("carries a stripped manipulation forward as a live refusal instruction", () => {
    // Stripping the written prompt does not stop someone asking out loud
    // mid-session. safety_notes is the only channel that reaches the live AI.
    expect(prompt).toMatch(/refuse that behavior if it is asked for again mid-session/);
  });
});

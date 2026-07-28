// WHO the player is talking to (interaction/dialogue/talk-target.ts): the gaze
// picks the partner, proximity only breaks the tie when nobody is being looked
// at. This is what lets a look at a second person HAND the conversation over
// instead of merely cancelling the first one.
//
// Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { pickTalkTarget, type TalkCandidate } from "@shared/world-engine/interaction/dialogue/talk-target.js";

const c = (id: string, dist: number, over: Partial<TalkCandidate> = {}): TalkCandidate => ({
  id,
  dist,
  gazed: false,
  questGiver: false,
  ...over,
});

const ground = { gazeOnly: false };
const spirit = { gazeOnly: true };

describe("pickTalkTarget — the gaze picks the partner", () => {
  it("the looked-at body wins over a nearer one", () => {
    expect(pickTalkTarget([c("near", 1), c("far", 6, { gazed: true })], ground)).toBe("far");
  });

  it("looking at a NEW person while beside the old one picks the new one", () => {
    // The switch case: both are in reach, the gaze has moved on.
    const cands = [c("partner", 1.5), c("other", 4, { gazed: true })];
    expect(pickTalkTarget(cands, ground)).toBe("other");
  });

  it("two people looked at together → the nearer of them", () => {
    const cands = [c("a", 5, { gazed: true }), c("b", 2, { gazed: true }), c("c", 1)];
    expect(pickTalkTarget(cands, ground)).toBe("b");
  });
});

describe("pickTalkTarget — proximity is the approach case only", () => {
  it("with the gaze on nobody, the nearest body is the one being walked up to", () => {
    expect(pickTalkTarget([c("far", 6), c("near", 2)], ground)).toBe("near");
  });

  it("at an equal distance the quest-giver leads the passer-by", () => {
    const cands = [c("townsperson", 3), c("giver", 3, { questGiver: true })];
    expect(pickTalkTarget(cands, ground)).toBe("giver");
    // …and order doesn't decide it.
    expect(pickTalkTarget([cands[1]!, cands[0]!], ground)).toBe("giver");
  });

  it("a nearer townsperson still beats a further quest-giver", () => {
    expect(pickTalkTarget([c("giver", 4, { questGiver: true }), c("townsperson", 2)], ground)).toBe("townsperson");
  });

  it("nobody in play → nobody", () => {
    expect(pickTalkTarget([], ground)).toBeNull();
  });
});

describe("pickTalkTarget — as a SPIRIT only the gaze can choose", () => {
  it("an unlooked-at body is never a partner (there is no walking up to it)", () => {
    expect(pickTalkTarget([c("near", 0.5), c("also", 3)], spirit)).toBeNull();
  });

  it("…and the looked-at one wins at any distance", () => {
    expect(pickTalkTarget([c("near", 0.5), c("across-town", 400, { gazed: true })], spirit)).toBe("across-town");
  });
});

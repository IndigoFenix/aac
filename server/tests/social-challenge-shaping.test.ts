// server/tests/social-challenge-shaping.test.ts
//
// Phase-5 interaction shaping + probe back-off. selectChallenge no longer
// derives intensity from the target's own gap alone — it folds in the whole
// skill vector (recovery buffer for friction probes) and the student's language
// level, and the now-wired back-off rule scaffolds after repeated failures.

import {
  emptyProfile,
  selectChallenge,
  recordProbeOutcome,
  buildSlpConfig,
  type Competency,
  type LearnerProfile,
} from "../services/social-bot/personality-and-challenge";

function weakOn(dim: Competency, value = 0.1): LearnerProfile {
  const p = emptyProfile();
  p.skills[dim] = { value, samples: 10 };
  return p;
}
function setSkill(p: LearnerProfile, dim: Competency, value: number) {
  p.skills[dim] = { value, samples: 10 };
}

describe("interaction shaping", () => {
  it("softens a friction probe when the recovery buffer (repair/attunement) is low", () => {
    const slp = buildSlpConfig({ targetSkills: ["assertiveness"], challengeRatio: 1 });

    const strong = weakOn("assertiveness");
    setSkill(strong, "repair", 1); setSkill(strong, "attunement", 1);
    const weak = weakOn("assertiveness");
    setSkill(weak, "repair", 0); setSkill(weak, "attunement", 0);

    const hi = selectChallenge(strong, slp, 5);
    const lo = selectChallenge(weak, slp, 5);

    expect(hi.probe).toBe("assert_wrong_view");
    expect(lo.probe).toBe("assert_wrong_view");
    expect(lo.intensity).toBeLessThan(hi.intensity);
  });

  it("does NOT apply the recovery buffer to non-friction probes", () => {
    const slp = buildSlpConfig({ targetSkills: ["turnTaking"], challengeRatio: 1 });
    const a = weakOn("turnTaking"); setSkill(a, "repair", 1); setSkill(a, "attunement", 1);
    const b = weakOn("turnTaking"); setSkill(b, "repair", 0); setSkill(b, "attunement", 0);
    expect(selectChallenge(a, slp, 5).intensity).toBeCloseTo(selectChallenge(b, slp, 5).intensity);
  });

  it("lowers intensity at a simpler language level", () => {
    const slp = buildSlpConfig({ targetSkills: ["turnTaking"], challengeRatio: 1 });
    const p = weakOn("turnTaking");
    const simple = selectChallenge(p, slp, 5, { languageLevelTier: 1 }); // single_words
    const full = selectChallenge(p, slp, 5, { languageLevelTier: 4 });   // full_sentences
    expect(simple.intensity).toBeLessThan(full.intensity);
  });

  it("scaffolds when shaping collapses the probe (friction + simple language + no recovery)", () => {
    const slp = buildSlpConfig({ targetSkills: ["assertiveness"], challengeRatio: 1 });
    const p = weakOn("assertiveness", 0.5); // small gap → small base intensity
    setSkill(p, "repair", 0); setSkill(p, "attunement", 0);
    const out = selectChallenge(p, slp, 5, { languageLevelTier: 1 });
    expect(out.probe).toBe("none");
    expect(out.dim).toBe("assertiveness"); // dim still surfaced for tracing
  });
});

describe("probe back-off", () => {
  it("scaffolds after three consecutive failed probes on a dim", () => {
    const slp = buildSlpConfig({ targetSkills: ["initiation"], challengeRatio: 1 });
    const p = weakOn("initiation");

    // Fresh: it probes.
    expect(selectChallenge(p, slp, 5).probe).toBe("go_minimal");

    // Three failures recorded → back off.
    recordProbeOutcome(p, "initiation", false);
    recordProbeOutcome(p, "initiation", false);
    recordProbeOutcome(p, "initiation", false);
    const backedOff = selectChallenge(p, slp, 5);
    expect(backedOff.probe).toBe("none");
    expect(backedOff.dim).toBe("initiation");

    // A subsequent success breaks the back-off streak → probes again.
    recordProbeOutcome(p, "initiation", true);
    expect(selectChallenge(p, slp, 5).probe).toBe("go_minimal");
  });
});

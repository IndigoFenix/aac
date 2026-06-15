// server/tests/social-competencies.test.ts
//
// Batch-A competency coverage: the conversation-mechanics skills (turnTaking,
// topicMaintenance, topicShifting, greetings, leaveTaking) are in the profile,
// updateProfile samples them CONDITIONALLY, and selectChallenge can pick their
// probes. Pure engine module — runs in the standard jest environment.

import {
  COMPETENCIES,
  emptyProfile,
  updateProfile,
  selectChallenge,
  buildSlpConfig,
  type Competency,
} from "../services/social-bot/personality-and-challenge";

const BATCH_A: Competency[] = [
  "turnTaking", "topicMaintenance", "topicShifting", "greetings", "leaveTaking",
];

// Neutral core event — the always-required fields, set so the core skills sit
// mid-range and don't interfere with what we're asserting about batch A.
function baseEv(over: Partial<Parameters<typeof updateProfile>[1]> = {}) {
  return {
    contingency: 0.5, addressedBid: true, askShare: 0.5, disclosed: false,
    affectTracksCharacter: true, repaired: null, tookOwnStance: false,
    sycophantic: false, complimentSpecific: null, initiatedBid: false,
    engagedCharacterInterest: null,
    ...over,
  };
}

describe("batch-A competencies", () => {
  it("are present in COMPETENCIES and a fresh profile", () => {
    const profile = emptyProfile();
    for (const c of BATCH_A) {
      expect(COMPETENCIES).toContain(c);
      expect(profile.skills[c]).toEqual({ value: 0.5, samples: 0 });
    }
  });

  it("samples greetings only at a greeting moment (null elsewhere)", () => {
    const p = emptyProfile();
    updateProfile(p, baseEv({ greeted: null }));
    expect(p.skills.greetings.samples).toBe(0);
    updateProfile(p, baseEv({ greeted: true }));
    expect(p.skills.greetings.samples).toBe(1);
    expect(p.skills.greetings.value).toBeGreaterThan(0.5);
  });

  it("samples topicShifting only when a real shift happened", () => {
    const p = emptyProfile();
    updateProfile(p, baseEv({ topicShiftedWell: null }));
    expect(p.skills.topicShifting.samples).toBe(0);
    updateProfile(p, baseEv({ topicShiftedWell: false }));
    expect(p.skills.topicShifting.samples).toBe(1);
    expect(p.skills.topicShifting.value).toBeLessThan(0.5);
  });

  it("drives turnTaking down when the user keeps interrupting", () => {
    const p = emptyProfile();
    for (let i = 0; i < 8; i++) updateProfile(p, baseEv({ turnTaking: false }));
    expect(p.skills.turnTaking.samples).toBe(8);
    expect(p.skills.turnTaking.value).toBeLessThan(0.35);
  });

  it("maps each probe-backed batch-A skill to its probe via selectChallenge", () => {
    const cases: Array<{ dim: Competency; probe: string }> = [
      { dim: "turnTaking", probe: "hold_floor" },
      { dim: "topicMaintenance", probe: "anchor_topic" },
      { dim: "topicShifting", probe: "invite_topic_change" },
      { dim: "leaveTaking", probe: "wind_down_cue" },
    ];
    for (const { dim, probe } of cases) {
      const p = emptyProfile();
      // Make this dim weak with enough samples to clear MIN_SAMPLES.
      for (let i = 0; i < 10; i++) p.skills[dim] = { value: 0.1, samples: 10 };
      // challengeRatio:1 forces past the scaffold gate; scope to just this dim.
      const slp = buildSlpConfig({ targetSkills: [dim], challengeRatio: 1 });
      const out = selectChallenge(p, slp, 5);
      expect(out.dim).toBe(dim);
      expect(out.probe).toBe(probe);
      expect(out.intensity).toBeGreaterThan(0);
      expect(out.intensity).toBeLessThanOrEqual(slp.maxChallengeIntensity);
    }
  });

  it("never probes greetings (detection only)", () => {
    const p = emptyProfile();
    p.skills.greetings = { value: 0.05, samples: 20 };
    const slp = buildSlpConfig({ targetSkills: ["greetings"], challengeRatio: 1 });
    // greetings has no PROBE_FOR entry → no candidate → scaffold.
    expect(selectChallenge(p, slp, 5).probe).toBe("none");
  });
});

const BATCH_B: Competency[] = [
  "perspectiveTaking", "emotionExpression", "empathy", "politeness", "askingForHelp", "refusal",
];

describe("batch-B competencies", () => {
  it("are present in COMPETENCIES and a fresh profile", () => {
    const profile = emptyProfile();
    for (const c of BATCH_B) {
      expect(COMPETENCIES).toContain(c);
      expect(profile.skills[c]).toEqual({ value: 0.5, samples: 0 });
    }
  });

  it("always samples perspectiveTaking, emotionExpression, and politeness", () => {
    const p = emptyProfile();
    updateProfile(p, baseEv({ consideredPerspective: false, expressedEmotion: true, polite: 0.9 }));
    expect(p.skills.perspectiveTaking.samples).toBe(1);
    expect(p.skills.perspectiveTaking.value).toBeLessThan(0.5);
    expect(p.skills.emotionExpression.samples).toBe(1);
    expect(p.skills.emotionExpression.value).toBeGreaterThan(0.5);
    expect(p.skills.politeness.samples).toBe(1);
    expect(p.skills.politeness.value).toBeGreaterThan(0.5);
  });

  it("samples empathy / askingForHelp / refusal only at their opportunities", () => {
    const p = emptyProfile();
    // No opportunities → no samples.
    updateProfile(p, baseEv({ showedEmpathy: null, askedForHelp: null, refusedWell: null }));
    expect(p.skills.empathy.samples).toBe(0);
    expect(p.skills.askingForHelp.samples).toBe(0);
    expect(p.skills.refusal.samples).toBe(0);
    // Opportunities arise → sampled.
    updateProfile(p, baseEv({ showedEmpathy: true, askedForHelp: false, refusedWell: true }));
    expect(p.skills.empathy.samples).toBe(1);
    expect(p.skills.empathy.value).toBeGreaterThan(0.5);
    expect(p.skills.askingForHelp.samples).toBe(1);
    expect(p.skills.askingForHelp.value).toBeLessThan(0.5);
    expect(p.skills.refusal.samples).toBe(1);
    expect(p.skills.refusal.value).toBeGreaterThan(0.5);
  });

  it("maps each batch-B skill to its probe via selectChallenge", () => {
    const cases: Array<{ dim: Competency; probe: string }> = [
      { dim: "perspectiveTaking", probe: "state_feeling" },
      { dim: "emotionExpression", probe: "invite_feeling" },
      { dim: "empathy", probe: "share_minor_trouble" },
      { dim: "politeness", probe: "do_a_favor" },
      { dim: "askingForHelp", probe: "introduce_obstacle" },
      { dim: "refusal", probe: "unreasonable_request" },
    ];
    for (const { dim, probe } of cases) {
      const p = emptyProfile();
      p.skills[dim] = { value: 0.1, samples: 10 };
      const slp = buildSlpConfig({ targetSkills: [dim], challengeRatio: 1 });
      const out = selectChallenge(p, slp, 5);
      expect(out.dim).toBe(dim);
      expect(out.probe).toBe(probe);
    }
  });
});

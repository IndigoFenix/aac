// server/tests/social-slp-config.test.ts
//
// Unit coverage for buildSlpConfig — the social-trainer targeting/enforcement
// builder. Implements the precedence "clinician default < AI override < locks"
// at its caller; this tests the enforcement half (scope + locks + ceiling).
// Imports from personality-and-challenge.ts (pure — no face/appearance imports),
// so it runs in the standard jest environment.

import {
  COMPETENCIES,
  buildSlpConfig,
  DEFAULT_SLP_CONFIG,
  DEFAULT_MAX_CHALLENGE_INTENSITY,
  DEFAULT_CHALLENGE_RATIO,
} from "../services/social-bot/personality-and-challenge";

describe("buildSlpConfig", () => {
  it("defaults to all competencies in scope, nothing locked, default ceiling", () => {
    const cfg = buildSlpConfig();
    expect(cfg.goalDimensions).toEqual(COMPETENCIES);
    expect(cfg.lockedDimensions).toEqual([]);
    expect(cfg.maxChallengeIntensity).toBe(DEFAULT_MAX_CHALLENGE_INTENSITY);
    expect(cfg.challengeRatio).toBe(DEFAULT_CHALLENGE_RATIO);
  });

  it("DEFAULT_SLP_CONFIG matches the unconfigured builder output", () => {
    expect(DEFAULT_SLP_CONFIG).toEqual(buildSlpConfig());
  });

  it("scopes goalDimensions to targetSkills when provided", () => {
    const cfg = buildSlpConfig({ targetSkills: ["initiation", "repair"] });
    expect(cfg.goalDimensions).toEqual(["repair", "initiation"]); // canonical order
  });

  it("treats empty targetSkills as 'all'", () => {
    expect(buildSlpConfig({ targetSkills: [] }).goalDimensions).toEqual(COMPETENCIES);
  });

  it("ALWAYS removes locked skills from goalDimensions (hard floor)", () => {
    const cfg = buildSlpConfig({
      targetSkills: ["initiation", "repair", "assertiveness"],
      lockedSkills: ["repair"],
    });
    expect(cfg.lockedDimensions).toEqual(["repair"]);
    expect(cfg.goalDimensions).not.toContain("repair");
    expect(cfg.goalDimensions).toEqual(["assertiveness", "initiation"]);
  });

  it("falls back to all-but-locked when targeting + locks would leave nothing", () => {
    // AI focuses only on a skill the clinician locked → no valid goals remain.
    const cfg = buildSlpConfig({ targetSkills: ["repair"], lockedSkills: ["repair"] });
    expect(cfg.goalDimensions).not.toContain("repair");
    expect(cfg.goalDimensions).toEqual(COMPETENCIES.filter((c) => c !== "repair"));
  });

  it("clamps the challenge ceiling into [0,1]", () => {
    expect(buildSlpConfig({ maxChallengeIntensity: 5 }).maxChallengeIntensity).toBe(1);
    expect(buildSlpConfig({ maxChallengeIntensity: -2 }).maxChallengeIntensity).toBe(0);
    expect(buildSlpConfig({ maxChallengeIntensity: 0.55 }).maxChallengeIntensity).toBe(0.55);
  });

  it("ignores unknown skill keys in either list", () => {
    const cfg = buildSlpConfig({
      targetSkills: ["initiation", "not_a_skill" as any],
      lockedSkills: ["also_bogus" as any],
    });
    expect(cfg.goalDimensions).toEqual(["initiation"]);
    expect(cfg.lockedDimensions).toEqual([]);
  });
});

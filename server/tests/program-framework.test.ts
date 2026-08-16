/**
 * Guard: the program-framework registry and everything that gates on it.
 *
 * The point of the "personal" framework is that a learner outside any school
 * system gets a REAL program (goals, services, progress) without any statutory
 * paperwork — no placement statements, no prior-written-consent forms, no
 * filing deadline. The failure mode this suite exists to catch is the opposite
 * of a crash: a missing/unknown framework quietly resolving to a statutory
 * bundle and surfacing US or Israeli legal machinery at a family that has none.
 */

import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_PROGRAM_FRAMEWORK,
  PROGRAM_FRAMEWORKS,
  frameworkCapabilities,
  frameworkLabelSuffix,
  getFrameworkBundle,
  isStatutoryFramework,
  normalizeFramework,
} from "@shared/program-framework";
import { programFrameworkEnum } from "@shared/schema";
import { buildFrameworkGuidance } from "../services/memory-schema/progress-memory-schema.js";
import { getSystemPrompt } from "../services/system-prompts.js";

describe("program-framework registry", () => {
  it("covers exactly the values in the program_framework pgEnum", () => {
    // Drift here means the DB accepts a value the capability table can't
    // describe — every gate then silently falls back to "personal".
    expect([...PROGRAM_FRAMEWORKS].sort()).toEqual([...programFrameworkEnum.enumValues].sort());
  });

  it("gives every framework a bundle with a distinct label suffix", () => {
    const suffixes = PROGRAM_FRAMEWORKS.map((fw) => frameworkLabelSuffix(fw));
    expect(new Set(suffixes).size).toBe(PROGRAM_FRAMEWORKS.length);
    for (const fw of PROGRAM_FRAMEWORKS) {
      expect(getFrameworkBundle(fw)).not.toBeNull();
    }
  });

  it("normalizes unknown and absent values to null, not to a guess", () => {
    expect(normalizeFramework("tala")).toBe("tala");
    expect(normalizeFramework("personal")).toBe("personal");
    expect(normalizeFramework("iep")).toBeNull();
    expect(normalizeFramework("")).toBeNull();
    expect(normalizeFramework(null)).toBeNull();
    expect(normalizeFramework(undefined)).toBeNull();
  });
});

describe("statutory capability gating", () => {
  it("grants a personal program NO statutory elements", () => {
    const caps = frameworkCapabilities("personal");
    expect(caps.statutoryDueDate).toBe(false);
    expect(caps.lre).toBe(false);
    expect(caps.adverseEffect).toBe(false);
    expect(caps.consentForms).toBe(false);
    expect(caps.transitionPlan).toBe(false);
    expect(caps.statutoryMeetingTypes).toBe(false);
    expect(caps.interventionLevel).toBe(false);
    expect(isStatutoryFramework("personal")).toBe(false);
  });

  it("keeps GAS available under every framework — it is clinical, not statutory", () => {
    for (const fw of PROGRAM_FRAMEWORKS) {
      expect(frameworkCapabilities(fw).gas).toBe(true);
    }
  });

  it("keeps the statutory frameworks statutory", () => {
    expect(isStatutoryFramework("tala")).toBe(true);
    expect(isStatutoryFramework("us_iep")).toBe(true);
    // IDEA-specific machinery belongs to us_iep only.
    expect(frameworkCapabilities("us_iep").consentForms).toBe(true);
    expect(frameworkCapabilities("us_iep").transitionPlan).toBe(true);
    expect(frameworkCapabilities("tala").consentForms).toBe(false);
    // ICF intervention level is the TALA side.
    expect(frameworkCapabilities("tala").interventionLevel).toBe(true);
    expect(frameworkCapabilities("us_iep").interventionLevel).toBe(false);
  });

  it("resolves an unknown or absent framework to the NON-statutory bundle", () => {
    // The whole safety property: never invent legal obligations for a learner
    // whose framework was never recorded.
    for (const missing of [null, undefined, "", "typo_framework"]) {
      const caps = frameworkCapabilities(missing);
      expect(caps.consentForms).toBe(false);
      expect(caps.lre).toBe(false);
      expect(caps.statutoryDueDate).toBe(false);
    }
    expect(isStatutoryFramework(DEFAULT_PROGRAM_FRAMEWORK)).toBe(false);
  });

  it("labels an unknown framework rather than mislabelling it as IEP", () => {
    // The old `framework === 'tala' ? 'Tala' : 'Iep'` ternary called everything
    // that wasn't TALA an IEP. It must not come back.
    expect(frameworkLabelSuffix("personal")).toBe("Personal");
    expect(frameworkLabelSuffix("nonsense")).toBe("Personal");
    expect(frameworkLabelSuffix("tala")).toBe("Tala");
    expect(frameworkLabelSuffix("us_iep")).toBe("Iep");
  });
});

describe("buildFrameworkGuidance (progress prompt)", () => {
  it("tells the assistant to skip statutory paperwork on a personal program", () => {
    const g = buildFrameworkGuidance("personal");
    expect(g).toMatch(/PERSONAL/);
    expect(g).toMatch(/not enrolled in a school system/i);
    expect(g).toMatch(/no statutory layer/i);
    // The program itself is NOT reduced — goals/services/progress still apply.
    expect(g).toMatch(/goals/i);
    expect(g).toMatch(/services/i);
  });

  it("lists the statutory elements that do apply, per framework", () => {
    const iep = buildFrameworkGuidance("us_iep");
    expect(iep).toMatch(/US IEP/);
    expect(iep).toMatch(/leastRestrictiveEnvironment/);
    expect(iep).toMatch(/consent/i);
    expect(iep).toMatch(/transition plan/i);

    const tala = buildFrameworkGuidance("tala");
    expect(tala).toMatch(/Israeli TALA/);
    expect(tala).toMatch(/interventionLevel/);
    // TALA has no prior-written-consent or transition-plan requirement here.
    expect(tala).not.toMatch(/transition plan/i);
  });

  it("treats an absent framework as personal", () => {
    for (const missing of [null, undefined, ""]) {
      expect(buildFrameworkGuidance(missing)).toMatch(/PERSONAL/);
    }
  });
});

describe("getSystemPrompt framework fallback", () => {
  it("does not default a missing framework to US IEP", () => {
    // Regression: the old code did `if (!framework) framework = 'us_iep'`,
    // which framed every unknown student in US statutory terms.
    const missing = getSystemPrompt("assistant", null);
    const personal = getSystemPrompt("assistant", "personal");
    expect(missing).toBe(personal);
  });
});

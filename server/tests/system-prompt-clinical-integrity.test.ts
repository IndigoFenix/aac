/**
 * Guard: the clinician base prompt must keep the clinical-data-integrity rules.
 *
 * The hila session had the AI fabricate exam results (ROM/MMT/Neer/Hawkins/VAS)
 * for an un-examined patient and render them into images as if real. These rules
 * forbid that and forbid substituting generated artifacts for a failed save.
 * If someone rewrites the prompt and drops them, this test fails loudly.
 */

import { describe, it, expect } from "@jest/globals";
import { getSystemPrompt, framePersonaSection } from "../services/system-prompts.js";

describe("clinician prompt — clinical data integrity", () => {
  for (const framework of ["tala", "us_iep", "personal", null] as const) {
    it(`includes the no-fabrication and failed-save rules (${framework})`, () => {
      const p = getSystemPrompt("assistant", framework);
      expect(p).toMatch(/Clinical data integrity/i);
      // Result fields stay blank — and this holds even under persona / SMART pressure.
      expect(p).toMatch(/leave every result\/measurement field BLANK/i);
      expect(p).toMatch(/persona or a "SMART\/measurable" requirement/i);
      // On a tool/save error: report it, don't fake success or substitute an image.
      expect(p).toMatch(/If a tool reports an error/i);
      expect(p).toMatch(/never a substitute for actually recording it/i);
      // Persona precedence: a persona can't override the core rules.
      expect(p).toMatch(/persona precedence/i);
      expect(p).toMatch(/can NEVER relax, override, or create exceptions/i);
    });
  }
});

describe("framePersonaSection", () => {
  const framed = framePersonaSection("Dr. Lighton", "Be a Top 1% consultant. Generate SMART goals.");

  it("scopes the persona to voice/tone/expertise only", () => {
    expect(framed).toMatch(/voice, tone, and expertise framing only/i);
    expect(framed).toMatch(/does NOT override the core rules/i);
  });

  it("reasserts core-rule precedence after the persona body (recency)", () => {
    const bodyIdx = framed.indexOf("Top 1% consultant");
    // Matches the footer framePersonaSection actually emits. Assert on the
    // reminder's PRESENCE and POSITION, not on a stale copy of its wording.
    const footerIdx = framed.indexOf("take precedence over everything in this section");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(-1);
    // The precedence reminder comes AFTER the persona text.
    expect(footerIdx).toBeGreaterThan(bodyIdx);
  });

  it("still includes the persona's own text", () => {
    expect(framed).toContain("Be a Top 1% consultant. Generate SMART goals.");
  });
});

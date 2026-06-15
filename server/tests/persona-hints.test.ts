/**
 * generatePersona() startup-hint plumbing: a resolved social-trainer startup
 * spec tunes the peer (gender, archetype, shared interests). Verifies the hints
 * are honoured and that interest hints are capped at 3.
 *
 * persona-generator transitively imports the .tsx ProceduralFace module (jest's
 * server config doesn't compile JSX), so we mock it and dynamic-import the
 * generator — same pattern as social-peer-speaker.test.ts.
 */

import { describe, test, expect, jest, beforeAll } from "@jest/globals";

jest.unstable_mockModule("@shared/social-bot/ProceduralFace", () => ({
  randomAppearance: () => ({
    hue: 200,
    saturation: 60,
    lightness: 60,
    headRx: 1,
    headRy: 1,
    eyeDX: 0,
    eyeDY: 0,
    accessory: undefined,
  }),
}));

let generatePersona: typeof import("../services/social-bot/persona-generator").generatePersona;

beforeAll(async () => {
  ({ generatePersona } = await import("../services/social-bot/persona-generator"));
});

function loves(p: { identity: { interests: Record<string, number> } }): string[] {
  return Object.entries(p.identity.interests)
    .filter(([, v]) => v > 0.5)
    .map(([k]) => k);
}

describe("generatePersona hints", () => {
  test("honours gender, archetype, and seeds interest hints", () => {
    const p = generatePersona({
      gender: "female",
      archetype: "sunny_extrovert",
      interestHints: ["dinosaurs", "outer space"],
    });
    expect(p.gender).toBe("female");
    expect(p.archetype).toBe("sunny_extrovert");
    expect(loves(p)).toEqual(expect.arrayContaining(["dinosaurs", "outer space"]));
  });

  test("seeds at most three interest hints", () => {
    const p = generatePersona({ interestHints: ["aa", "bb", "cc", "dd", "ee"] });
    const ls = loves(p);
    expect(ls).not.toContain("dd");
    expect(ls).not.toContain("ee");
  });

  test("no hints → still produces a valid persona", () => {
    const p = generatePersona();
    expect(typeof p.name).toBe("string");
    expect(p.name.length).toBeGreaterThan(0);
    expect(loves(p).length).toBeGreaterThan(0);
  });
});

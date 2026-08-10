import { describe, it, expect } from "@jest/globals";
import {
  isUserTarget,
  isDeviceTarget,
  isUnknownTarget,
  PARTY_USER,
  PARTY_DEVICE,
} from "../services/dual-agent/speech-party";

// Regression coverage for the facilitator-mode bug (session
// aa5a9567): the Observer tagged every transcript with the student's
// FULL name ("שחף סוחמי") while the coordinator cached only the FIRST
// name ("שחף"). The old exact-string match returned false, so
// USER-targeted speech never triggered a board rebuild.

describe("isUserTarget", () => {
  it("matches the literal USER token", () => {
    expect(isUserTarget("USER")).toBe(true);
    expect(isUserTarget("user")).toBe(true);
    expect(isUserTarget(" User ")).toBe(true);
  });

  it("matches an exact first-name config", () => {
    expect(isUserTarget("שחף", "שחף")).toBe(true);
  });

  it("matches a FULL-name target against a first-name config", () => {
    // The core regression: target is full name, config is first name.
    expect(isUserTarget("שחף סוחמי", "שחף")).toBe(true);
  });

  it("matches a first-name target against a full-name config", () => {
    expect(isUserTarget("שחף", "שחף סוחמי")).toBe(true);
  });

  it("accepts multiple name forms and matches any", () => {
    expect(isUserTarget("שחף סוחמי", "שחף סוחמי", "שחף")).toBe(true);
    expect(isUserTarget("Shachaf", "שחף סוחמי", "Shachaf Suchami")).toBe(true);
  });

  it("ignores trailing punctuation the model adds", () => {
    expect(isUserTarget("שחף!", "שחף")).toBe(true);
    expect(isUserTarget('"שחף"', "שחף")).toBe(true);
  });

  it("is case-insensitive for Latin names", () => {
    expect(isUserTarget("shachaf suchami", "Shachaf")).toBe(true);
  });

  it("does NOT match an unrelated speaker", () => {
    expect(isUserTarget("שלי פרי", "שחף", "שחף סוחמי")).toBe(false);
    expect(isUserTarget("DEVICE", "שחף")).toBe(false);
  });

  // Regression coverage for the surname-collision bug (session bb87e58d,
  // 2026-08-10): the mother ("לילית זיסמן") shares the student's family name
  // ("הדר זיסמן"). Any-token matching read her as the student, so the
  // attribution trust gate demoted every utterance she aimed at her daughter
  // to ambient hearsay — no yellow caption, no board rebuild, all session.
  it("does NOT match a family member on the shared surname alone", () => {
    expect(isUserTarget("לילית זיסמן", "הדר זיסמן", "הדר")).toBe(false);
    expect(isUserTarget("זיסמן", "הדר זיסמן", "הדר")).toBe(false);
  });

  it("does NOT match a different person who shares only the given name", () => {
    expect(isUserTarget("הדר לוי", "הדר זיסמן")).toBe(false);
  });

  it("still matches the student with the shared-surname family present", () => {
    expect(isUserTarget("הדר", "הדר זיסמן", "הדר")).toBe(true);
    expect(isUserTarget("הדר זיסמן", "הדר זיסמן", "הדר")).toBe(true);
    expect(isUserTarget("הדר!", "הדר זיסמן", "הדר")).toBe(true);
  });

  it("returns false with no value or no names", () => {
    expect(isUserTarget(undefined, "שחף")).toBe(false);
    expect(isUserTarget("שחף סוחמי")).toBe(false);
  });
});

describe("isDeviceTarget", () => {
  it("matches the literal DEVICE token and the AI name", () => {
    expect(isDeviceTarget("DEVICE")).toBe(true);
    expect(isDeviceTarget("Aivota", "Aivota")).toBe(true);
    expect(isDeviceTarget("aivota!", "Aivota")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(isDeviceTarget("שחף", "Aivota")).toBe(false);
  });
});

describe("party constants and isUnknownTarget", () => {
  it("exposes the reserved tokens", () => {
    expect(PARTY_USER).toBe("USER");
    expect(PARTY_DEVICE).toBe("DEVICE");
  });

  it("detects UNKNOWN", () => {
    expect(isUnknownTarget("UNKNOWN")).toBe(true);
    expect(isUnknownTarget("שחף")).toBe(false);
  });
});

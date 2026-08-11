/**
 * Storage-side ElevenLabs key validation (shared/elevenlabs-key.ts).
 *
 * The values that reach the settings field in practice — verified against the
 * live API and the dev DB on 2026-08-11 — are: a real "sk_" secret, the 64-hex
 * key ID re-copied from the ElevenLabs dashboard (the secret is only revealed
 * once, at creation), or a password/word a browser autofilled into the
 * password-type input. Only the first may reach the database; the repository
 * guard (aacSettingsRepository.sanitizeUpdates) throws the returned code as a
 * client-translatable error:CODE.
 */

import { describe, it, expect } from "@jest/globals";
import { elevenLabsKeyProblem } from "@shared/elevenlabs-key";

describe("elevenLabsKeyProblem", () => {
  it("accepts a real sk_ key", () => {
    expect(elevenLabsKeyProblem("sk_" + "a1b2c3d4".repeat(6))).toBeNull();
  });

  it("accepts clearing the key (empty / whitespace-only)", () => {
    expect(elevenLabsKeyProblem("")).toBeNull();
    expect(elevenLabsKeyProblem("   ")).toBeNull();
  });

  it("accepts a padded sk_ key (storage trims it)", () => {
    expect(elevenLabsKeyProblem("  sk_" + "x".repeat(48) + " ")).toBeNull();
  });

  it("names a pasted 64-hex dashboard key ID specifically", () => {
    expect(elevenLabsKeyProblem("f".repeat(64))).toBe("ELEVENLABS_KEY_ID");
    expect(elevenLabsKeyProblem("AbCdEf0123456789".repeat(4))).toBe("ELEVENLABS_KEY_ID");
  });

  it("rejects an autofilled password", () => {
    expect(elevenLabsKeyProblem("Hadar1996")).toBe("ELEVENLABS_KEY_FORMAT");
  });

  it("rejects a legacy 32-hex key (the API no longer accepts them)", () => {
    expect(elevenLabsKeyProblem("a".repeat(32))).toBe("ELEVENLABS_KEY_FORMAT");
  });

  it("rejects an sk_ prefix with too little behind it", () => {
    expect(elevenLabsKeyProblem("sk_short")).toBe("ELEVENLABS_KEY_FORMAT");
  });
});

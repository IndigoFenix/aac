// client/src/features/consent/sign-error.test.ts
//
/// <reference types="jest" />
//
// Run with:  npm run test:client-app -- sign-error

import { CONSENT_ERROR_CODES, describeConsentError, describeSignError } from "./sign-error";

// A translator that echoes what it was asked for, so the assertions read the
// key and the params straight off the result.
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.values(params).join(",")})` : key;

describe("describeSignError", () => {
  it("names the offending field from a zod issue path, in the wizard's own words", () => {
    const out = describeSignError(
      { message: "Invalid input", issues: [{ path: ["guardianFields", "governmentIdNumber"], message: "Too small" }] },
      t,
    );
    expect(out).toBe("consent.wizard.invalidField(consent.wizard.fieldNames.governmentIdNumber)");
  });

  it("falls back to the raw path segment for a field it has no words for", () => {
    const out = describeSignError({ issues: [{ path: ["attestation", "notes"] }] }, t);
    expect(out).toBe("consent.wizard.invalidField(notes)");
  });

  it("explains a self-consenting student when the server refuses the attestation", () => {
    expect(describeSignError({ code: "signer_not_permitted", message: "…" }, t)).toBe(
      "consent.wizard.selfConsentNoAttestBody",
    );
  });

  it("never shows the server's raw English for anything else", () => {
    expect(describeSignError({ message: "Sign failed (500)" }, t)).toBe("consent.wizard.unexpectedError");
    expect(describeSignError(undefined, t)).toBe("consent.wizard.unexpectedError");
    expect(describeSignError({ issues: [] }, t)).toBe("consent.wizard.unexpectedError");
  });
});

describe("describeConsentError", () => {
  it("maps every known server code to its own translation key", () => {
    for (const code of CONSENT_ERROR_CODES) {
      expect(describeConsentError({ code, message: "raw english" }, t)).toBe(`consent.errors.${code}`);
    }
  });

  it("does not echo an unknown code or the message", () => {
    expect(describeConsentError({ code: "something_new", message: "raw" }, t)).toBe(
      "consent.wizard.unexpectedError",
    );
  });

  it("a field issue wins over a code", () => {
    expect(
      describeConsentError({ code: "permission_denied", issues: [{ path: ["signature"] }] }, t),
    ).toBe("consent.wizard.invalidField(consent.wizard.fieldNames.signature)");
  });

  it("outside the sign step, signer_not_permitted is just its own sentence", () => {
    expect(describeConsentError({ code: "signer_not_permitted" }, t)).toBe(
      "consent.errors.signer_not_permitted",
    );
  });
});

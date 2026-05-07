/**
 * Pure-logic tests for the protocol-agnostic claim-mapping layer.
 * Both OIDC claims and SAML attributes feed into this helper.
 */

import { describe, it, expect } from "@jest/globals";
import { applyClaimMapping } from "../services/identity-claim-mapping.js";

describe("applyClaimMapping", () => {
  describe("default mapping", () => {
    it("extracts externalId from sub", () => {
      const out = applyClaimMapping({ sub: "user-123", email: "u@example.com" }, undefined);
      expect(out.externalId).toBe("user-123");
      expect(out.email).toBe("u@example.com");
    });

    it("falls back to nameID when sub is missing (SAML case)", () => {
      const out = applyClaimMapping({ nameID: "saml-user-456", email: "saml@example.com" }, undefined);
      expect(out.externalId).toBe("saml-user-456");
      expect(out.email).toBe("saml@example.com");
    });

    it("extracts standard OIDC name fields", () => {
      const out = applyClaimMapping({
        sub: "u",
        given_name: "Alice",
        family_name: "Liddell",
        name: "Alice Liddell",
      }, undefined);
      expect(out.givenName).toBe("Alice");
      expect(out.familyName).toBe("Liddell");
      expect(out.fullName).toBe("Alice Liddell");
    });

    it("preserves the raw claims dict for audit", () => {
      const claims = { sub: "u", custom_attr: "x", another: 42 };
      const out = applyClaimMapping(claims, undefined);
      expect(out.raw).toEqual(claims);
    });
  });

  describe("per-provider override", () => {
    it("overrides the default externalId source", () => {
      const out = applyClaimMapping(
        { teudat_zehut: "123456789", email: "t@example.com" },
        { externalId: ["teudat_zehut"] },
      );
      expect(out.externalId).toBe("123456789");
    });

    it("merges with defaults — unspecified fields still resolve", () => {
      // Mapping only overrides nationalIdNumber; other fields fall back to default.
      const out = applyClaimMapping(
        {
          sub: "user-1",
          email: "u@example.com",
          "urn:oid:1.2.840.113549.1.9.1": "9988776",
        },
        { nationalIdNumber: ["urn:oid:1.2.840.113549.1.9.1"] },
      );
      expect(out.externalId).toBe("user-1");
      expect(out.email).toBe("u@example.com");
      expect(out.nationalIdNumber).toBe("9988776");
    });

    it("tries source keys in order — first match wins", () => {
      const out = applyClaimMapping(
        { sub: "u", mail: "first@example.com", email: "second@example.com" },
        { email: ["mail", "email"] },
      );
      expect(out.email).toBe("first@example.com");
    });

    it("coerces numeric values to strings", () => {
      const out = applyClaimMapping({ sub: 12345 }, undefined);
      expect(out.externalId).toBe("12345");
    });
  });

  describe("error handling", () => {
    it("throws when no externalId source resolves", () => {
      expect(() => applyClaimMapping({ email: "x@example.com" }, undefined))
        .toThrow(/externalId/);
    });

    it("treats empty strings as missing (continues to next source)", () => {
      const out = applyClaimMapping(
        { sub: "", uid: "fallback-uid" },
        undefined,
      );
      expect(out.externalId).toBe("fallback-uid");
    });
  });

  describe("MoE-style mapping (regression scenario for §1.3)", () => {
    it("can map Hebrew/SAML attributes to canonical fields", () => {
      // Simulated MoE SAML attributes — Teudat Zehut as ID, school code, role.
      const claims = {
        nameID: "MOE-USR-7788",
        "urn:oid:1.2.840.113549.1.9.1": "alice@school.moe.gov.il",
        teudat_zehut: "012345678",
        school_id: "SCH-9921",
        user_type: "teacher",
      };
      const mapping = {
        externalId: ["nameID"],
        email: ["urn:oid:1.2.840.113549.1.9.1"],
        nationalIdNumber: ["teudat_zehut"],
        instituteCode: ["school_id"],
        userType: ["user_type"],
      };
      const out = applyClaimMapping(claims, mapping);
      expect(out.externalId).toBe("MOE-USR-7788");
      expect(out.email).toBe("alice@school.moe.gov.il");
      expect(out.nationalIdNumber).toBe("012345678");
      expect(out.instituteCode).toBe("SCH-9921");
      expect(out.userType).toBe("teacher");
    });
  });
});

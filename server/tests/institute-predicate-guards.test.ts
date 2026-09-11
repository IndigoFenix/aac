/**
 * The institute authorization predicate pair — structural guards.
 *
 * DB-FREE by construction: every case here is refused BEFORE the repository
 * issues a query, which is the property being pinned. If one of these ever
 * reaches Postgres the test will fail on the connection, which is the correct
 * failure — "it asked the database" means the guard is gone.
 *
 * Pins the fix for audit finding F12 (2026-09-10): the customer-support
 * short-circuit `if (getActiveSupportInstituteId() === instituteId) return true`
 * is `undefined === undefined` — TRUE — for a caller that passes a nullish
 * institute id, which is how the 2026-04 consent escalation
 * (`PUT /api/consent/students/:id/authority`) handed institute-admin rights to
 * every authenticated caller. See SECURITY_ARCHITECTURE §2.4 / §5.4.
 */

import { describe, it, expect } from "@jest/globals";
import { instituteRepository } from "../repositories/instituteRepository.js";
import {
  getActiveSupportInstituteId,
  runWithSupportContext,
} from "../services/customerSupportService.js";

const USER = "11111111-1111-1111-1111-111111111111";
const INSTITUTE = "22222222-2222-2222-2222-222222222222";

describe("support-mode sentinel is structurally impossible to trip", () => {
  it("NON-VACUITY: the pre-fix expression really does grant on a nullish id", () => {
    // This is the literal line the two predicates used to open with. Outside a
    // support session `getActiveSupportInstituteId()` is `undefined`, so the
    // comparison against an undefined argument is TRUE and the old code
    // returned `true` — institute admin — without ever looking at the user.
    const instituteId = undefined as unknown as string;
    expect(getActiveSupportInstituteId()).toBeUndefined();
    expect(getActiveSupportInstituteId() === instituteId).toBe(true);
  });

  describe.each([
    ["undefined", undefined as unknown as string],
    ["null", null as unknown as string],
    ["empty string", ""],
  ])("a %s institute id", (_label, instituteId) => {
    it("is never an admin, outside a support session", async () => {
      expect(await instituteRepository.isUserAdminOfInstitute(instituteId, USER)).toBe(false);
    });

    it("is never a member, outside a support session", async () => {
      expect(await instituteRepository.isUserMemberOfInstitute(instituteId, USER)).toBe(false);
    });

    it("is never an admin or member INSIDE a support session either", async () => {
      await runWithSupportContext(INSTITUTE, async () => {
        expect(await instituteRepository.isUserAdminOfInstitute(instituteId, USER)).toBe(false);
        expect(await instituteRepository.isUserMemberOfInstitute(instituteId, USER)).toBe(false);
      });
    });

    it("does not resolve a membership row", async () => {
      expect(await instituteRepository.getInstituteUserLink(instituteId, USER)).toBeUndefined();
      expect(await instituteRepository.getActiveMembership(instituteId, USER)).toBeUndefined();
    });
  });

  describe.each([
    ["undefined", undefined as unknown as string],
    ["null", null as unknown as string],
    ["empty string", ""],
  ])("a %s user id", (_label, userId) => {
    it("is refused even for a real institute in a support session for it", async () => {
      // The support short-circuit intentionally ignores WHICH user is asking —
      // a support agent holds no membership row. That is only sound while the
      // institute id is real; a nullish USER id must still not sail through the
      // rest of the predicate.
      expect(await instituteRepository.isUserAdminOfInstitute(INSTITUTE, userId)).toBe(false);
      expect(await instituteRepository.isUserMemberOfInstitute(INSTITUTE, userId)).toBe(false);
    });
  });

  it("still short-circuits for a REAL institute inside its support session", async () => {
    await runWithSupportContext(INSTITUTE, async () => {
      expect(await instituteRepository.isUserAdminOfInstitute(INSTITUTE, USER)).toBe(true);
      expect(await instituteRepository.isUserMemberOfInstitute(INSTITUTE, USER)).toBe(true);
    });
  });

  it("does not short-circuit for a DIFFERENT institute inside a support session", async () => {
    // No DB is reachable here, so the assertion is that it does not return
    // `true` without asking — it must fall through to the membership lookup.
    await runWithSupportContext(INSTITUTE, async () => {
      expect(instituteRepository.isCustomerSupportSessionFor("33333333-3333-3333-3333-333333333333")).toBe(false);
      expect(instituteRepository.isCustomerSupportSessionFor(undefined as unknown as string)).toBe(false);
    });
  });
});

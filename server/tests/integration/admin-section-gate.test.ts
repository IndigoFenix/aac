/**
 * Tests for the `requireAdminSection(key)` middleware that gates each admin
 * section's routes. Mirrors the rule the AdminDashboard applies client-side.
 */

import { describe, it, expect } from "@jest/globals";
import { makeReq, makeRes } from "../helpers/http.js";
import { requireAdminSection } from "../../middleware/auth.js";

function adminPseudo(perms: string[]) {
  return {
    id: "admin-id",
    email: "admin@aivota.ai",
    isSystemAdmin: true,
    isAdmin: true,
    _identityKind: "admin" as const,
    adminPermissions: perms,
  };
}

describe("requireAdminSection", () => {
  it("blocks unauthenticated requests with 401", () => {
    const gate = requireAdminSection("personas");
    const req = makeReq({ user: null });
    (req as any).isAuthenticated = () => false;
    const { res, capture } = makeRes();
    let nextCalled = false;
    gate(req, res, () => { nextCalled = true; });
    expect(capture.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("blocks a regular (non-admin) user with 403", () => {
    const gate = requireAdminSection("personas");
    const req = makeReq({
      user: { id: "u1", email: "u@x.com", isSystemAdmin: false },
    });
    (req as any).isAuthenticated = () => true;
    const { res, capture } = makeRes();
    let nextCalled = false;
    gate(req, res, () => { nextCalled = true; });
    expect(capture.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("blocks a regular user even if their users-row has isSystemAdmin=true", () => {
    // Per phase 1: only admin_users-backed sessions count as admin identities.
    // A legacy session that deserialized as a regular user (string-id session
    // from before the rollout) must not satisfy section gates, even if their
    // user row has isSystemAdmin set.
    const gate = requireAdminSection("personas");
    const req = makeReq({
      user: { id: "u1", email: "u@x.com", isSystemAdmin: true /* but no _identityKind */ },
    });
    (req as any).isAuthenticated = () => true;
    const { res, capture } = makeRes();
    let nextCalled = false;
    gate(req, res, () => { nextCalled = true; });
    expect(capture.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("admits an admin with the wildcard '*' permission to any section", () => {
    const gate = requireAdminSection("voices");
    const req = makeReq({ user: adminPseudo(["*"]) });
    (req as any).isAuthenticated = () => true;
    const { res } = makeRes();
    let nextCalled = false;
    gate(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("admits an admin whose permissions explicitly include the section", () => {
    const gate = requireAdminSection("voices");
    const req = makeReq({ user: adminPseudo(["personas", "voices"]) });
    (req as any).isAuthenticated = () => true;
    const { res } = makeRes();
    let nextCalled = false;
    gate(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("blocks an admin whose permissions do NOT include the section", () => {
    const gate = requireAdminSection("voices");
    const req = makeReq({ user: adminPseudo(["personas"]) });
    (req as any).isAuthenticated = () => true;
    const { res, capture } = makeRes();
    let nextCalled = false;
    gate(req, res, () => { nextCalled = true; });
    expect(capture.statusCode).toBe(403);
    expect((capture.jsonBody as any).code).toBe("ADMIN_SECTION_FORBIDDEN");
    expect(nextCalled).toBe(false);
  });
});

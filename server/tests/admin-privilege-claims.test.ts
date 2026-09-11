/**
 * REGRESSION PINS — self-declared `userType` confers no privilege.
 *
 * The 2026-09-10 authorization audit (finding C1) found a two-request,
 * fully anonymous path to the platform-admin surface:
 *
 *   1. `POST /auth/register {"userType":"admin", …}`  — `registerSchema`
 *      accepted `"admin"` from the unauthenticated body and
 *      `userRepository.createUser` wrote it verbatim.
 *   2. `GET /api/admin/users`                          — `requireAdmin` read
 *      `user.userType !== "admin"` as a privilege claim, and the handler
 *      answered with raw `users` rows (bcrypt hash + encrypted TOTP seed
 *      included, because `hydrateRecords` rehydrates them).
 *
 * Both links are now gone rather than merely fixed: step 1 is refused by
 * `registerSchema`, and step 2's whole tier — `requireAdmin` and every route
 * behind it, `GET /api/admin/users` included — was DELETED on 2026-09-10 in
 * phase 0a of the authorization structural pass. What remains under
 * `/api/admin/*` is `requireSystemAdmin` and the section gates, so those are
 * what carry the pin now.
 *
 * These are the DB-free halves: the schema, the surviving middlewares and the
 * response allowlist. The end-to-end half (a real row written through the real
 * controller) lives in
 * `server/tests/integration/admin-privilege-escalation.test.ts`.
 *
 * NOTE on `services/userView.ts`: with `GET /api/admin/users` deleted it has no
 * production caller left. The allowlist pins below are kept deliberately — the
 * helper is the right shape for any future route that serialises a `users` row,
 * and dropping the pins would lose the record of what must never go out.
 */

import { describe, it, expect } from "@jest/globals";
import { makeReq, makeRes } from "./helpers/http.js";
import * as authMiddleware from "../middleware/auth.js";
import { requireSystemAdmin, requireAdminSection } from "../middleware/auth.js";
import { registerSchema, SELF_ASSIGNABLE_USER_TYPES, ALL_USER_TYPES } from "@shared/schema";
import {
  toAdminUserView,
  toAdminUserWithStudentsView,
  ADMIN_USER_VIEW_FIELDS,
} from "../services/userView.js";

function runGate(
  gate: typeof requireSystemAdmin,
  user: Record<string, unknown> | null,
): { statusCode: number; passed: boolean } {
  const req = makeReq({ user });
  (req as any).isAuthenticated = () => user !== null;
  const { res, capture } = makeRes();
  let passed = false;
  gate(req, res, () => {
    passed = true;
  });
  return { statusCode: capture.statusCode, passed };
}

describe("registerSchema — the public registration body", () => {
  const base = {
    email: "someone@example.com",
    firstName: "A",
    lastName: "B",
    password: "Passw0rdPassw0rd",
  };

  it("REFUSES userType 'admin'", () => {
    const parsed = registerSchema.safeParse({ ...base, userType: "admin" });
    expect(parsed.success).toBe(false);
  });

  it("refuses any other privileged-looking value", () => {
    for (const attempt of ["Admin", "ADMIN", "system_admin", "superuser", ""]) {
      expect(registerSchema.safeParse({ ...base, userType: attempt }).success).toBe(false);
    }
  });

  it("still accepts every legitimate self-assignable type", () => {
    for (const userType of SELF_ASSIGNABLE_USER_TYPES) {
      const parsed = registerSchema.safeParse({ ...base, userType });
      expect(parsed.success).toBe(true);
    }
  });

  it("keeps 'admin' legal as DATA on the admin-only update path", () => {
    // `adaptAdminAsUser` stamps userType:'admin' on the backoffice identity and
    // two production rows carry it. The value is legal; it simply means nothing.
    expect(ALL_USER_TYPES as readonly string[]).toContain("admin");
    expect(SELF_ASSIGNABLE_USER_TYPES as readonly string[]).not.toContain("admin");
  });
});

describe("requireAdmin is gone", () => {
  // Phase 0a of the authorization structural pass DELETED the tier outright
  // (20 route registrations, none with a client call site). The C1 chain ended
  // at that middleware, so the strongest possible pin is that the door itself no
  // longer exists — a re-introduction under the old name is a regression, and
  // nothing under `/api/admin/*` may gate on "is an admin" without naming a
  // section.
  it("is not exported from middleware/auth", () => {
    expect(authMiddleware).not.toHaveProperty("requireAdmin");
  });
});

describe("requireAdminSection — what replaced it", () => {
  const gate = requireAdminSection("admins");

  it("REFUSES a user whose only claim is userType='admin'", () => {
    const result = runGate(gate, {
      id: "u1",
      email: "attacker@example.com",
      userType: "admin",
      isAdmin: false,
      isSystemAdmin: false,
    });
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("refuses an ordinary user", () => {
    const result = runGate(gate, {
      id: "u2",
      userType: "Caregiver",
      isAdmin: false,
      isSystemAdmin: false,
    });
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("refuses a plain users.is_admin row — this gate needs an admin IDENTITY", () => {
    // Strictly narrower than the deleted `requireAdmin`, which admitted this.
    const result = runGate(gate, {
      id: "u3",
      userType: "Caregiver",
      isAdmin: true,
      isSystemAdmin: true,
    });
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("refuses a backoffice admin scoped to a DIFFERENT section", () => {
    const result = runGate(gate, {
      id: "a1",
      _identityKind: "admin",
      userType: "admin",
      isAdmin: true,
      isSystemAdmin: true,
      adminPermissions: ["contacts"],
    });
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("ADMITS a backoffice admin holding the section", () => {
    const result = runGate(gate, {
      id: "a2",
      _identityKind: "admin",
      userType: "admin",
      isAdmin: true,
      isSystemAdmin: true,
      adminPermissions: ["admins"],
    });
    expect(result.passed).toBe(true);
  });

  it("401s an unauthenticated request", () => {
    const result = runGate(gate, null);
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(401);
  });
});

describe("requireSystemAdmin", () => {
  it("REFUSES a user whose only claim is userType='admin'", () => {
    const result = runGate(requireSystemAdmin, {
      id: "u1",
      userType: "admin",
      isAdmin: false,
      isSystemAdmin: false,
    });
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("refuses a plain isAdmin user (system admin is strictly narrower)", () => {
    const result = runGate(requireSystemAdmin, {
      id: "u2",
      userType: "admin",
      isAdmin: true,
      isSystemAdmin: false,
    });
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("admits is_system_admin = true", () => {
    const result = runGate(requireSystemAdmin, {
      id: "u3",
      userType: "Caregiver",
      isAdmin: false,
      isSystemAdmin: true,
    });
    expect(result.passed).toBe(true);
  });
});

describe("admin user response allowlist", () => {
  const rawRow = {
    id: "u1",
    email: "victim@example.com",
    firstName: "V",
    lastName: "Ictim",
    fullName: "V Ictim",
    password: "$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ",
    mfaSecret: "aabbcc:ddeeff:001122",
    mfaEnabled: true,
    chatMemory: { Student_Notes: "clinical text" },
    googleId: "1029384756",
    externalStorage: "dropbox",
    phone: "+972500000000",
    isAdmin: false,
    isSystemAdmin: false,
    userType: "Caregiver",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("drops password and mfaSecret", () => {
    const view = toAdminUserView(rawRow);
    expect(view).not.toHaveProperty("password");
    expect(view).not.toHaveProperty("mfaSecret");
  });

  it("drops every field not on the allowlist, including new ones", () => {
    const withFutureColumn = { ...rawRow, someFutureSecret: "leak-me" };
    const view = toAdminUserView(withFutureColumn);
    for (const key of Object.keys(view)) {
      expect(ADMIN_USER_VIEW_FIELDS as readonly string[]).toContain(key);
    }
    expect(view).not.toHaveProperty("someFutureSecret");
    expect(view).not.toHaveProperty("chatMemory");
    expect(view).not.toHaveProperty("googleId");
    expect(view).not.toHaveProperty("externalStorage");
  });

  it("keeps the fields account management actually needs", () => {
    const view = toAdminUserView(rawRow);
    expect(view.id).toBe("u1");
    expect(view.email).toBe("victim@example.com");
    expect(view.userType).toBe("Caregiver");
    expect(view.isAdmin).toBe(false);
    expect(view.mfaEnabled).toBe(true);
  });

  it("reduces the attached students to identity only — no PHI", () => {
    const view = toAdminUserWithStudentsView(rawRow, [
      {
        id: "s1",
        name: "Child One",
        birthDate: "2015-04-01",
        gender: "female",
        chatMemory: { Student_Notes: "clinical" },
        communicationProfile: "…",
        biometricDataId: "b1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("birthDate");
    expect(serialized).not.toContain("chatMemory");
    expect(serialized).not.toContain("communicationProfile");
    expect((view.students as any[])[0]).toEqual({
      id: "s1",
      name: "Child One",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("survives a null/undefined row without throwing", () => {
    expect(toAdminUserView(undefined)).toEqual({});
    expect(toAdminUserWithStudentsView(null, null)).toEqual({ students: [] });
  });
});

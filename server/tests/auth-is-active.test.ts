// `users.is_active` as an actual revocation control.
//
// History this pins: the column was written but never read. Neither passport
// strategy consulted it, and the Google strategy resolved an account by EMAIL
// alone — checking neither the password nor the flag. So deactivating a user
// blocked nothing, while looking like it had worked. That is the worst shape a
// security control can have.
//
// Two halves here. The predicate is tested directly; the WIRING is pinned by
// reading the source, because the four gates live inside closures registered
// on the passport singleton and are not otherwise reachable. A behavioural
// test that could only cover one of the four doors would be worse than the
// source check, since the bug was precisely that one door was missed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { canAuthenticate } from "../userAuth";

describe("canAuthenticate", () => {
  it("allows an active account", () => {
    expect(canAuthenticate({ isActive: true })).toBe(true);
  });

  it("blocks a deactivated account", () => {
    expect(canAuthenticate({ isActive: false })).toBe(false);
  });

  it("treats an absent flag as active", () => {
    // The column is NOT NULL default true; a partial row (a projection that
    // did not select it) must not lock someone out by omission.
    expect(canAuthenticate({})).toBe(true);
    expect(canAuthenticate({ isActive: null })).toBe(true);
  });

  it("blocks a missing account", () => {
    expect(canAuthenticate(null)).toBe(false);
    expect(canAuthenticate(undefined)).toBe(false);
  });
});

describe("every authentication door consults the flag (users and admins)", () => {
  const src = readFileSync(
    path.join(process.cwd(), "server", "userAuth.ts"),
    "utf8",
  );

  // One call in the predicate's own definition, plus one per gate.
  it("routes all four gates through canAuthenticate", () => {
    const calls = src.match(/canAuthenticate\(/g) ?? [];
    // 1 declaration + 7 call sites (4 user-side, 3 admin-side).
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it("gates password login", () => {
    // The LocalStrategy branch that loads a user by email.
    expect(src).toMatch(/getUserByEmail[\s\S]{0,600}?canAuthenticate/);
  });

  it("gates Google login resolved by external identity", () => {
    expect(src).toMatch(/existingIdentity[\s\S]{0,400}?canAuthenticate/);
  });

  it("gates Google login resolved by email address", () => {
    // This was the widest hole: an account matched by address alone.
    expect(src).toMatch(/let user = await storage\.getUserByEmail[\s\S]{0,300}?canAuthenticate/);
  });

  it("gates session deserialization, so revocation hits open sessions", () => {
    // Without this a disabled user keeps working until their cookie expires,
    // which is what makes the difference between "revoked" and "revoked
    // eventually".
    expect(src).toMatch(/deserializeUser[\s\S]{0,900}?canAuthenticate/);
  });

  it("gates the ADMIN password branch", () => {
    // admin_users got its own is_active column in migration 0170; before that a
    // backoffice account — the widest access in the system — had no off switch.
    expect(src).toMatch(/isValidAdminPassword[\s\S]{0,300}?canAuthenticate/);
  });

  it("gates the ADMIN Google branch", () => {
    expect(src).toMatch(/adminMatch[\s\S]{0,200}?canAuthenticate/);
  });

  it("gates ADMIN session deserialization", () => {
    expect(src).toMatch(/adminUserRepository\.getById[\s\S]{0,200}?canAuthenticate/);
  });

  it("does not reintroduce a bare isActive check that bypasses the predicate", () => {
    // A stray `user.isActive` check would drift from the shared rule.
    const bare = src.match(/!\s*user\.isActive\b/g) ?? [];
    expect(bare).toEqual([]);
  });
});

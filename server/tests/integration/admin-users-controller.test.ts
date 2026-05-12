/**
 * Admin users management controller tests.
 *
 * Covers the CRUD endpoints behind the new Admins section, including the
 * "you cannot delete yourself" guard and the permissions sanitization
 * (wildcard `"*"` short-circuits the list, unknown keys are dropped).
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { truncateAll } from "../helpers/db.js";
import { makeReq, makeRes } from "../helpers/http.js";
import { adminUserRepository } from "../../repositories/adminUserRepository.js";
import { adminUsersController } from "../../controllers/adminUsersController.js";

function actor() {
  return { id: "system-admin-id", email: "actor@aivota.ai", isSystemAdmin: true };
}

describe("Admin users controller", () => {
  afterEach(truncateAll);

  it("lists admins", async () => {
    await adminUserRepository.create({
      id: "a-1",
      email: "one@aivota.ai",
      permissions: ["*"],
    } as any);

    const req = makeReq({ user: actor() });
    const { res, capture } = makeRes();
    await adminUsersController.list(req, res);

    expect(capture.statusCode).toBe(200);
    expect((capture.jsonBody as any).admins).toHaveLength(1);
    expect((capture.jsonBody as any).admins[0].email).toBe("one@aivota.ai");
  });

  it("creates an admin, lowercasing the email and defaulting permissions", async () => {
    const req = makeReq({
      user: actor(),
      body: { email: "  NEW@AIVOTA.ai ", firstName: "New", lastName: "Admin" },
    });
    const { res, capture } = makeRes();
    await adminUsersController.create(req, res);

    expect(capture.statusCode).toBe(200);
    const admin = (capture.jsonBody as any).admin;
    expect(admin.email).toBe("new@aivota.ai");
    expect(admin.permissions).toEqual(["*"]);
  });

  it("rejects duplicate emails", async () => {
    await adminUserRepository.create({ id: "a-1", email: "dup@aivota.ai" } as any);

    const req = makeReq({ user: actor(), body: { email: "dup@aivota.ai" } });
    const { res, capture } = makeRes();
    await adminUsersController.create(req, res);

    expect(capture.statusCode).toBe(409);
  });

  it("sanitizes permissions: unknown keys dropped, '*' short-circuits", async () => {
    const req = makeReq({
      user: actor(),
      body: {
        email: "limited@aivota.ai",
        permissions: ["personas", "nope", "voices"],
      },
    });
    const { res, capture } = makeRes();
    await adminUsersController.create(req, res);

    const admin = (capture.jsonBody as any).admin;
    expect(admin.permissions.sort()).toEqual(["personas", "voices"]);

    // Update to "*" — the wildcard should override the listed sections.
    const req2 = makeReq({
      user: actor(),
      params: { id: admin.id },
      body: { permissions: ["*", "personas"] },
    });
    const { res: res2, capture: cap2 } = makeRes();
    await adminUsersController.update(req2, res2);
    expect((cap2.jsonBody as any).admin.permissions).toEqual(["*"]);
  });

  it("refuses to delete the acting admin's own row", async () => {
    const me = await adminUserRepository.create({
      id: "self-admin",
      email: "self@aivota.ai",
    } as any);

    const req = makeReq({
      user: { id: me.id, email: me.email, isSystemAdmin: true },
      params: { id: me.id },
    });
    const { res, capture } = makeRes();
    await adminUsersController.remove(req, res);

    expect(capture.statusCode).toBe(400);
    // Row still there.
    expect(await adminUserRepository.getById(me.id)).toBeTruthy();
  });

  it("deletes another admin", async () => {
    const other = await adminUserRepository.create({
      id: "other-admin",
      email: "other@aivota.ai",
    } as any);

    const req = makeReq({ user: actor(), params: { id: other.id } });
    const { res, capture } = makeRes();
    await adminUsersController.remove(req, res);

    expect(capture.statusCode).toBe(200);
    expect(await adminUserRepository.getById(other.id)).toBeUndefined();
  });
});

/**
 * `buildClinicianCtx`'s fail-open sentinel — the AAC audit's "real recurring bug".
 *
 * Until 2026-09-10 the helper returned ONE `undefined` for two unrelated states:
 *
 *   - "no `?instituteId=` on the request" — legitimate, and the routes that hit
 *     it are governed by their own direct student gate; and
 *   - "the caller named an institute they are not a member of" — an assertion of
 *     a context they do not hold, i.e. a refusal.
 *
 * Consumers then read that single value in opposite directions:
 * `packageController` as DENY, `customAppRepository.getAssignedAppIds` as NO
 * FILTER, and `reportController.requireOwningInstitute` as ALLOW. These tests
 * pin that the two states are now distinguishable, and that each helper maps
 * them to the refusal its route intended.
 *
 * DB-free: `instituteService` is mocked, so no membership lookup runs.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const verifyMembership = jest.fn(
  async (_instituteId: string, _userId: string) => ({ isMember: true, isAdmin: false }) as any,
);
const getInstituteById = jest.fn(async (_id: string) => ({ id: _id, type: "school" }) as any);
const isStudentInInstitute = jest.fn(async (_i: string, _s: string) => false);

jest.unstable_mockModule("../services/instituteService", () => ({
  instituteService: { verifyMembership, getInstituteById, isStudentInInstitute },
}));

const { resolveClinicianCtx, visibilityCtx, requireInstituteCtx, buildClinicianCtx } =
  await import("../services/sharing/clinicianCtx.js");

const USER = "user-1";
const INSTITUTE = "inst-1";
const STUDENT = "student-1";

function makeReq(query: Record<string, unknown> = {}, user: unknown = { id: USER }): any {
  return { query, user };
}

function makeRes() {
  const sent: { status?: number; body?: unknown } = {};
  const res: any = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res, sent };
}

beforeEach(() => {
  verifyMembership.mockClear();
  getInstituteById.mockClear();
  isStudentInInstitute.mockClear();
  verifyMembership.mockImplementation(async () => ({ isMember: true, isAdmin: false }));
});

describe("resolveClinicianCtx distinguishes the three states", () => {
  it("no instituteId on the query → no_institute_selected (and never asks about membership)", async () => {
    const result = await resolveClinicianCtx(makeReq({}));
    expect(result.kind).toBe("no_institute_selected");
    expect(verifyMembership).not.toHaveBeenCalled();
  });

  it("an empty-string instituteId → no_institute_selected, not a membership lookup", async () => {
    const result = await resolveClinicianCtx(makeReq({ instituteId: "" }));
    expect(result.kind).toBe("no_institute_selected");
    expect(verifyMembership).not.toHaveBeenCalled();
  });

  it("no authenticated user → no_institute_selected", async () => {
    const result = await resolveClinicianCtx(makeReq({ instituteId: INSTITUTE }, null));
    expect(result.kind).toBe("no_institute_selected");
  });

  it("named an institute they are NOT a member of → not_a_member, carrying which one", async () => {
    verifyMembership.mockImplementation(async () => ({ isMember: false, isAdmin: false }));
    const result = await resolveClinicianCtx(makeReq({ instituteId: INSTITUTE }));
    expect(result).toEqual({ kind: "not_a_member", instituteId: INSTITUTE, userId: USER });
  });

  it("a member → an institute principal", async () => {
    const result = await resolveClinicianCtx(makeReq({ instituteId: INSTITUTE }));
    expect(result).toEqual({
      kind: "ctx",
      ctx: { kind: "institute", instituteId: INSTITUTE, userId: USER },
    });
  });

  it("THE POINT: the two refusal-adjacent states are not the same value", async () => {
    const noInstitute = await resolveClinicianCtx(makeReq({}));
    verifyMembership.mockImplementation(async () => ({ isMember: false, isAdmin: false }));
    const notMember = await resolveClinicianCtx(makeReq({ instituteId: INSTITUTE }));
    expect(noInstitute.kind).not.toBe(notMember.kind);
    // ...whereas the deprecated shim still collapses them, which is exactly
    // why it is deprecated and why no new consumer may use it.
    verifyMembership.mockImplementation(async () => ({ isMember: true, isAdmin: false }));
    expect(await buildClinicianCtx(makeReq({}))).toBeUndefined();
    verifyMembership.mockImplementation(async () => ({ isMember: false, isAdmin: false }));
    expect(await buildClinicianCtx(makeReq({ instituteId: INSTITUTE }))).toBeUndefined();
  });

  it("family-institute escalation still produces a student principal", async () => {
    getInstituteById.mockImplementation(async (id: string) => ({ id, type: "family" }));
    isStudentInInstitute.mockImplementation(async () => true);
    const result = await resolveClinicianCtx(makeReq({ instituteId: INSTITUTE }), STUDENT);
    expect(result).toEqual({ kind: "ctx", ctx: { kind: "student", studentId: STUDENT } });
  });
});

describe("visibilityCtx — the ctx is a refinement, the caller's own gate governs", () => {
  it("passes an undefined ctx through when no institute is selected", async () => {
    const { res, sent } = makeRes();
    const out = await visibilityCtx(makeReq({}), res);
    expect(out).toEqual({ ok: true, ctx: undefined });
    expect(sent.status).toBeUndefined();
  });

  it("REFUSES 403 when the caller is not a member of the institute they named", async () => {
    verifyMembership.mockImplementation(async () => ({ isMember: false, isAdmin: false }));
    const { res, sent } = makeRes();
    const out = await visibilityCtx(makeReq({ instituteId: INSTITUTE }), res);
    expect(out).toEqual({ ok: false });
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({ error: "error:NOT_INSTITUTE_MEMBER" });
  });

  it("returns the principal for a member", async () => {
    const { res } = makeRes();
    const out = await visibilityCtx(makeReq({ instituteId: INSTITUTE }), res);
    expect(out).toEqual({
      ok: true,
      ctx: { kind: "institute", instituteId: INSTITUTE, userId: USER },
    });
  });
});

describe("requireInstituteCtx — the route cannot work without a principal", () => {
  it("400 INSTITUTE_NOT_SELECTED when none was named", async () => {
    const { res, sent } = makeRes();
    expect(await requireInstituteCtx(makeReq({}), res)).toBeNull();
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: "error:INSTITUTE_NOT_SELECTED" });
  });

  it("403 NOT_INSTITUTE_MEMBER when one was named and not held — NOT the 400", async () => {
    // Before this pass both answered 400, so a genuine refusal was reported to
    // the client as a missing query parameter.
    verifyMembership.mockImplementation(async () => ({ isMember: false, isAdmin: false }));
    const { res, sent } = makeRes();
    expect(await requireInstituteCtx(makeReq({ instituteId: INSTITUTE }), res)).toBeNull();
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({ error: "error:NOT_INSTITUTE_MEMBER" });
  });

  it("returns the principal for a member", async () => {
    const { res } = makeRes();
    expect(await requireInstituteCtx(makeReq({ instituteId: INSTITUTE }), res)).toEqual({
      kind: "institute",
      instituteId: INSTITUTE,
      userId: USER,
    });
  });
});

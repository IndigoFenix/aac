/**
 * Institute references inside tool payloads must resolve by DISPLAY NAME.
 *
 * Incident (session 2c4b7feb): a clinician asked the chat to create a student.
 * The AI sent instituteIds: ["קלינקה רז טננבאום"] — the institute's name — and the
 * create was refused with "Access denied: you are not a member of institute
 * קלינקה רז טננבאום". The name was the only institute token the AI had ever seen:
 * Context_Institutes sets displayKey "name", renderMap prints that name INSTEAD of
 * the raw uuid key, and the institute's `id` property was not opened. The schema
 * then marked instituteIds REQUIRED, so the AI had to send something it could not
 * know. resolveDisplayKeyPath bridges name -> id for PATHS only; a name sitting in
 * a VALUE reached the membership check verbatim.
 *
 * These tests pin the three halves of the fix: refs resolve by name, the field is
 * no longer required (so the selected-institute fallback can do its job), and the
 * membership gate still refuses an institute the user does not belong to.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { DBOperationContext } from "../services/chat/memory-types";

const CLINIC = { id: "inst-uuid-clinic", name: "קלינקה רז טננבאום", type: "clinic", isActive: true };
const SCHOOL = { id: "inst-uuid-school", name: "Bet Issie Shapiro School", type: "school", isActive: true };
const MEMBERSHIPS = [
  { institute: CLINIC, membership: { userId: "user-1", instituteId: CLINIC.id, isActive: true } },
  { institute: SCHOOL, membership: { userId: "user-1", instituteId: SCHOOL.id, isActive: true } },
];

const getUserInstitutesWithMembership = jest.fn(async (_userId: string) => MEMBERSHIPS as any[]);
const assignStudentToInstitute = jest.fn(async (_i: string, _s: string, _u: string) => ({ success: true }));
const getInstituteStudents = jest.fn(async (_i: string, _u: string) => ({ success: true, students: [] as any[] }));

// Each mock re-declares the module's class export too: the repositories barrel
// re-exports the classes, and a missing named export is a hard ESM link error.
jest.unstable_mockModule("../services/instituteService", () => ({
  InstituteService: class {},
  instituteService: {
    getUserInstitutesWithMembership,
    assignStudentToInstitute,
    getInstituteStudents,
  },
}));

// The authoritative permission gate — kept in place behind the resolver, and
// driven off the same membership list so the stub cannot lie about who belongs.
const isUserMemberOfInstitute = jest.fn(
  async (instituteId: string, _userId: string) => MEMBERSHIPS.some((m) => m.institute.id === instituteId),
);
const getInstituteUserLink = jest.fn(async (instituteId: string, userId: string) =>
  MEMBERSHIPS.some((m) => m.institute.id === instituteId) ? { instituteId, userId, isAdmin: true } : null,
);
jest.unstable_mockModule("../repositories/instituteRepository", () => ({
  InstituteRepository: class {},
  instituteRepository: { isUserMemberOfInstitute, getInstituteUserLink },
}));

const createEvent = jest.fn(async (data: any, _u: string) => ({ id: "event-uuid", ...data, locations: [] }));
jest.unstable_mockModule("../services/calendarService", () => ({
  CalendarService: class {},
  calendarService: { createEvent },
}));

// No license rows -> no student cap to enforce.
jest.unstable_mockModule("../repositories/licenseRepository", () => ({
  LicenseRepository: class {},
  licenseRepository: { getLicensesByInstituteId: jest.fn(async (_i: string) => [] as any[]) },
}));

const createStudentWithLink = jest.fn(async (data: any, userId: string, role: string) => ({
  student: { id: "student-uuid", ...data },
  link: { studentId: "student-uuid", userId, role },
}));
jest.unstable_mockModule("../services/studentService", () => ({
  StudentService: class {},
  studentService: { createStudentWithLink },
}));

jest.unstable_mockModule("../services/activityLogService", () => ({
  activityLogService: { log: jest.fn() },
}));

const { resolveInstituteRefs, resolveInstituteRefOrThrow, instituteRefError } = await import(
  "../services/memory-schema/institute-ref"
);
const { INSTITUTE_INSTITUTES_FIELD, INSTITUTE_STUDENTS_FIELD, INSTITUTE_CALENDAR_FIELD } = await import(
  "../services/memory-schema/institute-memory-schema"
);

function ctxFor(instituteId?: string): DBOperationContext {
  return { all: { userId: "user-1", instituteId } } as unknown as DBOperationContext;
}

const AVIYA = { name: "אביה וייס", firstName: "אביה", lastName: "וייס", primaryLanguage: "he", framework: "tala" };

beforeEach(() => {
  createStudentWithLink.mockClear();
  assignStudentToInstitute.mockClear();
  isUserMemberOfInstitute.mockClear();
  getUserInstitutesWithMembership.mockClear();
  getInstituteUserLink.mockClear();
  createEvent.mockClear();
});

describe("resolveInstituteRefs", () => {
  it("resolves the display name the AI actually sees to the institute id", async () => {
    const { ids, unresolved } = await resolveInstituteRefs(["קלינקה רז טננבאום"], "user-1");
    expect(ids).toEqual([CLINIC.id]);
    expect(unresolved).toEqual([]);
  });

  it("tolerates case and stray whitespace in the name", async () => {
    const { ids } = await resolveInstituteRefs(["  bet issie  shapiro school "], "user-1");
    expect(ids).toEqual([SCHOOL.id]);
  });

  it("passes real institute ids straight through", async () => {
    const { ids, unresolved } = await resolveInstituteRefs([SCHOOL.id], "user-1");
    expect(ids).toEqual([SCHOOL.id]);
    expect(unresolved).toEqual([]);
  });

  it("de-duplicates an institute named twice (once by id, once by name)", async () => {
    const { ids } = await resolveInstituteRefs([CLINIC.id, "קלינקה רז טננבאום"], "user-1");
    expect(ids).toEqual([CLINIC.id]);
  });

  it("reports a ref matching nothing the user belongs to, and what is available", async () => {
    const { ids, unresolved, available } = await resolveInstituteRefs(["Some Other Clinic"], "user-1");
    expect(ids).toEqual([]);
    expect(unresolved).toEqual(["Some Other Clinic"]);
    expect(available).toEqual([CLINIC.name, SCHOOL.name]);
  });

  it("treats an id the user is not a member of as unresolved", async () => {
    const { ids, unresolved } = await resolveInstituteRefs(["inst-uuid-someone-else"], "user-1");
    expect(ids).toEqual([]);
    expect(unresolved).toEqual(["inst-uuid-someone-else"]);
  });

  it("throws the same message from the scalar form", async () => {
    await expect(resolveInstituteRefOrThrow("Some Other Clinic", "user-1")).rejects.toThrow(
      /No organization matching/,
    );
    await expect(resolveInstituteRefOrThrow(CLINIC.name, "user-1")).resolves.toBe(CLINIC.id);
  });

  it("keeps the error single-line so sanitizeDbError surfaces it whole", () => {
    const msg = instituteRefError(["Some Other Clinic"], [CLINIC.name, SCHOOL.name]);
    expect(msg).not.toContain("\n");
    expect(msg).toContain(CLINIC.name);
  });
});

describe("creating a student from chat", () => {
  const ops = INSTITUTE_STUDENTS_FIELD.db!;

  it("accepts the institute by name — the incident case", async () => {
    const created = await ops.add!(ctxFor(CLINIC.id), { ...AVIYA, instituteIds: [CLINIC.name] }, {});

    expect(created.id).toBe("student-uuid");
    expect(createStudentWithLink).toHaveBeenCalledTimes(1);
    expect(assignStudentToInstitute).toHaveBeenCalledWith(CLINIC.id, "student-uuid", "user-1");
  });

  it("enrolls in the selected institute when instituteIds is omitted", async () => {
    await ops.add!(ctxFor(SCHOOL.id), { ...AVIYA }, {});

    expect(assignStudentToInstitute).toHaveBeenCalledWith(SCHOOL.id, "student-uuid", "user-1");
  });

  it("enrolls in several organizations named however the AI has them", async () => {
    await ops.add!(ctxFor(CLINIC.id), { ...AVIYA, instituteIds: [CLINIC.name, SCHOOL.id] }, {});

    expect(assignStudentToInstitute.mock.calls.map((c) => c[0])).toEqual([CLINIC.id, SCHOOL.id]);
  });

  it("refuses an unknown organization without creating the student", async () => {
    await expect(
      ops.add!(ctxFor(CLINIC.id), { ...AVIYA, instituteIds: ["Some Other Clinic"] }, {}),
    ).rejects.toThrow(/No organization matching "Some Other Clinic"/);

    expect(createStudentWithLink).not.toHaveBeenCalled();
    expect(assignStudentToInstitute).not.toHaveBeenCalled();
  });

  it("still refuses a selected institute the user is not a member of", async () => {
    await expect(ops.add!(ctxFor("inst-uuid-someone-else"), { ...AVIYA }, {})).rejects.toThrow(
      /not a member/i,
    );

    expect(createStudentWithLink).not.toHaveBeenCalled();
  });
});

describe("creating an institute calendar event", () => {
  const ops = INSTITUTE_CALENDAR_FIELD.db!;
  const EVENT = { title: "Music Therapy", startTime: "2026-07-01T10:00:00", endTime: "2026-07-01T11:00:00" };

  it("accepts the institute by name", async () => {
    await ops.add!(ctxFor(CLINIC.id), { ...EVENT, instituteId: CLINIC.name }, {});

    expect(getInstituteUserLink).toHaveBeenCalledWith(CLINIC.id, "user-1");
    expect(createEvent.mock.calls[0][0].instituteId).toBe(CLINIC.id);
  });

  it("refuses an unknown organization instead of blaming the admin check", async () => {
    await expect(
      ops.add!(ctxFor(CLINIC.id), { ...EVENT, instituteId: "Some Other Clinic" }, {}),
    ).rejects.toThrow(/No organization matching/);

    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe("schema shape", () => {
  it("does not force the AI to supply instituteIds", () => {
    const student = INSTITUTE_STUDENTS_FIELD.values as any;
    expect(student.required).not.toContain("instituteIds");
    expect(student.required).toEqual(expect.arrayContaining(["firstName", "name"]));
  });

  it("opens the institute id so the uuid is visible behind the display name", () => {
    const institute = INSTITUTE_INSTITUTES_FIELD.values as any;
    expect(INSTITUTE_INSTITUTES_FIELD.displayKey).toBe("name");
    expect(institute.properties.id.opened).toBe(true);
  });
});

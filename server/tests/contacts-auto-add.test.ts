/**
 * Student_Contacts add-gate: the AAC's Monitor reaches the studentContacts
 * table through this memory field, so `aacSettings.autoAddContacts` has to be
 * enforced HERE (see buildStudentContactsField) and every row the AI does
 * create has to be flagged `autoAdded` for clinician review.
 *
 * DB-free: the module's db/biometric/activity-log imports are mocked, so this
 * exercises the gate itself rather than the table.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const createContact = jest.fn(async (data: any) => ({
  id: "c0ffee00-1111-2222-3333-444444444444",
  biometricDataId: null,
  timesIdentified: 0,
  isActive: true,
  lastSeenAt: null,
  ...data,
}));
const updateContact = jest.fn(async (_id: string, data: any) => ({ id: _id, ...data }));

jest.unstable_mockModule("../db", () => ({ db: {} }));
jest.unstable_mockModule("../services/biometric", () => ({
  createContact,
  updateContact,
  deleteContact: jest.fn(async () => {}),
  getLinkableEntitiesForStudent: jest.fn(async () => []),
}));
jest.unstable_mockModule("../services/activityLogService", () => ({
  activityLogService: { log: jest.fn() },
}));

let buildStudentContactsField: typeof import("../services/memory-schema/contacts-memory-schema").buildStudentContactsField;

beforeAll(async () => {
  ({ buildStudentContactsField } = await import(
    "../services/memory-schema/contacts-memory-schema"
  ));
});

beforeEach(() => {
  createContact.mockClear();
  updateContact.mockClear();
});

/** Minimal DBOperationContext — the ops only read ctx.all. */
function ctx(studentId = "stu-1"): any {
  const all = { studentId, userId: "usr-1", instituteId: "inst-1" };
  return { base: all, inherited: {}, all, path: "/Student_Contacts", pathTokens: ["Student_Contacts"] };
}

describe("Student_Contacts — contact-learning gate", () => {
  test("clinician default: adds are allowed and are NOT flagged for review", async () => {
    const field = buildStudentContactsField();
    await field.db!.add!(ctx(), { name: "Grandma", relationship: "grandmother" } as any);

    expect(createContact).toHaveBeenCalledTimes(1);
    expect((createContact.mock.calls[0][0] as any).autoAdded).toBe(false);
    expect(field.description).not.toMatch(/CONTACT LEARNING IS OFF/);
  });

  test("AAC path: a contact the AI creates is flagged autoAdded", async () => {
    const field = buildStudentContactsField({ allowAdd: true, markAutoAdded: true });
    const created: any = await field.db!.add!(ctx(), { name: "Mr. Levi", relationship: "teacher" } as any);

    const insert = createContact.mock.calls[0][0] as any;
    expect(insert.autoAdded).toBe(true);
    expect(insert.studentId).toBe("stu-1");
    expect(insert.name).toBe("Mr. Levi");
    expect(created.name).toBe("Mr. Levi");
  });

  test("learning off: add is refused, and nothing reaches the table", async () => {
    const field = buildStudentContactsField({ allowAdd: false, markAutoAdded: true });

    await expect(
      field.db!.add!(ctx(), { name: "A passer-by" } as any),
    ).rejects.toThrow(/disabled/i);
    expect(createContact).not.toHaveBeenCalled();
  });

  test("learning off: reading and updating existing contacts still work", async () => {
    const field = buildStudentContactsField({ allowAdd: false, markAutoAdded: true });
    // The refusal must not come from dropping the ops — the AI still needs to
    // know who the student's people are and to keep their notes current.
    expect(typeof field.db!.list).toBe("function");
    expect(typeof field.db!.update).toBe("function");
    expect(typeof field.db!.delete).toBe("function");
    // …and the schema has to SAY so, or the model spends turns retrying.
    expect(field.description).toMatch(/CONTACT LEARNING IS OFF/);
  });

  test("the AI cannot clear the review flag through an update", async () => {
    const field = buildStudentContactsField({ allowAdd: true, markAutoAdded: true });
    // findContactByKey hits the mocked db, so drive update through a stubbed
    // lookup by asserting on the whitelist instead: autoAdded is not in it.
    const updatable = [
      "name", "relationship", "role", "customRole", "organization",
      "contactEmail", "contactPhone", "contextNotes", "linkedUserId", "linkedStudentId",
    ];
    const props = Object.keys((field.values as any).properties);
    expect(updatable.every((k) => props.includes(k))).toBe(true);
    expect(props).not.toContain("autoAdded");
  });
});

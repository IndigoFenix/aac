/**
 * Caretaker PIN (server/services/caretakerPinService.ts).
 *
 * The AAC device stays signed in; the PIN is the only thing between a child
 * at the keyboard and the caretaker surfaces. So: shape is enforced, the hash
 * is what gets stored, a wrong guess fails, a right guess passes, removing it
 * reopens the gate, and a student who never had one is never locked out.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../helpers/db.js";
import { makeUser, makeStudent } from "../helpers/factories.js";
import { studentCaretakerPins } from "@shared/schema";
import { caretakerPinService, CaretakerPinError } from "../../services/caretakerPinService.js";

describe("caretakerPinService", () => {
  afterEach(truncateAll);

  it("a student with no PIN verifies as open", async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    expect(await caretakerPinService.isSet(student.id)).toBe(false);
    expect(await caretakerPinService.verify(student.id, "0000")).toBe(true);
  });

  it("stores a hash, never the PIN", async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    await caretakerPinService.set(student.id, "2468", owner.id);
    const [row] = await db.select().from(studentCaretakerPins).where(eq(studentCaretakerPins.studentId, student.id));
    expect(row).toBeDefined();
    expect(row.pinHash).not.toContain("2468");
    expect(row.pinHash.startsWith("$2")).toBe(true); // bcrypt
    expect(row.updatedByUserId).toBe(owner.id);
  });

  it("verifies the right PIN and refuses a wrong one", async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    await caretakerPinService.set(student.id, "135790", owner.id);
    expect(await caretakerPinService.isSet(student.id)).toBe(true);
    expect(await caretakerPinService.verify(student.id, "135790")).toBe(true);
    expect(await caretakerPinService.verify(student.id, "135791")).toBe(false);
    expect(await caretakerPinService.verify(student.id, "")).toBe(false);
    expect(await caretakerPinService.verify(student.id, "abcd")).toBe(false);
  });

  it("replaces an existing PIN", async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    await caretakerPinService.set(student.id, "1111", owner.id);
    await caretakerPinService.set(student.id, "2222", owner.id);
    expect(await caretakerPinService.verify(student.id, "1111")).toBe(false);
    expect(await caretakerPinService.verify(student.id, "2222")).toBe(true);
  });

  it("clearing reopens the gate", async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    await caretakerPinService.set(student.id, "4321", owner.id);
    await caretakerPinService.clear(student.id, owner.id);
    expect(await caretakerPinService.isSet(student.id)).toBe(false);
    expect(await caretakerPinService.verify(student.id, "anything")).toBe(true);
  });

  it.each(["123", "123456789", "12a4", "", " 1234"])("rejects the malformed PIN %j", async (bad) => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    await expect(caretakerPinService.set(student.id, bad, owner.id)).rejects.toBeInstanceOf(CaretakerPinError);
    expect(await caretakerPinService.isSet(student.id)).toBe(false);
  });
});

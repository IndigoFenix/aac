// server/services/call/callContacts.ts
// Resolves a student's *callable* contacts to persons + online status, and
// provisions the call room. A call to a contact is authorized by the callable
// link (set in the clinician contact editor), NOT by institute-sharing — so
// room creation here goes through the repository directly, bypassing the
// person-chat service's institute-membership check.

import { db } from "../../db";
import { studentContacts, instituteStudents, userStudents, students, type StudentContact } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { personRepository } from "../../repositories/personRepository";
import { personChatRepository } from "../../repositories/personChatRepository";
import { isPersonOnline } from "../realtime/room-registry";

export interface CallableContact {
  contactId: string;
  personId: string;
  name: string;
  relationship: string | null;
  online: boolean;
}

/** The person behind a contact (its linked user or student facet), or null. */
export async function resolveContactPersonId(contact: StudentContact): Promise<string | null> {
  if (contact.linkedUserId) return (await personRepository.getOrCreateForUser(contact.linkedUserId)).id;
  if (contact.linkedStudentId) return (await personRepository.getOrCreateForStudent(contact.linkedStudentId)).id;
  return null;
}

export async function getContactById(contactId: string): Promise<StudentContact | null> {
  const [row] = await db.select().from(studentContacts).where(eq(studentContacts.id, contactId));
  return row ?? null;
}

/** A student's active, callable, person-linked contacts with live online flags. */
export async function listCallableContacts(studentId: string): Promise<CallableContact[]> {
  const rows = await db
    .select()
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        eq(studentContacts.callable, true),
      ),
    );

  const out: CallableContact[] = [];
  for (const c of rows) {
    if (!c.linkedUserId && !c.linkedStudentId) continue; // only linked contacts are callable
    const personId = await resolveContactPersonId(c);
    if (!personId) continue;
    out.push({
      contactId: c.id,
      personId,
      name: c.name,
      relationship: c.relationship ?? null,
      online: isPersonOnline(personId),
    });
  }
  return out;
}

export interface CallableStudent {
  contactId: string;
  studentId: string;
  personId: string;
  name: string;
  online: boolean;
}

/**
 * The reverse of listCallableContacts: students who have listed THIS user as a
 * callable contact (so the user — e.g. a clinician/caregiver — may call them).
 * The callable link is bidirectional.
 */
export async function listCallableStudentsForUser(userId: string): Promise<CallableStudent[]> {
  const rows = await db
    .select({ contactId: studentContacts.id, studentId: studentContacts.studentId, studentName: students.name })
    .from(studentContacts)
    .innerJoin(students, eq(students.id, studentContacts.studentId))
    .where(
      and(
        eq(studentContacts.linkedUserId, userId),
        eq(studentContacts.callable, true),
        eq(studentContacts.isActive, true),
      ),
    );

  const out: CallableStudent[] = [];
  for (const r of rows) {
    const person = await personRepository.getOrCreateForStudent(r.studentId);
    out.push({
      contactId: r.contactId,
      studentId: r.studentId,
      personId: person.id,
      name: r.studentName,
      online: isPersonOnline(person.id),
    });
  }
  return out;
}

/** Whether a user actively serves (is linked to) a student. */
export async function userServesStudent(userId: string, studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userStudents.id })
    .from(userStudents)
    .where(and(eq(userStudents.userId, userId), eq(userStudents.studentId, studentId), eq(userStudents.isActive, true)));
  return !!row;
}

/** Whether a user is an active, callable contact of a student. */
export async function userIsCallableContactOf(userId: string, studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: studentContacts.id })
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.linkedUserId, userId),
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.callable, true),
        eq(studentContacts.isActive, true),
      ),
    );
  return !!row;
}

/**
 * Whether a user may operate the AAC *as* a student for calling — either a
 * caregiver (user_students) OR a callable contact. A callable contact who isn't
 * a formal caregiver still gets calling access (and only calling: this gate is
 * used for the call WS act-as + the callable-contacts list, not clinical data).
 */
export async function userMayActAsStudent(userId: string, studentId: string): Promise<boolean> {
  return (await userServesStudent(userId, studentId)) || (await userIsCallableContactOf(userId, studentId));
}

/** The institute a student belongs to (first active enrollment). */
export async function resolveStudentInstitute(studentId: string): Promise<string | null> {
  const [row] = await db
    .select({ instituteId: instituteStudents.instituteId })
    .from(instituteStudents)
    .where(eq(instituteStudents.studentId, studentId));
  return row?.instituteId ?? null;
}

/**
 * Find or create the direct person-chat room backing a call between a student
 * and a contact. Authorized by the callable contact link (institute check is
 * intentionally bypassed — see file header).
 */
export async function ensureCallRoom(
  studentPersonId: string,
  contactPersonId: string,
  instituteId: string,
): Promise<string> {
  const existing = await personChatRepository.findDirectRoom(instituteId, studentPersonId, contactPersonId);
  if (existing) return existing.id;
  const room = await personChatRepository.createRoom({
    instituteId,
    createdByPersonId: studentPersonId,
    participantPersonIds: [studentPersonId, contactPersonId],
    name: null,
    isDirect: true,
  });
  return room.id;
}

/**
 * contacts-memory-schema.ts
 *
 * Exposes studentContacts + programContacts to the AI as memory fields with
 * real DB operations (NOT chatMemory-backed).
 *
 *  - Student_Contacts        (map, student-scoped)
 *  - Program_TeamContacts    (array, program-scoped) — added to Context_Program
 *
 * Biometric embeddings and image URLs are deliberately excluded from AI
 * context; the AI can see physical-descriptor fields (hair/eye color, age,
 * identifying features) when a contact has linked biometric data.
 */

import { eq, and, asc, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  studentContacts,
  programContacts,
  biometricData,
  type StudentContact,
  type InsertStudentContact,
  type UpdateStudentContact,
  type ProgramContact,
  type InsertProgramContact,
  type UpdateProgramContact,
} from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldMapWithDB,
  type AgentMemoryFieldArrayWithDB,
  type AgentMemoryFieldObjectWithDB,
  type MemoryDBOperations,
} from "../chat/memory-types";
import type { AccessCtx } from "../sharing/visibility";
import {
  createContact,
  updateContact,
  deleteContact,
  getLinkableEntitiesForStudent,
  type LinkableEntity,
} from "../biometric";
import { activityLogService } from "../activityLogService";

// ============================================================================
// Key helpers
// ============================================================================

function shortId(uuid: string | null | undefined): string {
  return uuid?.slice(0, 8) || "unknown";
}

function sanitize(str: string | null | undefined): string {
  if (!str) return "unnamed";
  return (
    str
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 20)
      .replace(/_+$/, "")
      .toLowerCase() || "unnamed"
  );
}

/** `{shortId}_{sanitized_name}` — stable key for the contact map */
function contactKey(c: { id: string; name: string }): string {
  return `${shortId(c.id)}_${sanitize(c.name)}`;
}

async function findContactByKey(
  studentId: string,
  key: string,
): Promise<StudentContact | undefined> {
  const idPrefix = String(key).split("_")[0];
  const items = await db
    .select()
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        sql`${studentContacts.id}::text LIKE ${idPrefix + "%"}`,
      ),
    )
    .limit(1);
  return items[0];
}

// ============================================================================
// Shape-stripping: build the object the AI sees from a DB row + biometric row.
// Excludes embeddings and image URLs.
// ============================================================================

type ContactMemoryValue = {
  id: string;
  name: string;
  relationship?: string | null;
  role?: string | null;
  customRole?: string | null;
  organization?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  contextNotes?: string | null;
  lastSeenAt?: string | null;
  timesIdentified?: number;
  isActive?: boolean;
  linkedUserId?: string | null;
  linkedStudentId?: string | null;
  // Flattened non-sensitive biometric descriptors (read-only).
  hairColor?: string | null;
  eyeColor?: string | null;
  estimatedAge?: string | null;
  estimatedSex?: string | null;
  physicalDescription?: string | null;
  identifyingFeatures?: string | null;
  hasPhoto?: boolean;
};

async function contactToMemory(row: StudentContact): Promise<ContactMemoryValue> {
  let physical: Partial<ContactMemoryValue> = {};
  let hasPhoto = false;
  if (row.biometricDataId) {
    const [bd] = await db
      .select()
      .from(biometricData)
      .where(eq(biometricData.id, row.biometricDataId));
    if (bd) {
      physical = {
        hairColor: bd.hairColor,
        eyeColor: bd.eyeColor,
        estimatedAge: bd.estimatedAge,
        estimatedSex: bd.estimatedSex,
        physicalDescription: bd.physicalDescription,
        identifyingFeatures: bd.identifyingFeatures,
      };
      hasPhoto = !!bd.faceImageUrl;
    }
  }
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    role: row.role,
    customRole: row.customRole,
    organization: row.organization,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    contextNotes: row.contextNotes,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    timesIdentified: row.timesIdentified,
    isActive: row.isActive,
    linkedUserId: row.linkedUserId,
    linkedStudentId: row.linkedStudentId,
    ...physical,
    hasPhoto,
  };
}

// ============================================================================
// Student_Contacts (map) — DB operations
// ============================================================================

const studentContactsOps: MemoryDBOperations<ContactMemoryValue> = {
  list: async (ctx, { offset, limit }) => {
    const studentId = ctx.all.studentId;
    if (!studentId) throw new Error("studentId required for Student_Contacts");

    // Defense-in-depth: refuse the read when the requester has no resolved
    // visibility ctx. Controllers verify student access before this runs, but
    // a cross-student read here would expose phone, email, biometric
    // descriptors, and identifying features.
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    if (!accessCtx) return { items: [], total: 0, keys: [] };
    if (accessCtx.kind === "student" && accessCtx.studentId !== studentId) {
      return { items: [], total: 0, keys: [] };
    }

    const rows = await db
      .select()
      .from(studentContacts)
      .where(
        and(
          eq(studentContacts.studentId, studentId),
          eq(studentContacts.isActive, true),
        ),
      )
      .orderBy(asc(studentContacts.name))
      .offset(offset)
      .limit(limit);

    const items = await Promise.all(rows.map(contactToMemory));
    const keys = rows.map((r) => contactKey(r));

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(studentContacts)
      .where(
        and(
          eq(studentContacts.studentId, studentId),
          eq(studentContacts.isActive, true),
        ),
      );

    return { items, total: Number(count ?? 0), keys };
  },

  add: async (ctx, value) => {
    const studentId = ctx.all.studentId;
    if (!studentId) throw new Error("studentId required for contact creation");

    const insert: InsertStudentContact = {
      studentId,
      name: value.name,
      relationship: value.relationship ?? undefined,
      role: (value.role as any) ?? undefined,
      customRole: value.customRole ?? undefined,
      organization: value.organization ?? undefined,
      contactEmail: value.contactEmail ?? undefined,
      contactPhone: value.contactPhone ?? undefined,
      contextNotes: value.contextNotes ?? undefined,
      linkedUserId: value.linkedUserId ?? null,
      linkedStudentId: value.linkedStudentId ?? null,
    };
    const created = await createContact(insert);

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "create",
      subjectType1: "student_contact",
      subjectId1: created.id,
      details: { studentId },
      isAiInitiated: true,
    });

    return contactToMemory(created);
  },

  update: async (ctx, key, value) => {
    const studentId = ctx.all.studentId;
    if (!studentId) throw new Error("studentId required for contact update");

    const row = await findContactByKey(studentId, String(key));
    if (!row) throw new Error(`Contact with key ${key} not found`);

    // Strip read-only biometric descriptors — the AI must not edit those here.
    const updates: UpdateStudentContact = {};
    for (const k of [
      "name",
      "relationship",
      "role",
      "customRole",
      "organization",
      "contactEmail",
      "contactPhone",
      "contextNotes",
      "linkedUserId",
      "linkedStudentId",
    ] as const) {
      if (k in value) (updates as any)[k] = (value as any)[k];
    }

    const updated = await updateContact(row.id, updates);
    if (!updated) throw new Error(`Contact update failed for key ${key}`);

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "update",
      subjectType1: "student_contact",
      subjectId1: updated.id,
      details: { studentId },
      isAiInitiated: true,
    });

    return contactToMemory(updated);
  },

  delete: async (ctx, key) => {
    const studentId = ctx.all.studentId;
    if (!studentId) return;
    const row = await findContactByKey(studentId, String(key));
    if (!row) return;

    await deleteContact(row.id); // soft-delete
    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "delete",
      subjectType1: "student_contact",
      subjectId1: row.id,
      details: { studentId },
      isAiInitiated: true,
    });
  },

  fromDB: (record) => record,

  getDBKey: (value) => (value.id ? `${shortId(value.id)}_${sanitize(value.name)}` : sanitize(value.name)),
};

// ============================================================================
// Student_Contacts — field schema
// ============================================================================

const contactValueSchema: AgentMemoryFieldObjectWithDB = {
  id: "contact",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    name: { id: "name", type: "string", opened: true },
    relationship: {
      id: "relationship",
      type: "string",
      description: "Free-form relationship label (e.g. mother, classmate, therapist)",
    },
    role: {
      id: "role",
      type: "string",
      enum: [
        "parent_guardian",
        "student",
        "homeroom_teacher",
        "special_education_teacher",
        "general_education_teacher",
        "speech_language_pathologist",
        "occupational_therapist",
        "physical_therapist",
        "psychologist",
        "administrator",
        "case_manager",
        "external_provider",
        "other",
      ],
      description: "Formal team-member role, if applicable",
    },
    customRole: { id: "customRole", type: "string" },
    organization: { id: "organization", type: "string" },
    contactEmail: { id: "contactEmail", type: "string" },
    contactPhone: { id: "contactPhone", type: "string" },
    contextNotes: {
      id: "contextNotes",
      type: "string",
      description:
        "What you know about this relationship — attitudes toward the student, interaction patterns, anything noteworthy.",
      opened: true,
    },
    linkedUserId: {
      id: "linkedUserId",
      type: "string",
      description:
        "If this contact is a registered user in the system, their user id (from Student_LinkableEntities where type='user'). Mutually exclusive with linkedStudentId. When linked, the contact shares biometric data with the canonical user record.",
    },
    linkedStudentId: {
      id: "linkedStudentId",
      type: "string",
      description:
        "If this contact is another student in the system, their student id (from Student_LinkableEntities where type='student'). Mutually exclusive with linkedUserId.",
    },
    // Biometric descriptors are read-only — not writable from the AI.
    hairColor: { id: "hairColor", type: "string" },
    eyeColor: { id: "eyeColor", type: "string" },
    estimatedAge: { id: "estimatedAge", type: "string" },
    estimatedSex: { id: "estimatedSex", type: "string" },
    physicalDescription: { id: "physicalDescription", type: "string" },
    identifyingFeatures: { id: "identifyingFeatures", type: "string" },
    hasPhoto: { id: "hasPhoto", type: "boolean" },
    lastSeenAt: { id: "lastSeenAt", type: "string" },
    timesIdentified: { id: "timesIdentified", type: "integer" },
  },
  required: ["name"],
};

export const STUDENT_CONTACTS_FIELD: AgentMemoryFieldMapWithDB = {
  id: "Student_Contacts",
  type: "map",
  title: "Student Contacts",
  description:
    "People in the student's life — parents, siblings, classmates, therapists, teachers, " +
    "team members. THIS is the right place to record relationships and contacts. Do not use " +
    "/Context_Students/<id>/users for this — that map is only for granting platform login " +
    "access to a registered user account, not for recording who someone is to the student. " +
    "Keys are `{shortId}_{name}`. BEFORE adding a contact, CHECK Student_LinkableEntities. " +
    "If the person already exists as a user or student in the system, set linkedUserId " +
    "(for users) or linkedStudentId (for students) on the new contact so their records " +
    "stay connected — shared biometric data, no duplicate identities. Linking is NOT " +
    "automatic; you must set it explicitly when you recognize the person. To associate a " +
    "contact with a formal IEP/TALA team, add them to the program's teamContacts (junction) " +
    "after creating the contact. Photos and face embeddings are managed through the UI.",
  opened: true,
  values: contactValueSchema,
  db: studentContactsOps as any,
};

// ============================================================================
// Program_TeamContacts (array on Context_Program)
// ============================================================================

type TeamContactMemoryValue = {
  id: string;           // program_contacts.id (junction row)
  contactId: string;
  contactName: string;  // convenience — matches the underlying student_contact.name
  programRole?: string | null;
  responsibilities?: string[] | null;
  isCoordinator: boolean;
  isActive: boolean;
};

async function teamContactToMemory(
  junction: ProgramContact,
  contactName: string,
): Promise<TeamContactMemoryValue> {
  return {
    id: junction.id,
    contactId: junction.contactId,
    contactName,
    programRole: junction.programRole,
    responsibilities: junction.responsibilities,
    isCoordinator: junction.isCoordinator,
    isActive: junction.isActive,
  };
}

export const programContactsOps: MemoryDBOperations<TeamContactMemoryValue> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for Program_TeamContacts");

    const rows = await db
      .select({ junction: programContacts, contact: studentContacts })
      .from(programContacts)
      .innerJoin(studentContacts, eq(studentContacts.id, programContacts.contactId))
      .where(
        and(
          eq(programContacts.programId, programId),
          eq(programContacts.isActive, true),
        ),
      )
      .orderBy(desc(programContacts.isCoordinator), asc(studentContacts.name))
      .offset(offset)
      .limit(limit);

    const items = await Promise.all(
      rows.map((r) => teamContactToMemory(r.junction, r.contact.name)),
    );

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(programContacts)
      .where(
        and(
          eq(programContacts.programId, programId),
          eq(programContacts.isActive, true),
        ),
      );

    return { items, total: Number(count ?? 0) };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for team contact add");
    if (!value.contactId) {
      throw new Error(
        "contactId required — first create a Student_Contacts row, then add its id here",
      );
    }

    const insert: InsertProgramContact = {
      programId,
      contactId: value.contactId,
      programRole: (value.programRole as any) ?? undefined,
      responsibilities: value.responsibilities ?? undefined,
      isCoordinator: value.isCoordinator ?? false,
      isActive: value.isActive ?? true,
    };
    const [row] = await db.insert(programContacts).values(insert).returning();
    const [c] = await db
      .select({ name: studentContacts.name })
      .from(studentContacts)
      .where(eq(studentContacts.id, row.contactId));

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "create",
      subjectType1: "program_contact",
      subjectId1: row.id,
      details: { programId },
      isAiInitiated: true,
    });

    return teamContactToMemory(row, c?.name ?? "");
  },

  update: async (ctx, key, value) => {
    // Array positional update — load the array, find at index, update by junction.id
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const rows = await db
      .select({ junction: programContacts, name: studentContacts.name })
      .from(programContacts)
      .innerJoin(studentContacts, eq(studentContacts.id, programContacts.contactId))
      .where(
        and(
          eq(programContacts.programId, programId),
          eq(programContacts.isActive, true),
        ),
      )
      .orderBy(desc(programContacts.isCoordinator), asc(studentContacts.name))
      .offset(Number(key))
      .limit(1);

    const target = rows[0];
    if (!target) throw new Error(`Team contact at index ${key} not found`);

    const updates: UpdateProgramContact = {};
    for (const k of ["programRole", "responsibilities", "isCoordinator", "isActive"] as const) {
      if (k in value) (updates as any)[k] = (value as any)[k];
    }

    const [updated] = await db
      .update(programContacts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(programContacts.id, target.junction.id))
      .returning();

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "update",
      subjectType1: "program_contact",
      subjectId1: updated.id,
      details: { programId },
      isAiInitiated: true,
    });

    return teamContactToMemory(updated, target.name);
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const rows = await db
      .select()
      .from(programContacts)
      .where(
        and(
          eq(programContacts.programId, programId),
          eq(programContacts.isActive, true),
        ),
      )
      .orderBy(desc(programContacts.isCoordinator))
      .offset(Number(key))
      .limit(1);

    if (!rows[0]) return;
    await db
      .update(programContacts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(programContacts.id, rows[0].id));
    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "delete",
      subjectType1: "program_contact",
      subjectId1: rows[0].id,
      details: { programId },
      isAiInitiated: true,
    });
  },

  fromDB: (record) => record,

  getDBKey: (value) => value.id,
};

const teamContactValueSchema: AgentMemoryFieldObjectWithDB = {
  id: "teamContact",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    contactId: {
      id: "contactId",
      type: "string",
      description:
        "The Student_Contacts row id this team assignment points to. Must already exist.",
    },
    contactName: { id: "contactName", type: "string" },
    programRole: {
      id: "programRole",
      type: "string",
      enum: [
        "parent_guardian",
        "student",
        "homeroom_teacher",
        "special_education_teacher",
        "general_education_teacher",
        "speech_language_pathologist",
        "occupational_therapist",
        "physical_therapist",
        "psychologist",
        "administrator",
        "case_manager",
        "external_provider",
        "other",
      ],
      description: "Per-program role override — falls back to the contact's role when null",
    },
    responsibilities: {
      id: "responsibilities",
      type: "array",
      items: { id: "r", type: "string" } as any,
    },
    isCoordinator: { id: "isCoordinator", type: "boolean" },
    isActive: { id: "isActive", type: "boolean" },
  },
  required: ["contactId"],
};

export const PROGRAM_TEAM_CONTACTS_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "teamContacts",
  type: "array",
  title: "Team Contacts",
  description:
    "People assigned to this program's team. Junction rows linking studentContacts to " +
    "this program — add a contact to Student_Contacts first, then reference it here by contactId.",
  opened: true,
  items: teamContactValueSchema,
  db: programContactsOps as any,
};

// ============================================================================
// Student_LinkableEntities — read-only list of users/students that share at
// least one institute with the current student, and therefore can be linked
// from a Student_Contacts row via linkedUserId / linkedStudentId.
// ============================================================================

// What the AI sees — strictly surface-level (id + type + name). No emails,
// no additional identifiers. Enough to pick someone from the list and link.
type LinkableEntitySurface = Pick<LinkableEntity, "id" | "type" | "name">;

const linkableEntitiesOps: MemoryDBOperations<LinkableEntitySurface> = {
  list: async (ctx, { offset, limit }) => {
    const studentId = ctx.all.studentId;
    if (!studentId) throw new Error("studentId required for Student_LinkableEntities");
    const all = await getLinkableEntitiesForStudent(studentId);
    const surface: LinkableEntitySurface[] = all.map(({ id, type, name }) => ({ id, type, name }));
    const items = surface.slice(offset, offset + limit);
    return { items, total: surface.length };
  },
  fromDB: (record) => record,
  getDBKey: (value) => value.id,
};

const linkableEntitySchema: AgentMemoryFieldObjectWithDB = {
  id: "linkableEntity",
  type: "object",
  opened: true,
  properties: {
    id: {
      id: "id",
      type: "string",
      description:
        "The user id (when type='user') or student id (when type='student'). Use this as linkedUserId/linkedStudentId when creating a Student_Contacts entry for this person.",
    },
    type: {
      id: "type",
      type: "string",
      enum: ["user", "student"],
    },
    name: { id: "name", type: "string" },
  },
  required: ["id", "type", "name"],
};

export const STUDENT_LINKABLE_ENTITIES_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_LinkableEntities",
  type: "array",
  title: "Linkable Users & Students",
  description:
    "Read-only. Users and other students that share at least one institute with " +
    "this student. When creating a Student_Contacts row for someone who already " +
    "appears in this list, set linkedUserId (for users) or linkedStudentId (for " +
    "students) on the new contact so the system knows it's the same real person. " +
    "If a matching name is found, auto-linking also happens on your behalf.",
  opened: false,
  items: linkableEntitySchema,
  db: linkableEntitiesOps as any,
};

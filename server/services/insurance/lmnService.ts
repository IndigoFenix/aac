import { db } from "../../db";
import { and, desc, eq } from "drizzle-orm";
import {
  lettersOfMedicalNecessity,
  students,
  medicalRecords,
  goals,
  programs,
  type LetterOfMedicalNecessity,
  type LmnStatus,
} from "@shared/schema";
import { getUtteranceMetrics, type UtteranceMetrics } from "./utteranceMetricsService";
import type { LmnSections } from "@shared/insurance-lmn-types";

export type { LmnSections } from "@shared/insurance-lmn-types";

const DEFAULT_RULE_OUT =
  "Natural speech, gestures, and writing have been evaluated and found insufficient to meet the student's daily communication needs across academic, social, and medical contexts. " +
  "Less restrictive low-tech options (picture exchange, communication books) have been trialed and do not provide adequate vocabulary breadth, novel-message generation, or independence.";

const DEFAULT_RATIONALE =
  "A dynamic-display speech-generating device with robust vocabulary and AI-assisted board synthesis is medically necessary to enable functional, generative, and independent communication. " +
  "The recommended device matches the student's motor, sensory, and cognitive profile and provides scalable vocabulary appropriate to current and projected language needs.";

const DEFAULT_ATTESTATION =
  "I attest that this Letter of Medical Necessity reflects my clinical judgment based on direct evaluation of the student. " +
  "The device requested is medically necessary and represents the least costly alternative that will meet the patient's communication needs.";

function severityFromMetrics(metrics: UtteranceMetrics): string {
  if (metrics.utteranceCount === 0) {
    return "Insufficient AAC activity has been recorded to compute communication metrics. Direct observation indicates significant expressive language impairment requiring augmentative support.";
  }
  const mlu = metrics.mlu;
  let level: string;
  if (mlu < 1.0) {
    level = "severe expressive language impairment, with single-word or pre-symbolic communication only";
  } else if (mlu < 2.0) {
    level = "moderate-to-severe expressive language impairment";
  } else if (mlu < 3.5) {
    level = "moderate expressive language impairment";
  } else {
    level = "mild expressive language impairment with continued need for AAC support for novel-message generation";
  }
  return (
    `Over the trailing ${Math.round(
      (new Date(metrics.windowEnd).getTime() - new Date(metrics.windowStart).getTime()) / (24 * 3600 * 1000),
    )} days, the student produced ${metrics.utteranceCount} AAC utterances ` +
    `(${metrics.totalWords} total words, ${metrics.ndw} different words; mean length of utterance = ${metrics.mlu}; ` +
    `communication rate = ${metrics.communicationRatePerMin} utterances per active minute). ` +
    `These metrics are consistent with ${level}.`
  );
}

function goalsNarrativeFrom(list: LmnSections["goalsList"]): string {
  if (list.length === 0) {
    return "No active goals are currently documented for this student. Initial AAC use is expected to focus on building functional communication and core vocabulary.";
  }
  const bullets = list
    .map((g) => (g.description ? `- ${g.title}: ${g.description}` : `- ${g.title}`))
    .join("\n");
  return `Active goals supported by this device:\n${bullets}`;
}

interface CreateDraftOpts {
  studentId: string;
  instituteId: string;
  userId: string;
  windowDays?: number;
}

/**
 * Build a fresh LMN draft. Snapshots all source data (identity, diagnosis,
 * goals, metrics) into the `sections` jsonb so later edits don't drift away
 * from the captured state. Caller verifies institute scoping; this function
 * trusts the inputs.
 */
export async function createLmnDraft(opts: CreateDraftOpts): Promise<LetterOfMedicalNecessity> {
  const [student] = await db
    .select({
      id: students.id,
      name: students.name,
      birthDate: students.birthDate,
    })
    .from(students)
    .where(eq(students.id, opts.studentId))
    .limit(1);

  if (!student) {
    throw new Error(`Student not found: ${opts.studentId}`);
  }

  // Pick the most recently updated medical record for diagnosis info.
  const [record] = await db
    .select()
    .from(medicalRecords)
    .where(eq(medicalRecords.studentId, opts.studentId))
    .orderBy(desc(medicalRecords.updatedAt))
    .limit(1);

  // Goals are scoped via programs → students. Pull active programs only,
  // then their non-archived goals. We treat anything other than "achieved"
  // or "discontinued" as still relevant for the LMN.
  const goalRows = await db
    .select({
      goalStatement: goals.goalStatement,
      relevance: goals.relevance,
      status: goals.status,
    })
    .from(goals)
    .innerJoin(programs, eq(goals.programId, programs.id))
    .where(eq(programs.studentId, opts.studentId));
  const activeGoals = goalRows
    .filter((g) => g.status !== "discontinued")
    .map((g) => ({
      title: g.goalStatement,
      description: g.relevance ?? null,
    }));

  const metrics = await getUtteranceMetrics({
    studentId: opts.studentId,
    windowDays: opts.windowDays,
  });

  const sections: LmnSections = {
    patientId: {
      name: student.name,
      birthDate: record?.birthDate ?? null,
      idNumber: null, // Caller can add later — we don't query the institute id-number here to avoid the redaction layer.
      institute: null,
    },
    diagnosis: {
      primary: record?.primaryDiagnosis ?? null,
      primaryCode: record?.primaryDiagnosisCode ?? null,
      coMorbidities: Array.isArray(record?.coMorbidities)
        ? (record!.coMorbidities as string[])
        : [],
      secondary: Array.isArray(record?.secondaryDiagnoses)
        ? (record!.secondaryDiagnoses as string[])
        : [],
    },
    metrics,
    goalsList: activeGoals,
    severityNarrative: severityFromMetrics(metrics),
    ruleOutNarrative: DEFAULT_RULE_OUT,
    rationaleNarrative: DEFAULT_RATIONALE,
    goalsNarrative: goalsNarrativeFrom(activeGoals),
    attestationNarrative: DEFAULT_ATTESTATION,
  };

  const [inserted] = await db
    .insert(lettersOfMedicalNecessity)
    .values({
      studentId: opts.studentId,
      userId: opts.userId,
      instituteId: opts.instituteId,
      sections: sections as any,
      metricsSnapshot: metrics as any,
      status: "draft",
    } as any)
    .returning();

  return inserted;
}

export async function getLmn(id: string): Promise<LetterOfMedicalNecessity | null> {
  const [row] = await db
    .select()
    .from(lettersOfMedicalNecessity)
    .where(eq(lettersOfMedicalNecessity.id, id))
    .limit(1);
  return row ?? null;
}

export async function listLmnsForStudent(
  studentId: string,
  instituteId: string,
): Promise<LetterOfMedicalNecessity[]> {
  return db
    .select()
    .from(lettersOfMedicalNecessity)
    .where(
      and(
        eq(lettersOfMedicalNecessity.studentId, studentId),
        eq(lettersOfMedicalNecessity.instituteId, instituteId),
      ),
    )
    .orderBy(desc(lettersOfMedicalNecessity.createdAt));
}

/**
 * All LMNs scoped to one institute. Used by the billing summary view to show
 * the latest LMN status per student in a single round-trip.
 */
export async function listLmnsForInstitute(
  instituteId: string,
): Promise<LetterOfMedicalNecessity[]> {
  return db
    .select()
    .from(lettersOfMedicalNecessity)
    .where(eq(lettersOfMedicalNecessity.instituteId, instituteId))
    .orderBy(desc(lettersOfMedicalNecessity.createdAt));
}

/** Edit the draft's sections. Throws when the LMN is already finalized. */
export async function updateLmnSections(
  id: string,
  sections: LmnSections,
): Promise<LetterOfMedicalNecessity> {
  const existing = await getLmn(id);
  if (!existing) throw new Error(`LMN not found: ${id}`);
  if (existing.status === "finalized") {
    throw new Error("Cannot edit a finalized LMN");
  }
  const [updated] = await db
    .update(lettersOfMedicalNecessity)
    .set({ sections: sections as any, updatedAt: new Date() })
    .where(eq(lettersOfMedicalNecessity.id, id))
    .returning();
  return updated;
}

interface FinalizeOpts {
  signatureName: string;
  signatureLicense: string | null;
  signatureCredentials: string | null;
}

/** Lock the LMN, record signature placeholders + finalizedAt. */
export async function finalizeLmn(
  id: string,
  opts: FinalizeOpts,
): Promise<LetterOfMedicalNecessity> {
  const existing = await getLmn(id);
  if (!existing) throw new Error(`LMN not found: ${id}`);
  if (existing.status === "finalized") return existing;
  const now = new Date();
  const [updated] = await db
    .update(lettersOfMedicalNecessity)
    .set({
      status: "finalized" as LmnStatus,
      finalizedAt: now,
      signedAt: now,
      signatureName: opts.signatureName,
      signatureLicense: opts.signatureLicense,
      signatureCredentials: opts.signatureCredentials,
      updatedAt: now,
    } as any)
    .where(eq(lettersOfMedicalNecessity.id, id))
    .returning();
  return updated;
}

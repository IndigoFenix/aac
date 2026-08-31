// server/services/dual-agent/diagnosis-for-prompt.ts
// The ONE way a student's primary diagnosis reaches a live-agent system prompt.
//
// AKIM §14 / §5.8. Three sites in dual-agent-service.ts used to run a bare
//   db.select({ primaryDiagnosis }).from(medicalRecords).where(studentId)
// and drop the result straight into the Gemini Live system prompt: session
// create, session reload, and the classroom roster — which did it for EVERY
// child enrolled on the device, not just the one using it. All three ignored
// the per-student privacy switch (`aac_settings.allow_read_reports`) and left
// no audit row, so the densest PHI read in the system was also the only one
// invisible to a breach investigation.
//
// This module fixes that in one place:
//   • the gate is honoured — `allowReadReports === false` means no read at all,
//     not a read whose result is discarded;
//   • every read that yields a diagnosis writes a `view` row on
//     medical_record / student with `details.route = "aac.live-prompt.diagnosis"`
//     and `isAiInitiated: true`, coalesced per (student, session) so a
//     reconnect storm does not inflate the log.
//
// Which record is read: the newest one that has NOT been superseded,
// preferring a `final` record when several exist. It is tempting to read only
// `status = 'final'` — but clinical records sit in `draft` indefinitely in
// practice (on staging, 7 of 9 medical records are drafts and exactly one is
// final), so a final-only filter would silently strip the diagnosis out of
// almost every live prompt. `superseded` is the one status that genuinely
// means "do not use this"; that is the filter, and no more.
//
// Both the DB reads and the log sink are injectable, so the behaviour above is
// tested without a database (server/tests/diagnosis-for-prompt.test.ts).

import { and, inArray, ne } from "drizzle-orm";
import { medicalRecords, aacSettings } from "@shared/schema";
import { db } from "../../db";
import { activityLogService, type ActivityLogEntry } from "../activityLogService";
import { ReadCoalescer } from "../../middleware/phi-read-audit";

/** Route label recorded on every audit row this module writes. */
export const DIAGNOSIS_PROMPT_ROUTE = "aac.live-prompt.diagnosis";

/** A medical record that could supply the prompt's diagnosis. */
export interface DiagnosisCandidate {
  /** The medical record's own id — the audit row's primary subject. */
  recordId?: string | null;
  studentId: string;
  primaryDiagnosis: string;
  /** `report_status`: draft | pending_review | final | superseded. */
  status?: string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
  /** From the medical record itself — the audit row inherits it. */
  instituteId?: string | null;
}

export interface DiagnosisPromptDeps {
  /**
   * Reads USABLE medical records for the given students — anything not
   * superseded. May return several per student; `pickDiagnosisRecord` decides
   * which one speaks. Rows without a diagnosis may be omitted.
   */
  readDiagnosisCandidates: (studentIds: string[]) => Promise<DiagnosisCandidate[]>;
  /**
   * Per-student `allowReadReports`. Only called for students whose setting the
   * caller did not already have in hand.
   */
  readAllowReadReports: (studentIds: string[]) => Promise<Map<string, boolean>>;
  log: (entry: ActivityLogEntry) => void;
  coalescer: ReadCoalescer;
}

export interface DiagnosisRequest {
  studentId: string;
  /**
   * The student's `aac_settings.allow_read_reports`. Undefined means "not in
   * hand" — it is looked up. `!== false` is the codebase convention for this
   * NOT NULL DEFAULT true column: a partial row must not silently deny.
   */
  allowReadReports?: boolean | null;
  /** Scopes audit coalescing, so each session records its own read. */
  sessionId?: string;
  /** The account the AAC device is signed in as. */
  userId?: string | null;
  instituteId?: string | null;
}

// ──────────────────────────────────────────────────────────────────
// Record selection (pure)
// ──────────────────────────────────────────────────────────────────

function timeOf(c: DiagnosisCandidate): number {
  const raw = c.updatedAt ?? c.createdAt;
  if (!raw) return 0;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Which of a student's records supplies the diagnosis: a `final` one beats a
 * non-final one, and among equals the most recently touched wins. Superseded
 * records are dropped outright — they are the only status that asserts the
 * record should no longer be used.
 *
 * Pure and exported so the rule is testable on its own.
 */
export function pickDiagnosisRecord(
  candidates: DiagnosisCandidate[],
): DiagnosisCandidate | null {
  let best: DiagnosisCandidate | null = null;
  for (const c of candidates) {
    if (!c.primaryDiagnosis) continue;
    if (c.status === "superseded") continue;
    if (!best) { best = c; continue; }
    const cFinal = c.status === "final";
    const bFinal = best.status === "final";
    if (cFinal !== bFinal) {
      if (cFinal) best = c;
      continue;
    }
    if (timeOf(c) > timeOf(best)) best = c;
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────
// Default (live) dependencies
// ──────────────────────────────────────────────────────────────────

async function dbReadDiagnosisCandidates(studentIds: string[]): Promise<DiagnosisCandidate[]> {
  if (studentIds.length === 0) return [];
  const rows = await db
    .select({
      recordId: medicalRecords.id,
      studentId: medicalRecords.studentId,
      primaryDiagnosis: medicalRecords.primaryDiagnosis,
      status: medicalRecords.status,
      updatedAt: medicalRecords.updatedAt,
      createdAt: medicalRecords.createdAt,
      instituteId: medicalRecords.instituteId,
    })
    .from(medicalRecords)
    .where(
      and(
        inArray(medicalRecords.studentId, studentIds),
        // A superseded record has been explicitly retired; everything else —
        // draft included — is a live description of the student.
        ne(medicalRecords.status, "superseded"),
      ),
    );
  return rows.filter((r): r is typeof r & { primaryDiagnosis: string } => !!r.primaryDiagnosis);
}

async function dbReadAllowReadReports(studentIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (studentIds.length === 0) return out;
  const rows = await db
    .select({
      studentId: aacSettings.studentId,
      allowReadReports: aacSettings.allowReadReports,
    })
    .from(aacSettings)
    .where(inArray(aacSettings.studentId, studentIds));
  for (const r of rows) out.set(r.studentId, r.allowReadReports !== false);
  return out;
}

/** Process-wide coalescer, mirroring the phi-read-audit middleware. */
const defaultCoalescer = new ReadCoalescer();

export function defaultDiagnosisDeps(): DiagnosisPromptDeps {
  return {
    readDiagnosisCandidates: dbReadDiagnosisCandidates,
    readAllowReadReports: dbReadAllowReadReports,
    log: (entry) => activityLogService.log(entry),
    coalescer: defaultCoalescer,
  };
}

// ──────────────────────────────────────────────────────────────────
// Loaders
// ──────────────────────────────────────────────────────────────────

/**
 * Batch form. Returns a map of studentId → primary diagnosis for every student
 * whose privacy gate is open and who has a usable record. Each child on a
 * classroom roster is judged by their OWN setting.
 *
 * Never throws: a failure here must degrade the prompt, not the session.
 */
export async function loadDiagnosesForPrompt(
  requests: DiagnosisRequest[],
  deps: DiagnosisPromptDeps = defaultDiagnosisDeps(),
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (requests.length === 0) return result;

  try {
    // Resolve the gate for anyone whose setting the caller did not supply.
    const unknown = requests
      .filter((r) => r.allowReadReports === undefined)
      .map((r) => r.studentId);
    const looked = unknown.length > 0 ? await deps.readAllowReadReports(unknown) : new Map();

    const permitted: DiagnosisRequest[] = [];
    for (const req of requests) {
      const allowed =
        req.allowReadReports === undefined
          ? looked.get(req.studentId) !== false // absent row → column default (true)
          : req.allowReadReports !== false;
      if (allowed) permitted.push(req);
    }
    // Gate closed for everyone: NO read is issued at all.
    if (permitted.length === 0) return result;

    const rows = await deps.readDiagnosisCandidates(permitted.map((r) => r.studentId));
    const byStudent = new Map<string, DiagnosisCandidate[]>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId);
      if (list) list.push(row);
      else byStudent.set(row.studentId, [row]);
    }

    for (const req of permitted) {
      const row = pickDiagnosisRecord(byStudent.get(req.studentId) ?? []);
      if (!row?.primaryDiagnosis) continue;
      result.set(req.studentId, row.primaryDiagnosis);
      auditDiagnosisRead(req, row, deps);
    }
  } catch (err) {
    console.warn(
      "[diagnosis-for-prompt] diagnosis load failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return result;
}

/** Single-student form. Null when the gate is closed or no usable record exists. */
export async function loadDiagnosisForPrompt(
  request: DiagnosisRequest,
  deps: DiagnosisPromptDeps = defaultDiagnosisDeps(),
): Promise<string | null> {
  const map = await loadDiagnosesForPrompt([request], deps);
  return map.get(request.studentId) ?? null;
}

function auditDiagnosisRead(
  req: DiagnosisRequest,
  row: DiagnosisCandidate,
  deps: DiagnosisPromptDeps,
): void {
  // Per (student, session): a reconnect inside the window is the same access,
  // a new session is a new one.
  const key = `diagnosis|${req.studentId}|${req.sessionId ?? "-"}`;
  if (!deps.coalescer.shouldLog(key)) return;
  deps.log({
    userId: req.userId ?? null,
    instituteId: req.instituteId ?? row.instituteId ?? null,
    eventType: "view",
    subjectType1: "medical_record",
    subjectId1: row.recordId ?? null,
    subjectType2: "student",
    subjectId2: req.studentId,
    details: { route: DIAGNOSIS_PROMPT_ROUTE, sessionId: req.sessionId ?? null },
    isAiInitiated: true,
  });
}

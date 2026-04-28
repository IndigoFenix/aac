// server/services/consent/consentGate.ts
// Boundary helper that PHI-touching entry points consult to enforce that an
// active student_consent_records row exists for the student before doing
// AI processing, finalizing reports, creating share invites, or starting
// AAC sessions.
//
// Gated behind CONSENT_GATE_ENABLED env var so the helper can be wired into
// services now without breaking existing flows. Flip the flag once the
// legacy-grace backfill (task #6) and the consent-collection UI (later
// phases) are in place.

import { consentService } from "./consentService.js";
import { db } from "../../db.js";
import { eq } from "drizzle-orm";
import { students, type StudentConsentRecord } from "@shared/schema";
import type { OptInType } from "@shared/legal";

export class ConsentGateError extends Error {
  readonly code = "consent_required" as const;
  readonly studentId: string;
  constructor(studentId: string, message?: string) {
    super(
      message ??
        // Phrased so the AI can read this directly off a tool-result error and
        // explain it to the user in plain language. The clinician/parent UI
        // surfaces a "Sign consent" CTA in the same flow.
        `Cannot access or modify this student's data: no active informed-consent record exists for the student (id=${studentId}). Ask the user to complete the consent wizard for this student before retrying.`,
    );
    this.studentId = studentId;
    this.name = "ConsentGateError";
  }
}

export interface ConsentSnapshot {
  consentId: string;
  country: string;
  regime: string | null;
  signedAt: Date;
  optIns: Record<OptInType, boolean>;
  optInsForcedOff: boolean;
}

function isConsentGateEnabled(): boolean {
  return process.env.CONSENT_GATE_ENABLED === "true";
}

export interface ConsentStatus {
  /**
   * Whether PHI writes for this student are currently allowed by the gate.
   * False means a write attempt would throw ConsentGateError.
   */
  writesAllowed: boolean;
  /** True when an active (non-revoked) consent record exists. */
  hasActiveConsent: boolean;
  /** True when the gate is honoring the legacy 90-day grace window. */
  inLegacyGrace: boolean;
  /** The legacy deadline if any, in ISO format. */
  legacyConsentDeadline: string | null;
  /** Whether the global gate flag is on. */
  gateEnabled: boolean;
}

/**
 * Snapshot of the student's gate state. Use this in the chat-session prompt
 * builder so the AI knows up-front when a student is in consent_pending
 * state and can explain blocked operations to the user without confusion.
 */
export async function getConsentStatus(studentId: string): Promise<ConsentStatus> {
  const gateEnabled = isConsentGateEnabled();
  const has = await consentService.hasActiveConsent(studentId);
  const [row] = await db
    .select({ legacyConsentDeadline: students.legacyConsentDeadline })
    .from(students)
    .where(eq(students.id, studentId));
  const deadline = row?.legacyConsentDeadline ?? null;
  const inGrace = !!deadline && deadline.getTime() > Date.now();
  // Mirror the requireActiveConsent decision tree:
  //   gate off → always allowed
  //   gate on  → allowed iff has consent OR in legacy grace
  const writesAllowed = !gateEnabled || has || inGrace;
  return {
    writesAllowed,
    hasActiveConsent: has,
    inLegacyGrace: inGrace,
    legacyConsentDeadline: deadline ? deadline.toISOString() : null,
    gateEnabled,
  };
}

/**
 * Throws ConsentGateError when the student has no active consent record
 * AND no remaining legacy grace window AND the gate is enabled. Call from
 * PHI-touching entry points.
 *
 * Legacy-grace rationale: students that predate the consent feature have
 * `legacy_consent_deadline` set to creation+90d so existing flows don't
 * break the day the feature ships. After the deadline, those students
 * become consent_pending until someone collects consent for them.
 */
export async function requireActiveConsent(studentId: string): Promise<void> {
  if (!isConsentGateEnabled()) return;
  const has = await consentService.hasActiveConsent(studentId);
  if (has) return;
  if (await isInLegacyGrace(studentId)) return;
  throw new ConsentGateError(studentId);
}

/**
 * Memory-schema helper: PHI-write entry points in memory schemas should
 * call this before the underlying repo write. Reads pass through.
 *
 * The memory-schema ctx convention puts studentId on `ctx.all.studentId`.
 * No-op when the gate is disabled or studentId isn't present.
 */
export async function requireConsentForMemoryWrite(
  ctx: { all: Record<string, unknown> },
): Promise<void> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return;
  await requireActiveConsent(studentId);
}

/**
 * Express helper: enforces requireActiveConsent and writes a 412 response
 * when the gate blocks. Returns true when the caller should proceed,
 * false when the response has already been sent.
 *
 * Usage:
 *   if (!(await requireConsentForResponse(req, res, studentId))) return;
 */
export async function requireConsentForResponse(
  _req: import("express").Request,
  res: import("express").Response,
  studentId: string,
): Promise<boolean> {
  try {
    await requireActiveConsent(studentId);
    return true;
  } catch (e) {
    if (e instanceof ConsentGateError) {
      res.status(412).json({
        success: false,
        code: "consent_required",
        message: "Active student consent record required for this operation",
        studentId: e.studentId,
      });
      return false;
    }
    throw e;
  }
}

async function isInLegacyGrace(studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ legacyConsentDeadline: students.legacyConsentDeadline })
    .from(students)
    .where(eq(students.id, studentId));
  if (!row?.legacyConsentDeadline) return false;
  return row.legacyConsentDeadline.getTime() > Date.now();
}

/**
 * Returns a frozen view of the student's active consent — disclosures
 * present at signing time + opt-in states. AI processing decisions
 * (e.g. whether the student's data may enter training) consult this.
 *
 * Returns null when there is no active consent. Callers should treat
 * null as "deny" for any optional processing path; mandatory paths
 * should call requireActiveConsent instead so the gate flag controls
 * blocking.
 */
export async function getConsentSnapshot(studentId: string): Promise<ConsentSnapshot | null> {
  const record = await consentService.getActiveConsent(studentId);
  return record ? toSnapshot(record) : null;
}

function toSnapshot(r: StudentConsentRecord): ConsentSnapshot {
  return {
    consentId: r.id,
    country: r.country,
    regime: r.enhancedProtectionRegime,
    signedAt: r.signedAt,
    optIns: {
      model_training: r.optInModelTraining,
      advertising: r.optInAdvertising,
      third_party_research: r.optInThirdPartyResearch,
      marketing_comms: r.optInMarketingComms,
    },
    optInsForcedOff: r.optInsForcedOff,
  };
}

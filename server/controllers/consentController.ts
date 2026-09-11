// server/controllers/consentController.ts
//
// HTTP surface for the student informed-consent flow. Wizard talks to these
// endpoints to fetch the notice, prefill from existing data, and submit the
// signed consent. Permission checks live here; legal validation in the
// service layer.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "../db";
import {
  studentContacts,
  studentConsentRecords,
  userStudents,
  type StudentContact,
  type StudentConsentRecord,
} from "@shared/schema";
import {
  consentService,
  ConsentError,
  type ConsentErrorCode,
} from "../services/consent/consentService";
import {
  consentInvitationService,
  ConsentInvitationError,
  type ConsentInvitationErrorCode,
} from "../services/consent/consentInvitationService";
import {
  consentWithdrawalService,
  type WithdrawalChannel,
} from "../services/consent/consentWithdrawalService";
import {
  consentAuthorityService,
  ConsentAuthorityError,
  type ConsentAuthorityErrorCode,
} from "../services/consent/consentAuthorityService";
import { getConsentStatus } from "../services/consent/consentGate";
import { PhoneOtpError, type PhoneOtpErrorCode } from "../services/phoneOtpService";
import { sendConsentReceipt } from "../services/consent/consentReceipt";
import { studentRepository } from "../repositories/studentRepository";
import { studentConsentRecordRepository } from "../repositories/studentConsentRecordRepository";
import { userRepository } from "../repositories/userRepository";
import { instituteRepository } from "../repositories/instituteRepository";
// The named student policies. Promoted OUT of this file — see the block below
// `loadGuardianContactForCurrentUser` for what each one admits.
import {
  principalFromRequest,
  sharesInstituteWithStudent,
  assertSharesInstituteWithStudent,
  administersStudentInstitute,
  assertWizardContextAccess,
} from "../services/access";
import {
  lookupConsentNotice,
  renderNoticeForHashing,
  getDefaultRecipients,
  computeAgeYears,
  resolveMinorProtection,
  resolveIdvRegimeContext,
  checkIdvAcceptability,
} from "@shared/legal";
import { activityLogService } from "../services/activityLogService";

// ============================================================================
// Zod
// ============================================================================

// Supplemental signature evidence (type-to-sign / draw-to-sign). Stored inside
// nonRepudiationEvidence, NOT used as a distinct IDV method. The image is a PNG
// data URL — capped so a pathological payload can't bloat the jsonb column.
const signatureShape = z.object({
  mode: z.enum(["typed", "drawn"]),
  typedName: z.string().max(200).optional(),
  image: z.string().max(2_000_000).optional(),
  signedAt: z.string().max(40).optional(),
});

const signatureSchema = signatureShape.optional();

const governmentIdTypeSchema = z.enum([
  "national_id",
  "passport",
  "driver_license",
  "other",
]);

const signConsentSchema = z.object({
  // Required for guardian consent; omitted for self-consent (the logged-in
  // student signs for themselves).
  signedByContactId: z.string().min(1).optional(),
  locale: z.string().min(2).max(10),
  consentTextVersion: z.string().min(1),
  consentTextHash: z.string().length(64),
  signature: signatureSchema,

  // Guardian contact updates committed in the same transaction as the sign.
  guardianFields: z
    .object({
      governmentIdNumber: z.string().min(1).max(40).optional(),
      governmentIdType: z.enum(["national_id", "passport", "driver_license", "other"]).optional(),
      governmentIdCountry: z.string().length(2).optional(),
      coGuardianAcknowledged: z.boolean().optional(),
    })
    .optional(),

  purposeAcknowledged: z.boolean(),
  voluntarinessAcknowledged: z.boolean(),
  thirdPartyTransfersAcknowledged: z.boolean(),

  optInModelTraining: z.boolean().optional(),
  optInAdvertising: z.boolean().optional(),
  optInThirdPartyResearch: z.boolean().optional(),
  optInMarketingComms: z.boolean().optional(),

  // Optional override; default flow uses authenticated_session for the family
  // parent path. Other origins (clinic in-person, video, gov SSO) will pass
  // a stronger method explicitly.
  identityVerificationMethod: z.string().optional(),
  identityVerificationEvidence: z.record(z.unknown()).optional(),
  nonRepudiationMethod: z.string().optional(),
  nonRepudiationEvidence: z.record(z.unknown()).optional(),

  // For the wizard's "treat as standard" v1 family path. Defaults to true.
  isSensitive: z.boolean().optional(),
});

const revokeConsentSchema = z.object({
  reason: z.string().max(2000).optional(),
});

// ============================================================================
// In-person clinician attestation — constants the SERVER owns
// ============================================================================

/**
 * The IDV method for the in-person path, forced server-side and NEVER read from
 * the request body.
 *
 * A client that can name its own IDV method can claim a regime it did not earn:
 * `gov_sso` and `signed_form_upload` are accepted for `us_coppa`, this one
 * deliberately is not (`shared/legal/idv-methods.ts` — `acceptedFor` omits
 * `us_coppa`, matching COPPA's closed enumeration of verifiable-parental-consent
 * methods, 16 CFR §312.5(b)(2)). `attestInPerson`'s zod schema therefore has no
 * `identityVerificationMethod` / `nonRepudiationMethod` key at all; zod strips
 * unknown keys, so a client that sends one is silently ignored rather than
 * honoured.
 *
 * The method declares `providesBothLegs: true`, so it stands alone on BOTH legs
 * and needs no pairing partner.
 */
const IN_PERSON_IDV_METHOD = "in_person_clinician_attested";

/**
 * The `student_contacts.government_id_verification_provider` tag written by this
 * path. This is the field that records the assertion came from a CLINICIAN
 * inspecting a document, not from the guardian's own click — the parent flow
 * writes `self_declared` for the same column.
 */
const IN_PERSON_ID_PROVIDER = "clinician_attested";

/**
 * JUDGEMENT CALL (2026-09-09) — the attestation is treated as SENSITIVE
 * processing, unlike the v1 family flow which passes `isSensitive: false`.
 *
 * A clinic recording an in-person consent is collecting SLP/AAC health data;
 * `signConsent`'s own default is `?? true` and the PPA Feb-2026 position paper
 * addresses exactly this case. `in_person_clinician_attested` is accepted for
 * `il_sensitive` and `eu_gdpr_art9`, so raising the bar here costs nothing in IL
 * or the EU while producing the honest regime label on the record.
 */
const IN_PERSON_IS_SENSITIVE = true;

/**
 * JUDGEMENT CALL (2026-09-09) — WHO may attest.
 *
 * `false` = any ACTIVE member of an institute the student is enrolled in (the
 * `assertSharesInstituteWithStudent` gate, same as every other student-scoped consent
 * endpoint). `true` = institute ADMIN only.
 *
 * Chosen `false`, deliberately: in a clinic the person sitting with the guardian
 * at intake is the treating clinician, who is usually not the institute admin.
 * Requiring admin would make the in-person path unusable in exactly the
 * situation it exists for, and would push clinics back to emailing a link to a
 * parent who is already in the room. Nothing in the legal layer contradicts
 * this — `planning-docs/student-access-permission/student-consent-onboarding-plan.md`
 * specifies the in-person method as "the clinician attests via the clinician's
 * own authenticated session" and never names a role, and no MoE principle
 * addresses who may create a consent record. (`moe-status.md` F.2's
 * "admins only, not v1" note is about right-to-erasure, not consent — it must
 * not be generalised.) The attester's identity is captured either way, so the
 * accountability is the audit trail, not the role gate.
 *
 * To reverse: flip this constant to `true`. Nothing else changes.
 */
const ATTEST_REQUIRES_INSTITUTE_ADMIN = false;

/**
 * ATTEST PARITY (2026-09-09) — "whoever could have ATTESTED a consent may also
 * REVOKE it."
 *
 * The hole this closes: `attestInPerson` signs as a guardian contact that has
 * NO `linkedUserId` (that absence is the whole reason the endpoint exists), and
 * `revokeConsent`'s rule is "the signing contact's linked user, or a system
 * admin". A clinic-attested consent therefore had exactly one revoker in the
 * whole system — a system admin — while every regime we implement grants the
 * data subject a right of withdrawal (§10.1 IL PPL, GDPR Art. 7(3), COPPA
 * §312.6). The guardian has no account, so the practical withdrawal path is
 * "tell the clinic", and the clinic must be able to act on it.
 *
 * ⚠️ SCOPE — this is NARROW ON PURPOSE, and the narrowness is the security
 * property. It applies ONLY to records whose `identityVerificationMethod` is
 * `IN_PERSON_IDV_METHOD`. The broad reading — "any institute member may revoke
 * any of that student's consents" — was considered and REJECTED: it would let a
 * clinic member tear up a consent the parent signed themselves through the
 * magic link or from their own session, taking a right away from the person who
 * actually holds it, which is a far larger widening than the one that was
 * approved. A parent-signed record's rules are untouched.
 *
 * The permission is `attestPermissionFor` — literally the same function the
 * attest WRITE gates on, including `ATTEST_REQUIRES_INSTITUTE_ADMIN`, so
 * flipping that constant tightens creation and withdrawal together and they can
 * never drift apart.
 */
type AttestPermission = "ok" | "unauthenticated" | "not_member" | "not_admin";

/**
 * THE attest predicate, in one place. Answers nothing to the client — callers
 * decide the status code — so it can be consulted by handlers that must NOT
 * respond on failure (the revoke path falls through to its own rules, and
 * `listHistory` uses it to decide whether to advertise the affordance).
 *
 * `assertAttestPermission` below is the response-writing wrapper the attest
 * endpoint uses; there is no second copy of the rule.
 */
async function attestPermissionFor(
  req: Request,
  studentId: string,
): Promise<AttestPermission> {
  const principal = principalFromRequest(req);
  if (!principal?.id) return "unauthenticated";
  if (!(await sharesInstituteWithStudent(principal, studentId))) return "not_member";
  if (
    ATTEST_REQUIRES_INSTITUTE_ADMIN &&
    !(await administersStudentInstitute(principal, studentId))
  ) {
    return "not_admin";
  }
  return "ok";
}

/**
 * Response-writing form of `attestPermissionFor`, for the attest endpoint.
 * Statuses and messages are exactly what the endpoint answered before the
 * predicate was lifted out (401 / 403 "No access to that student" / 403
 * "Only institute admins can attest consent in person").
 */
async function assertAttestPermission(
  req: Request,
  res: Response,
  studentId: string,
): Promise<boolean> {
  switch (await attestPermissionFor(req, studentId)) {
    case "ok":
      return true;
    case "unauthenticated":
      res.status(401).json({ success: false, message: "Unauthenticated" });
      return false;
    case "not_member":
      res.status(403).json({
        success: false,
        code: "permission_denied",
        message: "No access to that student",
      });
      return false;
    case "not_admin":
      res.status(403).json({
        success: false,
        code: "permission_denied",
        message: "Only institute admins can attest consent in person",
      });
      return false;
  }
}

/**
 * Which rule (if any) lets this caller revoke this consent record. `null` = no
 * rule does. The answer is also the AUDIT LABEL written to
 * `consent_revoked.details.revocation_path` (§8), so a reader of the log can
 * tell a signer's own withdrawal from one the clinic performed on their behalf
 * without re-deriving anything.
 *
 * Order is deliberate: `system_admin` short-circuits first exactly as it did
 * before this change (it never touches the contact query), then the SIGNER
 * rules verbatim, and only then attest parity. So a record that was already
 * revocable is revoked by the same rule and logged under the same label as
 * before; `attest_parity` appears only where nothing else would have allowed it.
 *
 * `attestGrant` lets a caller that resolves the parity predicate ONCE per
 * student (listHistory, over a list of records) avoid re-running its two
 * institute lookups per row. Omit it and it is resolved here.
 */
/**
 * The rules THIS endpoint enforces. There is a FOURTH audit label,
 * `signer_token` (§5.3) — the guardian with no account withdrawing over a
 * withdrawal token — and it is deliberately not here: that path has no `req.user`
 * to test, so it is decided by possession of the token in
 * `consentWithdrawalService` and never passes through `revokePathFor`. Anyone
 * reading `details.revocation_path` sees four values; anyone reading this
 * function sees the three that a SESSION can produce. Do not "complete" this
 * union with `signer_token` — it would imply a session could be admitted under
 * it, which is exactly the thing that must never be true.
 */
type RevokePath = "system_admin" | "signer" | "attest_parity";

async function revokePathFor(
  req: Request,
  existing: StudentConsentRecord,
  attestGrant?: boolean,
): Promise<RevokePath | null> {
  const user = principalFromRequest(req);
  const userId = user?.id;
  if (!userId) return null;

  if (user?.isSystemAdmin) return "system_admin";

  // Self-signed consent: only the student who signed may revoke.
  // Guardian-signed: only the signing contact's linked user may revoke.
  if (existing.signerType === "self" || !existing.signedByContactId) {
    if (existing.signedByUserId === userId) return "signer";
  } else {
    const [contact] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, existing.signedByContactId));
    if (contact?.linkedUserId === userId) return "signer";
  }

  // ATTEST PARITY — clinician-attested records ONLY. See the block comment on
  // `AttestPermission` for why this must not be generalised to other records.
  if (existing.identityVerificationMethod === IN_PERSON_IDV_METHOD) {
    const granted =
      attestGrant ??
      ((await attestPermissionFor(req, existing.studentId)) === "ok");
    if (granted) return "attest_parity";
  }

  return null;
}

/**
 * The clinic-desk sign. Deliberately NOT a superset of `signConsentSchema`:
 *
 *  - `identityVerificationMethod` / `nonRepudiationMethod` / `isSensitive` are
 *    absent — the server owns all three (see IN_PERSON_IDV_METHOD above).
 *  - `signature` is REQUIRED, not optional. On this path the guardian never
 *    touches an authenticated session of their own, so their typed/drawn
 *    signature is the only machine-captured act that is theirs. The legal layer
 *    does not demand it (the plan lets the clinician's session carry both legs
 *    alone), so this is a deliberate step ABOVE the documented minimum.
 *  - `attestation` is the clinician's own declaration, and `guardianPresent` is
 *    `z.literal(true)`: "the guardian was physically present" is the premise of
 *    the whole method, so a payload that does not assert it is malformed, not
 *    merely a record with a false flag.
 */
const attestInPersonSchema = z.object({
  signedByContactId: z.string().min(1),
  locale: z.string().min(2).max(10),
  consentTextVersion: z.string().min(1),
  consentTextHash: z.string().length(64),

  /** The GUARDIAN's own signature — see the note above. */
  signature: signatureShape,

  attestation: z.object({
    /** The clinician declares the guardian was in the room. */
    guardianPresent: z.literal(true),
    /** Which document the clinician inspected. */
    identificationType: governmentIdTypeSchema,
    /** Issuing country of that document (ISO 3166-1 alpha-2). */
    identificationCountry: z.string().length(2).optional(),
    /** Free-text note (e.g. "passport expired 2031, name matches"). */
    notes: z.string().max(2000).optional(),
  }),

  // Guardian contact updates committed alongside the sign. The ID NUMBER is
  // written to the contact row (its one existing home) and never copied into
  // the evidence jsonb — see the minimisation note in attestInPerson.
  guardianFields: z
    .object({
      governmentIdNumber: z.string().min(1).max(40).optional(),
      governmentIdCountry: z.string().length(2).optional(),
      coGuardianAcknowledged: z.boolean().optional(),
    })
    .optional(),

  purposeAcknowledged: z.boolean(),
  voluntarinessAcknowledged: z.boolean(),
  thirdPartyTransfersAcknowledged: z.boolean(),

  optInModelTraining: z.boolean().optional(),
  optInAdvertising: z.boolean().optional(),
  optInThirdPartyResearch: z.boolean().optional(),
  optInMarketingComms: z.boolean().optional(),
});

// ============================================================================
// Error → HTTP
// ============================================================================

const errorStatus: Record<ConsentErrorCode, number> = {
  student_not_found: 404,
  student_missing_birth_date: 400,
  contact_not_found: 404,
  contact_not_for_student: 403,
  contact_not_legal_guardian: 422,
  guardianship_basis_required: 422,
  signer_not_permitted: 422,
  disclosures_required: 400,
  notice_not_found: 404,
  notice_version_mismatch: 409,
  notice_hash_mismatch: 409,
  idv_unknown_method: 400,
  idv_not_acceptable: 422,
  consent_not_found: 404,
  consent_already_revoked: 409,
};

function handleError(res: Response, err: unknown): void {
  if (err instanceof ConsentError) {
    res.status(errorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  console.error("[ConsentController]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

// ============================================================================
// Permission helpers
// ============================================================================

async function loadGuardianContactForCurrentUser(
  studentId: string,
  userId: string,
): Promise<StudentContact | null> {
  const [row] = await db
    .select()
    .from(studentContacts)
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.linkedUserId, userId),
      ),
    );
  return row ?? null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STUDENT PREDICATES NOW LIVE IN `server/services/access/`.
 *
 * They were promoted out of this file on 2026-09-10 (authorization structural
 * pass, phase 1). This controller is where they were WRITTEN — the 2026-09-09
 * consent sweep produced the cast-free institute-overlap check and the
 * documented three-predicate wizard union after four hand-typed copies of the
 * same check all rotted the same way — but they answer a question the whole
 * REST surface asks, so they no longer belong to one controller.
 *
 * Nothing about WHO is allowed changed in the move; the consent suites are the
 * evidence. Names, and what each admits:
 *
 *   sharesInstituteWithStudent      system admin ∨ shares an ACTIVE institute
 *                                   with the student. (Was
 *                                   `userSharesInstituteWithStudent`.)
 *   assertSharesInstituteWithStudent  its 401/403-writing form — the ONE gate
 *                                   for `/active`, `/history`, `/authority`,
 *                                   `/invitations`. (Was `assertStudentAccess`;
 *                                   renamed because two functions in the
 *                                   codebase carried that name with different
 *                                   rules, and three more carried
 *                                   `requireStudentAccess`.)
 *   administersStudentInstitute     admin of one of the STUDENT's institutes —
 *                                   never a caller-supplied one (§5.5.1).
 *                                   (Was `userIsAdminForStudent`.)
 *   assertWizardContextAccess       the union: institute overlap ∨ linked
 *                                   `student_contacts` row ∨ active
 *                                   `user_students` link.
 *
 * 🚨 Do not re-type any of them here. A fifth copy is how the last one rotted.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ============================================================================
// Controller
// ============================================================================

class ConsentController {
  /**
   * GET /api/consent/notice?country=IL&locale=en[&version=...]
   * Returns the notice content (renderable text), its computed hash, the
   * resolved version, and the default recipient list to disclose.
   */
  async getNotice(req: Request, res: Response): Promise<void> {
    try {
      const country = String(req.query.country ?? "").trim();
      const locale = String(req.query.locale ?? "en").trim();
      const version = req.query.version ? String(req.query.version).trim() : undefined;

      if (!country) {
        res.status(400).json({ success: false, message: "country is required" });
        return;
      }

      const variant = lookupConsentNotice({ country, locale, version });
      if (!variant) {
        res.status(404).json({
          success: false,
          message: "No consent notice for that country/locale/version",
        });
        return;
      }
      const hash = createHash("sha256")
        .update(renderNoticeForHashing(variant.content))
        .digest("hex");

      res.json({
        success: true,
        country: variant.country,
        locale: variant.locale,
        version: variant.version,
        hash,
        content: variant.content,
        thirdPartyRecipients: getDefaultRecipients(),
      });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/active
   * The signed consent record currently in force, or null. Permission: any
   * institute member of an institute attached to the student (system admins
   * always pass) — the same gate as its siblings. It had NO check at all until
   * 2026-09-09, so any authenticated user could read any student's record.
   *
   * Also returns a server-computed `gate` — the SAME `getConsentStatus` the
   * write gate consults, for the same reason `/history` ships `canRevoke`: so
   * the UI's affordance and the server's answer cannot disagree. The absence of
   * a consent record is NOT the same as "finalize would be refused": the
   * decision also folds in `CONSENT_GATE_ENABLED` and the legacy grace window,
   * neither of which the client can see. Re-deriving it client-side from
   * `consent === null` disables finalize on every gate-off install and every
   * student still inside grace, where finalize in fact succeeds.
   */
  async getActiveForStudent(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.studentId;
      if (!(await assertSharesInstituteWithStudent(req, res, studentId))) return;
      const record = await consentService.getActiveConsent(studentId);
      const gate = await getConsentStatus(studentId);
      res.json({ success: true, consent: record, gate });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/history
   * Full audit-grade history of consent records for the student. Returns
   * active + revoked records, ordered most-recent first. Permission: any
   * institute member of an institute attached to the student. (System
   * admins always pass.)
   *
   * Each record carries a server-computed `canRevoke` — the SAME
   * `revokePathFor` the revoke endpoint enforces, so the UI's affordance and
   * the server's answer cannot disagree. Reading the gate is not the same as
   * passing it: this endpoint admits any institute member, and most of them may
   * not revoke most records.
   */
  async listHistory(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.studentId;
      if (!(await assertSharesInstituteWithStudent(req, res, studentId))) return;
      const records = await consentService.listHistory(studentId);
      // Every record here belongs to ONE student, so the parity predicate is
      // resolved once and handed down rather than re-queried per row.
      const attestGrant = (await attestPermissionFor(req, studentId)) === "ok";
      // Same rule as `canRevoke`, one rung over: whether the clinic may re-send
      // the guardian a WITHDRAWAL link (§5.3). Institute-admin gated, matching
      // the endpoint, and the service decides whether a link could reach anyone
      // — the client cannot see `linkedUserId` or what channels are on file.
      const canSendLink = await administersStudentInstitute(principalFromRequest(req), studentId);
      const history = await Promise.all(
        records.map(async (record) => ({
          ...record,
          canRevoke:
            !record.revokedAt &&
            (await revokePathFor(req, record, attestGrant)) !== null,
          canSendWithdrawalLink:
            canSendLink &&
            (await consentWithdrawalService.canIssueWithdrawalLink(record)),
        })),
      );
      res.json({ success: true, history });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/wizard-context[?contactId=…]
   * Bundles everything the wizard needs to render: student basics, the
   * current user's profile, their existing guardian contact for this
   * student (if auto-create ran), and the active consent record (if any).
   *
   * `?contactId=` is the IN-PERSON ATTESTATION variant: the clinician is not
   * the guardian, so the default "contact linked to the calling user" lookup
   * finds nothing and the wizard would render its no-guardian dead end. With
   * the param the wizard is handed the named contact instead.
   *
   * That param is gated by `assertSharesInstituteWithStudent` — STRICTER than the default
   * path, and it stays that way. Naming another person's contact row is not
   * something a bare session may do, so the param cannot widen what this
   * endpoint already exposes.
   *
   * PERMISSION (default path, 2026-09-10): `assertWizardContextAccess` —
   * institute overlap OR a `student_contacts` row linked to the caller OR an
   * active `user_students` link. See the block comment on that helper for why
   * the parent path is modelled explicitly instead of by institute overlap, and
   * why the magic-link guardian is NOT among the callers it serves. Until this
   * date the default path checked only that a session existed, and returned the
   * student's name, birth date, country and active consent record to every
   * authenticated account on the platform (docs/SECURITY_ARCHITECTURE.md §2.4).
   *
   * ORDERING MATTERS: permission is resolved BEFORE the student row is read, so
   * an unpermitted caller gets the same 403 for a real student and for an
   * invented id. Reading the student first would turn the 404 into a student-id
   * oracle for exactly the callers this gate exists to refuse.
   */
  async getWizardContext(req: Request, res: Response): Promise<void> {
    try {
      const userId = principalFromRequest(req)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }

      const studentId = req.params.studentId;
      const requestedContactId = req.query.contactId
        ? String(req.query.contactId).trim()
        : "";

      let contact: StudentContact | null;
      if (requestedContactId) {
        if (!(await assertSharesInstituteWithStudent(req, res, studentId))) return;
        const [named] = await db
          .select()
          .from(studentContacts)
          .where(eq(studentContacts.id, requestedContactId));
        if (!named) {
          res.status(404).json({ success: false, code: "contact_not_found", message: "Contact not found" });
          return;
        }
        if (named.studentId !== studentId) {
          res.status(403).json({ success: false, code: "contact_not_for_student", message: "Contact does not belong to that student" });
          return;
        }
        contact = named;
      } else {
        // Loaded first because it is BOTH the response's `guardianContact` and
        // one of the three things that may admit the caller — one query, two
        // jobs, no second copy of the "is this contact mine" rule.
        contact = await loadGuardianContactForCurrentUser(studentId, userId);
        if (!(await assertWizardContextAccess(req, res, studentId, contact))) return;
      }

      const student = await studentRepository.getStudentById(studentId);
      if (!student) {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }
      const user = await userRepository.getUser(userId);

      const activeConsent = await consentService.getActiveConsent(studentId);
      const resolvedAuthority = await consentAuthorityService.resolveForStudent(studentId);

      res.json({
        success: true,
        // Who must sign (guardian vs. self) so the wizard renders the right
        // flow. Null when birth date is missing.
        signerType: resolvedAuthority?.signerType ?? null,
        consentAuthority: student.consentAuthority ?? "auto",
        student: {
          id: student.id,
          name: student.name,
          firstName: student.firstName,
          lastName: student.lastName,
          birthDate: student.birthDate,
          country: student.country,
          primaryLanguage: student.primaryLanguage,
        },
        user: user
          ? {
              id: user.id,
              firstName: user.firstName,
              lastName: user.lastName,
              fullName: user.fullName,
              email: user.email,
              country: (user as any).country ?? null,
              phone: (user as any).phone ?? null,
            }
          : null,
        guardianContact: contact,
        activeConsent,
      });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/authority
   * Returns the stored consent-authority determination plus the currently
   * resolved signer (guardian vs. self). Permission: institute member.
   */
  async getAuthority(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.studentId;
      if (!(await assertSharesInstituteWithStudent(req, res, studentId))) return;
      const student = await studentRepository.getStudentById(studentId);
      if (!student) { res.status(404).json({ success: false, message: "Student not found" }); return; }
      const resolved = await consentAuthorityService.resolveForStudent(studentId);
      res.json({
        success: true,
        consentAuthority: student.consentAuthority ?? "auto",
        guardianshipBasis: student.guardianshipBasis ?? null,
        guardianshipEvidence: student.guardianshipEvidence ?? null,
        guardianshipReviewDate: student.guardianshipReviewDate ?? null,
        resolved, // { signerType, basis, source } | null
      });
    } catch (err) {
      handleAuthorityError(res, err);
    }
  }

  /**
   * PUT /api/consent/students/:studentId/authority
   * Sets the consent-authority determination (auto / guardian_required / self)
   * plus guardianship basis/evidence/review-date. Permission: institute admin.
   */
  async setAuthority(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }
      const studentId = req.params.studentId;
      if (!(await administersStudentInstitute(principalFromRequest(req), studentId))) {
        res.status(403).json({ success: false, code: "permission_denied", message: "Only institute admins can set consent authority" });
        return;
      }
      const parsed = setAuthoritySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const updated = await consentAuthorityService.setConsentAuthority(
        studentId,
        {
          mode: parsed.data.mode,
          basis: parsed.data.basis ?? null,
          evidence: parsed.data.evidence ?? null,
          reviewDate: parsed.data.reviewDate ?? null,
        },
        userId,
      );
      const resolved = await consentAuthorityService.resolveForStudent(studentId);
      res.json({
        success: true,
        consentAuthority: updated?.consentAuthority ?? parsed.data.mode,
        guardianshipBasis: updated?.guardianshipBasis ?? null,
        guardianshipEvidence: updated?.guardianshipEvidence ?? null,
        guardianshipReviewDate: updated?.guardianshipReviewDate ?? null,
        resolved,
      });
    } catch (err) {
      handleAuthorityError(res, err);
    }
  }

  /**
   * POST /api/consent/students/:studentId/sign
   * Updates the guardian contact (legal-guardian declaration + gov-ID) and
   * signs the consent record in the same transaction.
   */
  async signConsent(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }
      const parsed = signConsentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const studentId = req.params.studentId;
      const input = parsed.data;

      // Resolve who may sign for this student (guardian vs. self). signConsent
      // re-validates this server-side; here we branch the permission + contact
      // handling. A null resolution (missing birth date) falls through to the
      // guardian path so signConsent surfaces the clearer student_missing_birth_date.
      const resolved = await consentAuthorityService.resolveForStudent(studentId);
      const signerType = resolved?.signerType ?? "guardian";

      let signedByContactId: string | null = null;
      let signedByUserId: string | null = null;
      let receiptTo: string | null = null;

      if (signerType === "guardian") {
        if (!input.signedByContactId) {
          res.status(422).json({ success: false, code: "signer_not_permitted", message: "This student requires guardian consent — a signing contact is required" });
          return;
        }
        // Permission: the contact being signed-as must be linked to the
        // current user (parent/guardian flow). Stronger flows (clinic
        // in-person attest, etc.) will land at different endpoints.
        const [contact] = await db
          .select()
          .from(studentContacts)
          .where(eq(studentContacts.id, input.signedByContactId));
        if (!contact) {
          res.status(404).json({ success: false, code: "contact_not_found", message: "Contact not found" });
          return;
        }
        if (contact.studentId !== studentId) {
          res.status(403).json({ success: false, code: "contact_not_for_student", message: "Contact does not belong to that student" });
          return;
        }
        if (contact.linkedUserId !== userId) {
          res.status(403).json({ success: false, code: "contact_not_owned_by_caller", message: "Only the linked user can sign as this contact" });
          return;
        }

        // Update the guardian contact in the same transaction:
        //   - flip isLegalGuardian = true (the wizard step asserted it)
        //   - apply coGuardianAcknowledged
        //   - persist gov-ID fields if the wizard collected/updated them
        //   - stamp legalGuardianDeclaredAt
        const updates: Partial<typeof studentContacts.$inferInsert> = {
          isLegalGuardian: true,
          legalGuardianDeclaredAt: new Date(),
        };
        if (input.guardianFields) {
          const g = input.guardianFields;
          if (g.coGuardianAcknowledged !== undefined) updates.coGuardianAcknowledged = g.coGuardianAcknowledged;
          if (g.governmentIdNumber !== undefined) {
            updates.governmentIdNumber = g.governmentIdNumber;
            updates.governmentIdVerifiedVia = "manual_entry";
            updates.governmentIdVerificationProvider = "self_declared";
            updates.governmentIdVerifiedAt = new Date();
          }
          if (g.governmentIdType !== undefined) updates.governmentIdType = g.governmentIdType;
          if (g.governmentIdCountry !== undefined) updates.governmentIdCountry = g.governmentIdCountry.toUpperCase();
        }
        await db
          .update(studentContacts)
          .set(updates)
          .where(eq(studentContacts.id, input.signedByContactId));

        signedByContactId = input.signedByContactId;
        receiptTo = contact.contactEmail ?? null;
      } else {
        // Self-consent: the acting user must be the student's own account (an
        // active user-student link). No guardian contact is involved.
        const [link] = await db
          .select()
          .from(userStudents)
          .where(
            and(
              eq(userStudents.userId, userId),
              eq(userStudents.studentId, studentId),
              eq(userStudents.isActive, true),
            ),
          );
        if (!link) {
          res.status(403).json({ success: false, code: "contact_not_owned_by_caller", message: "Only the student can self-consent for themselves" });
          return;
        }
        if (input.signedByContactId) {
          res.status(422).json({ success: false, code: "signer_not_permitted", message: "This student self-consents — a guardian contact cannot sign on their behalf" });
          return;
        }
        signedByUserId = userId;
      }

      // V1 family flow defaults: authenticated_session both legs, standard regime.
      const idvMethod = input.identityVerificationMethod ?? "authenticated_session";
      const nrMethod = input.nonRepudiationMethod ?? "authenticated_session";
      const idvEvidence = input.identityVerificationEvidence ?? {
        userId,
        signedAt: new Date().toISOString(),
        provenance: "v1_family_flow",
      };
      const nrEvidence = {
        ...(input.nonRepudiationEvidence ?? {
          userId,
          ip: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
        }),
        ...(input.signature ? { signature: input.signature } : {}),
      };

      const record = await consentService.signConsent({
        studentId,
        signedByContactId,
        signedByUserId,
        locale: input.locale,
        consentTextVersion: input.consentTextVersion,
        consentTextHash: input.consentTextHash,
        thirdPartyRecipients: getDefaultRecipients(), // server-trusted, not from client
        purposeAcknowledged: input.purposeAcknowledged,
        voluntarinessAcknowledged: input.voluntarinessAcknowledged,
        thirdPartyTransfersAcknowledged: input.thirdPartyTransfersAcknowledged,
        optInModelTraining: input.optInModelTraining,
        optInAdvertising: input.optInAdvertising,
        optInThirdPartyResearch: input.optInThirdPartyResearch,
        optInMarketingComms: input.optInMarketingComms,
        identityVerificationMethod: idvMethod,
        identityVerificationEvidence: idvEvidence,
        nonRepudiationMethod: nrMethod,
        nonRepudiationEvidence: nrEvidence,
        isSensitive: input.isSensitive ?? false, // v1 family flow: standard
        signedFromIp: req.ip ?? null,
        signedFromUserAgent: (req.headers["user-agent"] as string) ?? null,
        actingUserId: userId,
      });

      // Email the parent their copy of the signed consent (Right to
      // Information). Awaited before responding so Lambda doesn't freeze it;
      // the helper never throws, so a delivery failure won't fail the sign.
      const student = await studentRepository.getStudentById(studentId);
      const finalReceiptTo =
        receiptTo ?? (await userRepository.getUser(userId))?.email ?? null;
      await sendConsentReceipt({
        to: finalReceiptTo,
        studentName: student?.name ?? "your child",
        consent: record,
      });

      res.json({ success: true, consent: record });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * POST /api/consent/students/:studentId/attest-in-person
   *
   * The clinic-desk consent: the guardian is physically in the room, the
   * clinician has inspected their identification, and the clinician records the
   * consent from their OWN authenticated session.
   *
   * Why this is a separate endpoint and not a relaxation of `/sign`:
   * `/sign` refuses unless `contact.linkedUserId === caller` (403
   * `contact_not_owned_by_caller`). That rule is correct for the parent flow and
   * is left exactly as it is — a clinic guardian is a name and an email with no
   * account, so the parent rule can never admit them, and loosening it would
   * also admit every OTHER caller who is not the guardian. This endpoint accepts
   * a contact the caller does not own precisely because the caller is not
   * claiming to BE the guardian: they are attesting, from their own identified
   * session, that they saw one.
   *
   * The clinician's attestation is what establishes `isLegalGuardian` on the
   * contact (step 4 of `signConsent` requires it). In the parent flow the
   * guardian's own click flips that bit; here the clinician's inspection does,
   * and the record says so in three places — `governmentIdVerificationProvider =
   * 'clinician_attested'` on the contact, `attestingClinicianUserId` in the
   * consent record's `identity_verification_evidence`, and a `guardian_id_verified`
   * activity-log row naming the attester.
   */
  async attestInPerson(req: Request, res: Response): Promise<void> {
    try {
      const userId = principalFromRequest(req)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }
      const studentId = req.params.studentId;

      // Permission — `assertAttestPermission` wraps `attestPermissionFor`, the
      // ONE copy of this rule. `revokeConsent` consults the same predicate for
      // attest parity (see the AttestPermission block comment), so flipping
      // ATTEST_REQUIRES_INSTITUTE_ADMIN tightens creation and withdrawal
      // together. A hand-rolled copy of this check is how the last one rotted.
      if (!(await assertAttestPermission(req, res, studentId))) return;

      const parsed = attestInPersonSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const input = parsed.data;

      // The contact must exist and belong to this student. NOTE the deliberate
      // absence of the `linkedUserId === userId` check — see the header.
      const [contact] = await db
        .select()
        .from(studentContacts)
        .where(eq(studentContacts.id, input.signedByContactId));
      if (!contact) {
        res.status(404).json({ success: false, code: "contact_not_found", message: "Contact not found" });
        return;
      }
      if (contact.studentId !== studentId) {
        res.status(403).json({ success: false, code: "contact_not_for_student", message: "Contact does not belong to that student" });
        return;
      }

      // A self-consenting student has no guardian for anyone to attest for.
      const resolvedAuthority = await consentAuthorityService.resolveForStudent(studentId);
      if (resolvedAuthority?.signerType === "self") {
        res.status(422).json({
          success: false,
          code: "signer_not_permitted",
          message: "This student self-consents — a guardian contact cannot sign on their behalf",
        });
        return;
      }

      // ── Legal pre-flight ────────────────────────────────────────────────
      // `signConsent` re-checks this at step 9 and is the authority. It is
      // checked HERE as well for two reasons, and neither is redundancy for its
      // own sake:
      //
      //  1. ORDER. `signConsent` looks the consent notice up (step 5) BEFORE it
      //     checks IDV acceptability (step 9). Notices exist only for IL, so a
      //     US student would fail `notice_not_found` and the COPPA rule would
      //     never be reached — the refusal would look like "we have no US text"
      //     rather than "this method is not a COPPA method". Checking first
      //     makes the legal refusal the one the caller actually sees.
      //  2. The contact row is not touched until this passes, so a refused
      //     attestation cannot leave `isLegalGuardian` flipped behind it.
      //
      // The rule itself is NOT re-implemented: this calls the same adapter, so
      // adding a country stays data.
      const student = await studentRepository.getStudentById(studentId);
      if (!student) {
        res.status(404).json({ success: false, code: "student_not_found", message: "Student not found" });
        return;
      }
      if (!student.birthDate) {
        res.status(400).json({
          success: false,
          code: "student_missing_birth_date",
          message: "Student has no birth date — cannot compute minor-protection regime",
        });
        return;
      }
      const country = (student.country ?? "IL").toUpperCase();
      const ageAtSigningYears = computeAgeYears(new Date(student.birthDate));
      const minor = resolveMinorProtection(country, ageAtSigningYears);
      const idvRegime = resolveIdvRegimeContext({
        country,
        minorRegime: minor.regime,
        isSensitive: IN_PERSON_IS_SENSITIVE,
      });
      const idvCheck = checkIdvAcceptability({
        identityMethod: IN_PERSON_IDV_METHOD,
        nonRepudiationMethod: IN_PERSON_IDV_METHOD,
        regime: idvRegime,
      });
      if (!idvCheck.acceptable) {
        // The live case today: a US student under 13 resolves to `us_coppa`,
        // for which this method is not an enumerated verifiable-parental-consent
        // method. Nothing about it is US-specific in code — the same branch
        // fires for any (country, age, sensitivity) the registry rejects.
        res.status(errorStatus.idv_not_acceptable).json({
          success: false,
          code: "idv_not_acceptable",
          message:
            "In-person clinician attestation is not an acceptable consent method for this student's legal regime",
          details: {
            regime: idvRegime,
            reason: idvCheck.reason,
            identityMethod: IN_PERSON_IDV_METHOD,
            nonRepudiationMethod: IN_PERSON_IDV_METHOD,
            enhancedProtectionRegime: minor.regime,
          },
        });
        return;
      }

      // ── The attestation write ───────────────────────────────────────────
      const attestedAt = new Date();
      const identificationCountry = (
        input.attestation.identificationCountry ??
        input.guardianFields?.governmentIdCountry ??
        null
      )?.toUpperCase() ?? null;

      const contactUpdates: Partial<typeof studentContacts.$inferInsert> = {
        // The clinician's attestation IS the guardianship evidence here.
        isLegalGuardian: true,
        legalGuardianDeclaredAt: attestedAt,
        governmentIdType: input.attestation.identificationType,
        governmentIdVerifiedVia: "manual_entry",
        governmentIdVerificationProvider: IN_PERSON_ID_PROVIDER,
        governmentIdVerifiedAt: attestedAt,
      };
      if (identificationCountry) contactUpdates.governmentIdCountry = identificationCountry;
      if (input.guardianFields?.governmentIdNumber !== undefined) {
        contactUpdates.governmentIdNumber = input.guardianFields.governmentIdNumber;
      }
      if (input.guardianFields?.coGuardianAcknowledged !== undefined) {
        contactUpdates.coGuardianAcknowledged = input.guardianFields.coGuardianAcknowledged;
      }
      await db
        .update(studentContacts)
        .set(contactUpdates)
        .where(eq(studentContacts.id, contact.id));

      const attester = await userRepository.getUser(userId);
      const attesterName =
        attester?.fullName ??
        [attester?.firstName, attester?.lastName].filter(Boolean).join(" ") ??
        null;

      // Evidence — the identity leg. `attestingClinicianUserId` is the key name
      // the consent plan specifies (§"Method-specific evidence"), so an auditor
      // querying `identity_verification_evidence->>'attestingClinicianUserId'`
      // finds every attested record; `studentConsentRecordRepository
      // .listAttestedByUser` is the same query as a first-class call.
      //
      // MINIMISATION: the ID NUMBER is not here. `studentContacts
      // .governmentIdNumber` is stored in plaintext and is un-masked at the REST
      // layer (SECURITY_ARCHITECTURE §1.3, an open finding); copying it into a
      // second, un-redacted jsonb column would widen that finding for no
      // evidentiary gain. What was inspected is recorded as document TYPE +
      // issuing country, and the number itself stays in its one existing home.
      const identityEvidence = {
        provenance: "in_person_clinician_attest",
        attestingClinicianUserId: userId,
        attestingClinicianName: attesterName,
        attestingClinicianEmail: attester?.email ?? null,
        attestedAt: attestedAt.toISOString(),
        guardianPresent: true,
        identificationInspected: {
          type: input.attestation.identificationType,
          country: identificationCountry,
          numberOnFile: !!(
            input.guardianFields?.governmentIdNumber ?? contact.governmentIdNumber
          ),
        },
        notes: input.attestation.notes ?? null,
        signedByContactId: contact.id,
        signedByContactName: contact.name,
      };

      // Evidence — the non-repudiation leg. The clinician's session is what the
      // method rests on; the guardian's own signature rides alongside it.
      const nonRepudiationEvidence = {
        attestingClinicianUserId: userId,
        attestedAt: attestedAt.toISOString(),
        ip: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
        signature: input.signature,
        signedByContactId: contact.id,
      };

      const record = await consentService.signConsent({
        studentId,
        signedByContactId: contact.id,
        signedByUserId: null,
        locale: input.locale,
        consentTextVersion: input.consentTextVersion,
        consentTextHash: input.consentTextHash,
        thirdPartyRecipients: getDefaultRecipients(), // server-trusted
        purposeAcknowledged: input.purposeAcknowledged,
        voluntarinessAcknowledged: input.voluntarinessAcknowledged,
        thirdPartyTransfersAcknowledged: input.thirdPartyTransfersAcknowledged,
        optInModelTraining: input.optInModelTraining,
        optInAdvertising: input.optInAdvertising,
        optInThirdPartyResearch: input.optInThirdPartyResearch,
        optInMarketingComms: input.optInMarketingComms,
        // Server-owned, every one of them. Nothing below reads `req.body`.
        identityVerificationMethod: IN_PERSON_IDV_METHOD,
        identityVerificationEvidence: identityEvidence,
        nonRepudiationMethod: IN_PERSON_IDV_METHOD,
        nonRepudiationEvidence,
        isSensitive: IN_PERSON_IS_SENSITIVE,
        signedFromIp: req.ip ?? null,
        signedFromUserAgent: (req.headers["user-agent"] as string) ?? null,
        actingUserId: userId,
      });

      // Audit. `signConsent` already fired `consent_signed` with
      // `identityVerificationMethod` in its details, which is what distinguishes
      // this from a self-signed consent. This SECOND row is the attestation act
      // itself — the previously-allocated-but-never-emitted `guardian_id_verified`
      // — so an auditor can find "which guardians did clinician X vouch for"
      // without reading consent records.
      activityLogService.log({
        userId,
        eventType: "guardian_id_verified",
        subjectType1: "student_contact",
        subjectId1: contact.id,
        subjectType2: "student",
        subjectId2: studentId,
        details: {
          consentRecordId: record.id,
          attestingClinicianUserId: userId,
          identityVerificationMethod: IN_PERSON_IDV_METHOD,
          verificationProvider: IN_PERSON_ID_PROVIDER,
          guardianPresent: true,
          identificationType: input.attestation.identificationType,
          identificationCountry,
          idvRegime,
          signatureMode: input.signature.mode,
        },
      });

      // The guardian's own copy of what they signed (Right to Information).
      // Never throws; a delivery failure must not fail the attestation.
      await sendConsentReceipt({
        to: contact.contactEmail ?? null,
        studentName: student.name ?? "your child",
        consent: record,
      });

      res.json({ success: true, consent: record });
    } catch (err) {
      handleError(res, err);
    }
  }

  /**
   * POST /api/consent/:consentId/revoke
   *
   * Two rules, and `revokePathFor` is where both live:
   *
   *  1. The ORIGINAL SIGNER (the signing contact's linked user, or the student
   *     on a self-signed record) or a system admin — unchanged, for every
   *     record.
   *  2. ATTEST PARITY — for a record whose `identityVerificationMethod` is
   *     `in_person_clinician_attested` ONLY, anyone who satisfies the same
   *     predicate the attest endpoint gates on. That record was created FOR a
   *     guardian with no account, so rule 1 can never admit its data subject;
   *     without this the only revoker in the system is a system admin.
   *
   * It does NOT widen anything else: a consent the parent signed themselves
   * (session or magic link) is still revocable only by them. See the
   * AttestPermission block comment for why the broad reading was rejected.
   */
  async revokeConsent(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthenticated" });
        return;
      }
      const parsed = revokeConsentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const consentId = req.params.consentId;

      const existing = await studentConsentRecordRepository.getById(consentId);
      if (!existing) {
        res.status(404).json({ success: false, code: "consent_not_found", message: "Consent not found" });
        return;
      }

      const path = await revokePathFor(req, existing);
      if (!path) {
        res.status(403).json({
          success: false,
          code: "permission_denied",
          message: "Only the original signer can revoke this consent",
        });
        return;
      }

      // Audit (§8): `revocation_path` names WHICH rule admitted this caller, so
      // a clinic-performed withdrawal is distinguishable from the signer's own
      // at a glance. On the parity path we also carry the ATTESTER's id, so one
      // row answers "who vouched for this guardian, and who tore it up".
      const revoked = await consentService.revokeConsent({
        consentId,
        revokedByUserId: userId,
        reason: parsed.data.reason,
        extraDetails: {
          revocation_path: path,
          ...(path === "attest_parity"
            ? {
                attested_by_user_id:
                  (existing.identityVerificationEvidence as any)
                    ?.attestingClinicianUserId ?? null,
                identity_verification_method: existing.identityVerificationMethod,
              }
            : {}),
        },
      });
      res.json({ success: true, consent: revoked });
    } catch (err) {
      handleError(res, err);
    }
  }

  // ============================================================================
  // Magic-link consent invitations (clinician → parent without account)
  // ============================================================================

  /**
   * POST /api/consent/invitations
   * Clinician creates an invitation for a contact (parent without an account)
   * and dispatches it via email or SMS. Returns the redemption URL — the
   * plaintext code is shown only once. Permission: must be admin of the
   * source institute.
   */
  async createInvitation(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }

      const parsed = createInvitationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const input = parsed.data;

      // Permission: caller must be admin of the source institute (or system admin).
      const isSystemAdmin = !!(req.user as any)?.isSystemAdmin;
      if (!isSystemAdmin) {
        const isAdmin = await instituteRepository.isUserAdminOfInstitute(input.sourceInstituteId, userId);
        if (!isAdmin) {
          res.status(403).json({
            success: false,
            code: "permission_denied",
            message: "Only institute admins can send consent invitations",
          });
          return;
        }
      }

      const result = await consentInvitationService.createInvitation({
        studentId: input.studentId,
        contactId: input.contactId,
        recipientType: input.recipientType,
        selfDestination: input.selfDestination,
        sourceInstituteId: input.sourceInstituteId,
        createdByUserId: userId,
        channel: input.channel,
        ttlDays: input.ttlDays,
        appBaseUrl: getBaseUrl(req),
      });

      res.json({
        success: true,
        invitation: result.invitation,
        code: result.code,           // shown once
        redemptionUrl: result.redemptionUrl,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/redeem  { code }
   * Public endpoint (no session required) — the magic-link page calls it
   * when the parent arrives. Validates the token and returns the wizard
   * context. Does NOT consume the token.
   *
   * The code is taken from the BODY, never the query string, so it does not
   * land in access logs. The response is deliberately minimal (see
   * consentInvitationService.redeemContext) because it precedes verification.
   */
  async redeemInvitation(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      if (!code) { res.status(400).json({ success: false, message: "code is required" }); return; }
      const ctx = await consentInvitationService.redeemContext(code);
      res.json({ success: true, ...ctx });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/sign
   * Public endpoint (no session required) — the magic-link page submits the
   * signed wizard payload here. Token IS the auth.
   */
  async signInvitation(req: Request, res: Response): Promise<void> {
    try {
      const parsed = signWithTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const { code, ...rest } = parsed.data;
      const result = await consentInvitationService.signWithToken({
        code,
        payload: {
          locale: rest.locale,
          consentTextVersion: rest.consentTextVersion,
          consentTextHash: rest.consentTextHash,
          thirdPartyRecipients: [], // server overrides at sign-time anyway
          purposeAcknowledged: rest.purposeAcknowledged,
          voluntarinessAcknowledged: rest.voluntarinessAcknowledged,
          thirdPartyTransfersAcknowledged: rest.thirdPartyTransfersAcknowledged,
          optInModelTraining: rest.optInModelTraining,
          optInAdvertising: rest.optInAdvertising,
          optInThirdPartyResearch: rest.optInThirdPartyResearch,
          optInMarketingComms: rest.optInMarketingComms,
          identityVerificationMethod: rest.identityVerificationMethod ?? "verified_phone_otp",
          identityVerificationEvidence: rest.identityVerificationEvidence ?? {},
          nonRepudiationMethod: rest.nonRepudiationMethod ?? "verified_phone_otp",
          nonRepudiationEvidence: {
            ...(rest.nonRepudiationEvidence ?? {}),
            ...(rest.signature ? { signature: rest.signature } : {}),
          },
          isSensitive: rest.isSensitive ?? false,
        } as any,
        guardianFields: rest.guardianFields,
        signedFromIp: req.ip ?? null,
        signedFromUserAgent: (req.headers["user-agent"] as string) ?? null,
      });
      res.json({ success: true, consent: result.consent });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * GET /api/consent/students/:studentId/invitations
   * Returns the active (non-revoked, non-redeemed, unexpired) invitations
   * for a student. Permission-gated: institute member (or system admin).
   * The clinician needs this to see if a magic link they sent is still
   * outstanding before sending another.
   */
  async listPendingInvitations(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.studentId;

      // Permission: caller must share an institute with the student. We
      // accept any membership — pending invitations are operational state,
      // not PHI. (The actual signing flow has stricter checks.)
      if (!(await assertSharesInstituteWithStudent(req, res, studentId))) return;

      const { consentInvitationRepository } = await import("../repositories/consentInvitationRepository");
      const invitations = await consentInvitationRepository.listPendingForStudent(studentId);
      res.json({ success: true, invitations });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/request-otp
   * Public — token IS the auth. Sends/re-sends an SMS OTP to the contact's
   * phone for this invitation. Rate-limited per (invitation, phone).
   */
  async requestPhoneOtp(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      if (!code) {
        res.status(400).json({ success: false, message: "code is required" });
        return;
      }
      const out = await consentInvitationService.requestPhoneOtp(code);
      res.json({
        success: true,
        sentTo: out.sentTo,
        expiresAt: out.expiresAt.toISOString(),
        bypass: out.bypass,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/verify-otp
   * Public — token IS the auth. Verifies the user-submitted OTP and marks
   * it consumed. Sign endpoint then confirms the verification within the
   * freshness window before writing the consent record.
   */
  async verifyPhoneOtp(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      const otpCode = String(req.body?.otpCode ?? "").trim();
      if (!code || !otpCode) {
        res.status(400).json({
          success: false,
          message: "code and otpCode are required",
        });
        return;
      }
      const out = await consentInvitationService.verifyPhoneOtp({
        code,
        otpCode,
      });
      res.json({
        success: true,
        verifiedAt: out.verifiedAt.toISOString(),
        sentTo: out.sentTo,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/verify-id
   * Public — token IS the auth. Verifies the parent-supplied last-4 of the
   * child's institute ID for an email-channel invitation. Attempt-capped in
   * the service. Never echoes the ID back.
   */
  async verifyChildId(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      const last4 = String(req.body?.last4 ?? "").trim();
      if (!code || !last4) {
        res.status(400).json({ success: false, message: "code and last4 are required" });
        return;
      }
      const out = await consentInvitationService.verifyChildId({ code, last4 });
      res.json({
        success: true,
        verifiedAt: out.verifiedAt.toISOString(),
        attemptsRemaining: out.attemptsRemaining,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/invitations/:id/revoke
   * Clinician revokes a pending invitation.
   */
  async revokeInvitation(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }
      const result = await consentInvitationService.revokeInvitation({
        invitationId: req.params.id,
        revokedByUserId: userId,
      });
      res.json({ success: true, invitation: result });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  // ============================================================================
  // Self-serve withdrawal for a signer with NO user account (§5.3)
  //
  // Every endpoint below except the last is PUBLIC and token-authed, for the
  // same reason the sign endpoints are: the person who holds the right to
  // withdraw is a guardian with an email and a phone and no `users` row, so
  // there is no session to require. `requireAuth` on this surface would not be
  // "more secure", it would be a permanent refusal of a statutory right.
  //
  // What replaces the session is, in order: an unguessable single-use token
  // hashed at rest and bound to ONE consent record, delivered only to a channel
  // already on file, plus the same second factor the sign flow used for that
  // channel, plus an explicit human confirmation. Routes carry
  // `authRateLimiter`.
  // ============================================================================

  /**
   * POST /api/consent/withdraw/request-link  { reference }
   * PUBLIC. The receipt email's withdrawal link lands here.
   *
   * 🚨 ALWAYS 200, ALWAYS THE SAME BODY. It must not reveal whether the
   * reference names a real consent record, whether the student exists, whether
   * the signer has an account, whether a delivery channel is on file, or
   * whether the consent was already withdrawn. The service swallows every
   * refusal for exactly this reason; this handler must not "improve" on it by
   * surfacing one.
   */
  async requestWithdrawalLink(req: Request, res: Response): Promise<void> {
    try {
      const reference = String(req.body?.reference ?? "").trim();
      // Even a missing reference gets the same answer — a 400 here would let a
      // caller distinguish "malformed" from "unknown", which is a start.
      if (reference) {
        await consentWithdrawalService.requestLinkByReference({
          reference,
          appBaseUrl: getBaseUrl(req),
        });
      }
      res.json({ success: true });
    } catch (err) {
      // The service does not throw. If something below it did, the caller still
      // learns nothing.
      console.error("[ConsentController][withdraw] request-link:", err);
      res.json({ success: true });
    }
  }

  /**
   * POST /api/consent/withdraw/context  { code }
   * PUBLIC — the token IS the auth. What the withdrawal page renders before the
   * guardian confirms. The code travels in the BODY, never the query string, so
   * it does not land in access logs.
   */
  async getWithdrawalContext(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      if (!code) { res.status(400).json({ success: false, message: "code is required" }); return; }
      const ctx = await consentWithdrawalService.withdrawContext(code);
      res.json({ success: true, ...ctx });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /** POST /api/consent/withdraw/request-otp  { code } — PUBLIC. */
  async requestWithdrawalOtp(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      if (!code) { res.status(400).json({ success: false, message: "code is required" }); return; }
      const out = await consentWithdrawalService.requestPhoneOtp(code);
      res.json({
        success: true,
        sentTo: out.sentTo,
        expiresAt: out.expiresAt.toISOString(),
        bypass: out.bypass,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /** POST /api/consent/withdraw/verify-otp  { code, otpCode } — PUBLIC. */
  async verifyWithdrawalOtp(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      const otpCode = String(req.body?.otpCode ?? "").trim();
      if (!code || !otpCode) {
        res.status(400).json({ success: false, message: "code and otpCode are required" });
        return;
      }
      const out = await consentWithdrawalService.verifyPhoneOtp({ code, otpCode });
      res.json({
        success: true,
        verifiedAt: out.verifiedAt.toISOString(),
        sentTo: out.sentTo,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /** POST /api/consent/withdraw/verify-id  { code, last4 } — PUBLIC. */
  async verifyWithdrawalChildId(req: Request, res: Response): Promise<void> {
    try {
      const code = String(req.body?.code ?? "").trim();
      const last4 = String(req.body?.last4 ?? "").trim();
      if (!code || !last4) {
        res.status(400).json({ success: false, message: "code and last4 are required" });
        return;
      }
      const out = await consentWithdrawalService.verifyChildId({ code, last4 });
      res.json({
        success: true,
        verifiedAt: out.verifiedAt.toISOString(),
        attemptsRemaining: out.attemptsRemaining,
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/withdraw/confirm  { code, confirm: true, reason? }
   * PUBLIC. The withdrawal itself.
   *
   * `confirm` is `z.literal(true)`: an email scanner or link-prefetcher that
   * follows the URL reaches a page, never this endpoint, and a client that
   * POSTs without the flag is refused. A withdrawal terminates a live AAC
   * session for a child who depends on the device — it must never happen
   * because software followed a link.
   */
  async confirmWithdrawal(req: Request, res: Response): Promise<void> {
    try {
      const parsed = withdrawConfirmSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }
      const out = await consentWithdrawalService.confirmWithdrawal({
        code: parsed.data.code,
        confirm: parsed.data.confirm,
        reason: parsed.data.reason,
        ip: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      });
      // The record itself is not echoed: the holder of this token is the
      // guardian, and they already saw everything they needed on the context
      // call. All they need now is "it is done".
      res.json({ success: true, revokedAt: out.consent.revokedAt });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }

  /**
   * POST /api/consent/:consentId/withdrawal-link  { channel? }
   * AUTHENTICATED — the clinic re-issues a withdrawal link because the guardian
   * phoned, or lost the email.
   *
   * Permission is `administersStudentInstitute`, matching `createInvitation` (the
   * consent-sending affordance this mirrors) rather than the looser
   * `assertSharesInstituteWithStudent`. This is a send, not a read, and the conservative
   * choice was taken deliberately: the act is "cause a message to be sent to a
   * guardian on the clinic's behalf", which is the same act
   * `createInvitation` gates on institute admin. Note the caller never learns
   * the code — it goes to the guardian's stored channel and the response
   * carries only a masked destination — so this cannot become a way for a
   * clinician to withdraw a parent-signed consent themselves. That remains
   * exactly what §5.2 says it is.
   */
  async reissueWithdrawalLink(req: Request, res: Response): Promise<void> {
    try {
      const userId = principalFromRequest(req)?.id;
      if (!userId) { res.status(401).json({ success: false, message: "Unauthenticated" }); return; }

      const consentId = req.params.consentId;
      const existing = await studentConsentRecordRepository.getById(consentId);
      if (!existing) {
        res.status(404).json({ success: false, code: "consent_not_found", message: "Consent not found" });
        return;
      }
      if (!(await administersStudentInstitute(principalFromRequest(req), existing.studentId))) {
        res.status(403).json({
          success: false,
          code: "permission_denied",
          message: "Only institute admins can send a withdrawal link",
        });
        return;
      }

      const parsed = reissueWithdrawalSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", issues: parsed.error.issues });
        return;
      }

      const out = await consentWithdrawalService.reissueLinkForClinician({
        consentId,
        channel: parsed.data.channel as WithdrawalChannel | undefined,
        createdByUserId: userId,
        appBaseUrl: getBaseUrl(req),
      });
      res.json({
        success: true,
        channel: out.channel,
        sentTo: out.sentToMasked,
        expiresAt: out.expiresAt.toISOString(),
      });
    } catch (err) {
      handleInvitationError(res, err);
    }
  }
}

const withdrawConfirmSchema = z.object({
  code: z.string().min(8).max(64),
  /**
   * `z.literal(true)` — a payload without it is MALFORMED, not "a withdrawal
   * with confirm=false". See the handler's note on link-prefetchers.
   */
  confirm: z.literal(true),
  reason: z.string().max(2000).optional(),
});

const reissueWithdrawalSchema = z.object({
  /** Omit to let the server pick the strongest channel on file. */
  channel: z.enum(["email", "sms"]).optional(),
});

// Consent-authority determination
const setAuthoritySchema = z.object({
  mode: z.enum(["auto", "guardian_required", "self"]),
  basis: z
    .enum([
      "minor",
      "court_appointed_guardian",
      "limited_guardian",
      "supported_decision_making",
      "power_of_attorney",
    ])
    .nullish(),
  evidence: z.record(z.unknown()).nullish(),
  reviewDate: z.string().max(40).nullish(),
});

// Local helpers for the invitation endpoints
const createInvitationSchema = z.object({
  studentId: z.string().min(1),
  // Required for guardian invitations; omitted for self-consent.
  contactId: z.string().min(1).optional(),
  recipientType: z.enum(["guardian", "self"]).optional(),
  // Destination (student's own email/phone) for a self-consent invitation.
  selfDestination: z.string().min(1).max(320).optional(),
  sourceInstituteId: z.string().min(1),
  channel: z.enum(["email", "sms", "manual"]),
  ttlDays: z.number().int().positive().max(30).optional(),
});

const signWithTokenSchema = z.object({
  code: z.string().min(8).max(64),
  locale: z.string().min(2).max(10),
  consentTextVersion: z.string().min(1),
  consentTextHash: z.string().length(64),
  guardianFields: z
    .object({
      governmentIdNumber: z.string().min(1).max(40).optional(),
      governmentIdType: z.enum(["national_id", "passport", "driver_license", "other"]).optional(),
      governmentIdCountry: z.string().length(2).optional(),
      coGuardianAcknowledged: z.boolean().optional(),
    })
    .optional(),
  purposeAcknowledged: z.boolean(),
  voluntarinessAcknowledged: z.boolean(),
  thirdPartyTransfersAcknowledged: z.boolean(),
  optInModelTraining: z.boolean().optional(),
  optInAdvertising: z.boolean().optional(),
  optInThirdPartyResearch: z.boolean().optional(),
  optInMarketingComms: z.boolean().optional(),
  signature: signatureSchema,
  identityVerificationMethod: z.string().optional(),
  identityVerificationEvidence: z.record(z.unknown()).optional(),
  nonRepudiationMethod: z.string().optional(),
  nonRepudiationEvidence: z.record(z.unknown()).optional(),
  isSensitive: z.boolean().optional(),
});

const invitationErrorStatus: Record<ConsentInvitationErrorCode, number> = {
  contact_not_found: 404,
  contact_missing_channel: 400,
  recipient_type_mismatch: 409,
  self_destination_required: 400,
  student_not_found: 404,
  code_not_found: 404,
  code_expired: 410,
  code_already_used: 410,
  code_revoked: 410,
  permission_denied: 403,
  channel_unsupported: 400,
  phone_otp_required: 412,
  child_id_not_on_file: 400,
  child_id_verify_locked: 429,
  child_id_mismatch: 422,
  child_id_verification_required: 412,
  // Withdrawal-token flow (§5.3).
  consent_not_found: 404,
  consent_already_revoked: 409,
  withdrawal_not_available: 403,
  confirmation_required: 400,
};

const phoneOtpErrorStatus: Record<PhoneOtpErrorCode, number> = {
  phone_invalid: 400,
  rate_limited: 429,
  send_failed: 502,
  code_not_found: 404,
  code_expired: 410,
  code_already_used: 410,
  code_attempts_exceeded: 429,
  code_mismatch: 422,
};

function handleInvitationError(res: Response, err: unknown): void {
  if (err instanceof ConsentInvitationError) {
    res.status(invitationErrorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  if (err instanceof PhoneOtpError) {
    res.status(phoneOtpErrorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  if (err instanceof ConsentError) {
    res.status((errorStatus as any)[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  console.error("[ConsentController][invitation]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

const authorityErrorStatus: Record<ConsentAuthorityErrorCode, number> = {
  student_not_found: 404,
  invalid_mode: 400,
  invalid_basis: 400,
  guardianship_basis_required: 422,
};

function handleAuthorityError(res: Response, err: unknown): void {
  if (err instanceof ConsentAuthorityError) {
    res.status(authorityErrorStatus[err.code] ?? 500).json({
      success: false,
      code: err.code,
      message: err.message,
    });
    return;
  }
  console.error("[ConsentController][authority]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

function getBaseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

export const consentController = new ConsentController();
